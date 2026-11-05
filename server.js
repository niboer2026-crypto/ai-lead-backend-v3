const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

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

// 内存中模拟运行中的独立浏览器实例映射表
const runningAccounts = new Map();

// 中间件配置
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. 健康检查
app.get('/api/health', (req, res) => {
  res.json({ msg: 'AI Lead Master Backend is active', ok: true });
});

// 2. 获取社媒账号列表
app.get('/api/social-accounts', (req, res) => {
  try {
    const accounts = db.prepare('SELECT * FROM social_accounts ORDER BY id DESC').all();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== 社交搜索内联路由 ====================
const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const validPlatforms = ["Facebook", "Instagram", "TikTok"];
const validGenders = ["不限", "男性", "女性"];

// 获取搜索配置
app.get('/api/social-search', (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM social_search_configs ORDER BY id DESC`).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建搜索任务
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
  if (!validGenders.includes(gender)) {
    return res.status(400).json({ error: "性别设置无效" });
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

// 删除搜索任务
app.delete('/api/social-search/:id', (req, res) => {
  try {
    const result = db.prepare(`DELETE FROM social_search_configs WHERE id = ?`).run(Number(req.params.id));
    res.json({ ok: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启用/停用搜索任务
app.patch('/api/social-search/:id', (req, res) => {
  try {
    const enabled = req.body.enabled ? 1 : 0;
    const result = db.prepare(`UPDATE social_search_configs SET enabled = ? WHERE id = ?`).run(enabled, Number(req.params.id));
    res.json({ ok: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 执行搜索
app.post('/api/social-search/:id/run', async (req, res) => {
  try {
    const config = db.prepare(`
      SELECT s.*, a.profile_id, a.label, a.platform as account_platform
      FROM social_search_configs s
      JOIN social_accounts a ON s.account_id = a.id
      WHERE s.id = ?
    `).get(Number(req.params.id));

    if (!config) {
      return res.status(404).json({ error: "搜索任务不存在" });
    }
    if (!config.enabled) {
      return res.status(400).json({ error: "该搜索任务已停用" });
    }

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
    if (!url) {
      return res.status(400).json({ error: "不支持的平台类型" });
    }

    await accountInstance.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    res.json({
      ok: true,
      platform: config.platform,
      account: config.label,
      country: config.country,
      city: config.city,
      keywords: config.keywords,
      gender: config.gender,
      url,
      notice: "已在独立浏览器中打开平台搜索页面。"
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ==========================================================

// 默认主页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Lead Master backend running on port ${PORT}`);
});
