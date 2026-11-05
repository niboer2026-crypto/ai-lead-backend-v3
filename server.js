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

// 【免登录直通】直接返回已认证状态，不再拦截
app.get('/api/auth/status', (req, res) => { res.json({ setupRequired: false, authenticated: true, username: 'dubai' }); });
app.post('/api/auth/setup', (req, res) => { res.json({ ok: true, username: 'dubai' }); });
app.post('/api/auth/login', (req, res) => { res.json({ ok: true, username: 'dubai' }); });
app.post('/api/auth/logout', (req, res) => { res.json({ ok: true }); });
app.use('/api', (req, res, next) => { next(); });

// Gemini Key 配置
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
  return res.status(409).json({ ok: false, error: '社交平台尚未连接官方授权 API。' });
});

// OpenStreetMap 真实商家地图抓取
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
    res.json({ ok: true, provider: 'OpenStreetMap', attribution: '© OpenStreetMap contributors', location: location.display_name, searched: unique.length, saved: unique.length, results: unique, notice: '搜索完成' });
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

// Gemini 真实 AI 智能客服与排班意图识别
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
    const systemInstruction = `${userPromptCustom}

You are the customer service assistant for a beauty salon business serving Dubai/UAE. Detect the language of each incoming customer message and reply in that exact language. Support any language, including English, Arabic, Chinese, Nepali, Hindi, French, Urdu and others. Be warm, concise, professional and helpful.
Today in Dubai is ${today}.
Return ONLY valid JSON with exactly these keys: {"reply":"string","detected_language":"language name","has_booking_intent":false,"appointment_date":null,"appointment_time":null}. Use YYYY-MM-DD for date and HH:MM (24-hour) for time.`;

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

