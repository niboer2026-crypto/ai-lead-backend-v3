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

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    source TEXT,
    center TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS api_cost_logs (
    id TEXT PRIMARY KEY,
    service TEXT,
    endpoint TEXT,
    units INTEGER,
    cost_usd REAL,
    timestamp TEXT
  );

  CREATE TABLE IF NOT EXISTS appointments (
    appointment_number TEXT PRIMARY KEY,
    staff_id TEXT,
    date TEXT,
    time TEXT,
    status TEXT,
    created_at TEXT
  );
`);

// 内存中模拟运行中的独立浏览器实例映射表 (profile_id -> { page, browser })
const runningAccounts = new Map();

// 中间件配置
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 辅助函数：API 成本日志记录
function logApiUsage(service, endpoint, units, costUSD) {
  const id = 'LOG-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const timestamp = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO api_cost_logs (id, service, endpoint, units, cost_usd, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, service, endpoint, units, costUSD, timestamp);
  } catch (e) {
    console.error('Log cost error:', e);
  }
}

// 1. 系统健康检查
app.get('/api/health', (req, res) => {
  res.json({ msg: 'AI Lead Master Backend is active', ok: true });
});

// 2. 获取 API 成本统计
app.get('/api/admin/api-costs', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM api_cost_logs ORDER BY timestamp DESC LIMIT 50').all();
    const total = db.prepare('SELECT SUM(cost_usd) as total FROM api_cost_logs').get();
    res.json({ ok: true, totalCostUSD: total?.total || 0, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 获取与保存社交账号列表
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

// 4. CRM 客户线索管理与查重
app.post('/api/leads/add', (req, res) => {
  try {
    const lead = req.body || {};
    const phone = lead.phone || '';
    const center = lead.center || 'B2C';

    const existing = db.prepare('SELECT * FROM leads WHERE phone = ? AND center = ?').get(phone, center);
    if (existing) {
      return res.status(409).json({ ok: false, error: '检测到重复线索（手机号已存在）' });
    }

    const id = 'LEAD-' + Date.now();
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO leads (id, name, phone, source, center, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, lead.name || '未知客户', phone, lead.source || '手动录入', center, createdAt);

    logApiUsage('CRM Deduplication', '/api/leads/add', 1, 0.0001);
    res.json({ ok: true, msg: '线索保存成功', data: { id, ...lead, createdAt } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. 社媒平台 Webhook 监听端点
const handleWebhook = (sourceName, payload, res) => {
  try {
    const name = payload.name || `${sourceName} 用户`;
    const phone = payload.phone || 'Unknown';

    if (phone !== 'Unknown') {
      const existing = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
      if (!existing) {
        db.prepare(`
          INSERT INTO leads (id, name, phone, source, center, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('LEAD-' + Date.now(), name, phone, sourceName, 'B2C', new Date().toISOString());
      }
    }
    logApiUsage(sourceName + ' Webhook', '/api/webhooks/' + sourceName.toLowerCase(), 1, 0.0);
    res.json({ received: true });
  } catch (e) {
    res.status(400).json({ error: 'Webhook 解析错误' });
  }
};

app.post('/api/webhooks/facebook', (req, res) => handleWebhook('Facebook Ads', req.body, res));
app.post('/api/webhooks/tiktok', (req, res) => handleWebhook('TikTok Ads', req.body, res));
app.post('/api/webhooks/instagram', (req, res) => handleWebhook('Instagram Direct', req.body, res));

// 6. 社交平台定向搜索 API 路由
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
      notice: "已在独立浏览器中成功打开搜索页面"
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 默认根路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Lead Master Backend is running on port ${PORT}`);
});
