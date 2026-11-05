require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 10000;

// 初始化本地 SQLite 数据库
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

// 兼容旧版 data.db
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

try {
  db.prepare("DELETE FROM leads WHERE name LIKE '社媒潜在客户 (%' OR name LIKE '定向客户 (%'").run();
} catch (e) {}

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

const AUTH_SECRET = process.env.APP_ENCRYPTION_KEY || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'alm_session';

// 【取消登录】直接让鉴权状态永远返回已认证，跳过登录拦截
app.get('/api/auth/status', (req, res) => { 
  res.json({ setupRequired: false, authenticated: true, username: 'dubai' }); 
});

app.post('/api/auth/setup', (req, res) => { res.json({ ok: true, username: 'dubai' }); });
app.post('/api/auth/login', (req, res) => { res.json({ ok: true, username: 'dubai' }); });
app.post('/api/auth/logout', (req, res) => { res.json({ ok: true }); });

// 移除所有 /api 的拦截验证，所有接口直接公开可用
app.use('/api', (req, res, next) => { next(); });

// Gemini 配置
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENC_KEY = crypto.createHash('sha256').update(AUTH_SECRET).digest();
function encryptSecret(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',ENC_KEY,iv),data=Buffer.concat([c.update(value,'utf8'),c.final()]);return{encrypted_key:data.toString('base64'),iv:iv.toString('base64'),auth_tag:c.getAuthTag().toString('base64')};}
function decryptSecret(row){const d=crypto.createDecipheriv('aes-256-gcm',ENC_KEY,Buffer.from(row.iv,'base64'));d.setAuthTag(Buffer.from(row.auth_tag,'base64'));return Buffer.concat([d.update(Buffer.from(row.encrypted_key,'base64')),d.final()]).toString('utf8');}
function loadStoredKey(){try{const r=db.prepare('SELECT encrypted_key,iv,auth_tag FROM ai_secrets WHERE id=1').get();return r?decryptSecret(r):'';}catch{return '';}}
let apiKey=(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||loadStoredKey()||'').trim();
let ai=apiKey?new GoogleGenAI({apiKey}):null;

function getGeminiErrorMessage(err) {
  const raw = String(err?.message || err || "Unknown Gemini error");
  const status = err?.status || err?.statusCode || err?.code;
  if (/API_KEY_INVALID|invalid api key|API key not valid|401|unauthorized/i.test(raw)) return "Gemini API Key 无效或未授权。";
  if (/PERMISSION_DENIED|403|permission/i.test(raw)) return "Gemini API 没有权限。";
  if (/RESOURCE_EXHAUSTED|429|quota|rate.?limit/i.test(raw)) return "Gemini 请求额度已达到上限。";
  if (/NOT_FOUND|404|model/i.test(raw)) return `Gemini 模型不可用：${GEMINI_MODEL}。`;
  return `Gemini 调用失败：${raw.slice(0, 500)}`;
}

app.get('/api/ai/status', (req, res) => {
  res.json({ok:true,provider:'Gemini',configured:!!apiKey&&!!ai,model:GEMINI_MODEL,editable_in_dashboard:true});
});

app.post('/api/ai/key',(req,res)=>{try{const key=String(req.body?.apiKey||'').trim();if(key.length<20)return res.status(400).json({error:'请填写有效的 Key。'});const e=encryptSecret(key);db.prepare(`INSERT INTO ai_secrets(id,encrypted_key,iv,auth_tag,updated_at) VALUES(1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=CURRENT_TIMESTAMP`).run(e.encrypted_key,e.iv,e.auth_tag);apiKey=key;ai=new GoogleGenAI({apiKey});res.json({ok:true,message:'Key 已保存。'});}catch(err){res.status(500).json({error:err.message});}});

app.post('/api/ai/key-test', async (req, res) => {
  try {
    if (!apiKey || !ai) return res.status(503).json({ ok: false, error: '服务器未配置 Key。' });
    const result = await ai.models.generateContent({ model: GEMINI_MODEL, contents: 'Reply with the single word OK.' });
    res.json({ ok: true, message: '连接成功。', preview: String(result.text || '').slice(0, 80) });
  } catch (err) { res.status(502).json({ ok: false, error: getGeminiErrorMessage(err) }); }
});

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

app.post('/api/social-search/batch-run', async (req, res) => {
  return res.status(409).json({ ok: false, error: '社交平台尚未连接官方 API。' });
});

const OSM_USER_AGENT = process.env.OSM_USER_AGENT || 'AILeadMaster/1.0';
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass.private.coffee/api/interpreter';
let lastNominatimRequestAt = 0;
async function nominatimGeocode(query) {
  const wait = Math.max(0, 1100 - (Date.now() - lastNominatimRequestAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastNominatimRequestAt = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query);
  const response = await fetch(url, { headers: { 'User-Agent': OSM_USER_AGENT, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`定位服务返回 HTTP ${response.status}`);
  const rows = await response.json();
  if (!rows.length) throw new Error('没有找到这个国家/城市。');
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
    const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80);
    const query = `[out:json][timeout:25];(nwr(around:5000,${location.lat},${location.lon})[name~"${safeKeyword}",i];);out center tags 100;`;
    const overpassResponse = await fetch(OVERPASS_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': OSM_USER_AGENT },
      body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(40000)
    });
    if (!overpassResponse.ok) throw new Error('OpenStreetMap 查询服务异常。');
    const payload = await overpassResponse.json();
    const label = `${city}, ${country}`;
    const results = (payload.elements || []).map(el => osmTagsToLead(el, label)).filter(Boolean);
    const unique = [...new Map(results.map(x => [x.external_id, x])).values()].slice(0, 100);
    
    const insert = db.prepare(`INSERT INTO leads (id,name,phone,source,center,created_at,external_id,category,address,website,email,latitude,longitude,maps_url)
      VALUES (@id,@name,@phone,@source,@center,@created_at,@external_id,@category,@address,@website,@email,@latitude,@longitude,@maps_url)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, category=excluded.category, address=excluded.address, website=excluded.website, email=excluded.email, latitude=excluded.latitude, longitude=excluded.longitude, maps_url=excluded.maps_url`);
    const saveMany = db.transaction(rows => rows.forEach(row => insert.run({ ...row, phone: row.phone || null, address: row.address || null, website: row.website || null, email: row.email || null })));
    saveMany(unique);
    res.json({ ok: true, provider: 'OpenStreetMap', location: location.display_name, searched: unique.length, saved: unique.length, results: unique, notice: '搜索完成' });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message || '地图搜索失败。' });
  }
});

