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
    access_token TEXT,
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

// 兼容字段扩展
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

const defaultWelcome = "👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？";
const defaultPrompt = "You are a senior beauty consultant & personal assistant for a high-end beauty brand in the Middle East (Dubai, Riyadh, Doha). Professional, warm, and attentive. Never call yourself AI Sales.";

const existingConfig = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO ai_config (id, welcome_msg, system_prompt) VALUES (1, ?, ?)').run(defaultWelcome, defaultPrompt);
}

app.use(express.json());

const AUTH_SECRET = process.env.APP_ENCRYPTION_KEY || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// 【取消登录拦截】直通已认证状态
app.get('/api/auth/status', (req, res) => { res.json({ setupRequired: false, authenticated: true, username: 'dubai' }); });
app.post('/api/auth/setup', (req, res) => { res.json({ ok: true, username: 'dubai' }); });
app.post('/api/auth/login', (req, res) => { res.json({ ok: true, username: 'dubai' }); });
app.post('/api/auth/logout', (req, res) => { res.json({ ok: true }); });
app.use('/api', (req, res, next) => { next(); });

// Gemini Key 管理
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENC_KEY = crypto.createHash('sha256').update(AUTH_SECRET).digest();
function encryptSecret(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',ENC_KEY,iv),data=Buffer.concat([c.update(value,'utf8'),c.final()]);return{encrypted_key:data.toString('base64'),iv:iv.toString('base64'),auth_tag:c.getAuthTag().toString('base64')};}
function decryptSecret(row){const d=crypto.createDecipheriv('aes-256-gcm',ENC_KEY,Buffer.from(row.iv,'base64'));d.setAuthTag(Buffer.from(row.auth_tag,'base64'));return Buffer.concat([d.update(Buffer.from(row.encrypted_key,'base64')),d.final()]).toString('utf8');}
function loadStoredKey(){try{const r=db.prepare('SELECT encrypted_key,iv,auth_tag FROM ai_secrets WHERE id=1').get();return r?decryptSecret(r):'';}catch{return '';}}
let apiKey=(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||loadStoredKey()||'').trim();
let ai=apiKey?new GoogleGenAI({apiKey}):null;

function getGeminiErrorMessage(err) {
  const raw = String(err?.message || err || "Unknown Gemini error");
  if (/API_KEY_INVALID|invalid api key|401/i.test(raw)) return "Gemini API Key 无效或未授权。";
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(raw)) return "Gemini 请求额度达到上限。";
  return `Gemini 调用失败：${raw.slice(0, 300)}`;
}

app.get('/api/ai/status', (req, res) => {
  res.json({ok:true,provider:'Gemini',configured:!!apiKey&&!!ai,model:GEMINI_MODEL,editable_in_dashboard:true});
});

app.post('/api/ai/key',(req,res)=>{
  try{
    const key=String(req.body?.apiKey||'').trim();
    if(key.length<20)return res.status(400).json({error:'请填写有效的 Key。'});
    const e=encryptSecret(key);
    db.prepare(`INSERT INTO ai_secrets(id,encrypted_key,iv,auth_tag,updated_at) VALUES(1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=CURRENT_TIMESTAMP`).run(e.encrypted_key,e.iv,e.auth_tag);
    apiKey=key;
    ai=new GoogleGenAI({apiKey});
    res.json({ok:true,message:'Gemini Key 已加密保存并生效。'});
  }catch(err){res.status(500).json({error:err.message});}
});

