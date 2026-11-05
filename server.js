const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== 1. 自愈式前端与目录保护 ====================
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const indexPath = path.join(publicDir, 'index.html');
const defaultHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Master - 中东跨境智能 CRM 与获客控制台</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; margin: 0; padding: 20px; color: #333; }
    .container { max-width: 1300px; margin: 0 auto; background: #fff; padding: 25px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
    .header-bar { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #e8eaed; padding-bottom: 12px; margin-bottom: 20px; }
    h2 { color: #1a73e8; margin: 0; }
    .lang-switcher select { padding: 6px 12px; border-radius: 6px; border: 1px solid #cbd5e0; font-weight: bold; background: #fff; cursor: pointer; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin-bottom: 24px; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; text-align: center; }
    .stat-card h4 { margin: 0 0 8px 0; color: #4a5568; font-size: 14px; }
    .stat-card .num { font-size: 24px; font-weight: bold; color: #2b6cb0; }
    .card { background: #fafbfc; border: 1px solid #e1e4e8; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    h3 { color: #2d3748; margin-top: 0; border-bottom: 1px solid #edf2f7; padding-bottom: 8px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; align-items: end; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-weight: 600; font-size: 13px; color: #4a5568; }
    .form-group input, .form-group select { padding: 9px 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; outline: none; }
    button { padding: 9px 16px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px; transition: background 0.2s; }
    button.primary { background: #3182ce; color: #fff; }
    button.primary:hover { background: #2b6cb0; }
    button.secondary { background: #718096; color: #fff; }
    button.danger { background: #e53e3e; color: #fff; }
    button.whatsapp { background: #25d366; color: #fff; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
    th, td { border: 1px solid #e2e8f0; padding: 12px; text-align: left; }
    th { background-color: #edf2f7; font-weight: 600; color: #2d3748; }
    tr:nth-child(even) { background-color: #f8fafc; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header-bar">
      <h2 id="uiTitle">🚀 AI Lead Master - 跨境智能 CRM 控制台</h2>
      <div class="lang-switcher">
        <label id="lblLang" style="font-size: 13px; margin-right: 5px;">语言 / Language:</label>
        <select id="langSelect" onchange="changeLanguage(this.value)">
          <option value="zh">中文</option>
          <option value="en">English</option>
          <option value="ar">العربية</option>
        </select>
      </div>
    </div>

    <!-- 数据漏斗与统计看板 -->
    <div class="stats-grid">
      <div class="stat-card">
        <h4 id="statTotalLeads">总线索量 (Total Leads)</h4>
        <div class="num" id="valTotalLeads">0</div>
      </div>
      <div class="stat-card">
        <h4>Facebook Leads</h4>
        <div class="num" id="valFbLeads">0</div>
      </div>
      <div class="stat-card">
        <h4>Instagram Leads</h4>
        <div class="num" id="valIgLeads">0</div>
      </div>
      <div class="stat-card">
        <h4>TikTok Leads</h4>
        <div class="num" id="valTkLeads">0</div>
      </div>
    </div>

    <!-- 1. 智能预约管理模块 -->
    <div class="card">
      <h3 id="secApptTitle">📅 智能预约与排班管理系统</h3>
      <form id="appointmentForm" class="form-grid">
        <div class="form-group">
          <label id="lblStaff">分配员工 / 技师：</label>
          <input type="text" id="apptStaff" placeholder="例如: Sarah (Dubai Branch)" required>
        </div>
        <div class="form-group">
          <label id="lblClientPhone">客户手机号：</label>
          <input type="text" id="apptPhone" placeholder="+971 50 123 4567" required>
        </div>
        <div class="form-group">
          <label id="lblDate">预约日期：</label>
          <input type="date" id="apptDate" required>
        </div>
        <div class="form-group">
          <label id="lblTime">预约时间段：</label>
          <input type="time" id="apptTime" required>
        </div>
        <button type="submit" class="primary" id="btnCreateAppt">确认创建预约</button>
      </form>
      <h4 style="margin-top: 25px;" id="subApptList">当前预约排班列表</h4>
      <table>
        <thead>
          <tr>
            <th id="thApptNo">预约单号</th>
            <th id="thStaff">技师/员工</th>
            <th id="thPhone">客户手机号</th>
            <th id="thDateTime">预约时间</th>
            <th id="thStatus">状态</th>
            <th id="thAction">操作</th>
          </tr>
        </thead>
        <tbody id="appointmentList"></tbody>
      </table>
    </div>

    <!-- 2. 账号绑定与社媒定向搜索模块 -->
    <div class="card">
      <h3 id="secSearchTitle">🌐 多平台社媒定向搜索与获客任务</h3>
      <form id="socialSearchForm" class="form-grid">
        <div class="form-group">
          <label id="lblAcc">选择平台账号：</label>
          <select id="ssAccount" required><option value="">请选择账号</option></select>
        </div>
        <div class="form-group">
          <label id="lblPlatform">目标平台：</label>
          <input type="text" id="ssPlatform" readonly placeholder="自动匹配" style="background: #edf2f7;">
        </div>
        <div class="form-group">
          <label id="lblCountry">目标国家 (Country)：</label>
          <input type="text" id="ssCountry" placeholder="UAE / Saudi">
        </div>
        <div class="form-group">
          <label id="lblCity">目标城市 (City)：</label>
          <input type="text" id="ssCity" placeholder="Dubai / Riyadh">
        </div>
        <div class="form-group">
          <label id="lblKeywords">搜索关键词：</label>
          <input type="text" id="ssKeywords" placeholder="Salon & Spa" required>
        </div>
        <div class="form-group">
          <label id="lblGender">性别筛选：</label>
          <select id="ssGender">
            <option value="不限">不限 / All</option>
            <option value="男性">男性 / Male</option>
            <option value="女性">女性 / Female</option>
          </select>
        </div>
        <div style="grid-column: 1 / -1; margin-top: 10px;">
          <button type="submit" class="primary" style="width: 100%; padding: 12px;" id="btnSaveSearch">保存并创建定向搜索任务</button>
        </div>
      </form>
      <h4 style="margin-top: 30px;" id="subSearchList">当前社媒定向搜索任务列表</h4>
      <table>
        <thead>
          <tr>
            <th>Platform</th>
            <th>Account ID</th>
            <th>Country</th>
            <th>City</th>
            <th>Keywords</th>
            <th>Gender</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="socialSearchList"></tbody>
      </table>
    </div>
  </div>

  <script src="/social-search.js"></script>
</body>
</html>`;

if (!fs.existsSync(indexPath)) {
  fs.writeFileSync(indexPath, defaultHtml, 'utf8');
}

// ==================== 2. SQLite 数据库与表初始化 ====================
const db = new Database('data.db');

db.exec(`
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

const runningAccounts = new Map();

app.use(express.json());
app.use(express.static(publicDir));

// ==================== 3. API 接口逻辑 ====================

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true }));

// 获取统计漏斗数据
app.get('/api/dashboard/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
    const fb = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Facebook%'").get().cnt;
    const ig = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Instagram%'").get().cnt;
    const tk = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%TikTok%'").get().cnt;
    res.json({ ok: true, total, fb, ig, tk });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 社交账号列表
app.get('/api/social-accounts', (req, res) => {
  try {
    const accounts = db.prepare('SELECT * FROM social_accounts ORDER BY id DESC').all();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 预约管理接口
app.get('/api/appointments', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM appointments ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/appointments/:no', (req, res) => {
  try {
    db.prepare('DELETE FROM appointments WHERE appointment_number = ?').run(req.params.no);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 社交搜索配置接口
const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const validPlatforms = ["Facebook", "Instagram", "TikTok"];

app.get('/api/social-search', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM social_search_configs ORDER BY id DESC`).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    return res.status(400).json({ error: "参数校验失败，请检查账号与关键词" });
  }

  try {
    const result = db.prepare(`
      INSERT INTO social_search_configs (account_id, platform, country, city, keywords, gender)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(accountId, platform, country, city, keywords, gender);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/social-search/:id', (req, res) => {
  try {
    db.prepare(`DELETE FROM social_search_configs WHERE id = ?`).run(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/social-search/:id', (req, res) => {
  try {
    const enabled = req.body.enabled ? 1 : 0;
    db.prepare(`UPDATE social_search_configs SET enabled = ? WHERE id = ?`).run(enabled, Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => res.sendFile(indexPath));

app.listen(PORT, () => {
  console.log(`AI Lead Master Backend is running on port ${PORT}`);
});