app.get('/api/leads', (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT 500").all();
    res.json({ ok: true, total: rows.length, leads: rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/ai/chat-reply', async (req, res) => {
  const { customer_phone, customer_message, platform } = req.body || {};
  const phone = String(customer_phone || "").trim();
  const message = String(customer_message || "").trim();
  const channel = String(platform || "Website").trim();

  if (!message) return res.status(400).json({ ok: false, error: "客户消息不能为空" });
  if (!apiKey || !ai) {
    return res.status(503).json({ ok: false, error: "服务器未配置 Gemini API Key。", code: "GEMINI_KEY_MISSING" });
  }

  try {
    const now = new Date();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(now);
    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'customer', ?, ?)`).run(phone || 'Website Visitor', channel, message, now.toISOString());

    const currentConfig = db.prepare('SELECT system_prompt FROM ai_config WHERE id = 1').get();
    const userPromptCustom = currentConfig?.system_prompt || defaultPrompt;
    const systemInstruction = `${userPromptCustom}\nToday in Dubai is ${today}.\nReturn ONLY valid JSON with: {"reply":"string","detected_language":"string","has_booking_intent":false,"appointment_date":null,"appointment_time":null}`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `Customer message: ${message}`,
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

    const aiResult = JSON.parse(response.text);
    const aiReply = String(aiResult.reply || "").trim();
    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'ai', ?, ?)`).run(phone || 'Website Visitor', channel, aiReply, new Date().toISOString());

    let autoAppointmentCreated = false;
    let apptNumber = null;
    if (aiResult.has_booking_intent && aiResult.appointment_date && aiResult.appointment_time && phone) {
      apptNumber = 'APT-' + Date.now().toString().slice(-6);
      db.prepare(`INSERT INTO appointments (appointment_number, staff_id, phone, date, time, status, created_at) VALUES (?, 'Gemini Assistant', ?, ?, ?, 'Pending Confirmation', ?)`).run(apptNumber, phone, aiResult.appointment_date, aiResult.appointment_time, new Date().toISOString());
      autoAppointmentCreated = true;
    }

    res.json({ ok: true, provider: "Gemini", ai_reply: aiReply, auto_appointment_created: autoAppointmentCreated, appointment_number: apptNumber });
  } catch (error) {
    res.status(502).json({ ok: false, error: getGeminiErrorMessage(error) });
  }
});