app.post('/api/ai/key-test', async (req, res) => {
  try {
    if (!apiKey || !ai) return res.status(503).json({ ok: false, error: '服务器未配置 Key。' });
    const result = await ai.models.generateContent({ model: GEMINI_MODEL, contents: 'Reply with OK.' });
    res.json({ ok: true, message: '连接成功，Gemini 已准备就绪！', preview: String(result.text || '').slice(0, 50) });
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

// 社媒账号管理（支持 180+ 矩阵号批量录入与隔离）
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

// OpenStreetMap 真实商家地图数据接口
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
  if (!rows.length) throw new Error('没有找到这个国家/城市，请换成英文再试（如 Dubai）。');
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
    const query = `[out:json][timeout:25];(nwr(around:5000,${location.lat},${location.lon})[name~"${safeKeyword}",i];nwr(around:5000,${location.lat},${location.lon})[shop~"${safeKeyword}",i];nwr(around:5000,${location.lat},${location.lon})[amenity~"${safeKeyword}",i];);out center tags 100;`;
    const overpassResponse = await fetch(OVERPASS_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': OSM_USER_AGENT },
      body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(40000)
    });
    if (!overpassResponse.ok) throw new Error('OpenStreetMap 查询服务异常，请稍后再试。');
    const payload = await overpassResponse.json();
    const label = `${city}, ${country}`;
    const results = (payload.elements || []).map(el => osmTagsToLead(el, label)).filter(Boolean);
    const unique = [...new Map(results.map(x => [x.external_id, x])).values()].slice(0, 100);

    const insert = db.prepare(`INSERT INTO leads (id,name,phone,source,center,created_at,external_id,category,address,website,email,latitude,longitude,maps_url)
      VALUES (@id,@name,@phone,@source,@center,@created_at,@external_id,@category,@address,@website,@email,@latitude,@longitude,@maps_url)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, category=excluded.category, address=excluded.address, website=excluded.website, email=excluded.email, latitude=excluded.latitude, longitude=excluded.longitude, maps_url=excluded.maps_url`);
    const saveMany = db.transaction(rows => rows.forEach(row => insert.run({ ...row, phone: row.phone || null, address: row.address || null, website: row.website || null, email: row.email || null })));
    saveMany(unique);
    res.json({ ok: true, provider: 'OpenStreetMap', location: location.display_name, searched: unique.length, saved: unique.length, results: unique });
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

// Gemini AI 客服与精准意图识别
app.post('/api/ai/chat-reply', async (req, res) => {
  const { customer_phone, customer_message, platform } = req.body || {};
  const phone = String(customer_phone || "").trim();
  const message = String(customer_message || "").trim();
  const channel = String(platform || "Website").trim();

  if (!message) return res.status(400).json({ ok: false, error: "客户消息不能为空" });
  if (!apiKey || !ai) {
    return res.status(503).json({ ok: false, error: "服务器未配置 Gemini API Key，请在下方【Gemini AI 连接状态】卡片中保存 Key。", code: "GEMINI_KEY_MISSING" });
  }

  try {
    const now = new Date();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(now);
    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'customer', ?, ?)`).run(phone || 'Website Visitor', channel, message, now.toISOString());

    const currentConfig = db.prepare('SELECT system_prompt FROM ai_config WHERE id = 1').get();
    const userPromptCustom = currentConfig?.system_prompt || defaultPrompt;
    const systemInstruction = `${userPromptCustom}

You are the customer service assistant for a beauty salon business serving Dubai/UAE. Detect the language of each incoming customer message and reply in that exact language (English, Arabic, Chinese, etc.).
Today in Dubai is ${today}.
Return ONLY valid JSON with exactly these keys: {"reply":"string","detected_language":"language name","has_booking_intent":false,"appointment_date":null,"appointment_time":null}. Use YYYY-MM-DD for date and HH:MM (24-hour) for time.`;

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

    res.json({ ok: true, provider: "Gemini", model: GEMINI_MODEL, detected_language: aiResult.detected_language, ai_reply: aiReply, auto_appointment_created: autoAppointmentCreated, appointment_number: apptNumber });
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

// 全功能直通 HTML 页面（免登无遮罩，修正发送按钮绑定）
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Master - 智能美业 CRM</title>
  <style>
    :root{--bg:#f4f6ff;--surface:#fff;--ink:#18213b;--line:#e7eaf4;--primary:#635bff}
    *{box-sizing:border-box}
    body{font-family:Inter,sans-serif;background:var(--bg);margin:0;padding:22px;color:var(--ink)}
    .container{max-width:1440px;margin:0 auto 0 226px}
    .header-bar{background:#fff;border:1px solid var(--line);border-radius:22px;padding:18px 22px;margin-bottom:22px;display:flex;justify-content:space-between;align-items:center}
    .nav-buttons-scroll{position:fixed;z-index:50;left:18px;top:18px;bottom:18px;width:190px;display:flex;flex-direction:column;gap:8px;padding:18px 12px;background:linear-gradient(165deg,#282b63,#4443a8 55%,#287ca5);border-radius:22px}
    .nav-buttons-scroll:before{content:"LEAD MASTER";color:#c9d4ff;font-size:11px;font-weight:900;letter-spacing:2px;padding:5px 10px 15px}
    .nav-btn{width:100%;text-align:left;background:transparent;color:#e7eaff;border:0;padding:12px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer}
    .nav-btn:hover{background:rgba(255,255,255,.2);color:#fff}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:22px}
    .stat-card{padding:20px;border-radius:19px;color:#fff;min-height:130px;display:flex;flex-direction:column;justify-content:space-between}
    .stat-card.blue{background:linear-gradient(135deg,#4776f5,#6654df)}.stat-card.purple{background:linear-gradient(135deg,#a855f7,#713bd5)}.stat-card.pink{background:linear-gradient(135deg,#f472b6,#d94691)}.stat-card.emerald{background:linear-gradient(135deg,#19c79a,#079b83)}
    .stat-card h4{margin:0;font-size:12px}.stat-card .num{font-size:32px;font-weight:850}
    .card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:22px;margin-bottom:20px}
    .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;align-items:end}
    .form-group{display:flex;flex-direction:column;gap:7px}.form-group label{font-size:12px;font-weight:700;color:#6b7590}
    .form-group input,.form-group select,.form-group textarea{padding:11px;background:#f8f9ff;border:1px solid #dfe4f2;border-radius:11px;outline:none}
    button{padding:10px 14px;border:0;border-radius:10px;font-weight:800;cursor:pointer;background:#4f7df3;color:#fff}
    button:hover{filter:brightness(1.05)}
    .table-responsive{width:100%;overflow-x:auto;border:1px solid var(--line);border-radius:13px;margin-top:12px}
    table{width:100%;border-collapse:collapse;font-size:13px}th,td{border-bottom:1px solid #edf0f7;padding:12px;text-align:left}th{background:#f3f5ff;font-size:11px}
    .chat-box{height:300px;background:#f8f9ff;border:1px solid #dfe4f2;border-radius:15px;padding:15px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
    .msg{padding:10px 13px;border-radius:14px;max-width:85%;font-size:13px;line-height:1.5}.msg.customer{background:#fff;align-self:flex-start;border:1px solid #e0e6f4}.msg.ai{background:linear-gradient(135deg,#665cf0,#398bdc);color:#fff;align-self:flex-end}
    @media(max-width:820px){.container{margin:0}.nav-buttons-scroll{position:relative;width:100%;height:auto;flex-direction:row;overflow-x:auto;margin-bottom:15px}}
  </style>
</head>
<body>
  <div class="nav-buttons-scroll">
    <button class="nav-btn" onclick="scrollToSec('sec-dashboard')">📊 仪表盘</button>
    <button class="nav-btn" onclick="scrollToSec('sec-ai-chat')">🤖 美业助理</button>
    <button class="nav-btn" onclick="scrollToSec('sec-ai-edit')">✍️ 助理设置</button>
    <button class="nav-btn" onclick="scrollToSec('sec-gemini-key')">🔐 Gemini 设置</button>
    <button class="nav-btn" onclick="scrollToSec('sec-maps-leads')">🗺️ 地图商家</button>
    <button class="nav-btn" onclick="scrollToSec('sec-social-acc')">👤 社媒配置</button>
    <button class="nav-btn" onclick="scrollToSec('sec-search-task')">🌐 搜客任务</button>
    <button class="nav-btn" onclick="scrollToSec('sec-appointments')">📅 预约列表</button>
  </div>

  <div class="container">
    <div class="header-bar" id="sec-dashboard">
      <h2>🚀 AI Lead Master CRM <span style="font-size:12px;background:#10b981;color:#fff;padding:3px 8px;border-radius:6px">免密直通版</span></h2>
      <button onclick="location.reload()">🔄 刷新页面</button>
    </div>

    <!-- 📊 看板 -->
    <div class="stats-grid">
      <div class="stat-card blue"><div><h4>📦 总线索量</h4><div class="num" id="valTotalLeads">0</div></div></div>
      <div class="stat-card purple"><div><h4>📘 Facebook</h4><div class="num" id="valFbLeads">0</div></div></div>
      <div class="stat-card pink"><div><h4>📸 Instagram</h4><div class="num" id="valIgLeads">0</div></div></div>
      <div class="stat-card emerald"><div><h4>🎵 TikTok</h4><div class="num" id="valTkLeads">0</div></div></div>
    </div>

    <!-- 🤖 AI美业助理工作台 -->
    <div class="card" id="sec-ai-chat">
      <h3 style="color:#0ea5e9;">🤖 智能美业助理与预约工作台</h3>
      <div class="chat-box" id="chatLogsContainer">
        <div class="msg ai" id="aiWelcomeBox">👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？</div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input type="text" id="chatPhoneInput" placeholder="客户手机号" style="width:160px;padding:10px;border:1px solid #ccc;border-radius:8px">
        <input type="text" id="chatMsgInput" placeholder="输入测试咨询 (如: 帮我预约明天下午3点剪发)" style="flex:1;padding:10px;border:1px solid #ccc;border-radius:8px" onkeypress="if(event.key==='Enter') sendAiMessage()">
        <button onclick="sendAiMessage()" style="background:#0ea5e9">发送给助理</button>
      </div>
    </div>

    <!-- ✍️ 助理设置 -->
    <div class="card" id="sec-ai-edit">
      <h3 style="color:#a855f7;">✍️ 自定义助理打招呼语与人设</h3>
      <form id="aiConfigForm" style="display:flex;flex-direction:column;gap:10px">
        <div class="form-group"><label>打招呼语：</label><input type="text" id="cfgWelcomeMsg" required></div>
        <div class="form-group"><label>人设 Prompt：</label><textarea id="cfgSystemPrompt" rows="3" required></textarea></div>
        <button type="submit" style="background:#a855f7;width:fit-content">💾 保存人设</button>
      </form>
    </div>

    <!-- 🔐 Key设置 -->
    <div class="card" id="sec-gemini-key">
      <h3 style="color:#10b981;">🔐 Gemini AI Key 配置</h3>
      <div style="display:flex;gap:8px;margin-top:10px">
        <input id="geminiApiKeyInput" type="password" placeholder="粘贴 Google AI Studio API Key" style="flex:1;padding:10px;border:1px solid #ccc;border-radius:8px">
        <button onclick="saveGeminiKey()" style="background:#10b981">保存 Key</button>
        <button onclick="testGeminiKey()" style="background:#635bff">测试连接</button>
      </div>
      <p id="geminiKeyStatus" style="margin-top:8px;font-size:12px;color:#64748b">状态检测中...</p>
    </div>

    <!-- 🗺️ 地图商家搜索 -->
    <div class="card" id="sec-maps-leads">
      <h3 style="color:#0284c7;">🗺️ 免费真实商家获客（OpenStreetMap）</h3>
      <form id="mapsLeadForm" class="form-grid">
        <div class="form-group"><label>国家</label><input id="mapsCountry" value="United Arab Emirates" required></div>
        <div class="form-group"><label>城市</label><input id="mapsCity" value="Dubai" required></div>
        <div class="form-group"><label>商家关键词</label><input id="mapsKeyword" placeholder="salon / spa / hotel" required></div>
        <button type="submit" id="mapsSearchBtn" style="background:#0284c7">🔎 搜索真实商家</button>
      </form>
      <p id="mapsSearchStatus" style="margin-top:8px;font-size:12px;color:#64748b"></p>
      <div class="table-responsive"><table><thead><tr><th>商家名称</th><th>类别</th><th>真实电话</th><th>网站</th><th>地址</th><th>地图链接</th></tr></thead><tbody id="mapsLeadResults"><tr><td colspan="6" style="text-align:center;color:#64748b">尚未搜索</td></tr></tbody></table></div>
    </div>

    <!-- 👤 社媒配置 -->
    <div class="card" id="sec-social-acc">
      <h3>👤 社媒平台账号隔离配置 (支持180+矩阵号批量管理)</h3>
      <form id="accountForm" class="form-grid">
        <div class="form-group"><label>平台</label><select id="accPlatform"><option>TikTok</option><option>Facebook</option><option>Instagram</option><option>WhatsApp</option></select></div>
        <div class="form-group"><label>备注标签 (如: TikTok-Matrix-01)</label><input id="accLabel" placeholder="TikTok-01" required></div>
        <div class="form-group"><label>Profile/Token ID</label><input id="accProfileId" placeholder="tk_dubai_001" required></div>
        <button type="submit">🔗 绑定账号</button>
      </form>
      <div class="table-responsive"><table><thead><tr><th>ID</th><th>平台</th><th>备注</th><th>Profile</th><th>操作</th></tr></thead><tbody id="accountTableList"></tbody></table></div>
    </div>

    <!-- 🌐 搜客任务 -->
    <div class="card" id="sec-search-task">
      <h3>🌐 全自动社媒定向搜客与评论区互动任务</h3>
      <form id="socialSearchForm" class="form-grid">
        <div class="form-group"><label>矩阵账号</label><select id="ssAccount" required><option value="">选择账号</option></select></div>
        <div class="form-group"><label>平台</label><input id="ssPlatform" readonly style="background:#eee"></div>
        <div class="form-group"><label>目标评论区关键词</label><input id="ssKeywords" placeholder="Dubai Salon / Hair style" required></div>
        <button type="submit">💾 创建任务</button>
      </form>
      <div class="table-responsive"><table><thead><tr><th>平台</th><th>账号</th><th>关键词</th><th>操作</th></tr></thead><tbody id="socialSearchList"></tbody></table></div>
    </div>

    <!-- 📅 预约列表 -->
    <div class="card" id="sec-appointments">
      <h3 style="color:#16a34a;">📅 智能预约排班列表</h3>
      <form id="appointmentForm" class="form-grid">
        <div class="form-group"><label>技师</label><input id="apptStaff" placeholder="Sarah" required></div>
        <div class="form-group"><label>客户电话</label><input id="apptPhone" placeholder="手机号" required></div>
        <div class="form-group"><label>日期</label><input type="date" id="apptDate" required></div>
        <div class="form-group"><label>时间</label><input type="time" id="apptTime" required></div>
        <button type="submit" style="background:#16a34a">✅ 生成预约单</button>
      </form>
      <div class="table-responsive"><table><thead><tr><th>单号</th><th>技师</th><th>电话</th><th>时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="appointmentList"></tbody></table></div>
    </div>
  </div>

  <script>
    function scrollToSec(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }
    async function api(url, options = {}) {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    }

    window.addEventListener("DOMContentLoaded", () => {
      loadAll();
      checkGeminiStatus();
    });

    async function loadAll() {
      loadStats(); loadAiConfig(); loadAccounts(); loadAppointments(); loadSearchTasks(); loadChatLogs(); loadStoredLeads();
    }

    async function loadStats() {
      try {
        const s = await api("/api/dashboard/stats");
        document.getElementById("valTotalLeads").textContent = s.total;
        document.getElementById("valFbLeads").textContent = s.fb;
        document.getElementById("valIgLeads").textContent = s.ig;
        document.getElementById("valTkLeads").textContent = s.tk;
      } catch(e){}
    }

    async function loadAiConfig() {
      try {
        const cfg = await api("/api/ai/config");
        document.getElementById("cfgWelcomeMsg").value = cfg.welcome_msg || "";
        document.getElementById("cfgSystemPrompt").value = cfg.system_prompt || "";
        document.getElementById("aiWelcomeBox").textContent = cfg.welcome_msg || "";
      } catch(e){}
    }

    document.getElementById("aiConfigForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/ai/config", { method: "POST", body: JSON.stringify({ welcome_msg: document.getElementById("cfgWelcomeMsg").value, system_prompt: document.getElementById("cfgSystemPrompt").value }) });
        alert("助理人设保存成功！");
      } catch(err){ alert(err.message); }
    });

    async function saveGeminiKey() {
      const key = document.getElementById("geminiApiKeyInput").value.trim();
      if (!key) return alert("请输入有效的 Key");
      try {
        const res = await api("/api/ai/key", { method: "POST", body: JSON.stringify({ apiKey: key }) });
        alert(res.message);
        checkGeminiStatus();
      } catch(e){ alert(e.message); }
    }

    async function checkGeminiStatus() {
      try {
        const res = await api("/api/ai/status");
        document.getElementById("geminiKeyStatus").textContent = res.configured ? ("🟢 状态：已配置 Gemini API (" + res.model + ")") : "🔴 状态：未配置 Key，请填入后点击保存。";
      } catch(e){}
    }

    async function testGeminiKey() {
      try {
        const res = await api("/api/ai/key-test", { method: "POST", body: JSON.stringify({}) });
        alert(res.message + "\n预览回复：" + res.preview);
      } catch(e){ alert(e.message); }
    }

    async function sendAiMessage() {
      const inputs = document.querySelectorAll("#sec-ai-chat input");
      const phoneInput = inputs[0];
      const msgInput = inputs[1];
      const container = document.getElementById("chatLogsContainer");

      const phone = phoneInput ? phoneInput.value.trim() : "";
      const message = msgInput ? msgInput.value.trim() : "";
      if (!message) return alert("请输入要测试发送的内容");

      container.innerHTML += '<div class="msg customer">[' + (phone || '访客') + '] ' + message + '</div>';
      if (msgInput) msgInput.value = "";
      container.scrollTop = container.scrollHeight;

      const loadingDiv = document.createElement("div");
      loadingDiv.className = "msg ai";
      loadingDiv.id = "tempAiLoading";
      loadingDiv.textContent = "🤖 AI 正在实时思考并调用大模型中……";
      container.appendChild(loadingDiv);
      container.scrollTop = container.scrollHeight;

      try {
        const res = await api("/api/ai/chat-reply", { method: "POST", body: JSON.stringify({ customer_phone: phone, customer_message: message }) });
        document.getElementById("tempAiLoading")?.remove();
        container.innerHTML += '<div class="msg ai">' + res.ai_reply + '</div>';
        container.scrollTop = container.scrollHeight;
        if (res.auto_appointment_created) {
          alert("🎉 AI 已识别预约意向，自动创建单号：" + res.appointment_number);
          loadAppointments(); loadStats();
        }
      } catch(err) {
        document.getElementById("tempAiLoading")?.remove();
        container.innerHTML += '<div class="msg customer" style="background:#fee2e2;color:#991b1b">❌ 发送失败：' + err.message + '</div>';
        container.scrollTop = container.scrollHeight;
      }
    }

    async function loadChatLogs() {
      try {
        const logs = await api("/api/ai/chat-logs");
        if (logs.length > 0) {
          const container = document.getElementById("chatLogsContainer");
          container.innerHTML = "";
          logs.forEach(l => {
            container.innerHTML += '<div class="msg ' + (l.sender === 'ai' ? 'ai' : 'customer') + '">[' + l.customer_phone + '] ' + l.message + '</div>';
          });
          container.scrollTop = container.scrollHeight;
        }
      } catch(e){}
    }

    document.getElementById("mapsLeadForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("mapsSearchBtn");
      const status = document.getElementById("mapsSearchStatus");
      btn.disabled = true; status.textContent = "正在实时检索 OpenStreetMap 商家地图数据...";
      try {
        const data = await api("/api/maps/search", { method: "POST", body: JSON.stringify({ country: document.getElementById("mapsCountry").value, city: document.getElementById("mapsCity").value, keyword: document.getElementById("mapsKeyword").value }) });
        status.textContent = "搜索完成，成功导入/更新 " + data.saved + " 条公开真实商家记录。";
        loadStoredLeads(); loadStats();
      } catch(err){ status.textContent = "搜索失败：" + err.message; }
      finally { btn.disabled = false; }
    });

    async function loadStoredLeads() {
      try {
        const res = await api("/api/leads");
        const tbody = document.getElementById("mapsLeadResults");
        tbody.innerHTML = "";
        if (!res.leads || !res.leads.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b">暂无搜索记录</td></tr>'; return; }
        res.leads.forEach(l => {
          tbody.innerHTML += '<tr><td><b>' + l.name + '</b></td><td>' + l.category + '</td><td>' + (l.phone || '—') + '</td><td>' + (l.website ? '<a href="'+l.website+'" target="_blank">官网</a>' : '—') + '</td><td>' + (l.address || '—') + '</td><td><a href="' + l.maps_url + '" target="_blank">Google Maps</a></td></tr>';
        });
      } catch(e){}
    }

    async function loadAccounts() {
      try {
        const accs = await api("/api/social-accounts");
        const tbody = document.getElementById("accountTableList");
        const sel = document.getElementById("ssAccount");
        tbody.innerHTML = ""; sel.innerHTML = '<option value="">选择账号</option>';
        accs.forEach(a => {
          sel.innerHTML += '<option value="' + a.id + '" data-platform="' + a.platform + '">' + a.platform + ' - ' + a.label + '</option>';
          tbody.innerHTML += '<tr><td>' + a.id + '</td><td>' + a.platform + '</td><td><b>' + a.label + '</b></td><td><code>' + a.profile_id + '</code></td><td><button onclick="deleteAccount(' + a.id + ')" style="background:#ef4444;padding:3px 8px;font-size:12px">解绑</button></td></tr>';
        });
      } catch(e){}
    }

    document.getElementById("accountForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/social-accounts", { method: "POST", body: JSON.stringify({ platform: document.getElementById("accPlatform").value, label: document.getElementById("accLabel").value, profile_id: document.getElementById("accProfileId").value }) });
        alert("账号绑定成功！");
        e.target.reset(); loadAccounts();
      } catch(err){ alert(err.message); }
    });

    async function deleteAccount(id) {
      if (!confirm("确定要解绑该账号吗？")) return;
      try { await api("/api/social-accounts/" + id, { method: "DELETE" }); loadAccounts(); } catch(err){ alert(err.message); }
    }

    document.getElementById("ssAccount").addEventListener("change", (e) => {
      const opt = e.target.selectedOptions[0];
      if (opt && opt.dataset.platform) document.getElementById("ssPlatform").value = opt.dataset.platform;
    });

    async function loadSearchTasks() {
      try {
        const tasks = await api("/api/social-search");
        const tbody = document.getElementById("socialSearchList");
        tbody.innerHTML = "";
        tasks.forEach(t => {
          tbody.innerHTML += '<tr><td>' + t.platform + '</td><td>ID:' + t.account_id + '</td><td><code>' + t.keywords + '</code></td><td><button onclick="runTask(' + t.id + ')" style="padding:3px 8px;font-size:12px">执行搜客</button> <button onclick="deleteTask(' + t.id + ')" style="background:#ef4444;padding:3px 8px;font-size:12px">删除</button></td></tr>';
        });
      } catch(e){}
    }

    document.getElementById("socialSearchForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/social-search", { method: "POST", body: JSON.stringify({ account_id: Number(document.getElementById("ssAccount").value), platform: document.getElementById("ssPlatform").value, keywords: document.getElementById("ssKeywords").value }) });
        alert("任务创建成功！");
        e.target.reset(); loadSearchTasks();
      } catch(err){ alert(err.message); }
    });

    async function runTask(id) {
      try { const res = await api("/api/social-search/" + id + "/run", { method: "POST" }); window.open(res.url, '_blank'); } catch(err){ alert(err.message); }
    }

    async function deleteTask(id) {
      if (!confirm("确认删除？")) return;
      try { await api("/api/social-search/" + id, { method: "DELETE" }); loadSearchTasks(); } catch(err){ alert(err.message); }
    }

    async function loadAppointments() {
      try {
        const appts = await api("/api/appointments");
        const tbody = document.getElementById("appointmentList");
        tbody.innerHTML = "";
        appts.forEach(a => {
          tbody.innerHTML += '<tr><td><b style="color:#0284c7">' + a.appointment_number + '</b></td><td>' + a.staff_id + '</td><td>' + a.phone + '</td><td>' + a.date + ' ' + a.time + '</td><td><span style="color:#16a34a">' + a.status + '</span></td><td><a href="https://wa.me/' + a.phone.replace(/[^0-9]/g,"") + '" target="_blank"><button style="background:#25d366;padding:3px 8px;font-size:12px">💬 WA</button></a> <button onclick="deleteAppt(\'' + a.appointment_number + '\')" style="background:#ef4444;padding:3px 8px;font-size:12px">取消</button></td></tr>';
        });
      } catch(e){}
    }

    document.getElementById("appointmentForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/appointments", { method: "POST", body: JSON.stringify({ staff_id: document.getElementById("apptStaff").value, phone: document.getElementById("apptPhone").value, date: document.getElementById("apptDate").value, time: document.getElementById("apptTime").value }) });
        alert("预约创建成功！");
        e.target.reset(); loadAppointments(); loadStats();
      } catch(err){ alert(err.message); }
    });

    async function deleteAppt(no) {
      if (!confirm("确认取消此预约？")) return;
      try { await api("/api/appointments/" + no, { method: "DELETE" }); loadAppointments(); loadStats(); } catch(err){ alert(err.message); }
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
