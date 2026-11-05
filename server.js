const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== 自动自愈机制：确保 public 目录和文件存在 ====================
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const indexPath = path.join(publicDir, 'index.html');
if (!fs.existsSync(indexPath)) {
  const defaultHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Master - 智能 CRM 与社媒获客控制台</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f9; margin: 0; padding: 20px; color: #333; }
    .container { max-width: 1200px; margin: 0 auto; background: #fff; padding: 25px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    h2 { color: #1a73e8; border-bottom: 2px solid #e8eaed; padding-bottom: 12px; margin-top: 0; }
    h3 { color: #3c4043; margin-top: 0; }
    .card { background: #fafbfc; border: 1px solid #e1e4e8; border-radius: 8px; padding: 20px; margin-bottom: 24px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; align-items: end; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-weight: 600; font-size: 13px; color: #4a5568; }
    .form-group input, .form-group select { padding: 9px 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; outline: none; }
    button { padding: 9px 16px; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px; transition: background 0.2s; }
    button.primary { background: #3182ce; color: #fff; }
    button.primary:hover { background: #2b6cb0; }
    button.secondary { background: #718096; color: #fff; }
    button.danger { background: #e53e3e; color: #fff; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
    th, td { border: 1px solid #e2e8f0; padding: 12px; text-align: left; }
    th { background-color: #edf2f7; font-weight: 600; color: #2d3748; }
    tr:nth-child(even) { background-color: #f8fafc; }
  </style>
</head>
<body>
  <div class="container">
    <h2>🚀 AI Lead Master - 智能 CRM 与社媒获客控制台 (Auto-Recovered)</h2>
    <div class="card">
      <h3>👤 绑定社媒平台账号</h3>
      <form id="accountForm" class="form-grid">
        <div class="form-group">
          <label>所属平台：</label>
          <select id="accPlatform" required>
            <option value="Facebook">Facebook</option>
            <option value="Instagram">Instagram</option>
            <option value="TikTok">TikTok</option>
          </select>
        </div>
        <div class="form-group">
          <label>账号备注 / 标签：</label>
          <input type="text" id="accLabel" placeholder="例如: 迪拜美业主账号" required>
        </div>
        <div class="form-group">
          <label>独立环境 Profile ID：</label>
          <input type="text" id="accProfileId" placeholder="例如: prof_uae_001" required>
        </div>
        <button type="submit" class="primary">绑 定 账 号</button>
      </form>
    </div>
    <div class="card">
      <h3>🌐 多平台社交定向搜索任务</h3>
      <form id="socialSearchForm" class="form-grid">
        <div class="form-group">
          <label>选择平台账号：</label>
          <select id="ssAccount" required><option value="">请选择账号</option></select>
        </div>
        <div class="form-group">
          <label>目标平台：</label>
          <input type="text" id="ssPlatform" readonly placeholder="自动匹配" style="background: #edf2f7;">
        </div>
        <div class="form-group">
          <label>目标国家 (Country)：</label>
          <input type="text" id="ssCountry" placeholder="例如: UAE">
        </div>
        <div class="form-group">
          <label>目标城市 (City)：</label>
          <input type="text" id="ssCity" placeholder="例如: Dubai">
        </div>
        <div class="form-group">
          <label>搜索关键词：</label>
          <input type="text" id="ssKeywords" placeholder="例如: Salon & Spa" required>
        </div>
        <div class="form-group">
          <label>性别筛选：</label>
          <select id="ssGender">
            <option value="不限">不限</option>
            <option value="男性">男性</option>
            <option value="女性">女性</option>
          </select>
        </div>
        <div style="grid-column: 1 / -1; margin-top: 10px;">
          <button type="submit" class="primary" style="width: 100%; padding: 12px;">保 存 并 创 建 搜 索 任 务</button>
        </div>
      </form>
      <h3 style="margin-top: 30px;">当前社媒定向搜索任务</h3>
      <table>
        <thead>
          <tr>
            <th>平台</th>
            <th>账号 ID</th>
            <th>国家</th>
            <th>城市</th>
            <th>关键词</th>
            <th>性别</th>
            <th>状态</th>
            <th>操作选项</th>
          </tr>
        </thead>
        <tbody id="socialSearchList"></tbody>
      </table>
    </div>
  </div>
  <script src="/social-search.js"></script>
</body>
</html>`;
  fs.writeFileSync(indexPath, defaultHtml, 'utf8');
}
// ==============================================================================

// 初始化 SQLite 数据库
const db = new Database('data.db');

// 初始化核心表结构
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
`);

const runningAccounts = new Map();

app.use(express.json());
app.use(express.static(publicDir));

// API 路由
app.get('/api/health', (req, res) => {
  res.json({ msg: 'AI Lead Master Backend is active', ok: true });
});

app.get('/api/social-accounts', (req, res) => {
  try {
    const accounts = db.prepare('SELECT * FROM social_accounts ORDER BY id DESC').all();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social-accounts', (req, res) => {
  try {
    const { platform, label, profile_id } = req.body || {};
    if (!platform || !label || !profile_id) {
      return res.status(400).json({ error: '平台、标签和Profile ID不能为空' });
    }
    const result = db.prepare(`
      INSERT INTO social_accounts (platform, label, profile_id) VALUES (?, ?, ?)
    `).run(platform, label, profile_id);
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const validPlatforms = ["Facebook", "Instagram", "TikTok"];
const validGenders = ["不限", "男性", "女性"];

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

  if (!accountId || !validPlatforms.includes(platform)) {
    return res.status(400).json({ error: "账号或平台无效" });
  }
  if (!keywords) {
    return res.status(400).json({ error: "请填写搜索关键词" });
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
    const result = db.prepare(`DELETE FROM social_search_configs WHERE id = ?`).run(Number(req.params.id));
    res.json({ ok: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/social-search/:id', (req, res) => {
  try {
    const enabled = req.body.enabled ? 1 : 0;
    const result = db.prepare(`UPDATE social_search_configs SET enabled = ? WHERE id = ?`).run(enabled, Number(req.params.id));
    res.json({ ok: result.changes > 0 });
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

    if (!config) return res.status(404).json({ error: "搜索任务不存在" });
    if (!config.enabled) return res.status(400).json({ error: "该搜索任务已停用" });

    const accountInstance = runningAccounts.get(config.profile_id);
    if (!accountInstance || !accountInstance.page) {
      return res.status(400).json({ error: "请先启动对应账号的独立浏览器实例" });
    }

    const query = [config.keywords, config.city, config.country].filter(Boolean).join(" ");
    const encoded = encodeURIComponent(query);
    const searchUrls = {
      Facebook: `https://www.facebook.com/search/top?q=${encoded}`,
      Instagram: `https://www.instagram.com/explore/search/keyword/?q=${encoded}`,
      TikTok: `https://www.tiktok.com/search?q=${encoded}`
    };

    const url = searchUrls[config.platform];
    await accountInstance.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    res.json({ ok: true, platform: config.platform, account: config.label, url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 根路由兜底
app.get('/', (req, res) => {
  res.sendFile(indexPath);
});

app.listen(PORT, () => {
  console.log(`AI Lead Master Backend is running on port ${PORT}`);
});
