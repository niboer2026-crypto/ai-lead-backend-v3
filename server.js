require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 10000;

// 初始化本地 SQLite 数据库
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
console.log(`[DB] SQLite database: ${DB_PATH}`);

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

// 兼容旧版 data.db：为真实地图线索增加字段，不删除原有客户数据
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

// 清除旧版本自动获客演示代码生成的假线索；保留其他真实客户记录
try {
  db.prepare("DELETE FROM leads WHERE name LIKE '社媒潜在客户 (%' OR name LIKE '定向客户 (%'").run();
} catch (e) { console.error('[Mock lead cleanup]', e.message); }

// 🧹 自动清理：启动时自动清理 7 天前的旧聊天日志
try {
  db.exec(`DELETE FROM chat_logs WHERE datetime(created_at) < datetime('now', '-7 days');`);
} catch (e) {}

const defaultWelcome = "👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？";
const defaultPrompt = "You are a senior beauty consultant & personal assistant for a high-end beauty brand in the Middle East (Dubai, Riyadh, Doha). Professional, warm, and attentive. Never call yourself AI Sales.";

const existingConfig = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO ai_config (id, welcome_msg, system_prompt) VALUES (1, ?, ?)').run(defaultWelcome, defaultPrompt);
}

app.use(express.json());

// Admin first-run setup and signed-cookie authentication
const AUTH_SECRET = process.env.APP_ENCRYPTION_KEY || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.APP_ENCRYPTION_KEY && !process.env.SESSION_SECRET) console.warn('[Security] 请设置长期固定的 APP_ENCRYPTION_KEY；否则服务重启后会使登录会话失效，且后台保存的 Gemini Key 无法解密。');
const COOKIE_NAME = 'alm_session';
function signToken(payload) { const body=Buffer.from(JSON.stringify(payload)).toString('base64url'); const sig=crypto.createHmac('sha256',AUTH_SECRET).update(body).digest('base64url'); return body+'.'+sig; }
function verifyToken(token) { try { const [body,sig]=String(token||'').split('.'); const expected=crypto.createHmac('sha256',AUTH_SECRET).update(body).digest(); const actual=Buffer.from(sig,'base64url'); if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected)) return null; const d=JSON.parse(Buffer.from(body,'base64url').toString()); return d.exp>Date.now()?d:null; } catch { return null; } }
function getSession(req) { const c=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE_NAME+'=')); return c?verifyToken(decodeURIComponent(c.slice(COOKIE_NAME.length+1))):null; }
function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')) { return {salt,hash:crypto.scryptSync(password,salt,64).toString('hex')}; }
function checkPassword(password,salt,hash) { const a=crypto.scryptSync(password,salt,64), b=Buffer.from(hash,'hex'); return a.length===b.length&&crypto.timingSafeEqual(a,b); }

// 可通过部署环境变量安全初始化/重置指定管理员；密码不写入源码或 ZIP。
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
function bootstrapAdmin() {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    console.log('[AUTH] 未设置 ADMIN_USERNAME/ADMIN_PASSWORD，使用首次访问页面创建管理员。');
    return;
  }
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(ADMIN_USERNAME)) {
    throw new Error('ADMIN_USERNAME 必须为 3-40 位字母、数字或 . _ -');
  }
  if (ADMIN_PASSWORD.length < 8) {
    throw new Error('ADMIN_PASSWORD 至少需要 8 个字符。');
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
  const reset = String(process.env.ADMIN_BOOTSTRAP_RESET || '').toLowerCase() === 'true';
  if (!existing) {
    const h = hashPassword(ADMIN_PASSWORD);
    db.prepare("INSERT INTO users(username,password,role) VALUES(?,?,'admin')")
      .run(ADMIN_USERNAME, h.salt + ':' + h.hash);
    console.log(`[AUTH] 管理员 ${ADMIN_USERNAME} 已初始化。`);
  } else if (reset) {
    const h = hashPassword(ADMIN_PASSWORD);
    db.prepare("UPDATE users SET password=?, role='admin' WHERE username=?")
      .run(h.salt + ':' + h.hash, ADMIN_USERNAME);
    console.log(`[AUTH] 管理员 ${ADMIN_USERNAME} 的密码已按环境变量重置。`);
  } else {
    db.prepare("UPDATE users SET role='admin' WHERE username=?").run(ADMIN_USERNAME);
    console.log(`[AUTH] 管理员 ${ADMIN_USERNAME} 已存在；未覆盖现有密码。`);
  }
}
bootstrapAdmin();
app.get('/api/auth/status',(req,res)=>{ const admin=db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get(); const session=getSession(req); res.json({setupRequired:!admin,authenticated:!!session,username:session?.username||null}); });
app.post('/api/auth/setup',(req,res)=>{ if(db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) return res.status(409).json({error:'管理员已经创建，请直接登录。'}); const username=String(req.body?.username||'').trim().slice(0,40), password=String(req.body?.password||''); if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return res.status(400).json({error:'用户名需为 3-40 位字母、数字或 . _ -'}); if(password.length<8) return res.status(400).json({error:'密码至少 8 位。'}); const h=hashPassword(password); db.prepare('INSERT INTO users(username,password,role) VALUES(?,?,?)').run(username,h.salt+':'+h.hash,'admin'); const token=signToken({username,exp:Date.now()+7*86400000}); res.setHeader('Set-Cookie',`${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`); res.json({ok:true,username}); });
app.post('/api/auth/login',(req,res)=>{ const username=String(req.body?.username||'').trim(), password=String(req.body?.password||''); const row=db.prepare("SELECT * FROM users WHERE username=? AND role='admin'").get(username); if(!row) return res.status(401).json({error:'用户名或密码错误。'}); const [salt,hash]=String(row.password).split(':'); const valid=hash?checkPassword(password,salt,hash):row.password===password; if(!valid) return res.status(401).json({error:'用户名或密码错误。'}); const token=signToken({username,exp:Date.now()+7*86400000}); res.setHeader('Set-Cookie',`${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`); res.json({ok:true,username}); });
app.post('/api/auth/logout',(req,res)=>{res.setHeader('Set-Cookie',`${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`);res.json({ok:true});});
app.use('/api',(req,res,next)=>{if(['/auth/status','/auth/setup','/auth/login','/auth/logout'].includes(req.path))return next();if(!getSession(req))return res.status(401).json({error:'登录已失效，请重新登录。',code:'AUTH_REQUIRED'});next();});