// 完整带前端 UI 视图的渲染（完全免登录直通）
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
    body{font-family:Inter,sans-serif;background:var(--bg);margin:0;padding:22px;color:var(--ink)}
    .container{max-width:1440px;margin:0 auto 0 226px}
    .header-bar{background:#fff;border:1px solid var(--line);border-radius:22px;padding:18px 22px;margin-bottom:22px;box-shadow:var(--shadow);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
    h2{color:#252b55;margin:0;font-size:23px}h3{color:#283252;margin:0 0 16px;font-size:17px;font-weight:800}
    .nav-buttons-scroll{position:fixed;z-index:50;left:18px;top:18px;bottom:18px;width:190px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding:18px 12px;background:linear-gradient(165deg,#282b63,#4443a8 55%,#287ca5);border-radius:22px}
    .nav-buttons-scroll:before{content:"LEAD MASTER";color:#c9d4ff;font-size:11px;font-weight:900;letter-spacing:2px;padding:5px 10px 15px}
    .nav-btn{width:100%;text-align:left;background:transparent;color:#e7eaff;border:0;padding:12px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer}
    .nav-btn:hover{background:rgba(255,255,255,.2);color:#fff}
    .lang-btn{background:linear-gradient(135deg,#635bff,#9a5cff);color:#fff;border:0;padding:9px 15px;border-radius:12px;font-size:12px;font-weight:800;cursor:pointer}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:22px}
    .stat-card{padding:20px;border-radius:19px;color:#fff;display:flex;flex-direction:column;justify-content:space-between;min-height:145px}
    .stat-card.blue{background:linear-gradient(135deg,#4776f5,#6654df)}.stat-card.purple{background:linear-gradient(135deg,#a855f7,#713bd5)}.stat-card.pink{background:linear-gradient(135deg,#f472b6,#d94691)}.stat-card.emerald{background:linear-gradient(135deg,#19c79a,#079b83)}
    .stat-card h4{margin:0 0 9px;font-size:12px;opacity:.94}.stat-card .num{font-size:32px;font-weight:850;margin-bottom:12px}
    .card{background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:20px;padding:22px;margin-bottom:20px;box-shadow:var(--shadow)}
    .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;align-items:end}.form-group{display:flex;flex-direction:column;gap:7px}.form-group label{font-weight:750;font-size:12px;color:#6b7590}
    .form-group input,.form-group select,.form-group textarea,#chatPhoneInput,#chatMsgInput{padding:11px 13px;background:#f8f9ff;border:1px solid #dfe4f2;color:#202944;border-radius:11px;font-size:14px;outline:none;width:100%}
    button{padding:10px 14px;border:0;border-radius:10px;font-weight:800;cursor:pointer;font-size:13px}
    button.primary{background:linear-gradient(135deg,#4f7df3,#6256dc);color:#fff}button.secondary{background:linear-gradient(135deg,#8b96ad,#64718d);color:#fff}button.success{background:linear-gradient(135deg,#20c997,#079b78);color:#fff}button.danger{background:linear-gradient(135deg,#fb7185,#e04461);color:#fff}button.whatsapp{background:linear-gradient(135deg,#25d366,#128c7e);color:#fff}button.purple-btn{background:linear-gradient(135deg,#a855f7,#7046d8);color:#fff}
    .table-responsive{width:100%;overflow-x:auto;border:1px solid var(--line);border-radius:13px}table{width:100%;border-collapse:collapse;margin:0;font-size:13px;min-width:620px}th,td{border-bottom:1px solid #edf0f7;padding:12px;text-align:left}th{background:#f3f5ff;font-weight:800;color:#5c63a5;font-size:10px}tr:nth-child(even){background:#fbfcff}
    .badge{padding:4px 9px;border-radius:20px;font-size:11px;font-weight:800;display:inline-block}.badge.fb{background:#e7efff;color:#2459c5}.badge.ig{background:#ffe8f3;color:#bd2872}.badge.tk{background:#edf0f4;color:#273044}
    .chat-box{height:330px;background:linear-gradient(180deg,#f8f9ff,#f0f5ff);border:1px solid #e0e6f4;border-radius:15px;padding:15px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-bottom:13px}
    .msg{padding:10px 13px;border-radius:14px;max-width:85%;font-size:13px;line-height:1.55;word-break:break-word}
    .msg.customer{background:#fff;color:#34405c;align-self:flex-start;border:1px solid #e5eaf4}.msg.ai{background:linear-gradient(135deg,#665cf0,#398bdc);color:#fff;align-self:flex-end}
    .chat-input-group{display:flex;gap:8px;flex-wrap:wrap}
    @media(max-width:820px){.container{margin:0}.nav-buttons-scroll{position:relative;width:100%;height:auto;flex-direction:row;overflow-x:auto;margin-bottom:15px}.stats-grid{grid-template-columns:repeat(2,1fr)}}
  </style>
</head>
<body>
  <div class="nav-buttons-scroll">
    <button class="nav-btn" onclick="scrollToSec('sec-dashboard')">📊 仪表盘</button>
    <button class="nav-btn" onclick="scrollToSec('sec-ai-chat')">🤖 美业助理</button>
    <button class="nav-btn" onclick="scrollToSec('sec-ai-edit')">✍️ 助理设置</button>
    <button class="nav-btn" onclick="scrollToSec('sec-maps-leads')">🗺️ 地图商家</button>
    <button class="nav-btn" onclick="scrollToSec('sec-social-acc')">👤 社媒配置</button>
    <button class="nav-btn" onclick="scrollToSec('sec-search-task')">🌐 搜客任务</button>
    <button class="nav-btn" onclick="scrollToSec('sec-appointments')">📅 预约列表</button>
  </div>

  <div class="container" id="mainApp">
    <div class="header-bar" id="sec-dashboard">
      <h2>🚀 AI Lead Master CRM <span style="font-size:12px;background:#10b981;color:#fff;padding:2px 8px;border-radius:6px">已免密直通版</span></h2>
      <button class="lang-btn" onclick="toggleLanguage()">🌐 EN / 中文</button>
    </div>

    <!-- 📊 统计看板 -->
    <div class="stats-grid">
      <div class="stat-card blue"><div><h4>📦 总线索量</h4><div class="num" id="valTotalLeads">0</div></div></div>
      <div class="stat-card purple"><div><h4>📘 Facebook</h4><div class="num" id="valFbLeads">0</div></div></div>
      <div class="stat-card pink"><div><h4>📸 Instagram</h4><div class="num" id="valIgLeads">0</div></div></div>
      <div class="stat-card emerald"><div><h4>🎵 TikTok</h4><div class="num" id="valTkLeads">0</div></div></div>
    </div>

    <!-- 🤖 智能美业助理工作台 -->
    <div class="card" id="sec-ai-chat" style="border: 1px solid #0ea5e9;">
      <h3 style="color: #38bdf8;">🤖 智能美业助理与预约工作台</h3>
      <p style="font-size: 12px; color: #94a3b8; margin-bottom: 12px;">客户输入预约意向，助理将温柔解答并自动识别时间生成预约单！</p>
      <div class="chat-box" id="chatLogsContainer">
        <div class="msg ai" id="aiWelcomeBox">👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？</div>
      </div>
      <div class="chat-input-group">
        <input type="text" id="chatPhoneInput" placeholder="客户手机号" style="max-width:180px;">
        <input type="text" id="chatMsgInput" placeholder="输入咨询 (如: 帮我预约明天下午3点)" style="flex:1;" onkeypress="if(event.key==='Enter') sendAiMessage()">
        <button class="primary" onclick="sendAiMessage()">发送给助理</button>
      </div>
    </div>

    <!-- ✍️ 助理人设设置 -->
    <div class="card" id="sec-ai-edit" style="border: 1px solid #a855f7;">
      <h3 style="color: #c084fc;">✍️ 自定义助理打招呼语与人设设置</h3>
      <form id="aiConfigForm" style="display:flex; flex-direction:column; gap:12px;">
        <div class="form-group"><label>开场打招呼词 (Welcome Message)：</label><input type="text" id="cfgWelcomeMsg" required></div>
        <div class="form-group"><label>助理人设与沟通风格 Prompt：</label><textarea id="cfgSystemPrompt" rows="3" required></textarea></div>
        <button type="submit" class="purple-btn" style="width: auto; align-self: flex-start;">💾 保存助理配置</button>
      </form>
    </div>

    <!-- 🔐 Gemini Key 设置 -->
    <div class="card" style="border:1px solid #10b981;">
      <h3 style="color:#34d399;">🔐 Gemini AI 连接状态</h3>
      <div class="form-grid" style="margin:14px 0;"><div class="form-group" style="grid-column:1/-1"><label>Gemini API Key</label><input id="geminiApiKeyInput" type="password" placeholder="粘贴 Google AI Studio API Key"></div><div style="display:flex;gap:8px;grid-column:1/-1"><button type="button" class="primary" onclick="saveGeminiKey()">🔐 保存 Key</button><button type="button" class="success" onclick="testGeminiKey()">🧪 测试连接</button><button type="button" class="secondary" onclick="checkGeminiStatus()">刷新状态</button></div></div>
      <p id="geminiKeyStatus" style="margin-top:8px;font-size:13px;color:#64748b;">状态：检查中...</p>
    </div>

    <!-- 🗺️ 免费真实商家获客 -->
    <div class="card" id="sec-maps-leads" style="border:1px solid #0ea5e9;">
      <h3>🗺️ 免费真实商家获客（OpenStreetMap）</h3>
      <p style="color:#94a3b8;font-size:13px;">按国家、城市和商家类型搜索公开地图资料，只保存真实返回的商家数据。</p>
      <form id="mapsLeadForm" class="form-grid">
        <div class="form-group"><label>国家</label><input id="mapsCountry" placeholder="United Arab Emirates" required></div>
        <div class="form-group"><label>城市</label><input id="mapsCity" placeholder="Dubai" required></div>
        <div class="form-group"><label>商家关键词</label><input id="mapsKeyword" placeholder="salon / restaurant / spa" required></div>
        <div style="grid-column:1/-1;display:flex;gap:10px;align-items:center;">
          <button class="primary" type="submit" id="mapsSearchBtn">🔎 搜索真实商家</button>
          <span id="mapsSearchStatus" style="color:#94a3b8;font-size:13px;"></span>
        </div>
      </form>
      <div class="table-responsive" style="margin-top:15px;"><table><thead><tr><th>商家名称</th><th>类别</th><th>真实电话</th><th>网站</th><th>地址</th><th>来源</th><th>地图</th></tr></thead><tbody id="mapsLeadResults"><tr><td colspan="7" style="text-align:center;color:#64748b;">尚未搜索</td></tr></tbody></table></div>
    </div>

    <!-- 👤 社媒账号配置 -->
    <div class="card" id="sec-social-acc">
      <h3>👤 1. 社媒平台账号隔离配置</h3>
      <form id="accountForm" class="form-grid">
        <div class="form-group"><label>社媒平台：</label><select id="accPlatform" required><option value="Facebook">📘 Facebook</option><option value="Instagram">📸 Instagram</option><option value="TikTok">🎵 TikTok</option></select></div>
        <div class="form-group"><label>备注标签：</label><input type="text" id="accLabel" placeholder="Dubai Branch" required></div>
        <div class="form-group"><label>Profile ID：</label><input type="text" id="accProfileId" placeholder="prof_dubai_01" required></div>
        <button type="submit" class="primary">🔗 绑定账号</button>
      </form>
      <h4 style="margin-top:20px;color:#38bdf8;">已授权账号列表</h4>
      <div class="table-responsive"><table><thead><tr><th>ID</th><th>平台</th><th>备注</th><th>Profile</th><th>绑定时间</th><th>操作</th></tr></thead><tbody id="accountTableList"></tbody></table></div>
    </div>

    <!-- 🌐 搜客任务 -->
    <div class="card" id="sec-search-task">
      <h3>🌐 2. 全自动社媒定向搜客任务</h3>
      <form id="socialSearchForm" class="form-grid">
        <div class="form-group"><label>执行账号：</label><select id="ssAccount" required><option value="">Select Account</option></select></div>
        <div class="form-group"><label>目标平台：</label><input type="text" id="ssPlatform" readonly placeholder="Auto" style="background:#0f172a;"></div>
        <div class="form-group"><label>国家：</label><input type="text" id="ssCountry" placeholder="UAE"></div>
        <div class="form-group"><label>城市：</label><input type="text" id="ssCity" placeholder="Dubai"></div>
        <div class="form-group"><label>关键词：</label><input type="text" id="ssKeywords" placeholder="Salon & Spa" required></div>
        <div class="form-group"><label>性别筛选：</label><select id="ssGender"><option value="不限">All</option><option value="女性">Female</option></select></div>
        <button type="submit" class="primary" style="grid-column:1/-1;">💾 创建抓取任务</button>
      </form>
      <h4 style="margin-top:20px;color:#38bdf8;">获客任务调度</h4>
      <div class="table-responsive"><table><thead><tr><th>平台</th><th>账号</th><th>国家</th><th>城市</th><th>关键词</th><th>性别</th><th>状态</th><th>操作</th></tr></thead><tbody id="socialSearchList"></tbody></table></div>
    </div>

    <!-- 📅 预约列表 -->
    <div class="card" id="sec-appointments">
      <h3>📅 3. 智能预约排班与私域转化</h3>
      <form id="appointmentForm" class="form-grid">
        <div class="form-group"><label>接待技师：</label><input type="text" id="apptStaff" placeholder="Sarah (Dubai)" required></div>
        <div class="form-group"><label>客户手机号：</label><input type="text" id="apptPhone" placeholder="输入客户手机号" required></div>
        <div class="form-group"><label>预约日期：</label><input type="date" id="apptDate" required></div>
        <div class="form-group"><label>时间段：</label><input type="time" id="apptTime" required></div>
        <button type="submit" class="success">✅ 生成预约单</button>
      </form>
      <h4 style="margin-top:20px;color:#38bdf8;">预约与私域转化列表</h4>
      <div class="table-responsive"><table><thead><tr><th>单号</th><th>技师</th><th>客户手机号</th><th>时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="appointmentList"></tbody></table></div>
    </div>
  </div>

  <script>
    let currentLang = "zh";
    function scrollToSec(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    function toggleLanguage() { currentLang = currentLang === "zh" ? "en" : "zh"; alert("语言切换已触发"); }

    async function api(url, options = {}) {
      const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ("HTTP Error " + res.status));
      return data;
    }

    window.addEventListener("DOMContentLoaded", async () => {
      loadAllData();
      checkGeminiStatus();
    });

    async function loadAllData() {
      await loadAiConfig();
      await loadStats();
      await loadAccounts();
      await loadAppointments();
      await loadSearchTasks();
      await loadChatLogs();
      await loadStoredLeads();
    }

    async function loadAiConfig() {
      try {
        const cfg = await api("/api/ai/config");
        document.getElementById("cfgWelcomeMsg").value = cfg.welcome_msg || "";
        document.getElementById("cfgSystemPrompt").value = cfg.system_prompt || "";
        document.getElementById("aiWelcomeBox").textContent = cfg.welcome_msg || "";
      } catch (e) {}
    }

    document.getElementById("aiConfigForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/ai/config", { method: "POST", body: JSON.stringify({ welcome_msg: document.getElementById("cfgWelcomeMsg").value.trim(), system_prompt: document.getElementById("cfgSystemPrompt").value.trim() }) });
        alert("助理配置保存成功！");
        await loadAiConfig();
      } catch (err) { alert(err.message); }
    });

    async function saveGeminiKey() {
      const apiKey = document.getElementById('geminiApiKeyInput').value.trim();
      if (!apiKey) return alert('请输入 Key');
      try {
        const d = await api('/api/ai/key', { method: 'POST', body: JSON.stringify({ apiKey }) });
        alert(d.message);
        checkGeminiStatus();
      } catch(e) { alert('保存失败：' + e.message); }
    }

    async function checkGeminiStatus() {
      try {
        const res = await api('/api/ai/status');
        document.getElementById('geminiKeyStatus').textContent = res.configured ? ('状态：已配置 · 模型 ' + res.model) : '状态：未配置。请填写 Key 或在 Render Environment 中添加 GEMINI_API_KEY。';
      } catch (e) {}
    }

    async function testGeminiKey() {
      try {
        const res = await api('/api/ai/key-test', { method: 'POST', body: JSON.stringify({}) });
        alert(res.message);
        checkGeminiStatus();
      } catch(e) { alert(e.message); }
    }

    async function sendAiMessage() {
      const phone = document.getElementById("chatPhoneInput").value.trim();
      const message = document.getElementById("chatMsgInput").value.trim();
      const container = document.getElementById("chatLogsContainer");
      if (!message) return;

      container.innerHTML += '<div class="msg customer">[' + (phone || 'Visitor') + '] ' + message + '</div>';
      document.getElementById("chatMsgInput").value = "";
      container.scrollTop = container.scrollHeight;

      try {
        const res = await api("/api/ai/chat-reply", { method: "POST", body: JSON.stringify({ customer_phone: phone, customer_message: message, platform: "WhatsApp" }) });
        container.innerHTML += '<div class="msg ai">' + res.ai_reply + '</div>';
        container.scrollTop = container.scrollHeight;
        if (res.auto_appointment_created) {
          alert("🔥 助理成功为您生成预约单！单号 [" + res.appointment_number + "]");
          loadAppointments();
          loadStats();
        }
      } catch (err) {
        container.innerHTML += '<div class="msg customer" style="background:#7f1d1d">错误：' + err.message + '</div>';
      }
    }

    async function loadChatLogs() {
      const container = document.getElementById("chatLogsContainer");
      try {
        const logs = await api("/api/ai/chat-logs");
        if (logs.length > 0) {
          container.innerHTML = "";
          logs.forEach(l => {
            container.innerHTML += '<div class="msg ' + (l.sender === 'ai' ? 'ai' : 'customer') + '">[' + l.customer_phone + '] ' + l.message + '</div>';
          });
          container.scrollTop = container.scrollHeight;
        }
      } catch (e) {}
    }

    async function loadStats() {
      try {
        const s = await api("/api/dashboard/stats");
        document.getElementById("valTotalLeads").textContent = s.total;
        document.getElementById("valFbLeads").textContent = s.fb;
        document.getElementById("valIgLeads").textContent = s.ig;
        document.getElementById("valTkLeads").textContent = s.tk;
      } catch (e) {}
    }

    async function loadAccounts() {
      const tbody = document.getElementById("accountTableList");
      const sel = document.getElementById("ssAccount");
      if (!tbody || !sel) return;
      try {
        const accs = await api("/api/social-accounts");
        sel.innerHTML = '<option value="">选择授权账号</option>';
        accs.forEach(a => { sel.innerHTML += '<option value="' + a.id + '" data-platform="' + a.platform + '">' + a.platform + ' - ' + a.label + '</option>'; });
        tbody.innerHTML = "";
        if (!accs.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">No Accounts</td></tr>'; return; }
        accs.forEach(a => {
          tbody.innerHTML += '<tr><td>' + a.id + '</td><td>' + a.platform + '</td><td><b>' + a.label + '</b></td><td><code>' + a.profile_id + '</code></td><td>' + a.created_at.replace('T', ' ').slice(0, 16) + '</td><td><button class="danger" style="padding:4px 8px;" onclick="deleteAccount(' + a.id + ')">Unbind</button></td></tr>';
        });
      } catch (e) {}
    }

    document.getElementById("accountForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/social-accounts", { method: "POST", body: JSON.stringify({ platform: document.getElementById("accPlatform").value, label: document.getElementById("accLabel").value.trim(), profile_id: document.getElementById("accProfileId").value.trim() }) });
        alert("绑定成功！");
        this.reset();
        loadAccounts();
      } catch (err) { alert(err.message); }
    });

    async function deleteAccount(id) {
      if (!confirm("确认解绑？")) return;
      try { await api("/api/social-accounts/" + id, { method: "DELETE" }); loadAccounts(); } catch (err) { alert(err.message); }
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
          tbody.innerHTML += '<tr><td>' + item.name + '</td><td>' + item.category + '</td><td>' + (item.phone || '—') + '</td><td>' + (item.website ? '<a href="'+item.website+'" target="_blank">'+item.website+'</a>' : '—') + '</td><td>' + (item.address || '—') + '</td><td>OpenStreetMap</td><td><a href="' + item.maps_url + '" target="_blank">Google Maps</a></td></tr>';
        });
      } catch (e) {}
    }

    document.getElementById("mapsLeadForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      const btn = document.getElementById("mapsSearchBtn");
      const status = document.getElementById("mapsSearchStatus");
      btn.disabled = true; status.textContent = "正在查询真实地图数据…";
      try {
        const data = await api("/api/maps/search", { method: "POST", body: JSON.stringify({ country: document.getElementById("mapsCountry").value.trim(), city: document.getElementById("mapsCity").value.trim(), keyword: document.getElementById("mapsKeyword").value.trim() }) });
        status.textContent = "搜索完成：新增/更新 " + data.saved + " 条真实记录。";
        loadStoredLeads();
        loadStats();
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
          tbody.innerHTML += '<tr><td><b>' + t.platform + '</b></td><td>ID: ' + t.account_id + '</td><td>' + (t.country || 'Global') + '</td><td>' + (t.city || 'Any') + '</td><td><code>' + t.keywords + '</code></td><td>' + t.gender + '</td><td><span style="color:' + (t.enabled ? '#22c55e' : '#f87171') + '">' + (t.enabled ? '● Active' : '○ Disabled') + '</span></td><td><button class="primary" style="padding:4px 8px;" onclick="runTask(' + t.id + ')">Run</button> <button class="danger" style="padding:4px 8px;" onclick="deleteTask(' + t.id + ')">Delete</button></td></tr>';
        });
      } catch (e) {}
    }

    document.getElementById("socialSearchForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/social-search", { method: "POST", body: JSON.stringify({ account_id: Number(document.getElementById("ssAccount").value), platform: document.getElementById("ssPlatform").value, country: document.getElementById("ssCountry").value.trim(), city: document.getElementById("ssCity").value.trim(), keywords: document.getElementById("ssKeywords").value.trim(), gender: document.getElementById("ssGender").value }) });
        alert("任务创建成功！");
        this.reset();
        loadSearchTasks();
      } catch (err) { alert(err.message); }
    });

    async function runTask(id) {
      try { const res = await api("/api/social-search/" + id + "/run", { method: "POST" }); window.open(res.url, '_blank'); } catch (err) { alert(err.message); }
    }

    async function deleteTask(id) {
      if (!confirm("确认删除？")) return;
      try { await api("/api/social-search/" + id, { method: "DELETE" }); loadSearchTasks(); } catch (err) { alert(err.message); }
    }

    async function loadAppointments() {
      const tbody = document.getElementById("appointmentList");
      if (!tbody) return;
      try {
        const appts = await api("/api/appointments");
        tbody.innerHTML = "";
        if (!appts.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">No Appointments</td></tr>'; return; }
        appts.forEach(ap => {
          tbody.innerHTML += '<tr><td><b style="color:#38bdf8">' + ap.appointment_number + '</b></td><td>' + ap.staff_id + '</td><td>' + ap.phone + '</td><td>' + ap.date + ' ' + ap.time + '</td><td><span style="color:#22c55e">' + ap.status + '</span></td><td><a href="https://wa.me/' + ap.phone.replace(/[^0-9]/g, "") + '" target="_blank"><button class="whatsapp" style="padding:4px 8px;">💬 WA</button></a> <button class="danger" style="padding:4px 8px;" onclick="deleteAppt(\'' + ap.appointment_number + '\')">Cancel</button></td></tr>';
        });
      } catch (e) {}
    }

    document.getElementById("appointmentForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/appointments", { method: "POST", body: JSON.stringify({ staff_id: document.getElementById("apptStaff").value.trim(), phone: document.getElementById("apptPhone").value.trim(), date: document.getElementById("apptDate").value, time: document.getElementById("apptTime").value }) });
        alert("预约成功！");
        this.reset();
        loadAppointments();
        loadStats();
      } catch (err) { alert(err.message); }
    });

    async function deleteAppt(no) {
      if (!confirm("确认取消？")) return;
      try { await api("/api/appointments/" + no, { method: "DELETE" }); loadAppointments(); loadStats(); } catch (err) { alert(err.message); }
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