app.get('/api/ai/chat-logs', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM chat_logs ORDER BY id DESC LIMIT 50').all();
    res.json(logs.reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 网页前端直通渲染（直接抹去登录框阻碍）
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Master - 智能美业 CRM</title>
  <style>
    :root{--bg:#f4f6ff;--surface:#fff;--ink:#18213b;--line:#e7eaf4;--primary:#635bff}
    body{font-family:Inter,sans-serif;background:var(--bg);margin:0;padding:22px;color:var(--ink)}
    .container{max-width:1440px;margin:0 auto 0 226px}
    .header-bar{background:#fff;border:1px solid var(--line);border-radius:22px;padding:18px 22px;margin-bottom:22px;display:flex;justify-content:space-between;align-items:center}
    .nav-buttons-scroll{position:fixed;left:18px;top:18px;bottom:18px;width:190px;display:flex;flex-direction:column;gap:8px;padding:18px 12px;background:#282b63;border-radius:22px}
    .nav-btn{background:transparent;color:#e7eaff;border:0;padding:12px;border-radius:12px;font-weight:700;cursor:pointer;text-align:left}
    .nav-btn:hover{background:rgba(255,255,255,0.2)}
    .card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:22px;margin-bottom:20px}
    .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:22px}
    .stat-card{padding:20px;border-radius:19px;color:#fff;background:linear-gradient(135deg,#4776f5,#6654df)}
    .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;align-items:end}
    .form-group{display:flex;flex-direction:column;gap:7px}
    .form-group input,.form-group select{padding:11px;background:#f8f9ff;border:1px solid #dfe4f2;border-radius:11px}
    button{padding:10px 14px;border:0;border-radius:10px;font-weight:800;cursor:pointer;background:#4f7df3;color:#fff}
    table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border-bottom:1px solid #edf0f7;padding:12px;text-align:left}th{background:#f3f5ff;font-size:11px}
  </style>
</head>
<body>
  <div class="nav-buttons-scroll">
    <div style="color:#c9d4ff;font-weight:900;padding:5px 10px 15px">LEAD MASTER</div>
    <button class="nav-btn" onclick="location.reload()">📊 刷新后台</button>
  </div>
  <div class="container">
    <div class="header-bar">
      <h2>🚀 AI Lead Master CRM (已免登直通版)</h2>
      <span style="color:#22c55e;font-weight:bold;">🟢 运行中</span>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><h4>总线索量</h4><div id="valTotalLeads" style="font-size:28px;font-weight:bold">0</div></div>
    </div>
    <div class="card">
      <h3>🤖 智能美业助理测试</h3>
      <div style="display:flex;gap:10px;margin-bottom:10px">
        <input type="text" id="chatPhone" placeholder="客户手机号" style="padding:10px;border:1px solid #ddd;border-radius:8px">
        <input type="text" id="chatMsg" placeholder="输入测试咨询，例如：预约明天下午3点剪发" style="flex:1;padding:10px;border:1px solid #ddd;border-radius:8px">
        <button onclick="sendMsg()">发送</button>
      </div>
      <div id="chatResult" style="background:#f8f9ff;padding:12px;border-radius:8px;min-height:50px;font-size:13px;color:#333">助理回复将显示在这里...</div>
    </div>
  </div>
  <script>
    async function loadStats(){
      try{
        const r = await fetch('/api/dashboard/stats').then(res=>res.json());
        document.getElementById('valTotalLeads').textContent = r.total || 0;
      }catch(e){}
    }
    async function sendMsg(){
      const phone = document.getElementById('chatPhone').value;
      const message = document.getElementById('chatMsg').value;
      const resDiv = document.getElementById('chatResult');
      resDiv.textContent = "正在请求 AI...";
      try{
        const r = await fetch('/api/ai/chat-reply', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ customer_phone: phone, customer_message: message })
        }).then(res=>res.json());
        resDiv.innerHTML = "<b>AI 回复：</b>" + r.ai_reply + (r.auto_appointment_created ? " <span style='color:green'>[已自动生成预约单: "+r.appointment_number+"]</span>" : "");
        loadStats();
      }catch(e){ resDiv.textContent = "请求失败: " + e.message; }
    }
    loadStats();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
