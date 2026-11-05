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

// 兼容旧版 data.db：为真实地图线索增加字段
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

// 清除旧版本自动获客演示代码生成的假线索
try {
  db.prepare("DELETE FROM leads WHERE name LIKE '社媒潜在客户 (%' OR name LIKE '定向客户 (%'").run();
} catch (e) { console.error('[Mock lead cleanup]', e.message); }

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

// 认证与安全配置
const AUTH_SECRET = process.env.APP_ENCRYPTION_KEY || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'alm_session';
function signToken(payload) { const body=Buffer.from(JSON.stringify(payload)).toString('base64url'); const sig=crypto.createHmac('sha256',AUTH_SECRET).update(body).digest('base64url'); return body+'.'+sig; }
function verifyToken(token) { try { const [body,sig]=String(token||'').split('.'); const expected=crypto.createHmac('sha256',AUTH_SECRET).update(body).digest(); const actual=Buffer.from(sig,'base64url'); if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected)) return null; const d=JSON.parse(Buffer.from(body,'base64url').toString()); return d.exp>Date.now()?d:null; } catch { return null; } }
function getSession(req) { const c=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE_NAME+'=')); return c?verifyToken(decodeURIComponent(c.slice(COOKIE_NAME.length+1))):null; }
function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')) { return {salt,hash:crypto.scryptSync(password,salt,64).toString('hex')}; }
function checkPassword(password,salt,hash) { const a=crypto.scryptSync(password,salt,64), b=Buffer.from(hash,'hex'); return a.length===b.length&&crypto.timingSafeEqual(a,b); }

app.get('/api/auth/status',(req,res)=>{ const admin=db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get(); const session=getSession(req); res.json({setupRequired:!admin,authenticated:!!session,username:session?.username||null}); });

