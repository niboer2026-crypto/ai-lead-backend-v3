const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

// 初始化 SQLite 数据库 (保存在根目录 data.db)
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
`);

// 内存中模拟运行中的独立浏览器实例映射表 (profile_id -> { page, browser })
const runningAccounts = new Map();

// 中间件配置
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // 托管前端静态文件

// 1. 健康检查接口
app.get('/api/health', (req, res) => {
  res.json({ msg: 'AI Lead Master Backend is active', ok: true });
});

// 2. 获取所有社媒账号列表接口
app.get('/api/social-accounts', (req, res) => {
  try {
    const accounts = db.prepare('SELECT * FROM social_accounts ORDER BY id DESC').all();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. 挂载社交搜索与自动化模块路由
const createSocialSearchModule = require('./modules/social-search.cjs');
app.use('/api/social-search', createSocialSearchModule(db, runningAccounts));

// 4. 默认主页路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`AI Lead Master backend running on port ${PORT}`);
});
