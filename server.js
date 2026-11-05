const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 10000;

// 初始化本地 SQLite 数据库 (自动生成 data.db文件)
const db = new Database('data.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'staff',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS social_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    label TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS social_search_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    country TEXT DEFAULT '',
    city TEXT DEFAULT '',
    keywords TEXT NOT NULL,
    gender TEXT DEFAULT '不限',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    source TEXT,
    center TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS appointments (
    appointment_number TEXT PRIMARY KEY,
    staff_id TEXT,
    phone TEXT,
    date TEXT,
    time TEXT,
    status TEXT,
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_phone TEXT,
    platform TEXT,
    sender TEXT,
    message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS ai_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    welcome_msg TEXT,
    system_prompt TEXT
  );
`);

// 初始默认 AI 欢迎词与提示词（美业专属智能助理）
const defaultWelcome = "👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？";
const defaultPrompt = "You are a senior beauty consultant & personal assistant for a high-end beauty brand in the Middle East (Dubai, Riyadh, Doha). Professional, warm, and attentive. Never call yourself AI Sales.";

const existingConfig = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO ai_config (id, welcome_msg, system_prompt) VALUES (1, ?, ?)').run(defaultWelcome, defaultPrompt);
}

// 强制同步超管账号：dubai / lcaizxy13
const superAdminUser = 'dubai';
const superAdminPass = 'lcaizxy13';
const existingAdmin = db.prepare('SELECT * FROM users WHERE username = ?').get(superAdminUser);
if (!existingAdmin) {
  db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(superAdminUser, superAdminPass, 'admin');
} else {
  db.prepare('UPDATE users SET password = ?, role = ? WHERE username = ?').run(superAdminPass, 'admin', superAdminUser);
}

app.use(express.json());

// 初始化 Gemini 客户端
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// API 路由：登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(String(username||"").trim(), String(password||"").trim());
  if (!user) return res.status(401).json({ error: '用户名或密码错误 / Invalid credentials' });
  res.json({ ok: true, username: user.username, role: user.role });
});

// AI 配置读取与保存 API
app.get('/api/ai/config', (req, res) => {
  try {
    const config = db.prepare('SELECT welcome_msg, system_prompt FROM ai_config WHERE id = 1').get();
    res.json(config || { welcome_msg: defaultWelcome, system_prompt: defaultPrompt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ai/config', (req, res) => {
  try {
    const { welcome_msg, system_prompt } = req.body || {};
    db.prepare('UPDATE ai_config SET welcome_msg = ?, system_prompt = ? WHERE id = 1').run(welcome_msg || defaultWelcome, system_prompt || defaultPrompt);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users', (req, res) => {
  try { res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id DESC').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '账号密码不能为空' });
    const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: '用户名已存在' });
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, password, role || 'staff');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', (req, res) => {
  try { db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dashboard/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
    const fb = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Facebook%'").get().cnt;
    const ig = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Instagram%'").get().cnt;
    const tk = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%TikTok%'").get().cnt;
    res.json({ ok: true, total, fb, ig, tk });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/social-accounts', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM social_accounts ORDER BY id DESC').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/social-accounts', (req, res) => {
  try {
    const { platform, label, profile_id } = req.body || {};
    db.prepare('INSERT INTO social_accounts (platform, label, profile_id) VALUES (?, ?, ?)').run(platform, label, profile_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/social-accounts/:id', (req, res) => {
  try { db.prepare('DELETE FROM social_accounts WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/appointments', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM appointments ORDER BY created_at DESC').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/appointments', (req, res) => {
  try {
    const b = req.body || {};
    const apptNo = 'APT-' + Date.now().toString().slice(-6);
    db.prepare(`INSERT INTO appointments (appointment_number, staff_id, phone, date, time, status, created_at) VALUES (?, ?, ?, ?, ?, 'Confirmed', ?)`).run(apptNo, b.staff_id || 'Staff', b.phone, b.date, b.time, new Date().toISOString());
    res.json({ ok: true, appointment_number: apptNo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/appointments/:no', (req, res) => {
  try { db.prepare('DELETE FROM appointments WHERE appointment_number = ?').run(req.params.no); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);
app.get('/api/social-search', (req, res) => {
  try { res.json(db.prepare(`SELECT * FROM social_search_configs ORDER BY id DESC`).all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/social-search', (req, res) => {
  const b = req.body || {};
  db.prepare(`INSERT INTO social_search_configs (account_id, platform, country, city, keywords, gender) VALUES (?, ?, ?, ?, ?, ?)`).run(Number(b.account_id), clean(b.platform, 30), clean(b.country, 100), clean(b.city, 100), clean(b.keywords, 1000), clean(b.gender || "不限", 20));
  res.json({ ok: true });
});

app.delete('/api/social-search/:id', (req, res) => {
  try { db.prepare(`DELETE FROM social_search_configs WHERE id = ?`).run(Number(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/social-search/:id', (req, res) => {
  try {
    db.prepare(`UPDATE social_search_configs SET enabled = ? WHERE id = ?`).run(req.body.enabled ? 1 : 0, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/social-search/:id/run', async (req, res) => {
  try {
    const config = db.prepare(`SELECT s.*, a.profile_id, a.label FROM social_search_configs s JOIN social_accounts a ON s.account_id = a.id WHERE s.id = ?`).get(Number(req.params.id));
    if (!config) return res.status(404).json({ error: "任务不存在" });
    const query = [config.keywords, config.city, config.country].filter(Boolean).join(" ");
    const encoded = encodeURIComponent(query);
    const searchUrls = {
      Facebook: `https://www.facebook.com/search/top?q=${encoded}`,
      Instagram: `https://www.instagram.com/explore/search/keyword/?q=${encoded}`,
      TikTok: `https://www.tiktok.com/search?q=${encoded}`
    };
    res.json({ ok: true, platform: config.platform, account: config.label, url: searchUrls[config.platform] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 🤖 Gemini AI 智能聊天与结构化预约时间提取（美业智能助理人设）
app.post('/api/ai/chat-reply', async (req, res) => {
  const { customer_phone, customer_message, platform } = req.body || {};
  const phone = customer_phone || '+971 50 999 8888';

  if (!customer_message) {
    return res.status(400).json({ error: "客户消息不能为空" });
  }

  try {
    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'customer', ?, ?)`).run(phone, platform || 'WhatsApp', customer_message, new Date().toISOString());

    const currentConfig = db.prepare('SELECT system_prompt FROM ai_config WHERE id = 1').get();
    const userPromptCustom = currentConfig ? currentConfig.system_prompt : defaultPrompt;

    const systemInstruction = `
      ${userPromptCustom}
      You must respond in strict JSON format with the following keys:
      {
        "reply": "Your warm, elegant, professional assistant reply to the customer in their language (English, Arabic, or Chinese). Never call yourself AI Sales.",
        "has_booking_intent": true or false,
        "appointment_date": "YYYY-MM-DD if mentioned or implied, otherwise null (current date is 2026-11-05)",
        "appointment_time": "HH:MM (24-hour format) if mentioned or implied, otherwise '15:00'"
      }
      Rules:
      1. If the customer wants to book or asks about booking/pricing, set "has_booking_intent" to true.
      2. Carefully parse any date/time clues (e.g. tomorrow, next Monday, 下午3点) relative to 2026-11-05.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `来自 [${platform || 'WhatsApp'}] 客户 (${phone}) 的咨询: "${customer_message}"`,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    });

    let aiResult;
    try {
      aiResult = JSON.parse(response.text.trim());
    } catch (e) {
      aiResult = {
        reply: response.text ? response.text.trim() : "感谢您的咨询，请问有什么我可以帮您的？",
        has_booking_intent: false,
        appointment_date: null,
        appointment_time: "15:00"
      };
    }

    const aiReply = aiResult.reply;

    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'ai', ?, ?)`).run(phone, platform || 'WhatsApp', aiReply, new Date().toISOString());

    let autoAppointmentCreated = false;
    let apptNumber = null;

    if (aiResult.has_booking_intent) {
      apptNumber = 'APT-' + Date.now().toString().slice(-6);
      const targetDate = aiResult.appointment_date || new Date().toISOString().split('T')[0];
      const targetTime = aiResult.appointment_time || '15:00';
      
      db.prepare(`INSERT INTO appointments (appointment_number, staff_id, phone, date, time, status, created_at) VALUES (?, '智能美业助理', ?, ?, ?, 'Confirmed', ?)`).run(
        apptNumber, phone, targetDate, targetTime, new Date().toISOString()
      );
      
      try {
        db.prepare(`INSERT OR IGNORE INTO leads (id, name, phone, source, center, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
          'LEAD-' + Date.now(), '助理预约客户', phone, `${platform || 'WhatsApp'} - 智能助理`, 'Dubai', new Date().toISOString()
        );
      } catch(e){}

      autoAppointmentCreated = true;
    }

    res.json({
      ok: true,
      customer_phone: phone,
      ai_reply: aiReply,
      auto_appointment_created: autoAppointmentCreated,
      appointment_number: apptNumber,
      extracted_date: aiResult.appointment_date,
      extracted_time: aiResult.appointment_time
    });

  } catch (error) {
    console.error("❌ Gemini AI 聊天异常:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/ai/chat-logs', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM chat_logs ORDER BY id DESC LIMIT 50').all();
    res.json(logs.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 前端网页界面（全响应式 + 手机适配 + 横向可滑动导航栏 + 助理打招呼编辑 + 双语）
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>AI Lead Master - 智能美业 CRM</title>
  <style>
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; margin: 0; padding: 12px; color: #f8fafc; }
    .container { max-width: 1400px; margin: 0 auto; background: #1e293b; padding: 18px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #334155; }
    
    .header-bar { border-bottom: 2px solid #334155; padding-bottom: 12px; margin-bottom: 16px; }
    .header-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
    h2 { color: #38bdf8; margin: 0; font-size: 20px; }

    /* 横向单行平滑滑动导航栏 */
    .nav-buttons-scroll {
      display: flex;
      gap: 10px;
      overflow-x: auto;
      white-space: nowrap;
      padding: 4px 2px 10px 2px;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .nav-buttons-scroll::-webkit-scrollbar { display: none; }
    
    .nav-btn {
      flex: 0 0 auto;
      background: #0f172a;
      color: #38bdf8;
      border: 1px solid #334155;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .nav-btn:hover, .nav-btn:active { background: #38bdf8; color: #0f172a; }

    .lang-btn { background: linear-gradient(135deg, #6366f1, #4f46e5); color: #fff; border: none; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: bold; cursor: pointer; }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 25px; }
    .stat-card { padding: 15px; border-radius: 12px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .stat-card.blue { background: linear-gradient(135deg, #3b82f6, #1d4ed8); }
    .stat-card.purple { background: linear-gradient(135deg, #a855f7, #6b21a8); }
    .stat-card.pink { background: linear-gradient(135deg, #ec4899, #be185d); }
    .stat-card.emerald { background: linear-gradient(135deg, #10b981, #047857); }
    .stat-card h4 { margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; }
    .stat-card .num { font-size: 24px; font-weight: bold; }

    .card { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 20px; }
    h3 { color: #f1f5f9; margin-top: 0; border-bottom: 2px solid #334155; padding-bottom: 8px; font-size: 16px; }

    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; align-items: end; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-weight: 600; font-size: 12px; color: #94a3b8; }
    .form-group input, .form-group select, .form-group textarea { padding: 10px 12px; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 8px; font-size: 14px; outline: none; width: 100%; }

    button { padding: 10px 14px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; transition: transform 0.1s; width: 100%; }
    button:active { transform: scale(0.97); }
    button.primary { background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; }
    button.secondary { background: linear-gradient(135deg, #64748b, #475569); color: #fff; }
    button.success { background: linear-gradient(135deg, #22c55e, #15803d); color: #fff; }
    button.danger { background: linear-gradient(135deg, #ef4444, #b91c1c); color: #fff; }
    button.whatsapp { background: linear-gradient(135deg, #25d366, #128c7e); color: #fff; }
    button.purple-btn { background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff; }

    .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; min-width: 600px; }
    th, td { border: 1px solid #334155; padding: 10px; text-align: left; }
    th { background-color: #1e293b; font-weight: 600; color: #38bdf8; text-transform: uppercase; font-size: 11px; }
    tr:nth-child(even) { background-color: rgba(30, 41, 59, 0.4); }

    #loginOverlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.95); display: flex; justify-content: center; align-items: center; z-index: 9999; padding: 15px; }
    .login-box { background: #1e293b; padding: 25px; border-radius: 16px; width: 100%; max-width: 360px; border: 1px solid #334155; box-shadow: 0 15px 35px rgba(0,0,0,0.6); }

    .badge { padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: bold; display: inline-block; }
    .badge.fb { background: #1d4ed8; color: #bfdbfe; }
    .badge.ig { background: #be185d; color: #fce7f3; }
    .badge.tk { background: #374151; color: #f3f4f6; border: 1px solid #6b7280; }

    .chat-box { height: 280px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
    .msg { padding: 8px 12px; border-radius: 8px; max-width: 85%; font-size: 13px; line-height: 1.4; word-break: break-word; }
    .msg.customer { background: #334155; color: #f8fafc; align-self: flex-start; }
    .msg.ai { background: #0284c7; color: #fff; align-self: flex-end; }

    .chat-input-group { display: flex; flex-direction: column; gap: 8px; }
    @media(min-width: 640px) {
      .chat-input-group { flex-direction: row; }
      body { padding: 20px; }
      h2 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <div id="loginOverlay">
    <div class="login-box">
      <h3 style="text-align:center; color:#38bdf8; margin-bottom:20px; font-size: 20px;" data-i18n="login_title">🔐 AI Lead Master 登录</h3>
      <form id="loginForm" style="display:flex; flex-direction:column; gap:14px;">
        <div class="form-group">
          <label data-i18n="username_label">用户名：</label>
          <input type="text" id="loginUser" data-i18n-ph="ph_user" placeholder="请输入用户名" required>
        </div>
        <div class="form-group">
          <label data-i18n="password_label">密码：</label>
          <input type="password" id="loginPass" data-i18n-ph="ph_pass" placeholder="请输入密码" required>
        </div>
        <button type="submit" class="primary" style="padding: 12px; margin-top: 8px;" data-i18n="login_btn">登 录 系 统</button>
        <div id="loginError" style="color:#f87171; font-size:12px; text-align:center;"></div>
      </form>
    </div>
  </div>

  <div class="container" id="mainApp" style="display:none;">
    <div class="header-bar" id="sec-dashboard">
      <div class="header-top">
        <h2>🚀 AI Lead Master CRM</h2>
        <div style="display: flex; align-items: center; gap: 10px;">
          <button class="lang-btn" onclick="toggleLanguage()">🌐 EN / 中文</button>
          <span id="currentUserDisplay" style="font-weight: bold; color: #38bdf8; background: #0f172a; padding: 4px 8px; border-radius: 6px; font-size:12px; border: 1px solid #334155;"></span>
          <button class="danger" onclick="logout()" style="width:auto; padding: 4px 10px; font-size:12px;" data-i18n="logout">退出</button>
        </div>
      </div>
      <!-- 手机端优化：横向单行滑块导航栏 -->
      <div class="nav-buttons-scroll">
        <button class="nav-btn" onclick="scrollToSec('sec-dashboard')" data-i18n="nav_dashboard">📊 仪表盘</button>
        <button class="nav-btn" onclick="scrollToSec('sec-ai-chat')" data-i18n="nav_ai">🤖 美业助理</button>
        <button class="nav-btn" onclick="scrollToSec('sec-ai-edit')" data-i18n="nav_edit_ai">✍️ 助理设置</button>
        <button class="nav-btn" onclick="scrollToSec('sec-user-mgmt')" data-i18n="nav_users">👑 账号管理</button>
        <button class="nav-btn" onclick="scrollToSec('sec-social-acc')" data-i18n="nav_social">👤 社媒配置</button>
        <button class="nav-btn" onclick="scrollToSec('sec-search-task')" data-i18n="nav_tasks">🌐 搜客任务</button>
        <button class="nav-btn" onclick="scrollToSec('sec-appointments')" data-i18n="nav_appts">📅 预约列表</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card blue">
        <h4 data-i18n="stat_total">📦 总线索量</h4>
        <div class="num" id="valTotalLeads">0</div>
      </div>
      <div class="stat-card purple">
        <h4>📘 Facebook</h4>
        <div class="num" id="valFbLeads">0</div>
      </div>
      <div class="stat-card pink">
        <h4>📸 Instagram</h4>
        <div class="num" id="valIgLeads">0</div>
      </div>
      <div class="stat-card emerald">
        <h4>🎵 TikTok</h4>
        <div class="num" id="valTkLeads">0</div>
      </div>
    </div>

    <!-- 助理对话工作台 -->
    <div class="card" id="sec-ai-chat" style="border: 1px solid #0ea5e9;">
      <h3 style="color: #38bdf8;" data-i18n="ai_title">🤖 智能美业助理与预约工作台</h3>
      <p style="font-size: 12px; color: #94a3b8; margin-bottom: 12px;" data-i18n="ai_desc">客户输入预约意向，助理将温柔解答并自动精准识别时间生成预约单！</p>
      
      <div class="chat-box" id="chatLogsContainer">
        <div class="msg ai" id="aiWelcomeBox">👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？</div>
      </div>

      <div class="chat-input-group">
        <input type="text" id="chatPhoneInput" data-i18n-ph="ph_phone" placeholder="客户手机号" value="+971 50 123 4567" style="padding: 10px; background: #1e293b; border: 1px solid #475569; color:#fff; border-radius:8px;">
        <input type="text" id="chatMsgInput" data-i18n-ph="ph_msg" placeholder="输入测试咨询 (如: 帮我预约明天下午3点)" style="padding: 10px; background: #1e293b; border: 1px solid #475569; color:#fff; border-radius:8px;" onkeypress="if(event.key==='Enter') sendAiMessage()">
        <button class="primary" onclick="sendAiMessage()" style="width: auto; white-space: nowrap;" data-i18n="btn_send_ai">发送给助理</button>
      </div>
    </div>

    <!-- 自定义编辑 AI 助理打招呼用词与 Prompt -->
    <div class="card" id="sec-ai-edit" style="border: 1px solid #a855f7;">
      <h3 style="color: #c084fc;" data-i18n="edit_ai_title">✍️ 自定义助理打招呼语与人设设置</h3>
      <form id="aiConfigForm" style="display:flex; flex-direction:column; gap:12px;">
        <div class="form-group">
          <label data-i18n="label_welcome">开场打招呼词 (Welcome Message)：</label>
          <input type="text" id="cfgWelcomeMsg" placeholder="例如: 您好！我是您的专属美业助理..." required>
        </div>
        <div class="form-group">
          <label data-i18n="label_prompt">助理人设与沟通风格 Prompt：</label>
          <textarea id="cfgSystemPrompt" rows="3" placeholder="定义助理的语气、称谓及对话规范..." required></textarea>
        </div>
        <button type="submit" class="purple-btn" style="width: auto; align-self: flex-start;" data-i18n="btn_save_config">💾 保存助理配置</button>
      </form>
    </div>

    <div class="card" id="sec-user-mgmt" style="display:none;">
      <h3 data-i18n="user_mgmt_title">👑 超级管理员权限：员工 / 子账号管理</h3>
      <form id="createUserForm" class="form-grid">
        <div class="form-group"><label data-i18n="username_label">用户名：</label><input type="text" id="newUsername" placeholder="staff_dubai01" required></div>
        <div class="form-group"><label data-i18n="password_label">密码：</label><input type="password" id="newPassword" placeholder="***" required></div>
        <div class="form-group"><label data-i18n="role_label">角色：</label><select id="newRole"><option value="staff" data-i18n="role_staff">员工 (Staff)</option><option value="admin" data-i18n="role_admin">管理员 (Admin)</option></select></div>
        <button type="submit" class="success" data-i18n="btn_create_user">➕ 开通子账号</button>
      </form>
      <h4 style="margin-top: 20px; color: #38bdf8;" data-i18n="user_list_title">系统账号列表</h4>
      <div class="table-responsive">
        <table><thead><tr><th>ID</th><th data-i18n="th_user">用户名</th><th data-i18n="th_role">角色</th><th data-i18n="th_time">开通时间</th><th data-i18n="th_action">操作</th></tr></thead><tbody id="usersTableList"></tbody></table>
      </div>
    </div>

    <div class="card" id="sec-social-acc">
      <h3 data-i18n="social_title">👤 1. 社媒平台账号隔离配置</h3>
      <form id="accountForm" class="form-grid">
        <div class="form-group"><label data-i18n="platform_label">社媒平台：</label><select id="accPlatform" required><option value="Facebook">📘 Facebook</option><option value="Instagram">📸 Instagram</option><option value="TikTok">🎵 TikTok</option></select></div>
        <div class="form-group"><label data-i18n="label_label">备注标签：</label><input type="text" id="accLabel" placeholder="Dubai Branch" required></div>
        <div class="form-group"><label>Profile ID：</label><input type="text" id="accProfileId" placeholder="prof_dubai_01" required></div>
        <button type="submit" class="primary" data-i18n="btn_bind_acc">🔗 绑定账号</button>
      </form>
      <h4 style="margin-top: 20px; color: #38bdf8;" data-i18n="acc_list_title">已授权账号列表</h4>
      <div class="table-responsive">
        <table><thead><tr><th>ID</th><th data-i18n="th_platform">平台</th><th data-i18n="th_label">备注</th><th>Profile</th><th data-i18n="th_time">绑定时间</th><th data-i18n="th_action">操作</th></tr></thead><tbody id="accountTableList"></tbody></table>
      </div>
    </div>

    <div class="card" id="sec-search-task">
      <h3 data-i18n="task_title">🌐 2. 全自动社媒定向搜客任务</h3>
      <form id="socialSearchForm" class="form-grid">
        <div class="form-group"><label data-i18n="acc_select">执行账号：</label><select id="ssAccount" required><option value="">Select Account</option></select></div>
        <div class="form-group"><label data-i18n="target_platform">目标平台：</label><input type="text" id="ssPlatform" readonly placeholder="Auto" style="background: #0f172a;"></div>
        <div class="form-group"><label data-i18n="country_label">国家：</label><input type="text" id="ssCountry" placeholder="UAE / Saudi"></div>
        <div class="form-group"><label data-i18n="city_label">城市：</label><input type="text" id="ssCity" placeholder="Dubai / Riyadh"></div>
        <div class="form-group"><label data-i18n="keyword_label">关键词：</label><input type="text" id="ssKeywords" placeholder="Salon & Spa" required></div>
        <div class="form-group"><label data-i18n="gender_label">性别筛选：</label><select id="ssGender"><option value="不限">All</option><option value="女性">Female</option></select></div>
        <div style="grid-column: 1 / -1; margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap;">
          <button type="submit" class="primary" style="flex: 2; min-width: 150px;" data-i18n="btn_create_task">💾 创建抓取任务</button>
          <button type="button" class="purple-btn" style="flex: 1; min-width: 150px;" onclick="triggerBatchScrape()" data-i18n="btn_batch_scrape">⚡ 一键自动获客</button>
        </div>
      </form>
      <h4 style="margin-top: 20px; color: #38bdf8;" data-i18n="task_list_title">获客任务调度</h4>
      <div class="table-responsive">
        <table><thead><tr><th data-i18n="th_platform">平台</th><th data-i18n="th_acc">账号</th><th data-i18n="th_country">国家</th><th data-i18n="th_city">城市</th><th data-i18n="th_keyword">关键词</th><th data-i18n="th_gender">性别</th><th data-i18n="th_status">状态</th><th data-i18n="th_action">操作</th></tr></thead><tbody id="socialSearchList"></tbody></table>
      </div>
    </div>

    <div class="card" id="sec-appointments">
      <h3 data-i18n="appt_title">📅 3. 智能预约排班与私域转化</h3>
      <form id="appointmentForm" class="form-grid">
        <div class="form-group"><label data-i18n="staff_label">接待技师：</label><input type="text" id="apptStaff" placeholder="Sarah (Dubai)" required></div>
        <div class="form-group"><label data-i18n="phone_label">客户手机号：</label><input type="text" id="apptPhone" placeholder="+971 50 123 4567" required></div>
        <div class="form-group"><label data-i18n="date_label">预约日期：</label><input type="date" id="apptDate" required></div>
        <div class="form-group"><label data-i18n="time_label">时间段：</label><input type="time" id="apptTime" required></div>
        <button type="submit" class="success" data-i18n="btn_create_appt">✅ 生成预约单</button>
      </form>
      <h4 style="margin-top: 20px; color: #38bdf8;" data-i18n="appt_list_title">预约与私域转化列表</h4>
      <div class="table-responsive">
        <table><thead><tr><th data-i18n="th_appt_no">单号</th><th data-i18n="th_staff">技师</th><th data-i18n="th_phone">客户手机号</th><th data-i18n="th_appt_time">时间</th><th data-i18n="th_status">状态</th><th data-i18n="th_action">操作</th></tr></thead><tbody id="appointmentList"></tbody></table>
      </div>
    </div>
  </div>

  <script>
    const i18n = {
      zh: {
        login_title: "🔐 AI Lead Master 登录",
        username_label: "用户名：",
        password_label: "密码：",
        ph_user: "请输入用户名",
        ph_pass: "请输入密码",
        login_btn: "登 录 系 统",
        logout: "退出",
        nav_dashboard: "📊 仪表盘",
        nav_ai: "🤖 美业助理",
        nav_edit_ai: "✍️ 助理设置",
        nav_users: "👑 账号管理",
        nav_social: "👤 社媒配置",
        nav_tasks: "🌐 搜客任务",
        nav_appts: "📅 预约列表",
        stat_total: "📦 总线索量",
        ai_title: "🤖 智能美业助理与预约工作台",
        ai_desc: "客户输入预约意向，助理将温柔解答并自动精准识别时间生成预约单！",
        ph_phone: "客户手机号",
        ph_msg: "输入测试咨询 (如: 帮我预约明天下午3点)",
        btn_send_ai: "发送给助理",
        edit_ai_title: "✍️ 自定义助理打招呼语与人设设置",
        label_welcome: "开场打招呼词 (Welcome Message)：",
        label_prompt: "助理人设与沟通风格 Prompt：",
        btn_save_config: "💾 保存助理配置",
        user_mgmt_title: "👑 超级管理员权限：员工 / 子账号管理",
        role_label: "角色：",
        role_staff: "员工 (Staff)",
        role_admin: "管理员 (Admin)",
        btn_create_user: "➕ 开通子账号",
        user_list_title: "系统账号列表",
        th_user: "用户名",
        th_role: "角色",
        th_time: "时间",
        th_action: "操作",
        social_title: "👤 1. 社媒平台账号隔离配置",
        platform_label: "社媒平台：",
        label_label: "备注标签：",
        btn_bind_acc: "🔗 绑定账号",
        acc_list_title: "已授权账号列表",
        th_platform: "平台",
        th_label: "备注",
        task_title: "🌐 2. 全自动社媒定向搜客任务",
        acc_select: "执行账号：",
        target_platform: "目标平台：",
        country_label: "国家：",
        city_label: "城市：",
        keyword_label: "关键词：",
        gender_label: "性别筛选：",
        btn_create_task: "💾 创建抓取任务",
        btn_batch_scrape: "⚡ 一键自动获客",
        task_list_title: "获客任务调度",
        th_acc: "账号",
        th_country: "国家",
        th_city: "城市",
        th_keyword: "关键词",
        th_gender: "性别",
        th_status: "状态",
        appt_title: "📅 3. 智能预约排班与私域转化",
        staff_label: "接待技师：",
        phone_label: "客户手机号：",
        date_label: "预约日期：",
        time_label: "时间段：",
        btn_create_appt: "✅ 生成预约单",
        appt_list_title: "预约与私域转化列表",
        th_appt_no: "单号",
        th_staff: "技师",
        th_phone: "客户手机号",
        th_appt_time: "时间",
      },
      en: {
        login_title: "🔐 AI Lead Master Login",
        username_label: "Username:",
        password_label: "Password:",
        ph_user: "Enter username",
        ph_pass: "Enter password",
        login_btn: "LOGIN SYSTEM",
        logout: "Logout",
        nav_dashboard: "📊 Dashboard",
        nav_ai: "🤖 Senior Assistant",
        nav_edit_ai: "✍️ Assistant Config",
        nav_users: "👑 Sub-Accounts",
        nav_social: "👤 Social Config",
        nav_tasks: "🌐 Lead Tasks",
        nav_appts: "📅 Appointments",
        stat_total: "📦 Total Leads",
        ai_title: "🤖 Beauty Assistant & Auto-Booking Workspace",
        ai_desc: "Customers message with booking intent, Senior Assistant replies warmly and creates appointments!",
        ph_phone: "Customer Phone Number",
        ph_msg: "Type test message (e.g. I want to book tomorrow at 3pm)",
        btn_send_ai: "Send to Assistant",
        edit_ai_title: "✍️ Customize Assistant Greeting & Persona",
        label_welcome: "Welcome Greeting Message:",
        label_prompt: "Assistant Persona & Rules Prompt:",
        btn_save_config: "💾 Save Config",
        user_mgmt_title: "👑 Super Admin: Staff / Sub-Account Management",
        role_label: "Role:",
        role_staff: "Staff",
        role_admin: "Admin",
        btn_create_user: "➕ Create Account",
        user_list_title: "System Accounts List",
        th_user: "Username",
        th_role: "Role",
        th_time: "Created Time",
        th_action: "Action",
        social_title: "👤 1. Social Media Accounts Isolation",
        platform_label: "Platform:",
        label_label: "Label:",
        btn_bind_acc: "🔗 Bind Account",
        acc_list_title: "Authorized Accounts",
        th_platform: "Platform",
        th_label: "Label",
        task_title: "🌐 2. Automated Social Lead Scraper Tasks",
        acc_select: "Account:",
        target_platform: "Platform:",
        country_label: "Country:",
        city_label: "City:",
        keyword_label: "Keywords:",
        gender_label: "Gender:",
        btn_create_task: "💾 Save Task",
        btn_batch_scrape: "⚡ Auto Lead Scrape",
        task_list_title: "Lead Scraper Schedule",
        th_acc: "Account",
        th_country: "Country",
        th_city: "City",
        th_keyword: "Keywords",
        th_gender: "Gender",
        th_status: "Status",
        appt_title: "📅 3. Smart Appointment & Conversion",
        staff_label: "Staff / Specialist:",
        phone_label: "Customer Phone:",
        date_label: "Date:",
        time_label: "Time Slot:",
        btn_create_appt: "✅ Create Booking",
        appt_list_title: "Appointments & Conversion List",
        th_appt_no: "Appt No",
        th_staff: "Specialist",
        th_phone: "Customer Phone",
        th_appt_time: "Time",
      }
    };

    let currentLang = localStorage.getItem("crm_lang") || "zh";

    function toggleLanguage() {
      currentLang = currentLang === "zh" ? "en" : "zh";
      localStorage.setItem("crm_lang", currentLang);
      applyLanguage();
    }

    function applyLanguage() {
      const dict = i18n[currentLang];
      document.querySelectorAll("[data-i18n]").forEach(el => {
        const key = el.getAttribute("data-i18n");
        if (dict[key]) el.textContent = dict[key];
      });
      document.querySelectorAll("[data-i18n-ph]").forEach(el => {
        const key = el.getAttribute("data-i18n-ph");
        if (dict[key]) el.placeholder = dict[key];
      });
    }

    function scrollToSec(id) {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }

    async function api(url, options = {}) {
      const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }

    document.getElementById("loginForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      const username = document.getElementById("loginUser").value.trim();
      const password = document.getElementById("loginPass").value.trim();
      const errEl = document.getElementById("loginError");
      errEl.textContent = "";
      try {
        const res = await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
        localStorage.setItem("ai_lead_user", res.username);
        localStorage.setItem("ai_lead_role", res.role);
        document.getElementById("loginOverlay").style.display = "none";
        document.getElementById("mainApp").style.display = "block";
        document.getElementById("currentUserDisplay").textContent = \`👤 \${res.username} (\${res.role === 'admin' ? 'Super Admin' : 'Staff'})\`;
        loadAllData();
      } catch (err) { errEl.textContent = err.message; }
    });

    function logout() {
      localStorage.removeItem("ai_lead_user");
      localStorage.removeItem("ai_lead_role");
      location.reload();
    }

    window.addEventListener("DOMContentLoaded", () => {
      applyLanguage();
      const savedUser = localStorage.getItem("ai_lead_user");
      const savedRole = localStorage.getItem("ai_lead_role");
      if (savedUser) {
        document.getElementById("loginOverlay").style.display = "none";
        document.getElementById("mainApp").style.display = "block";
        document.getElementById("currentUserDisplay").textContent = \`👤 \${savedUser} (\${savedRole === 'admin' ? 'Super Admin' : 'Staff'})\`;
        loadAllData();
      }
    });

    async function loadAllData() {
      const role = localStorage.getItem("ai_lead_role");
      if (role === 'admin') {
        document.getElementById("sec-user-mgmt").style.display = "block";
        await loadUsersList();
      } else {
        document.getElementById("sec-user-mgmt").style.display = "none";
      }
      await loadAiConfig();
      await loadStats();
      await loadAccounts();
      await loadAppointments();
      await loadSearchTasks();
      await loadChatLogs();
      applyLanguage();
    }

    async function loadAiConfig() {
      try {
        const cfg = await api("/api/ai/config");
        document.getElementById("cfgWelcomeMsg").value = cfg.welcome_msg || "";
        document.getElementById("cfgSystemPrompt").value = cfg.system_prompt || "";
        document.getElementById("aiWelcomeBox").textContent = cfg.welcome_msg || "👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？";
      } catch (e) { console.error(e); }
    }

    document.getElementById("aiConfigForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/ai/config", {
          method: "POST",
          body: JSON.stringify({
            welcome_msg: document.getElementById("cfgWelcomeMsg").value.trim(),
            system_prompt: document.getElementById("cfgSystemPrompt").value.trim()
          })
        });
        alert(currentLang === 'en' ? "Assistant Config Saved!" : "助理打招呼语及人设配置保存成功！");
        await loadAiConfig();
      } catch (err) { alert(err.message); }
    });

    async function sendAiMessage() {
      const phoneInput = document.getElementById("chatPhoneInput");
      const msgInput = document.getElementById("chatMsgInput");
      const container = document.getElementById("chatLogsContainer");
      const phone = phoneInput.value.trim();
      const message = msgInput.value.trim();
      if (!message) return;

      const userDiv = document.createElement("div");
      userDiv.className = "msg customer";
      userDiv.textContent = \`[\${phone}] \${message}\`;
      container.appendChild(userDiv);
      msgInput.value = "";
      container.scrollTop = container.scrollHeight;

      try {
        const res = await api("/api/ai/chat-reply", {
          method: "POST",
          body: JSON.stringify({ customer_phone: phone, customer_message: message, platform: "WhatsApp" })
        });

        const aiDiv = document.createElement("div");
        aiDiv.className = "msg ai";
        aiDiv.textContent = res.ai_reply;
        container.appendChild(aiDiv);
        container.scrollTop = container.scrollHeight;

        if (res.auto_appointment_created) {
          const msgText = currentLang === 'en' ? \`🔥 Assistant captured booking! Created [\${res.appointment_number}] for \${res.extracted_date || 'Today'} \${res.extracted_time || '15:00'}\` : \`🔥 助理成功为您生成预约单！单号 [\${res.appointment_number}]（时间: \${res.extracted_date || '今日'} \${res.extracted_time || '15:00'}）\`;
          alert(msgText);
          await loadAppointments();
          await loadStats();
        }
      } catch (err) {
        alert("助理响应失败: " + err.message);
      }
    }

    async function loadChatLogs() {
      const container = document.getElementById("chatLogsContainer");
      try {
        const logs = await api("/api/ai/chat-logs");
        if (logs.length > 0) {
          container.innerHTML = "";
          logs.forEach(l => {
            const div = document.createElement("div");
            div.className = l.sender === 'ai' ? 'msg ai' : 'msg customer';
            div.textContent = \`[\${l.customer_phone}] \${l.message}\`;
            container.appendChild(div);
          });
          container.scrollTop = container.scrollHeight;
        }
      } catch (e) { console.error(e); }
    }

    async function loadUsersList() {
      const tbody = document.getElementById("usersTableList");
      if (!tbody) return;
      try {
        const users = await api("/api/admin/users");
        tbody.innerHTML = "";
        users.forEach(u => {
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td>\${u.id}</td><td><b>\${u.username}</b></td><td><span style="color: \${u.role === 'admin' ? '#38bdf8' : '#a855f7'}; font-weight:bold;">\${u.role === 'admin' ? '👑 Admin' : '👤 Staff'}</span></td><td>\${u.created_at ? u.created_at.replace('T', ' ').slice(0, 16) : 'N/A'}</td><td>\${u.role !== 'admin' ? \`<button class="danger" style="padding: 4px 8px; font-size:12px;" onclick="deleteUser(\${u.id})">Delete</button>\` : '<span style="color:#64748b;">Main</span>'}</td>\`;
          tbody.appendChild(tr);
        });
      } catch (e) { console.error(e); }
    }

    document.getElementById("createUserForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username: document.getElementById("newUsername").value.trim(), password: document.getElementById("newPassword").value.trim(), role: document.getElementById("newRole").value }) });
        alert(currentLang === 'en' ? "Account created successfully!" : "开通成功！");
        this.reset();
        await loadUsersList();
      } catch (err) { alert(err.message); }
    });

    async function deleteUser(id) {
      if (!confirm("Confirm to delete?")) return;
      try { await api(\`/api/admin/users/\${id}\`, { method: "DELETE" }); await loadUsersList(); } catch (err) { alert(err.message); }
    }

    async function loadStats() {
      try {
        const s = await api("/api/dashboard/stats");
        document.getElementById("valTotalLeads").textContent = s.total;
        document.getElementById("valFbLeads").textContent = s.fb;
        document.getElementById("valIgLeads").textContent = s.ig;
        document.getElementById("valTkLeads").textContent = s.tk;
      } catch (e) { console.error(e); }
    }

    async function loadAccounts() {
      const tbody = document.getElementById("accountTableList");
      const sel = document.getElementById("ssAccount");
      if (!tbody || !sel) return;
      try {
        const accs = await api("/api/social-accounts");
        sel.innerHTML = \`<option value="">\${currentLang === 'en' ? 'Select Account' : '选择授权账号'}</option>\`;
        accs.forEach(a => {
          const opt = document.createElement("option");
          opt.value = a.id;
          opt.dataset.platform = a.platform;
          opt.textContent = \`\${a.platform} - \${a.label}\`;
          sel.appendChild(opt);
        });
        tbody.innerHTML = "";
        if (!accs.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">No Accounts</td></tr>'; return; }
        accs.forEach(a => {
          const badgeClass = a.platform === 'Facebook' ? 'fb' : (a.platform === 'Instagram' ? 'ig' : 'tk');
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td>\${a.id}</td><td><span class="badge \${badgeClass}">\${a.platform}</span></td><td><b>\${a.label}</b></td><td><code>\${a.profile_id}</code></td><td>\${a.created_at ? a.created_at.replace('T', ' ').slice(0, 16) : 'N/A'}</td><td><button class="danger" style="padding: 4px 8px; font-size:12px;" onclick="deleteAccount(\${a.id})">Unbind</button></td>\`;
          tbody.appendChild(tr);
        });
      } catch (e) { console.error(e); }
    }

    document.getElementById("accountForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/social-accounts", { method: "POST", body: JSON.stringify({ platform: document.getElementById("accPlatform").value, label: document.getElementById("accLabel").value.trim(), profile_id: document.getElementById("accProfileId").value.trim() }) });
        alert(currentLang === 'en' ? "Bound successfully!" : "绑定成功！");
        this.reset();
        await loadAccounts();
      } catch (err) { alert(err.message); }
    });

    async function deleteAccount(id) {
      if (!confirm("Confirm to unbind?")) return;
      try { await api(\`/api/social-accounts/\${id}\`, { method: "DELETE" }); await loadAccounts(); } catch (err) { alert(err.message); }
    }

    document.getElementById("ssAccount")?.addEventListener("change", function() {
      const opt = this.selectedOptions[0];
      if (opt && opt.dataset.platform) document.getElementById("ssPlatform").value = opt.dataset.platform;
    });

    async function loadSearchTasks() {
      const tbody = document.getElementById("socialSearchList");
      if (!tbody) return;
      try {
        const tasks = await api("/api/social-search");
        tbody.innerHTML = "";
        if (!tasks.length) { tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#64748b;">No Tasks</td></tr>'; return; }
        tasks.forEach(t => {
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td><b>\${t.platform}</b></td><td>ID: \${t.account_id}</td><td>\${t.country || 'Global'}</td><td>\${t.city || 'Any'}</td><td><code>\${t.keywords}</code></td><td>\${t.gender}</td><td><span style="color: \${t.enabled ? '#22c55e' : '#f87171'}; font-weight: bold;">\${t.enabled ? '● Active' : '○ Disabled'}</span></td><td style="display: flex; gap: 4px;"><button class="primary" style="padding: 4px 8px; font-size:12px;" onclick="runTask(\${t.id})">Run</button><button class="secondary" style="padding: 4px 8px; font-size:12px;" onclick="toggleTask(\${t.id}, \${t.enabled})">\${t.enabled ? 'Disable' : 'Enable'}</button><button class="danger" style="padding: 4px 8px; font-size:12px;" onclick="deleteTask(\${t.id})">Delete</button></td>\`;
          tbody.appendChild(tr);
        });
      } catch (e) { console.error(e); }
    }

    document.getElementById("socialSearchForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/social-search", { method: "POST", body: JSON.stringify({ account_id: Number(document.getElementById("ssAccount").value), platform: document.getElementById("ssPlatform").value, country: document.getElementById("ssCountry").value.trim(), city: document.getElementById("ssCity").value.trim(), keywords: document.getElementById("ssKeywords").value.trim(), gender: document.getElementById("ssGender").value }) });
        alert(currentLang === 'en' ? "Task created!" : "任务创建成功！");
        this.reset();
        await loadSearchTasks();
      } catch (err) { alert(err.message); }
    });

    async function runTask(id) {
      try { const res = await api(\`/api/social-search/\${id}/run\`, { method: "POST" }); alert(\`Search Target Launched:\n\${res.url}\`); } catch (err) { alert(err.message); }
    }

    async function triggerBatchScrape() { alert("⚡ Auto Lead Scrape Command Triggered!"); loadStats(); }
    async function toggleTask(id, current) {
      try { await api(\`/api/social-search/\${id}\`, { method: "PATCH", body: JSON.stringify({ enabled: !current }) }); await loadSearchTasks(); } catch (err) { alert(err.message); }
    }
    async function deleteTask(id) {
      if (!confirm("Confirm to delete?")) return;
      try { await api(\`/api/social-search/\${id}\`, { method: "DELETE" }); await loadSearchTasks(); } catch (err) { alert(err.message); }
    }

    async function loadAppointments() {
      const tbody = document.getElementById("appointmentList");
      if (!tbody) return;
      try {
        const appts = await api("/api/appointments");
        tbody.innerHTML = "";
        if (!appts.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">No Appointments</td></tr>'; return; }
        appts.forEach(ap => {
          const tr = document.createElement("tr");
          const cleanPhone = ap.phone.replace(/[^0-9]/g, "");
          tr.innerHTML = \`<td><b style="color:#38bdf8;">\${ap.appointment_number}</b></td><td>\${ap.staff_id}</td><td>\${ap.phone}</td><td>\${ap.date} \${ap.time}</td><td><span style="color: #22c55e; font-weight: bold;">\${ap.status}</span></td><td style="display: flex; gap: 4px;"><a href="https://wa.me/\${cleanPhone}" target="_blank"><button class="whatsapp" style="padding: 4px 8px; font-size:12px;">💬 WA</button></a><button class="danger" style="padding: 4px 8px; font-size:12px;" onclick="deleteAppt('\${ap.appointment_number}')">Cancel</button></td>\`;
          tbody.appendChild(tr);
        });
      } catch (e) { console.error(e); }
    }

    document.getElementById("appointmentForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/appointments", { method: "POST", body: JSON.stringify({ staff_id: document.getElementById("apptStaff").value.trim(), phone: document.getElementById("apptPhone").value.trim(), date: document.getElementById("apptDate").value, time: document.getElementById("apptTime").value }) });
        alert(currentLang === 'en' ? "Appointment created!" : "预约成功！");
        this.reset();
        await loadAppointments();
        await loadStats();
      } catch (err) { alert(err.message); }
    });

    async function deleteAppt(no) {
      if (!confirm("Confirm to cancel?")) return;
      try { await api(\`/api/appointments/\${no}\`, { method: "DELETE" }); await loadAppointments(); await loadStats(); } catch (err) { alert(err.message); }
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