app.post('/api/auth/setup',(req,res)=>{ 
  if(db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) return res.status(409).json({error:'管理员已经创建，请直接登录。'}); 
  const username=String(req.body?.username||'').trim().slice(0,40), password=String(req.body?.password||''); 
  if(!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return res.status(400).json({error:'用户名需为 3-40 位字母、数字或 . _ -'}); 
  if(password.length < 6) return res.status(400).json({error:'密码至少需 6 位。'}); // 已适配 lcaizxy13
  const h=hashPassword(password); 
  db.prepare('INSERT INTO users(username,password,role) VALUES(?,?,?)').run(username,h.salt+':'+h.hash,'admin'); 
  const token=signToken({username,exp:Date.now()+7*86400000}); 
  res.setHeader('Set-Cookie',`${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`); 
  res.json({ok:true,username}); 
});

app.post('/api/auth/login',(req,res)=>{ 
  const username=String(req.body?.username||'').trim(), password=String(req.body?.password||''); 
  const row=db.prepare("SELECT * FROM users WHERE username=? AND role='admin'").get(username); 
  if(!row) return res.status(401).json({error:'用户名或密码错误。'}); 
  const [salt,hash]=String(row.password).split(':'); 
  const valid=hash?checkPassword(password,salt,hash):row.password===password; 
  if(!valid) return res.status(401).json({error:'用户名或密码错误。'}); 
  const token=signToken({username,exp:Date.now()+7*86400000}); 
  res.setHeader('Set-Cookie',`${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${process.env.NODE_ENV==='production'?'; Secure':''}`); 
  res.json({ok:true,username}); 
});

app.post('/api/auth/logout',(req,res)=>{res.setHeader('Set-Cookie',`${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.NODE_ENV==='production'?'; Secure':''}`);res.json({ok:true});});
app.use('/api',(req,res,next)=>{if(['/auth/status','/auth/setup','/auth/login','/auth/logout'].includes(req.path))return next();if(!getSession(req))return res.status(401).json({error:'登录已失效，请重新登录。',code:'AUTH_REQUIRED'});next();});

// Gemini 配置与封装
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ENC_KEY = crypto.createHash('sha256').update(AUTH_SECRET).digest();
function encryptSecret(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',ENC_KEY,iv),data=Buffer.concat([c.update(value,'utf8'),c.final()]);return{encrypted_key:data.toString('base64'),iv:iv.toString('base64'),auth_tag:c.getAuthTag().toString('base64')};}
function decryptSecret(row){const d=crypto.createDecipheriv('aes-256-gcm',ENC_KEY,Buffer.from(row.iv,'base64'));d.setAuthTag(Buffer.from(row.auth_tag,'base64'));return Buffer.concat([d.update(Buffer.from(row.encrypted_key,'base64')),d.final()]).toString('utf8');}
function loadStoredKey(){try{const r=db.prepare('SELECT encrypted_key,iv,auth_tag FROM ai_secrets WHERE id=1').get();return r?decryptSecret(r):'';}catch{return '';}}
let apiKey=(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||loadStoredKey()||'').trim();
let ai=apiKey?new GoogleGenAI({apiKey}):null;

function getGeminiErrorMessage(err) {
  const raw = String(err?.message || err || "Unknown Gemini error");
  if (/API_KEY_INVALID|invalid api key|API key not valid|401|unauthorized/i.test(raw)) return "Gemini API Key 无效或未授权，请检查。";
  if (/PERMISSION_DENIED|403|permission/i.test(raw)) return "Gemini API 没有权限。";
  if (/RESOURCE_EXHAUSTED|429|quota/i.test(raw)) return "Gemini 请求配额已满，请稍后重试。";
  return `Gemini 调用失败：${raw.slice(0, 300)}`;
}

app.get('/api/ai/status', (req, res) => {
  res.json({ok:true,provider:'Gemini',configured:!!apiKey&&!!ai,model:GEMINI_MODEL});
});

app.post('/api/ai/key',(req,res)=>{try{if(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY)return res.status(409).json({error:'当前优先使用环境变量 Key。'});const key=String(req.body?.apiKey||'').trim();if(key.length<20)return res.status(400).json({error:'请填写有效的 API Key。'});const e=encryptSecret(key);db.prepare(`INSERT INTO ai_secrets(id,encrypted_key,iv,auth_tag,updated_at) VALUES(1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=CURRENT_TIMESTAMP`).run(e.encrypted_key,e.iv,e.auth_tag);apiKey=key;ai=new GoogleGenAI({apiKey});res.json({ok:true,message:'Gemini Key 保存成功。'});}catch(err){res.status(500).json({error:err.message});}});

app.post('/api/ai/key-test', async (req, res) => {
  try {
    if (!apiKey || !ai) return res.status(503).json({ ok: false, error: '未配置 API Key。' });
    const result = await ai.models.generateContent({ model: GEMINI_MODEL, contents: 'Reply OK.' });
    res.json({ ok: true, message: '连接成功！', preview: String(result.text || '').slice(0, 50) });
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
  return res.status(409).json({ ok: false, error: '社交平台未连接官方 API。' });
});

// OSM 地图商家搜索
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
  if (!rows.length) throw new Error('没有找到该城市/国家。');
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
    if (!country || !city || !keyword) return res.status(400).json({ ok: false, error: '请完整填写国家、城市和关键词。' });

    const location = await nominatimGeocode(`${city}, ${country}`);
    const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 80);
    const query = `[out:json][timeout:25];(nwr(around:5000,${location.lat},${location.lon})[name~"${safeKeyword}",i];);out center tags 100;`;
    const overpassResponse = await fetch(OVERPASS_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': OSM_USER_AGENT },
      body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(40000)
    });
    if (!overpassResponse.ok) throw new Error('地图搜索服务响应超时。');
    const payload = await overpassResponse.json();
    const label = `${city}, ${country}`;
    const results = (payload.elements || []).map(el => osmTagsToLead(el, label)).filter(Boolean);
    const unique = [...new Map(results.map(x => [x.external_id, x])).values()].slice(0, 100);
    
    const insert = db.prepare(`INSERT INTO leads (id,name,phone,source,center,created_at,external_id,category,address,website,email,latitude,longitude,maps_url)
      VALUES (@id,@name,@phone,@source,@center,@created_at,@external_id,@category,@address,@website,@email,@latitude,@longitude,@maps_url)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, category=excluded.category, address=excluded.address, website=excluded.website, email=excluded.email, latitude=excluded.latitude, longitude=excluded.longitude, maps_url=excluded.maps_url`);
    const saveMany = db.transaction(rows => rows.forEach(row => insert.run({ ...row, phone: row.phone || null, address: row.address || null, website: row.website || null, email: row.email || null })));
    saveMany(unique);
    res.json({ ok: true, provider: 'OpenStreetMap', location: location.display_name, searched: unique.length, saved: unique.length, results: unique, notice: '搜索成功。' });
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

// Gemini AI 聊天处理
app.post('/api/ai/chat-reply', async (req, res) => {
  const { customer_phone, customer_message, platform } = req.body || {};
  const phone = String(customer_phone || "").trim();
  const message = String(customer_message || "").trim();
  const channel = String(platform || "Website").trim();

  if (!message) return res.status(400).json({ ok: false, error: "消息不能为空" });
  if (!apiKey || !ai) {
    return res.status(503).json({ ok: false, error: "未配置 GEMINI_API_KEY。", code: "GEMINI_KEY_MISSING" });
  }

  try {
    const now = new Date();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(now);
    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'customer', ?, ?)`).run(phone || 'Website Visitor', channel, message, now.toISOString());

    const currentConfig = db.prepare('SELECT system_prompt FROM ai_config WHERE id = 1').get();
    const userPromptCustom = currentConfig?.system_prompt || defaultPrompt;
    const systemInstruction = `${userPromptCustom}
You are the customer service assistant for a beauty salon business serving Dubai/UAE. Detect the language of each incoming customer message and reply in that exact language. Support any language.
Today in Dubai is ${today}.
Return ONLY valid JSON with exactly these keys: {"reply":"string","detected_language":"language name","has_booking_intent":false,"appointment_date":null,"appointment_time":null}.`;

    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: `Customer message: ${message}`,
      config: {
        systemInstruction,
        temperature: 0.3,
        responseMimeType: "application/json"
      }
    });

    const rawText = response.text;
    if (!rawText) throw new Error("Gemini 返回空内容。");
    let aiResult = JSON.parse(rawText);

    const aiReply = String(aiResult.reply || "Hello! How can I help you?").trim();
    const hasBookingIntent = aiResult.has_booking_intent === true;
    const apptDate = /^\d{4}-\d{2}-\d{2}$/.test(aiResult.appointment_date || '') ? aiResult.appointment_date : null;
    const apptTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(aiResult.appointment_time || '') ? aiResult.appointment_time : null;

    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'ai', ?, ?)`).run(phone || 'Website Visitor', channel, aiReply, new Date().toISOString());

    let autoAppointmentCreated = false;
    let apptNumber = null;
    if (hasBookingIntent && apptDate && apptTime && phone) {
      apptNumber = 'APT-' + Date.now().toString().slice(-6);
      db.prepare(`INSERT INTO appointments (appointment_number, staff_id, phone, date, time, status, created_at) VALUES (?, 'Gemini Assistant', ?, ?, ?, 'Pending Confirmation', ?)`).run(apptNumber, phone, apptDate, apptTime, new Date().toISOString());
      autoAppointmentCreated = true;
    }

    res.json({ ok: true, provider: "Gemini", model: GEMINI_MODEL, customer_phone: phone, detected_language: String(aiResult.detected_language || "自动识别"), ai_reply: aiReply, auto_appointment_created: autoAppointmentCreated, appointment_number: apptNumber, extracted_date: apptDate, extracted_time: apptTime });
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

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Master - 智能美业 CRM</title>
  <style>
    :root{--bg:#f4f6ff;--surface:#fff;--ink:#18213b;--muted:#74809b;--line:#e7eaf4;--primary:#635bff;--cyan:#12b8d6;--pink:#ec4899;--green:#10b981;--orange:#f59e0b;--shadow:0 14px 40px rgba(36,48,90,.08)}
    *{box-sizing:border-box}body{font-family:Inter,sans-serif;background:var(--bg);margin:0;padding:22px;color:var(--ink)}
    .container{max-width:1440px;margin:0 auto 0 226px;background:transparent;padding:0}
    .header-bar{background:rgba(255,255,255,.88);border:1px solid var(--line);border-radius:22px;padding:18px 22px;margin-bottom:22px;box-shadow:var(--shadow)}
    .header-top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}
    h2{color:#252b55;margin:0;font-size:23px}h3{color:#283252;margin:0 0 16px;font-size:17px;font-weight:800}
    .nav-buttons-scroll{position:fixed;z-index:50;left:18px;top:18px;bottom:18px;width:190px;display:flex;flex-direction:column;gap:8px;overflow-y:auto;padding:18px 12px;background:linear-gradient(165deg,#282b63,#4443a8 55%,#287ca5);border-radius:22px}
    .nav-buttons-scroll:before{content:"LEAD MASTER";color:#c9d4ff;font-size:11px;font-weight:900;letter-spacing:2px;padding:5px 10px 15px}
    .nav-btn{width:100%;text-align:left;background:transparent;color:#e7eaff;border:1px solid transparent;padding:12px 13px;border-radius:12px;font-size:13px;font-weight:700;cursor:pointer;transition:.2s}
    .nav-btn:hover,.nav-btn.active{background:rgba(255,255,255,.2);color:#fff}
    .lang-btn{background:linear-gradient(135deg,#635bff,#9a5cff);color:#fff;border:0;padding:9px 15px;border-radius:12px;font-size:12px;font-weight:800;cursor:pointer}
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:16px;margin-bottom:22px}
    .stat-card{padding:20px;border-radius:19px;color:#fff;display:flex;flex-direction:column;justify-content:space-between;min-height:145px}
    .stat-card.blue{background:linear-gradient(135deg,#4776f5,#6654df)}.stat-card.purple{background:linear-gradient(135deg,#a855f7,#713bd5)}.stat-card.pink{background:linear-gradient(135deg,#f472b6,#d94691)}.stat-card.emerald{background:linear-gradient(135deg,#19c79a,#079b83)}
    .stat-card h4{margin:0 0 9px;font-size:12px;opacity:.94}.stat-card .num{font-size:32px;font-weight:850;margin-bottom:12px}
    .card-action-btn{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.38);color:#fff;padding:8px 11px;border-radius:10px;font-size:12px;font-weight:750;cursor:pointer;text-align:center}
    .card{background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:20px;padding:22px;margin-bottom:20px;box-shadow:var(--shadow)}
    .form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;align-items:end}.form-group{display:flex;flex-direction:column;gap:7px}.form-group label{font-weight:750;font-size:12px;color:#6b7590}
    .form-group input,.form-group select,.form-group textarea,#chatPhoneInput,#chatMsgInput{padding:11px 13px;background:#f8f9ff;border:1px solid #dfe4f2;color:#202944;border-radius:11px;font-size:14px;outline:none;width:100%}
    button{padding:10px 14px;border:0;border-radius:10px;font-weight:800;cursor:pointer;font-size:13px;width:100%}
    button.primary{background:linear-gradient(135deg,#4f7df3,#6256dc);color:#fff}button.secondary{background:linear-gradient(135deg,#8b96ad,#64718d);color:#fff}button.success{background:linear-gradient(135deg,#20c997,#079b78);color:#fff}button.danger{background:linear-gradient(135deg,#fb7185,#e04461);color:#fff}button.purple-btn{background:linear-gradient(135deg,#a855f7,#7046d8);color:#fff}
    .table-responsive{width:100%;overflow-x:auto;border:1px solid var(--line);border-radius:13px}table{width:100%;border-collapse:collapse;font-size:13px;min-width:620px}th,td{border-bottom:1px solid #edf0f7;padding:12px;text-align:left}th{background:#f3f5ff;font-weight:800;color:#5c63a5;font-size:10px}
    .chat-box{height:330px;background:#f8f9ff;border:1px solid #e0e6f4;border-radius:15px;padding:15px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;margin-bottom:13px}
    .msg{padding:10px 13px;border-radius:14px;max-width:85%;font-size:13px;line-height:1.55}.msg.customer{background:#fff;color:#34405c;align-self:flex-start;border:1px solid #e5eaf4}.msg.ai{background:linear-gradient(135deg,#665cf0,#398bdc);color:#fff;align-self:flex-end}
    .chat-input-group{display:flex;flex-direction:column;gap:8px}.chat-input-group button{width:auto;white-space:nowrap;padding-left:22px;padding-right:22px}
    @media(min-width:640px){.chat-input-group{flex-direction:row;align-items:center}}
    @media(max-width:820px){body{padding:10px}.container{margin:0}.nav-buttons-scroll{position:sticky;top:0;width:100%;height:auto;flex-direction:row;overflow-x:auto;padding:9px;margin:14px 0 0}}
  </style>
</head>
<body>
  <div id="authGate" style="position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;background:linear-gradient(135deg,#20265b,#5147a8 55%,#1686a4)"><div style="width:min(430px,100%);background:#fff;border-radius:24px;padding:30px;box-shadow:0 25px 80px #11182766"><div style="font-size:12px;font-weight:900;letter-spacing:2px;color:#655cf3;margin-bottom:10px">AI LEAD MASTER</div><h2 id="authTitle" style="margin-bottom:8px">管理员登录</h2><p id="authHint" style="color:#71809b;font-size:13px;margin:0 0 20px">请登录后进入管理后台</p><form id="authForm" style="display:grid;gap:12px"><input id="authUsername" required placeholder="用户名 (例如: dubai)" style="padding:13px;border:1px solid #dce2f0;border-radius:12px;font-size:15px"><input id="authPassword" required type="password" placeholder="密码 (例如: lcaizxy13)" style="padding:13px;border:1px solid #dce2f0;border-radius:12px;font-size:15px"><button id="authSubmit" class="primary" type="submit" style="padding:14px">登录</button></form><p id="authError" style="color:#dc3545;font-size:13px;min-height:20px;margin:12px 0 0"></p></div></div>
  
  <div class="container" id="mainApp" style="display:none">
    <div class="header-bar" id="sec-dashboard">
      <div class="header-top">
        <h2>🚀 AI Lead Master CRM</h2>
        <div style="display: flex; align-items: center; gap: 10px;">
          <button class="lang-btn" onclick="toggleLanguage()">🌐 EN / 中文</button><button class="secondary" style="width:auto;padding:9px 12px" onclick="logoutAdmin()">退出登录</button>
          <span id="currentUserDisplay" style="font-weight: bold; color: #38bdf8; background: #0f172a; padding: 4px 8px; border-radius: 6px; font-size:12px;">👤 Admin Mode</span>
        </div>
      </div>
      <div class="nav-buttons-scroll">
        <button class="nav-btn" onclick="scrollToSec('sec-dashboard')">📊 仪表盘</button>
        <button class="nav-btn" onclick="scrollToSec('sec-ai-chat')">🤖 美业助理</button>
        <button class="nav-btn" onclick="scrollToSec('sec-ai-edit')">✍️ 助理设置</button>
        <button class="nav-btn" onclick="scrollToSec('sec-maps-leads')">🗺️ 地图商家</button>
        <button class="nav-btn" onclick="scrollToSec('sec-social-acc')">👤 社媒配置</button>
        <button class="nav-btn" onclick="scrollToSec('sec-search-task')">🌐 搜客任务</button>
        <button class="nav-btn" onclick="scrollToSec('sec-appointments')">📅 预约列表</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card blue"><div><h4>📦 总线索量</h4><div class="num" id="valTotalLeads">0</div></div><button class="card-action-btn" onclick="scrollToSec('sec-appointments')">📅 查看预约管理 &rarr;</button></div>
      <div class="stat-card purple"><div><h4>📘 Facebook</h4><div class="num" id="valFbLeads">0</div></div><button class="card-action-btn" onclick="scrollToSec('sec-social-acc')">👤 配置社媒账号 &rarr;</button></div>
      <div class="stat-card pink"><div><h4>📸 Instagram</h4><div class="num" id="valIgLeads">0</div></div><button class="card-action-btn" onclick="scrollToSec('sec-search-task')">🌐 搜客获客任务 &rarr;</button></div>
      <div class="stat-card emerald"><div><h4>🎵 TikTok</h4><div class="num" id="valTkLeads">0</div></div><button class="card-action-btn" onclick="scrollToSec('sec-ai-chat')">🤖 进入AI助理工作台 &rarr;</button></div>
    </div>

    <div class="card" id="sec-ai-chat" style="border: 1px solid #0ea5e9;">
      <h3 style="color: #0284c7;">🤖 智能美业助理与预约工作台</h3>
      <div class="chat-box" id="chatLogsContainer"><div class="msg ai" id="aiWelcomeBox">👋 您好！我是您的专属美业助理，请问有什么我可以帮您的？</div></div>
      <div class="chat-input-group">
        <input type="text" id="chatPhoneInput" placeholder="客户手机号" value="+971 50 123 4567">
        <input type="text" id="chatMsgInput" placeholder="输入测试咨询 (如: 帮我预约明天下午3点)" onkeypress="if(event.key==='Enter') sendAiMessage()">
        <button class="primary" onclick="sendAiMessage()">发送给助理</button>
      </div>
    </div>

    <div class="card" id="sec-ai-edit" style="border: 1px solid #a855f7;">
      <h3 style="color: #9333ea;">✍️ 自定义助理打招呼语与人设设置</h3>
      <form id="aiConfigForm" style="display:flex;flex-direction:column;gap:12px;">
        <div class="form-group"><label>开场打招呼词：</label><input type="text" id="cfgWelcomeMsg" required></div>
        <div class="form-group"><label>助理人设与沟通风格 Prompt：</label><textarea id="cfgSystemPrompt" rows="3" required></textarea></div>
        <button type="submit" class="purple-btn" style="width:auto;">💾 保存助理配置</button>
      </form>
    </div>

    <div class="card" id="sec-gemini-key" style="border:1px solid #10b981;">
      <h3 style="color:#059669;">🔐 Gemini AI 连接状态</h3>
      <div class="form-grid" style="margin:14px 0;"><div class="form-group" style="grid-column:1/-1"><label>Gemini API Key</label><input id="geminiApiKeyInput" type="password" placeholder="粘贴 Google AI Studio API Key"></div><div style="display:flex;gap:8px;flex-wrap:wrap;grid-column:1/-1"><button type="button" class="primary" onclick="saveGeminiKey()">🔐 保存 API Key</button><button type="button" class="success" onclick="testGeminiKey()">🧪 测试连接</button></div></div>
      <p id="geminiKeyStatus" style="margin-top:12px;color:#64748b;font-size:13px;">状态：等待检查</p>
    </div>

    <div class="card" id="sec-maps-leads">
      <h3>🗺️ 免费真实商家获客（OpenStreetMap）</h3>
      <form id="mapsLeadForm" class="form-grid">
        <div class="form-group"><label>国家</label><input id="mapsCountry" placeholder="United Arab Emirates" required></div>
        <div class="form-group"><label>城市</label><input id="mapsCity" placeholder="Dubai" required></div>
        <div class="form-group"><label>商家关键词</label><input id="mapsKeyword" placeholder="salon / restaurant / spa" required></div>
        <div style="grid-column:1/-1;display:flex;gap:10px;"><button class="primary" type="submit" id="mapsSearchBtn">🔎 搜索真实商家</button><span id="mapsSearchStatus" style="align-self:center;font-size:13px;"></span></div>
      </form>
      <div class="table-responsive" style="margin-top:15px;"><table><thead><tr><th>商家名称</th><th>类别</th><th>真实电话</th><th>网站</th><th>地址</th><th>地图</th></tr></thead><tbody id="mapsLeadResults"><tr><td colspan="6" style="text-align:center;">尚未搜索</td></tr></tbody></table></div>
    </div>

    <div class="card" id="sec-appointments">
      <h3>📅 智能预约排班与私域转化</h3>
      <form id="appointmentForm" class="form-grid">
        <div class="form-group"><label>接待技师：</label><input type="text" id="apptStaff" placeholder="Sarah (Dubai)" required></div>
        <div class="form-group"><label>客户手机号：</label><input type="text" id="apptPhone" placeholder="输入客户手机号" required></div>
        <div class="form-group"><label>预约日期：</label><input type="date" id="apptDate" required></div>
        <div class="form-group"><label>时间段：</label><input type="time" id="apptTime" required></div>
        <button type="submit" class="success">✅ 生成预约单</button>
      </form>
      <div class="table-responsive" style="margin-top:15px;"><table><thead><tr><th>单号</th><th>技师</th><th>客户手机号</th><th>时间</th><th>状态</th><th>操作</th></tr></thead><tbody id="appointmentList"></tbody></table></div>
    </div>
  </div>

  <script>
    async function api(url, options = {}) {
      const res = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error("服务器响应格式异常"); }
      if (!res.ok) throw new Error(data.error || ("HTTP Error " + res.status));
      return data;
    }

    window.addEventListener("DOMContentLoaded", async () => {
      const st = await fetch('/api/auth/status').then(r=>r.json()).catch(()=>({setupRequired:true}));
      if(st.authenticated){ enterAdmin(st.username); return; }
      document.getElementById('authTitle').textContent = st.setupRequired ? '首次设置管理员账号' : '管理员登录';
      document.getElementById('authHint').textContent = st.setupRequired ? '请设置用户名 dubai 和密码 lcaizxy13' : '请输入管理员账号';
      document.getElementById('authForm').dataset.mode = st.setupRequired ? 'setup' : 'login';
      if(st.setupRequired) {
        document.getElementById('authUsername').value = 'dubai';
        document.getElementById('authPassword').value = 'lcaizxy13';
      }
    });

    function enterAdmin(username){ document.getElementById('authGate').style.display='none'; document.getElementById('mainApp').style.display='block'; document.getElementById('currentUserDisplay').textContent='👤 '+username; loadAllData(); checkGeminiStatus(); }
    
    document.getElementById('authForm').addEventListener('submit', async e=>{
      e.preventDefault();
      const err = document.getElementById('authError');
      err.textContent = '正在验证…';
      const mode = e.currentTarget.dataset.mode || 'login';
      try {
        const r = await fetch('/api/auth/'+mode, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username:document.getElementById('authUsername').value.trim(), password:document.getElementById('authPassword').value})});
        const d = await r.json();
        if(!r.ok) throw new Error(d.error||'操作失败');
        enterAdmin(d.username);
      } catch(x){ err.textContent = x.message; }
    });

    async function logoutAdmin(){ await fetch('/api/auth/logout',{method:'POST'}); location.reload(); }

    async function loadAllData() {
      await loadAiConfig();
      await loadStats();
      await loadAppointments();
      await loadStoredLeads();
    }

    async function loadAiConfig() {
      try {
        const cfg = await api("/api/ai/config");
        document.getElementById("cfgWelcomeMsg").value = cfg.welcome_msg || "";
        document.getElementById("cfgSystemPrompt").value = cfg.system_prompt || "";
        document.getElementById("aiWelcomeBox").textContent = cfg.welcome_msg || "";
      } catch (e) { console.error(e); }
    }

    document.getElementById("aiConfigForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/ai/config", { method: "POST", body: JSON.stringify({ welcome_msg: document.getElementById("cfgWelcomeMsg").value.trim(), system_prompt: document.getElementById("cfgSystemPrompt").value.trim() }) });
        alert("助理配置保存成功！");
        await loadAiConfig();
      } catch (err) { alert(err.message); }
    });

    async function saveGeminiKey(){
      const input = document.getElementById('geminiApiKeyInput'), el = document.getElementById('geminiKeyStatus'), apiKey = input.value.trim();
      if(!apiKey){ el.textContent='请先填写 API Key。'; return; }
      try {
        const d = await api('/api/ai/key', {method:'POST', body:JSON.stringify({apiKey})});
        input.value=''; el.textContent=d.message; await checkGeminiStatus();
      } catch(e){ el.textContent='保存失败：'+e.message; }
    }

    async function checkGeminiStatus() {
      const el = document.getElementById('geminiKeyStatus');
      try {
        const result = await api('/api/ai/status');
        el.textContent = result.configured ? ('状态：已配置 · 模型 ' + result.model) : '状态：未配置。';
      } catch (e) { el.textContent = '检查失败：' + e.message; }
    }

    async function testGeminiKey() {
      const el = document.getElementById('geminiKeyStatus');
      el.textContent = '正在测试连接…';
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
        const res = await api("/api/ai/chat-reply", { method: "POST", body: JSON.stringify({ customer_phone: phone, customer_message: message, platform: "WhatsApp" }) });
        const aiDiv = document.createElement("div");
        aiDiv.className = "msg ai";
        aiDiv.textContent = res.ai_reply;
        container.appendChild(aiDiv);
        container.scrollTop = container.scrollHeight;
        if (res.auto_appointment_created) {
          alert("🔥 助理成功生成预约单！单号 [" + res.appointment_number + "]");
          await loadAppointments();
          await loadStats();
        }
      } catch (err) {
        alert("发送失败：" + err.message);
      }
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

    async function loadStoredLeads() {
      const tbody = document.getElementById("mapsLeadResults");
      if (!tbody) return;
      try {
        const data = await api("/api/leads");
        const leads = (data.leads || []).filter(x => x.source === "OpenStreetMap");
        tbody.innerHTML = "";
        if (!leads.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">尚无数据</td></tr>'; return; }
        leads.forEach(item => {
          const tr = document.createElement("tr");
          const add = val => { const td = document.createElement("td"); td.textContent = val || "—"; tr.appendChild(td); };
          add(item.name); add(item.category); add(item.phone);
          const webTd = document.createElement("td");
          if(item.website){ const a = document.createElement("a"); a.href=item.website; a.target="_blank"; a.textContent=item.website; webTd.appendChild(a); } else webTd.textContent="—";
          tr.appendChild(webTd); add(item.address);
          const mapTd = document.createElement("td"); const mapA = document.createElement("a"); mapA.href=item.maps_url; mapA.target="_blank"; mapA.textContent="Google Maps"; mapTd.appendChild(mapA); tr.appendChild(mapTd);
          tbody.appendChild(tr);
        });
      } catch (e) { console.error(e); }
    }

    document.getElementById("mapsLeadForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      const btn = document.getElementById("mapsSearchBtn");
      const status = document.getElementById("mapsSearchStatus");
      btn.disabled = true; status.textContent = "正在查询真实商家…";
      try {
        const data = await api("/api/maps/search", { method: "POST", body: JSON.stringify({ country: document.getElementById("mapsCountry").value.trim(), city: document.getElementById("mapsCity").value.trim(), keyword: document.getElementById("mapsKeyword").value.trim() }) });
        status.textContent = "搜索完成：" + data.saved + " 条记录。";
        await loadStoredLeads();
        await loadStats();
      } catch (err) { status.textContent = "失败：" + err.message; }
      finally { btn.disabled = false; }
    });

    async function loadAppointments() {
      const tbody = document.getElementById("appointmentList");
      if (!tbody) return;
      try {
        const appts = await api("/api/appointments");
        tbody.innerHTML = "";
        if (!appts.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">暂无预约</td></tr>'; return; }
        appts.forEach(ap => {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td><b>${ap.appointment_number}</b></td><td>${ap.staff_id}</td><td>${ap.phone}</td><td>${ap.date} ${ap.time}</td><td><b>${ap.status}</b></td><td><button class="danger" style="padding:4px 8px;font-size:12px;" onclick="deleteAppt('${ap.appointment_number}')">取消</button></td>`;
          tbody.appendChild(tr);
        });
      } catch (e) { console.error(e); }
    }

    document.getElementById("appointmentForm")?.addEventListener("submit", async function(e) {
      e.preventDefault();
      try {
        await api("/api/appointments", { method: "POST", body: JSON.stringify({ staff_id: document.getElementById("apptStaff").value.trim(), phone: document.getElementById("apptPhone").value.trim(), date: document.getElementById("apptDate").value, time: document.getElementById("apptTime").value }) });
        alert("预约成功！");
        this.reset();
        await loadAppointments();
        await loadStats();
      } catch (err) { alert(err.message); }
    });

    async function deleteAppt(no) {
      if (!confirm("确认取消预约？")) return;
      try { await api("/api/appointments/" + no, { method: "DELETE" }); await loadAppointments(); await loadStats(); } catch (err) { alert(err.message); }
    }

    function scrollToSec(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); }
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