// Gemini Key：优先使用 Render 环境变量；也支持后台加密保存到 SQLite。
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENC_KEY = crypto.createHash('sha256').update(AUTH_SECRET).digest();
function encryptSecret(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',ENC_KEY,iv),data=Buffer.concat([c.update(value,'utf8'),c.final()]);return{encrypted_key:data.toString('base64'),iv:iv.toString('base64'),auth_tag:c.getAuthTag().toString('base64')};}
function decryptSecret(row){const d=crypto.createDecipheriv('aes-256-gcm',ENC_KEY,Buffer.from(row.iv,'base64'));d.setAuthTag(Buffer.from(row.auth_tag,'base64'));return Buffer.concat([d.update(Buffer.from(row.encrypted_key,'base64')),d.final()]).toString('utf8');}
function loadStoredKey(){try{const r=db.prepare('SELECT encrypted_key,iv,auth_tag FROM ai_secrets WHERE id=1').get();return r?decryptSecret(r):'';}catch{return '';}}
let apiKey=(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||loadStoredKey()||'').trim();
let ai=apiKey?new GoogleGenAI({apiKey}):null;
if(!apiKey) console.error('[Gemini] 尚未配置 API Key，请在后台 Gemini 设置中填写。');

function getGeminiErrorMessage(err) {
  const raw = String(err?.message || err || "Unknown Gemini error");
  const status = err?.status || err?.statusCode || err?.code;
  if (/API_KEY_INVALID|invalid api key|API key not valid|401|unauthorized/i.test(raw)) return "Gemini API Key 无效或未授权，请重新检查 GEMINI_API_KEY。";
  if (/PERMISSION_DENIED|403|permission/i.test(raw)) return "Gemini API 没有权限，请检查 Google AI Studio 项目和 API Key 权限。";
  if (/RESOURCE_EXHAUSTED|429|quota|rate.?limit/i.test(raw)) return "Gemini 请求额度或速率限制已达到，请检查 API 配额或稍后重试。";
  if (/NOT_FOUND|404|model/i.test(raw)) return `Gemini 模型不可用：${GEMINI_MODEL}。请检查模型名称或该 Key 的模型访问权限。`;
  if (/fetch failed|ENOTFOUND|ECONN|timeout|network/i.test(raw)) return "服务器连接 Google Gemini 失败，请检查服务器网络或部署环境。";
  return `Gemini 调用失败${status ? `（${status}）` : ""}：${raw.slice(0, 500)}`;
}

// AI 连通性状态：前端可直接检查是否配置密钥（不返回密钥本身）
app.get('/api/ai/status', (req, res) => {
  res.json({ok:true,provider:'Gemini',configured:!!apiKey&&!!ai,model:GEMINI_MODEL,editable_in_dashboard:true,source:(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY)?'environment':(loadStoredKey()?'dashboard':'none')});
});


// 保存 Gemini Key：服务端 AES-256-GCM 加密，不向浏览器返回明文。
app.post('/api/ai/key',(req,res)=>{try{if(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY)return res.status(409).json({error:'服务器已配置环境变量 Key，当前优先使用该 Key。若要改为后台保存，请先移除 GEMINI_API_KEY / GOOGLE_API_KEY 后重新部署。'});const key=String(req.body?.apiKey||'').trim();if(key.length<20||key.length>500)return res.status(400).json({error:'请填写有效的 Gemini API Key。'});const e=encryptSecret(key);db.prepare(`INSERT INTO ai_secrets(id,encrypted_key,iv,auth_tag,updated_at) VALUES(1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=CURRENT_TIMESTAMP`).run(e.encrypted_key,e.iv,e.auth_tag);apiKey=key;ai=new GoogleGenAI({apiKey});res.json({ok:true,message:'Gemini Key 已加密保存，可以测试连接。'});}catch(err){res.status(500).json({error:err.message});}});

// Gemini 连通性测试：只测试 Render 环境变量中的 Key，不接收或保存用户提交的密钥。
app.post('/api/ai/key-test', async (req, res) => {
  try {
    if (!apiKey || !ai) return res.status(503).json({ ok: false, error: '服务器尚未配置 GEMINI_API_KEY。请先在 Render Environment 中添加后重新部署。' });
    const result = await ai.models.generateContent({ model: GEMINI_MODEL, contents: 'Reply with the single word OK.' });
    res.json({ ok: true, message: '连接成功，Gemini 已正常响应。', preview: String(result.text || '').slice(0, 80) });
  } catch (err) { res.status(502).json({ ok: false, error: getGeminiErrorMessage(err) }); }
});

// AI 配置 API
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

// 仪表盘统计 API
app.get('/api/dashboard/stats', (req, res) => {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
    const fb = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Facebook%'").get().cnt;
    const ig = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Instagram%'").get().cnt;
    const tk = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%TikTok%'").get().cnt;
    res.json({ ok: true, total, fb, ig, tk });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 社媒账号配置 API
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

// 预约单管理 API
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

// 搜客任务 API
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

// 社媒任务只打开平台公开搜索页面；不会假装已抓取客户，也不会生成虚假线索
app.post('/api/social-search/batch-run', async (req, res) => {
  return res.status(409).json({
    ok: false,
    code: 'SOCIAL_API_NOT_CONNECTED',
    error: '社交平台尚未连接官方授权 API。为避免虚假数据，此功能不会生成客户或随机手机号。请先完成 Facebook/Instagram/TikTok 官方授权。'
  });
});

// 免费真实商家数据：OpenStreetMap + Nominatim + Overpass（不是 Google Maps 数据）
// 公共服务有速率和容量限制；不提供无限量抓取。仅保存 OSM 中实际存在的公开商家标签。
const OSM_USER_AGENT = process.env.OSM_USER_AGENT || 'AILeadMaster/1.0 (business lead search; configure contact email in environment)';
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass.private.coffee/api/interpreter';
let lastNominatimRequestAt = 0;
async function nominatimGeocode(query) {
  const wait = Math.max(0, 1100 - (Date.now() - lastNominatimRequestAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastNominatimRequestAt = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query);
  const response = await fetch(url, { headers: { 'User-Agent': OSM_USER_AGENT, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`地点定位服务返回 HTTP ${response.status}`);
  const rows = await response.json();
  if (!rows.length) throw new Error('没有找到这个国家/城市，请换成英文城市名再试。');
  return { lat: Number(rows[0].lat), lon: Number(rows[0].lon), display_name: rows[0].display_name };
}

function osmTagsToLead(element, locationLabel) {
  const tags = element.tags || {};
  const name = clean(tags.name || tags['name:en'] || tags.brand || '', 250);
  if (!name) return null;
  const phone = clean(tags.phone || tags['contact:phone'] || tags['contact:mobile'] || '', 100);
  const website = clean(tags.website || tags['contact:website'] || '', 500);
  const email = clean(tags.email || tags['contact:email'] || '', 250);
  const address = [tags['addr:housenumber'], tags['addr:street'], tags['addr:suburb'], tags['addr:city'], tags['addr:postcode'], tags['addr:country']].filter(Boolean).join(', ');
  const category = clean(tags.shop || tags.amenity || tags.office || tags.tourism || tags.craft || 'business', 100);
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  const externalId = `osm:${element.type}:${element.id}`;
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([name, address || locationLabel].filter(Boolean).join(', '))}`;
  return { id: externalId, external_id: externalId, name, phone, source: 'OpenStreetMap', center: locationLabel, created_at: new Date().toISOString(), category, address, website, email, latitude: Number.isFinite(lat) ? lat : null, longitude: Number.isFinite(lon) ? lon : null, maps_url: mapsUrl };
}

app.post('/api/maps/search', async (req, res) => {
  try {
    const country = clean(req.body?.country, 100);
    const city = clean(req.body?.city, 100);
    const keyword = clean(req.body?.keyword, 120);
    if (!country || !city || !keyword) return res.status(400).json({ ok: false, error: '国家、城市和商家关键词都必须填写。' });

    const location = await nominatimGeocode(`${city}, ${country}`);
    // 关键词用于 OSM name/category 标签匹配。半径固定 5km，避免对公共实例造成过大负载。
    const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80);
    const categoryPatterns = {
      salon: 'beauty|hairdresser', beauty: 'beauty|hairdresser', spa: 'beauty|hairdresser',
      restaurant: 'restaurant|fast_food', cafe: 'cafe', hotel: 'hotel|guest_house',
      clinic: 'clinic|doctors|dentist', supermarket: 'supermarket|convenience',
      shop: '.*'
    };
    const categoryRegex = categoryPatterns[keyword.toLowerCase()] || '.*';
    const query = `[out:json][timeout:25];(nwr(around:5000,${location.lat},${location.lon})[name~"${safeKeyword}",i];nwr(around:5000,${location.lat},${location.lon})[shop~"${categoryRegex}",i];nwr(around:5000,${location.lat},${location.lon})[amenity~"${categoryRegex}",i];);out center tags 100;`;
    const overpassResponse = await fetch(OVERPASS_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': OSM_USER_AGENT },
      body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(40000)
    });
    if (!overpassResponse.ok) throw new Error(`OpenStreetMap 查询服务返回 HTTP ${overpassResponse.status}，请稍后再试。`);
    const payload = await overpassResponse.json();
    const label = `${city}, ${country}`;
    const results = (payload.elements || []).map(el => osmTagsToLead(el, label)).filter(Boolean);
    const keywordLower = keyword.toLowerCase();
    const categoryAliases = { salon: ['beauty', 'hairdresser'], beauty: ['beauty', 'hairdresser'], spa: ['spa', 'beauty', 'hairdresser'], restaurant: ['restaurant', 'fast_food'], cafe: ['cafe'], hotel: ['hotel', 'guest_house'], clinic: ['clinic', 'doctors', 'dentist'], supermarket: ['supermarket', 'convenience'] };
    const terms = [keywordLower, ...(categoryAliases[keywordLower] || [])];
    const filtered = results.filter(x => terms.some(term => `${x.name} ${x.category}`.toLowerCase().includes(term)) || keywordLower.split(/\s+/).some(w => w.length > 2 && `${x.name} ${x.category}`.toLowerCase().includes(w)));
    const unique = [...new Map(filtered.map(x => [x.external_id, x])).values()].slice(0, 100);
    const insert = db.prepare(`INSERT INTO leads (id,name,phone,source,center,created_at,external_id,category,address,website,email,latitude,longitude,maps_url)
      VALUES (@id,@name,@phone,@source,@center,@created_at,@external_id,@category,@address,@website,@email,@latitude,@longitude,@maps_url)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, category=excluded.category, address=excluded.address, website=excluded.website, email=excluded.email, latitude=excluded.latitude, longitude=excluded.longitude, maps_url=excluded.maps_url`);
    const saveMany = db.transaction(rows => rows.forEach(row => insert.run({ ...row, phone: row.phone || null, address: row.address || null, website: row.website || null, email: row.email || null })));
    saveMany(unique);
    res.json({ ok: true, provider: 'OpenStreetMap', attribution: '© OpenStreetMap contributors', location: location.display_name, searched: unique.length, saved: unique.length, results: unique, notice: '结果来自 OpenStreetMap 公开地图标签；没有电话的网站不会补造电话。Google Maps 链接仅用于打开对应地点搜索。' });
  } catch (error) {
    console.error('[OSM lead search]', error);
    res.status(502).json({ ok: false, error: error.message || '免费地图搜索失败，请稍后重试。' });
  }
});

app.get('/api/leads', (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT 500").all();
    res.json({ ok: true, total: rows.length, leads: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// 🤖 Gemini 客服：真实调用失败时返回明确错误，不再伪装成 AI 成功回复
app.post('/api/ai/chat-reply', async (req, res) => {
  const { customer_phone, customer_message, platform } = req.body || {};
  const phone = String(customer_phone || "").trim();
  const message = String(customer_message || "").trim();
  const channel = String(platform || "Website").trim();

  if (!message) return res.status(400).json({ ok: false, error: "客户消息不能为空" });
  if (message.length > 5000) return res.status(400).json({ ok: false, error: "消息过长，请控制在 5000 个字符以内" });
  if (!apiKey || !ai) {
    return res.status(503).json({ ok: false, error: "服务器尚未配置 Gemini API Key。请设置 GEMINI_API_KEY 后重启服务。", code: "GEMINI_KEY_MISSING" });
  }

  try {
    const now = new Date();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(now);
    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'customer', ?, ?)`).run(phone || 'Website Visitor', channel, message, now.toISOString());

    const currentConfig = db.prepare('SELECT system_prompt FROM ai_config WHERE id = 1').get();
    const userPromptCustom = currentConfig?.system_prompt || defaultPrompt;
    const systemInstruction = `${userPromptCustom}

You are the customer service assistant for a beauty salon business serving Dubai/UAE. Detect the language of each incoming customer message and reply in that exact language. Support any language, including English, Arabic, Chinese, Nepali, Hindi, French, Urdu and others. Do not translate the reply into the administrator interface language. Be warm, concise, professional and helpful. Never claim a booking is confirmed unless the customer has clearly provided a date, time and phone number and the booking system has successfully created it. Do not invent prices, services, availability, addresses or policies; ask a short follow-up question when details are missing.
Today in Dubai is ${today}.
Return ONLY valid JSON with exactly these keys: {"reply":"string","detected_language":"language name","has_booking_intent":false,"appointment_date":null,"appointment_time":null}. Set has_booking_intent=true only when the customer clearly asks to make an appointment, not merely asks about prices or services. Use YYYY-MM-DD for a clearly specified date and HH:MM (24-hour) for a clearly specified time. If date or time is unclear, return null for that field.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `Customer channel: ${channel}
Customer phone: ${phone || 'not provided'}
Customer message: ${message}`,
      config: {
        systemInstruction,
        temperature: 0.3,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            reply: { type: "STRING" },
            detected_language: { type: "STRING" },
            has_booking_intent: { type: "BOOLEAN" },
            appointment_date: { type: "STRING", nullable: true },
            appointment_time: { type: "STRING", nullable: true }
          },
          required: ["reply", "detected_language", "has_booking_intent", "appointment_date", "appointment_time"]
        }
      }
    });

    const rawText = response.text;
    if (!rawText) throw new Error("Gemini 返回了空内容，请检查模型输出或安全过滤状态。");
    let aiResult;
    try { aiResult = JSON.parse(rawText); }
    catch { throw new Error(`Gemini 返回内容不是有效 JSON：${rawText.slice(0, 300)}`); }

    const aiReply = String(aiResult.reply || "Sorry, could you please repeat that?").trim();
    const hasBookingIntent = aiResult.has_booking_intent === true;
    const apptDate = /^\d{4}-\d{2}-\d{2}$/.test(aiResult.appointment_date || '') ? aiResult.appointment_date : null;
    const apptTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(aiResult.appointment_time || '') ? aiResult.appointment_time : null;

    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'ai', ?, ?)`).run(phone || 'Website Visitor', channel, aiReply, new Date().toISOString());

    // 只在客户明确提出预约且日期、时间、手机号齐全时创建预约，避免误生成预约单
    let autoAppointmentCreated = false;
    let apptNumber = null;
    if (hasBookingIntent && apptDate && apptTime && phone) {
      apptNumber = 'APT-' + Date.now().toString().slice(-6);
      db.prepare(`INSERT INTO appointments (appointment_number, staff_id, phone, date, time, status, created_at) VALUES (?, 'Gemini Assistant', ?, ?, ?, 'Pending Confirmation', ?)`).run(apptNumber, phone, apptDate, apptTime, new Date().toISOString());
      autoAppointmentCreated = true;
    }

    res.json({ ok: true, provider: "Gemini", model: GEMINI_MODEL, customer_phone: phone, detected_language: String(aiResult.detected_language || "自动识别"), ai_reply: aiReply, auto_appointment_created: autoAppointmentCreated, appointment_number: apptNumber, extracted_date: apptDate, extracted_time: apptTime });
  } catch (error) {
    const friendly = getGeminiErrorMessage(error);
    console.error("[Gemini Chat Error]", error?.stack || error);
    res.status(502).json({ ok: false, provider: "Gemini", model: GEMINI_MODEL, error: friendly, detail: String(error?.message || error).slice(0, 700) });
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

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>AI Lead Master - 智能美业 CRM</title>
  <style>
    :root{--bg:#f4f6ff;--surface:#fff;--ink:#18213b;--muted:#74809b;--line:#e7eaf4;--primary:#635bff;--cyan:#12b8d6;--pink:#ec4899;--green:#10b981;--orange:#f59e0b;--shadow:0 14px 40px rgba(36,48,90,.08)}
    *{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:22px}
    body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:radial-gradient(circle at 8% 4%,#e8eaff 0,transparent 28%),radial-gradient(circle at 95% 10%,#e0f7ff 0,transparent 25%),var(--bg);margin:0;padding:22px;color:var(--ink)}
    .container{max-width:1440px;margin:0 auto 0 226px;background:transparent;padding:0;border:0;box-shadow:none}
    .header-bar{background:rgba(255,255,255,.88);backdrop-filter:blur(14px);border:1px solid var(--line);border-radius:22px;padding:18px 22px;margin-bottom:22px;box-shadow:var(--shadow)}
    .header-top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:0}
    h2{color:#252b55;margin:0;font-size:23px;letter-spacing:-.5px}h3{color:#283252;margin:0 0 16px;border:0;padding:0;font-size:17px;font-weight:800}h4{margin-bottom:10px}
    .nav-buttons-scroll{position:fixed;z-index:50;left:18px;top:18px;bottom:18px;width:190px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;white-space:normal;padding:18px 12px;background:linear-gradient(165deg,#282b63,#4443a8 55%,#287ca5);border-radius:22px;box-shadow:0 18px 45px rgba(39,42,105,.25)}
    .nav-buttons-scroll:before{content:"LEAD MASTER";color:#c9d4ff;font-size:11px;font-weight:900;letter-spacing:2px;padding:5px 10px 15px}
    .nav-btn{width:100%;flex:0 0 auto;text-align:left;background:transparent;color:#e7eaff;border:1px solid transparent;padding:12px 13px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;transition:.2s}
    .nav-btn:hover,.nav-btn:focus,.nav-btn.active{background:rgba(255,255,255,.2);border-color:rgba(255,255,255,.24);color:#fff;transform:translateX(2px)}
    .lang-btn{background:linear-gradient(135deg,#635bff,#9a5cff);color:#fff;border:0;padding:9px 15px;border-radius:12px;font-size:12px;font-weight:800;cursor:pointer;box-shadow:0 7px 16px #635bff33}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:22px}
    .stat-card{padding:20px;border-radius:19px;color:#fff;box-shadow:0 12px 25px rgba(35,44,88,.13);display:flex;flex-direction:column;justify-content:space-between;min-height:145px;transition:.2s;overflow:hidden;position:relative}
    .stat-card:hover{transform:translateY(-4px)}.stat-card.blue{background:linear-gradient(135deg,#4776f5,#6654df)}.stat-card.purple{background:linear-gradient(135deg,#a855f7,#713bd5)}.stat-card.pink{background:linear-gradient(135deg,#f472b6,#d94691)}.stat-card.emerald{background:linear-gradient(135deg,#19c79a,#079b83)}
    .stat-card h4{margin:0 0 9px;font-size:12px;letter-spacing:.5px;opacity:.94}.stat-card .num{font-size:32px;font-weight:850;margin-bottom:12px}
    .card-action-btn{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.38);color:#fff;padding:8px 11px;border-radius:10px;font-size:12px;font-weight:750;cursor:pointer;text-align:center}
    .card{background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:20px;padding:22px;margin-bottom:20px;box-shadow:var(--shadow);scroll-margin-top:20px}
    .card:nth-of-type(odd){border-top:3px solid #7c75ff}.card:nth-of-type(even){border-top:3px solid #27b9ce}
    .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;align-items:end}.form-group{display:flex;flex-direction:column;gap:7px}.form-group label{font-weight:750;font-size:12px;color:#6b7590}
    .form-group input,.form-group select,.form-group textarea,#chatPhoneInput,#chatMsgInput{padding:11px 13px;background:#f8f9ff;border:1px solid #dfe4f2;color:#202944;border-radius:11px;font-size:14px;outline:none;width:100%;transition:.2s}
    .form-group input:focus,.form-group select:focus,.form-group textarea:focus,#chatPhoneInput:focus,#chatMsgInput:focus{border-color:#827aff;box-shadow:0 0 0 3px #827aff20;background:#fff}
    button{padding:10px 14px;border:0;border-radius:10px;font-weight:800;cursor:pointer;font-size:13px;transition:transform .12s,filter .15s;width:100%}button:hover{filter:brightness(1.05)}button:active{transform:scale(.98)}
    button.primary{background:linear-gradient(135deg,#4f7df3,#6256dc);color:#fff}button.secondary{background:linear-gradient(135deg,#8b96ad,#64718d);color:#fff}button.success{background:linear-gradient(135deg,#20c997,#079b78);color:#fff}button.danger{background:linear-gradient(135deg,#fb7185,#e04461);color:#fff}button.whatsapp{background:linear-gradient(135deg,#25d366,#128c7e);color:#fff}button.purple-btn{background:linear-gradient(135deg,#a855f7,#7046d8);color:#fff}
    .table-responsive{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:13px}table{width:100%;border-collapse:collapse;margin:0;font-size:13px;min-width:620px}th,td{border-bottom:1px solid #edf0f7;padding:12px;text-align:left}th{background:#f3f5ff;font-weight:800;color:#5c63a5;text-transform:uppercase;font-size:10px;letter-spacing:.5px}tr:nth-child(even){background:#fbfcff}tr:hover{background:#f5f7ff}
    .badge{padding:4px 9px;border-radius:20px;font-size:11px;font-weight:800;display:inline-block}.badge.fb{background:#e7efff;color:#2459c5}.badge.ig{background:#ffe8f3;color:#bd2872}.badge.tk{background:#edf0f4;color:#273044;border:1px solid #d9deea}
    .chat-box{height:330px;background:linear-gradient(180deg,#f8f9ff,#f0f5ff);border:1px solid #e0e6f4;border-radius:15px;padding:15px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-bottom:13px}
    .msg{padding:10px 13px;border-radius:14px;max-width:85%;font-size:13px;line-height:1.55;word-break:break-word;box-shadow:0 3px 10px rgba(31,46,90,.06)}.msg.customer{background:#fff;color:#34405c;align-self:flex-start;border:1px solid #e5eaf4}.msg.ai{background:linear-gradient(135deg,#665cf0,#398bdc);color:#fff;align-self:flex-end}
    .chat-input-group{display:flex;flex-direction:column;gap:8px}.chat-input-group button{width:auto;white-space:nowrap;padding-left:22px;padding-right:22px}
    #geminiKeyStatus{background:#f2f8ff;border:1px solid #dcecff;border-radius:11px;padding:10px 12px}
    @media(min-width:640px){.chat-input-group{flex-direction:row;align-items:center}body{padding:22px}}
    @media(max-width:820px){body{padding:10px}.container{margin:0}.header-bar{padding:15px;margin-bottom:14px}.nav-buttons-scroll{position:sticky;top:0;bottom:auto;left:auto;width:100%;height:auto;display:flex;flex-direction:row;gap:7px;overflow-x:auto;white-space:nowrap;padding:9px;margin:14px 0 0;border-radius:14px}.nav-buttons-scroll:before{display:none}.nav-btn{width:auto;text-align:center;flex:0 0 auto;padding:10px 12px;font-size:12px}.card{padding:16px;border-radius:16px}.stats-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.stat-card{padding:15px;min-height:128px}.stat-card .num{font-size:26px}h2{font-size:19px}}
    @media(max-width:420px){.stats-grid{grid-template-columns:1fr 1fr}.stat-card h4{font-size:10px}.stat-card .num{font-size:23px}.header-top{align-items:flex-start}}
  </style>
</head>
<body>
  <div id="authGate" style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:linear-gradient(135deg,#20265b,#5147a8 55%,#1686a4)"><div style="width:min(430px,100%);background:#fff;border-radius:24px;padding:30px;box-shadow:0 25px 80px #11182766"><div style="font-size:12px;font-weight:900;letter-spacing:2px;color:#655cf3;margin-bottom:10px">AI LEAD MASTER</div><h2 id="authTitle" style="margin-bottom:8px">管理员登录</h2><p id="authHint" style="color:#71809b;font-size:13px;margin:0 0 20px">请登录后进入管理后台</p><form id="authForm" style="display:grid;gap:12px"><input id="authUsername" required minlength="3" placeholder="管理员用户名" style="padding:13px;border:1px solid #dce2f0;border-radius:12px;font-size:15px"><input id="authPassword" required type="password" placeholder="密码（至少 10 位）" style="padding:13px;border:1px solid #dce2f0;border-radius:12px;font-size:15px"><button id="authSubmit" class="primary" type="submit" style="padding:14px">登录</button></form><p id="authError" style="color:#dc3545;font-size:13px;min-height:20px;margin:12px 0 0"></p></div></div>
  <div class="container" id="mainApp" style="display:none">
    <div class="header-bar" id="sec-dashboard">
      <div class="header-top">
        <h2>🚀 AI Lead Master CRM</h2>
        <div style="display: flex; align-items: center; gap: 10px;">
          <button class="lang-btn" onclick="toggleLanguage()">🌐 EN / 中文</button><button class="secondary" style="width:auto;padding:9px 12px" onclick="logoutAdmin()">退出登录</button>
          <span id="currentUserDisplay" style="font-weight: bold; color: #38bdf8; background: #0f172a; padding: 4px 8px; border-radius: 6px; font-size:12px; border: 1px solid #334155;">👤 Admin Mode</span>
        </div>
      </div>
      <div class="nav-buttons-scroll">
        <button class="nav-btn" onclick="scrollToSec('sec-dashboard')" data-i18n="nav_dashboard">📊 仪表盘</button>
        <button class="nav-btn" onclick="scrollToSec('sec-ai-chat')" data-i18n="nav_ai">🤖 美业助理</button>
        <button class="nav-btn" onclick="scrollToSec('sec-ai-edit')" data-i18n="nav_edit_ai">✍️ 助理设置</button>
        <button class="nav-btn" onclick="scrollToSec('sec-maps-leads')">🗺️ 地图商家</button>
        <button class="nav-btn" onclick="scrollToSec('sec-social-acc')" data-i18n="nav_social">👤 社媒配置</button>
        <button class="nav-btn" onclick="scrollToSec('sec-search-task')" data-i18n="nav_tasks">🌐 搜客任务</button>
        <button class="nav-btn" onclick="scrollToSec('sec-appointments')" data-i18n="nav_appts">📅 预约列表</button>
      </div>
    </div>

    <!-- 📊 仪表盘 -->
    <div class="stats-grid">
      <div class="stat-card blue">
        <div>
          <h4 data-i18n="stat_total">📦 总线索量</h4>
          <div class="num" id="valTotalLeads">0</div>
        </div>
        <button class="card-action-btn" onclick="scrollToSec('sec-appointments')" data-i18n="btn_jump_appts">📅 查看预约管理 &rarr;</button>
      </div>
      <div class="stat-card purple">
        <div>
          <h4>📘 Facebook</h4>
          <div class="num" id="valFbLeads">0</div>
        </div>
        <button class="card-action-btn" onclick="scrollToSec('sec-social-acc')" data-i18n="btn_jump_social">👤 配置社媒账号 &rarr;</button>
      </div>
      <div class="stat-card pink">
        <div>
          <h4>📸 Instagram</h4>
          <div class="num" id="valIgLeads">0</div>
        </div>
        <button class="card-action-btn" onclick="scrollToSec('sec-search-task')" data-i18n="btn_jump_tasks">🌐 搜客获客任务 &rarr;</button>
      </div>
      <div class="stat-card emerald">
        <div>
          <h4>🎵 TikTok</h4>
          <div class="num" id="valTkLeads">0</div>
        </div>
        <button class="card-action-btn" onclick="scrollToSec('sec-ai-chat')" data-i18n="btn_jump_ai">🤖 进入AI助理工作台 &rarr;</button>
      </div>
    </div>

    <!-- 🤖 AI 美业助理交互工作台 -->
    <div class="card" id="sec-ai-chat" style="border: 1px solid #0ea5e9;">
      <h3 style="color: #38bdf8;" data-i18n="ai_title">🤖 智能美业助理与预约工作台</h3>
      <p style="font-size: 12px; color: #94a3b8; margin-bottom: 12px;" data-i18n="ai_desc">客户输入预约意向，助理将温柔解答并自动精准识别时间生成预约单！</p>
      
      <div class="chat-box" id="chatLogsContainer">
        <div class="msg ai" id="aiWelcomeBox">👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？</div>
      </div>

      <div class="chat-input-group">
        <input type="text" id="chatPhoneInput" data-i18n-ph="ph_phone" placeholder="客户手机号" style="padding: 10px; background: #1e293b; border: 1px solid #475569; color:#fff; border-radius:8px;">
        <input type="text" id="chatMsgInput" data-i18n-ph="ph_msg" placeholder="输入测试咨询 (如: 帮我预约明天下午3点)" style="padding: 10px; background: #1e293b; border: 1px solid #475569; color:#fff; border-radius:8px;" onkeypress="if(event.key==='Enter') sendAiMessage()">
        <button class="primary" onclick="sendAiMessage()" style="width: auto; white-space: nowrap;" data-i18n="btn_send_ai">发送给助理</button>
      </div>
    </div>

    <!-- ✍️ 助理人设设置 -->
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

    <!-- Gemini API 配置：管理员可直接在后台填写，服务器加密保存 -->
    <div class="card" id="sec-gemini-key" style="border:1px solid #10b981;">
      <h3 style="color:#34d399;">🔐 Gemini AI 密钥设置</h3>
      <p style="font-size:13px;color:#64748b;">可直接在此处添加 Gemini API Key。密钥会发送到服务器并使用 AES-256-GCM 加密保存，不会回显到网页。</p>
      <div class="form-grid" style="margin:14px 0;">
        <div class="form-group" style="grid-column:1/-1">
          <label for="geminiApiKeyInput">Gemini API Key</label>
          <input id="geminiApiKeyInput" type="password" autocomplete="new-password" placeholder="粘贴 Google AI Studio 提供的 Gemini API Key">
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;grid-column:1/-1">
          <button type="button" class="primary" onclick="saveGeminiKey()">🔐 保存密钥</button>
          <button type="button" class="success" onclick="testGeminiKey()">🧪 测试连接</button>
          <button type="button" class="secondary" onclick="checkGeminiStatus()">刷新状态</button>
        </div>
      </div>
      <p id="geminiKeyStatus" style="margin-top:12px;color:#64748b;font-size:13px;">状态：等待检查</p>
      <p style="margin-top:6px;color:#b45309;font-size:12px;">提示：后台保存的密钥保存在 SQLite 数据库中。请配置持久化磁盘，并长期固定 APP_ENCRYPTION_KEY，否则重启或更换密钥可能导致无法解密。</p>
    </div>

    <!-- 👤 社媒配置 -->
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

    <!-- 🗺️ 免费真实商家线索：OSM 公共数据 -->
    <div class="card" id="sec-maps-leads" style="border:1px solid #0ea5e9;">
      <h3>🗺️ 免费真实商家获客（OpenStreetMap）</h3>
      <p style="color:#94a3b8;font-size:13px;">无需 Google Maps API Key。按国家、城市和商家类型搜索公开地图资料；只保存真实返回的商家，不会生成假客户或随机电话。Google Maps 按钮只负责打开地图定位。</p>
      <form id="mapsLeadForm" class="form-grid">
        <div class="form-group"><label>国家</label><input id="mapsCountry" placeholder="United Arab Emirates" required></div>
        <div class="form-group"><label>城市</label><input id="mapsCity" placeholder="Dubai" required></div>
        <div class="form-group"><label>商家关键词</label><input id="mapsKeyword" placeholder="salon / restaurant / hotel / spa" required></div>
        <div style="grid-column:1/-1;display:flex;gap:10px;flex-wrap:wrap;">
          <button class="primary" type="submit" id="mapsSearchBtn">🔎 搜索真实商家</button>
          <span id="mapsSearchStatus" style="color:#94a3b8;align-self:center;font-size:13px;"></span>
        </div>
      </form>
      <div id="mapsSearchNotice" style="margin:12px 0;color:#fbbf24;font-size:12px;"></div>
      <div class="table-responsive"><table><thead><tr><th>商家名称</th><th>类别</th><th>真实电话</th><th>网站</th><th>地址</th><th>来源</th><th>地图</th></tr></thead><tbody id="mapsLeadResults"><tr><td colspan="7" style="text-align:center;color:#64748b;">尚未搜索</td></tr></tbody></table></div>
      <p style="font-size:11px;color:#64748b;margin-top:8px;">数据归属 OpenStreetMap，遵守其服务使用限制并显示数据署名。公共地图不保证每家商户都有电话或完整资料。</p>
    </div>

    <!-- 🌐 社媒任务设置（未接官方 API 前仅用于配置，不会生成线索） -->
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
          <button type="button" class="purple-btn" style="flex: 1; min-width: 150px;" onclick="triggerBatchScrape()" data-i18n="btn_batch_scrape">社媒 API 未连接（不可抓取）</button>
        </div>
      </form>
      <h4 style="margin-top: 20px; color: #38bdf8;" data-i18n="task_list_title">获客任务调度</h4>
      <div class="table-responsive">
        <table><thead><tr><th data-i18n="th_platform">平台</th><th data-i18n="th_acc">账号</th><th data-i18n="th_country">国家</th><th data-i18n="th_city">城市</th><th data-i18n="th_keyword">关键词</th><th data-i18n="th_gender">性别</th><th data-i18n="th_status">状态</th><th data-i18n="th_action">操作</th></tr></thead><tbody id="socialSearchList"></tbody></table>
      </div>
    </div>

    <!-- 📅 预约列表 -->
    <div class="card" id="sec-appointments">
      <h3 data-i18n="appt_title">📅 3. 智能预约排班与私域转化</h3>
      <form id="appointmentForm" class="form-grid">
        <div class="form-group"><label data-i18n="staff_label">接待技师：</label><input type="text" id="apptStaff" placeholder="Sarah (Dubai)" required></div>
        <div class="form-group"><label data-i18n="phone_label">客户手机号：</label><input type="text" id="apptPhone" placeholder="输入客户真实手机号" required></div>
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
        nav_dashboard: "📊 仪表盘",
        nav_ai: "🤖 美业助理",
        nav_edit_ai: "✍️ 助理设置",
        nav_social: "👤 社媒配置",
        nav_tasks: "🌐 搜客任务",
        nav_appts: "📅 预约列表",
        stat_total: "📦 总线索量",
        btn_jump_appts: "📅 查看预约管理 &rarr;",
        btn_jump_social: "👤 配置社媒账号 &rarr;",
        btn_jump_tasks: "🌐 搜客获客任务 &rarr;",
        btn_jump_ai: "🤖 进入AI助理工作台 &rarr;",
        ai_title: "🤖 智能美业助理与预约工作台",
        ai_desc: "客户输入预约意向，助理将温柔解答并自动精准识别时间生成预约单！",
        ph_phone: "客户手机号",
        ph_msg: "输入测试咨询 (如: 帮我预约明天下午3点)",
        btn_send_ai: "发送给助理",
        edit_ai_title: "✍️ 自定义助理打招呼语与人设设置",
        label_welcome: "开场打招呼词 (Welcome Message)：",
        label_prompt: "助理人设与沟通风格 Prompt：",
        btn_save_config: "💾 保存助理配置",
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
        btn_batch_scrape: "社媒 API 未连接（不可抓取）",
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
        nav_dashboard: "📊 Dashboard",
        nav_ai: "🤖 Senior Assistant",
        nav_edit_ai: "✍️ Assistant Config",
        nav_social: "👤 Social Config",
        nav_tasks: "🌐 Lead Tasks",
        nav_appts: "📅 Appointments",
        stat_total: "📦 Total Leads",
        btn_jump_appts: "📅 View Appointments &rarr;",
        btn_jump_social: "👤 Setup Social &rarr;",
        btn_jump_tasks: "🌐 Lead Scraper &rarr;",
        btn_jump_ai: "🤖 Open AI Assistant &rarr;",
        ai_title: "🤖 Beauty Assistant & Auto-Booking Workspace",
        ai_desc: "Customers message with booking intent, Senior Assistant replies warmly and creates appointments!",
        ph_phone: "Customer Phone Number",
        ph_msg: "Type test message (e.g. I want to book tomorrow at 3pm)",
        btn_send_ai: "Send to Assistant",
        edit_ai_title: "✍️ Customize Assistant Greeting & Persona",
        label_welcome: "Welcome Greeting Message:",
        label_prompt: "Assistant Persona & Rules Prompt:",
        btn_save_config: "💾 Save Config",
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
      document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";
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
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', (b.getAttribute('onclick')||'').includes(id))); history.replaceState(null,'','#'+id); }
    }

    async function api(url, options = {}) {
      const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error("服务器响应格式异常");
      }
      if (!res.ok) throw new Error(data.error || ("HTTP Error " + res.status));
      return data;
    }

    window.addEventListener("DOMContentLoaded", async () => { applyLanguage(); const st=await fetch('/api/auth/status').then(r=>r.json()).catch(()=>({setupRequired:true})); if(st.authenticated){enterAdmin(st.username);return;} document.getElementById('authTitle').textContent=st.setupRequired?'创建管理员账号':'管理员登录';document.getElementById('authHint').textContent=st.setupRequired?'首次使用，请创建管理员账号和密码，密码至少 10 位。':'请登录后进入管理后台';document.getElementById('authSubmit').textContent=st.setupRequired?'创建账号并进入后台':'登录';document.getElementById('authForm').dataset.mode=st.setupRequired?'setup':'login'; });
    function enterAdmin(username){document.getElementById('authGate').style.display='none';document.getElementById('mainApp').style.display='block';document.getElementById('currentUserDisplay').textContent='👤 '+username;loadAllData();checkGeminiStatus();}
    document.getElementById('authForm').addEventListener('submit',async e=>{e.preventDefault();const err=document.getElementById('authError');err.textContent='正在验证…';const mode=e.currentTarget.dataset.mode||'login';try{const r=await fetch('/api/auth/'+mode,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('authUsername').value.trim(),password:document.getElementById('authPassword').value})});const d=await r.json();if(!r.ok)throw new Error(d.error||'登录失败');enterAdmin(d.username);}catch(x){err.textContent=x.message;}});
    async function logoutAdmin(){await fetch('/api/auth/logout',{method:'POST'});location.reload();}


    async function loadAllData() {
      await loadAiConfig();
      await loadStats();
      await loadAccounts();
      await loadAppointments();
      await loadSearchTasks();
      await loadChatLogs();
      await loadStoredLeads();
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
        alert(currentLang === 'en' ? "Assistant Config Saved!" : "助理配置保存成功！");
        await loadAiConfig();
      } catch (err) { alert(err.message); }
    });

    async function saveGeminiKey(){const input=document.getElementById('geminiApiKeyInput'),el=document.getElementById('geminiKeyStatus'),apiKey=input.value.trim();if(!apiKey){el.textContent='请先填写 Gemini API Key。';return;}el.textContent='正在加密保存…';try{const d=await api('/api/ai/key',{method:'POST',body:JSON.stringify({apiKey})});input.value='';el.textContent=d.message;await checkGeminiStatus();}catch(e){el.textContent='保存失败：'+e.message;}}

    async function checkGeminiStatus() {
      const el = document.getElementById('geminiKeyStatus');
      try {
        const result = await api('/api/ai/status');
        el.textContent = result.configured ? ('状态：已配置 · 模型 ' + result.model + ' · 来源 ' + (result.source === 'dashboard' ? '后台保存' : '服务器环境变量')) : '状态：尚未配置，请在上方输入 Gemini API Key 并保存。';
      } catch (e) { el.textContent = '状态检查失败：' + e.message; }
    }
    async function testGeminiKey() {
      const el = document.getElementById('geminiKeyStatus');
      el.textContent = '正在测试 Gemini，请稍候…';
      try {
        const result = await api('/api/ai/key-test', { method: 'POST', body: JSON.stringify({}) });
        el.textContent = '状态：连接成功 · ' + result.preview;
        alert(result.message);
      } catch (e) { el.textContent = '状态：连接失败 · ' + e.message; alert(e.message); }
    }

    async function sendAiMessage() {
      const phoneInput = document.getElementById("chatPhoneInput");
      const msgInput = document.getElementById("chatMsgInput");
      const container = document.getElementById("chatLogsContainer");
      const phone = phoneInput.value.trim();
      const message = msgInput.value.trim();
      if (!message) return;

      const userDiv = document.createElement("div");
      userDiv.className = "msg customer";
      userDiv.textContent = "[" + phone + "] " + message;
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
        aiDiv.textContent = (res.detected_language ? "[" + (currentLang === 'en' ? "Detected: " : "识别语言：") + res.detected_language + "]\n" : "") + res.ai_reply;
        container.appendChild(aiDiv);
        container.scrollTop = container.scrollHeight;

        if (res.auto_appointment_created) {
          const msgText = currentLang === 'en' ? "🔥 Assistant captured booking! Created [" + res.appointment_number + "]" : "🔥 助理成功为您生成预约单！单号 [" + res.appointment_number + "]";
          alert(msgText);
          await loadAppointments();
          await loadStats();
        }
      } catch (err) {
        const errorDiv = document.createElement("div");
        errorDiv.className = "msg customer";
        errorDiv.style.background = "#7f1d1d";
        errorDiv.textContent = "Gemini 客服发送失败：" + err.message;
        container.appendChild(errorDiv);
        container.scrollTop = container.scrollHeight;
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
            div.textContent = "[" + l.customer_phone + "] " + l.message;
            container.appendChild(div);
          });
          container.scrollTop = container.scrollHeight;
        }
      } catch (e) { console.error(e); }
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
        sel.innerHTML = "<option value=\"\">" + (currentLang === 'en' ? 'Select Account' : '选择授权账号') + "</option>";
        accs.forEach(a => {
          const opt = document.createElement("option");
          opt.value = a.id;
          opt.dataset.platform = a.platform;
          opt.textContent = a.platform + " - " + a.label;
          sel.appendChild(opt);
        });
        tbody.innerHTML = "";
        if (!accs.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">No Accounts</td></tr>'; return; }
        accs.forEach(a => {
          const badgeClass = a.platform === 'Facebook' ? 'fb' : (a.platform === 'Instagram' ? 'ig' : 'tk');
          const tr = document.createElement("tr");
          tr.innerHTML = "<td>" + a.id + "</td><td><span class=\"badge " + badgeClass + "\">" + a.platform + "</span></td><td><b>" + a.label + "</b></td><td><code>" + a.profile_id + "</code></td><td>" + (a.created_at ? a.created_at.replace('T', ' ').slice(0, 16) : 'N/A') + "</td><td><button class=\"danger\" style=\"padding: 4px 8px; font-size:12px;\" onclick=\"deleteAccount(" + a.id + ")\">Unbind</button></td>";
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
      try { await api("/api/social-accounts/" + id, { method: "DELETE" }); await loadAccounts(); } catch (err) { alert(err.message); }
    }

    document.getElementById("ssAccount")?.addEventListener("change", function() {
      const opt = this.selectedOptions[0];
      if (opt && opt.dataset.platform) document.getElementById("ssPlatform").value = opt.dataset.platform;
    });

    async function loadStoredLeads() {
      const tbody = document.getElementById("mapsLeadResults");
      if (!tbody) return;
      try {
        const data = await api("/api/leads");
        const leads = (data.leads || []).filter(x => x.source === "OpenStreetMap");
        tbody.innerHTML = "";
        if (!leads.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#64748b;">尚无真实地图线索</td></tr>'; return; }
        leads.forEach(item => {
          const tr = document.createElement("tr");
          const add = value => { const td = document.createElement("td"); td.textContent = value || "—"; tr.appendChild(td); };
          add(item.name); add(item.category); add(item.phone);
          const websiteTd = document.createElement("td");
          if (item.website) { const a = document.createElement("a"); a.href = item.website; a.target = "_blank"; a.rel = "noopener"; a.textContent = item.website; websiteTd.appendChild(a); } else websiteTd.textContent = "—";
          tr.appendChild(websiteTd); add(item.address); add("OpenStreetMap");
          const mapTd = document.createElement("td"); const mapA = document.createElement("a"); mapA.href = item.maps_url || "#"; mapA.target = "_blank"; mapA.rel = "noopener"; mapA.textContent = "Google Maps"; mapTd.appendChild(mapA); tr.appendChild(mapTd);
          tbody.appendChild(tr);
        });
      } catch (e) { console.error("Load saved leads:", e); }
    }

    document.getElementById("mapsLeadForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      const btn = document.getElementById("mapsSearchBtn");
      const status = document.getElementById("mapsSearchStatus");
      const body = {
        country: document.getElementById("mapsCountry").value.trim(),
        city: document.getElementById("mapsCity").value.trim(),
        keyword: document.getElementById("mapsKeyword").value.trim()
      };
      btn.disabled = true; status.textContent = "正在查询真实地图数据…";
      try {
        const data = await api("/api/maps/search", { method: "POST", body: JSON.stringify(body) });
        const tbody = document.getElementById("mapsLeadResults"); tbody.innerHTML = "";
        if (!data.results.length) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;">该区域没有找到匹配的公开商家数据。没有创建任何线索。</td></tr>';
        data.results.forEach(item => {
          const tr = document.createElement("tr");
          const td = value => { const el = document.createElement("td"); el.textContent = value || "—"; return el; };
          tr.appendChild(td(item.name)); tr.appendChild(td(item.category)); tr.appendChild(td(item.phone));
          const webTd = document.createElement("td");
          if (item.website) { const a = document.createElement("a"); a.href = item.website; a.target = "_blank"; a.rel = "noopener"; a.textContent = item.website; webTd.appendChild(a); } else webTd.textContent = "—";
          tr.appendChild(webTd); tr.appendChild(td(item.address)); tr.appendChild(td("OpenStreetMap"));
          const mapTd = document.createElement("td"); const mapA = document.createElement("a"); mapA.href = item.maps_url; mapA.target = "_blank"; mapA.rel = "noopener"; mapA.textContent = "Google Maps"; mapTd.appendChild(mapA); tr.appendChild(mapTd);
          tbody.appendChild(tr);
        });
        document.getElementById("mapsSearchNotice").textContent = data.notice + " | 地点：" + data.location;
        status.textContent = "搜索完成：" + data.searched + " 条真实记录，新增/更新 " + data.saved + " 条。";
        await loadStats();
      } catch (err) { status.textContent = "搜索失败：" + err.message; }
      finally { btn.disabled = false; }
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
          tr.innerHTML = "<td><b>" + t.platform + "</b></td><td>ID: " + t.account_id + "</td><td>" + (t.country || 'Global') + "</td><td>" + (t.city || 'Any') + "</td><td><code>" + t.keywords + "</code></td><td>" + t.gender + "</td><td><span style=\"color: " + (t.enabled ? '#22c55e' : '#f87171') + "; font-weight: bold;\">" + (t.enabled ? '● Active' : '○ Disabled') + "</span></td><td style=\"display: flex; gap: 4px;\"><button class=\"primary\" style=\"padding: 4px 8px; font-size:12px;\" onclick=\"runTask(" + t.id + ")\">Run</button><button class=\"secondary\" style=\"padding: 4px 8px; font-size:12px;\" onclick=\"toggleTask(" + t.id + ", " + t.enabled + ")\">" + (t.enabled ? 'Disable' : 'Enable') + "</button><button class=\"danger\" style=\"padding: 4px 8px; font-size:12px;\" onclick=\"deleteTask(" + t.id + ")\">Delete</button></td>";
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
      try { const res = await api("/api/social-search/" + id + "/run", { method: "POST" }); window.open(res.url, '_blank'); } catch (err) { alert(err.message); }
    }

    async function triggerBatchScrape() {
      alert("社交平台尚未接入官方授权 API，因此不会抓取或生成客户。请先使用上方免费真实商家搜索，社媒自动获客需完成 Meta/TikTok 官方授权。");
    }

    async function toggleTask(id, current) {
      try { await api("/api/social-search/" + id, { method: "PATCH", body: JSON.stringify({ enabled: !current }) }); await loadSearchTasks(); } catch (err) { alert(err.message); }
    }
    async function deleteTask(id) {
      if (!confirm("Confirm to delete?")) return;
      try { await api("/api/social-search/" + id, { method: "DELETE" }); await loadSearchTasks(); } catch (err) { alert(err.message); }
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
          tr.innerHTML = "<td><b style=\"color:#38bdf8;\">" + ap.appointment_number + "</b></td><td>" + ap.staff_id + "</td><td>" + ap.phone + "</td><td>" + ap.date + " " + ap.time + "</td><td><span style=\"color: #22c55e; font-weight: bold;\">" + ap.status + "</span></td><td style=\"display: flex; gap: 4px;\"><a href=\"https://wa.me/" + cleanPhone + "\" target=\"_blank\"><button class=\"whatsapp\" style=\"padding: 4px 8px; font-size:12px;\">💬 WA</button></a><button class=\"danger\" style=\"padding: 4px 8px; font-size:12px;\" onclick=\"deleteAppt('" + ap.appointment_number + "')\">Cancel</button></td>";
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
      try { await api("/api/appointments/" + no, { method: "DELETE" }); await loadAppointments(); await loadStats(); } catch (err) { alert(err.message); }
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
