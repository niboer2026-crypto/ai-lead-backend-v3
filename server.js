require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT DEFAULT 'staff', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS chat_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_phone TEXT, platform TEXT, sender TEXT, message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS ai_config (id INTEGER PRIMARY KEY DEFAULT 1, welcome_msg TEXT, system_prompt TEXT);
`);

const defaultWelcome = "👋 您好！我是 Beauty Corner 专属美业助理，请问有什么可以帮您的？";
const defaultPrompt = "You are a senior beauty consultant for a high-end beauty salon in Dubai. Professional, warm, and attentive. Detect language and reply in the same language.";

const existingConfig = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO ai_config (id, welcome_msg, system_prompt) VALUES (1, ?, ?)').run(defaultWelcome, defaultPrompt);
}

app.use(express.json());
app.use(express.static(__dirname));

// 🌐 纯豆包（火山方舟）调用接口函数
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

app.get('/api/ai/status', (req, res) => {
  const hasDoubao = !!process.env.DOUBAO_API_KEY && !!process.env.DOUBAO_ENDPOINT_ID;
  res.json({ 
    ok: true, 
    model: "豆包大模型 (Doubao)", 
    configured: hasDoubao,
    doubaoReady: hasDoubao 
  });
});

app.post('/api/ai/key-test', async (req, res) => {
  try {
    const text = await callDoubao('Reply OK', 'You are a helpful assistant.');
    res.json({ ok: true, message: '豆包 AI 连通测试成功！', preview: String(text).slice(0, 50) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
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

    const aiReply = await callDoubao(message, cfg?.system_prompt || defaultPrompt);

    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'ai', ?, ?)`).run(phone, platform || 'Website', aiReply, new Date().toISOString());

    res.json({ ok: true, ai_reply: aiReply });
  } catch (err) {
    res.status(502).json({ ok: false, error: "AI 响应失败: " + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
