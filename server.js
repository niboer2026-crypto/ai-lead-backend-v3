const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

// 初始化数据库
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
`);

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

// API 路由
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  res.json({ ok: true, username: user.username, role: user.role });
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
const validPlatforms = ["Facebook", "Instagram", "TikTok"];

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
      Instagram: `https://www.instagram.com/explore/search/keyword/?q=${encoded}`, TikTok: `https://www.tiktok.com/search?q=${encoded}`
    };
    res.json({ ok: true, platform: config.platform, account: config.label, url: searchUrls[config.platform] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 根目录直接响应完整的炫彩前端
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Master - 智能跨境 CRM 控制台</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; margin: 0; padding: 20px; color: #f8fafc; }
    .container { max-width: 1400px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #334155; }
    .header-bar { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #334155; padding-bottom: 15px; margin-bottom: 25px; }
    h2 { color: #38bdf8; margin: 0; font-size: 24px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { padding: 20px; border-radius: 12px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .stat-card.blue { background: linear-gradient(135deg, #3b82f6, #1d4ed8); }
    .stat-card.purple { background: linear-gradient(135deg, #a855f7, #6b21a8); }
    .stat-card.pink { background: linear-gradient(135deg, #ec4899, #be185d); }
    .stat-card.emerald { background: linear-gradient(135deg, #10b981, #047857); }
    .stat-card h4 { margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; }
    .stat-card .num { font-size: 32px; font-weight: bold; }
    .card { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin-bottom: 25px; }
    h3 { color: #f1f5f9; margin-top: 0; border-bottom: 2px solid #334155; padding-bottom: 10px; font-size: 18px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px; align-items: end; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-weight: 600; font-size: 13px; color: #94a3b8; }
    .form-group input, .form-group select { padding: 10px 14px; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 8px; font-size: 14px; outline: none; }
    button { padding: 10px 18px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; transition: transform 0.1s; }
    button:active { transform: scale(0.97); }
    button.primary { background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; }
    button.secondary { background: linear-gradient(135deg, #64748b, #475569); color: #fff; }
    button.success { background: linear-gradient(135deg, #22c55e, #15803d); color: #fff; }
    button.danger { background: linear-gradient(135deg, #ef4444, #b91c1c); color: #fff; }
    button.whatsapp { background: linear-gradient(135deg, #25d366, #128c7e); color: #fff; }
    button.purple-btn { background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
    th, td { border: 1px solid #334155; padding: 14px; text-align: left; }
    th { background-color: #1e293b; font-weight: 600; color: #38bdf8; text-transform: uppercase; font-size: 12px; }
    tr:nth-child(even) { background-color: rgba(30, 41, 59, 0.4); }
    #loginOverlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.95); display: flex; justify-content: center; align-items: center; z-index: 9999; backdrop-filter: blur(8px); }
    .login-box { background: #1e293b; padding: 40px; border-radius: 16px; width: 380px; border: 1px solid #334155; box-shadow: 0 15px 35px rgba(0,0,0,0.6); }
    .badge { padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; display: inline-block; }
    .badge.fb { background: #1d4ed8; color: #bfdbfe; }
    .badge.ig { background: #be185d; color: #fce7f3; }
    .badge.tk { background: #374151; color: #f3f4f6; border: 1px solid #6b7280; }
  </style>
</head>
<body>
  <div id="loginOverlay">
    <div class="login-box">
      <h3 style="text-align:center; color:#38bdf8; margin-bottom:25px; font-size: 22px;">🔐 AI Lead Master 登录</h3>
      <form id="loginForm" style="display:flex; flex-direction:column; gap:18px;">
        <div class="form-group">
          <label>用户名 (Username)：</label>
          <input type="text" id="loginUser" placeholder="请输入用户名" required>
        </div>
        <div class="form-group">
          <label>密码 (Password)：</label>
          <input type="password" id="loginPass" placeholder="请输入密码" required>
        </div>
        <button type="submit" class="primary" style="padding: 14px; margin-top: 10px; font
