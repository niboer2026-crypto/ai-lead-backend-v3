require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 10000;
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'staff', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS chat_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_phone TEXT, platform TEXT, sender TEXT, message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS ai_config (id INTEGER PRIMARY KEY DEFAULT 1, welcome_msg TEXT, system_prompt TEXT);
  CREATE TABLE IF NOT EXISTS ai_secrets (id INTEGER PRIMARY KEY CHECK (id = 1), encrypted_key TEXT NOT NULL, iv TEXT NOT NULL, auth_tag TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
`);

const defaultWelcome = "👋 您好！我是 Beauty Corner 专属美业助理，请问有什么可以帮您的？";
const defaultPrompt = "You are a senior beauty consultant for a high-end beauty salon in Dubai. Professional, warm, and attentive. Detect language and reply in the same language.";

const existingConfig = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO ai_config (id, welcome_msg, system_prompt) VALUES (1, ?, ?)').run(defaultWelcome, defaultPrompt);
}

app.use(express.json());
app.use(express.static(__dirname));

const AUTH_SECRET = process.env.APP_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const ENC_KEY = crypto.createHash('sha256').update(AUTH_SECRET).digest();

function loadStoredKey() {
  try {
    const r = db.prepare('SELECT encrypted_key,iv,auth_tag FROM ai_secrets WHERE id=1').get();
    if (!r) return '';
    const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(r.iv, 'base64'));
    d.setAuthTag(Buffer.from(r.auth_tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(r.encrypted_key, 'base64')), d.final()]).toString('utf8');
  } catch { return ''; }
}

function getApiKeyPool() {
  const envKeys = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
  const stored = loadStoredKey();
  const storedKeys = stored.split(',').map(k => k.trim()).filter(Boolean);
  return Array.from(new Set([...envKeys, ...storedKeys]));
}

// 🌐 明确写好的豆包（火山方舟）调用接口函数
async function callDoubao(promptText, systemPrompt) {
  const doubaoKey = process.env.DOUBAO_API_KEY;
  const endpointId = process.env.DOUBAO_ENDPOINT_ID;
  if (!doubaoKey || !endpointId) {
    throw new Error("未配置豆包环境变量 (DOUBAO_API_KEY 或 DOUBAO_ENDPOINT_ID)");
  }

  const response = await fetch("https://ark.cn-beijing.volces.com/api/v3/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${doubaoKey}`
    },
    body: JSON.stringify({
      model: endpointId,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: promptText }
      ],
      temperature: 0.7
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "豆包 API 请求失败");
  }
  return data.choices?.[0]?.message?.content || "";
}

// 🛡️ 智能 AI 路由：Gemini 额度耗尽时，自动走豆包接口
async function callSmartAI(promptText, systemPrompt) {
  const keys = getApiKeyPool();
  let lastError = null;

  // 1. 优先尝试 Gemini 3.8-flash 轮询
  if (keys.length > 0) {
    for (const apiKey of keys) {
      try {
        const aiClient = new GoogleGenAI({ apiKey });
        const response = await aiClient.models.generateContent({
          model: "gemini-3.8-flash",
          contents: promptText,
          config: { systemInstruction: systemPrompt, temperature: 0.7 }
        });
        if (response && response.text) return `${response.text}`;
      } catch (err) {
        lastError = err;
        console.warn(`[Gemini Error] Key failed, trying next...: ${err.message}`);
      }
    }
  }

  // 2. Gemini 失败或超限（429）时，自动调用豆包接口兜底！
  try {
    console.log("[Fallback] Switching to Doubao API...");
    const doubaoReply = await callDoubao(promptText, systemPrompt);
    if (doubaoReply) return doubaoReply;
  } catch (doubaoErr) {
    console.warn(`[Doubao Error]: ${doubaoErr.message}`);
    throw new Error(`Gemini 与豆包均调用失败。Gemini 错误: ${lastError?.message || '无可用Key'}, 豆包错误: ${doubaoErr.message}`);
  }

  throw lastError || new Error("所有 AI 通道均调用失败");
}

app.get('/api/ai/status', (req, res) => {
  const hasGemini = getApiKeyPool().length > 0;
  const hasDoubao = !!process.env.DOUBAO_API_KEY && !!process.env.DOUBAO_ENDPOINT_ID;
  res.json({ 
    ok: true, 
    model: hasDoubao ? "Gemini + 豆包双引擎" : "Gemini 3.8-flash", 
    configured: hasGemini || hasDoubao,
    doubaoReady: hasDoubao 
  });
});

app.post('/api/ai/key', (req, res) => {
  try {
    const key = String(req.body?.apiKey || '').trim();
    if (!key) return res.status(400).json({ error: '请输入有效的 Key' });
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
    const encrypted = Buffer.concat([c.update(key, 'utf8'), c.final()]);
    db.prepare(`INSERT INTO ai_secrets(id,encrypted_key,iv,auth_tag,updated_at) VALUES(1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,iv=excluded.iv,auth_tag=excluded.auth_tag`).run(encrypted.toString('base64'), iv.toString('base64'), c.getAuthTag().toString('base64'));
    res.json({ ok: true, message: 'API Key 保存成功' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/key-test', async (req, res) => {
  try {
    const text = await callSmartAI('Reply OK', 'You are a helpful assistant.');
    res.json({ ok: true, message: 'AI 连通测试成功！', preview: String(text).slice(0, 50) });
  } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.get('/api/ai/config', (req, res) => {
  res.json(db.prepare('SELECT welcome_msg, system_prompt FROM ai_config WHERE id = 1').get() || { welcome_msg: defaultWelcome, system_prompt: defaultPrompt });
});

app.post('/api/ai/chat-reply', async (req, res) => {
  try {
    const { customer_phone, customer_message, platform } = req.body || {};
    const phone = String(customer_phone || "Web Visitor").trim();
    const message = String(customer_message || "").trim();
    if (!message) return res.status(400).json({ ok: false, error: "消息不能为空" });

    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'customer', ?, ?)`).run(phone, platform || 'Website', message, new Date().toISOString());
    const cfg = db.prepare('SELECT system_prompt FROM ai_config WHERE id = 1').get();

    const aiReply = await callSmartAI(message, cfg?.system_prompt || defaultPrompt);

    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'ai', ?, ?)`).run(phone, platform || 'Website', aiReply, new Date().toISOString());

    res.json({ ok: true, ai_reply: aiReply });
  } catch (err) {
    res.status(502).json({ ok: false, error: "AI 响应失败: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
