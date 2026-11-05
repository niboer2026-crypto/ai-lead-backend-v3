const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

// 确保 public 目录存在
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

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

// 强制重置/同步超管账号：dubai / lcaizxy13
const superAdminUser = 'dubai';
const superAdminPass = 'lcaizxy13';
const existingAdmin = db.prepare('SELECT * FROM users WHERE username = ?').get(superAdminUser);

if (!existingAdmin) {
  db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(superAdminUser, superAdminPass, 'admin');
} else {
  db.prepare('UPDATE users SET password = ?, role = ? WHERE username = ?').run(superAdminPass, 'admin', superAdminUser);
}

app.use(express.json());
app.use(express.static(publicDir));

// API 路由：登录
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  res.json({ ok: true, username: user.username, role: user.role });
});

// 子账号管理
app.get('/api/admin/users', (req, res) => {
  try {
    res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id DESC').all());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users', (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: '该用户名已存在' });
    db.prepare('INSERT INTO users (username, password, role) VALUES (?, ?, ?)').run(username, password, role || 'staff');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 统计漏斗
app.get('/api/dashboard/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
    const fb = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Facebook%'").get().cnt;
    const ig = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Instagram%'").get().cnt;
    const tk = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%TikTok%'").get().cnt;
    res.json({ ok: true, total, fb, ig, tk });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 社媒账号
app.get('/api/social-accounts', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM social_accounts ORDER BY id DESC').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/social-accounts', (req, res) => {
  try {
    const { platform, label, profile_id } = req.body || {};
    if (!platform || !label || !profile_id) return res.status(400).json({ error: '字段不能为空' });
    db.prepare('INSERT INTO social_accounts (platform, label, profile_id) VALUES (?, ?, ?)').run(platform, label, profile_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/social-accounts/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM social_accounts WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 预约管理
app.get('/api/appointments', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM appointments ORDER BY created_at DESC').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/appointments', (req, res) => {
  try {
    const b = req.body || {};
    const apptNo = 'APT-' + Date.now().toString().slice(-6);
    db.prepare(`
      INSERT INTO appointments (appointment_number, staff_id, phone, date, time, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'Confirmed', ?)
    `).run(apptNo, b.staff_id || 'Staff', b.phone, b.date, b.time, new Date().toISOString());
    res.json({ ok: true, appointment_number: apptNo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/appointments/:no', (req, res) => {
  try {
    db.prepare('DELETE FROM appointments WHERE appointment_number = ?').run(req.params.no);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 社媒搜索任务
const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const validPlatforms = ["Facebook", "Instagram", "TikTok"];

app.get('/api/social-search', (req, res) => {
  try { res.json(db.prepare(`SELECT * FROM social_search_configs ORDER BY id DESC`).all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/social-search', (req, res) => {
  const b = req.body || {};
  const accountId = Number(b.account_id);
  const platform = clean(b.platform, 30);
  const country = clean(b.country, 100);
  const city = clean(b.city, 100);
  const keywords = clean(b.keywords, 1000);
  const gender = clean(b.gender || "不限", 20);

  if (!accountId || !validPlatforms.includes(platform) || !keywords) {
    return res.status(400).json({ error: "校验失败" });
  }

  try {
    db.prepare(`
      INSERT INTO social_search_configs (account_id, platform, country, city, keywords, gender)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(accountId, platform, country, city, keywords, gender);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/social-search/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM social_search_configs WHERE id = ?`).run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/social-search/:id', (req, res) => {
  try {
    const enabled = req.body.enabled ? 1 : 0;
    db.prepare(`UPDATE social_search_configs SET enabled = ? WHERE id = ?`).run(enabled, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/social-search/:id/run', async (req, res) => {
  try {
    const config = db.prepare(`
      SELECT s.*, a.profile_id, a.label
      FROM social_search_configs s
      JOIN social_accounts a ON s.account_id = a.id
      WHERE s.id = ?
    `).get(Number(req.params.id));

    if (!config) return res.status(404).json({ error: "任务不存在" });
    if (!config.enabled) return res.status(400).json({ error: "任务已停用" });

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

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
