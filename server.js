
require('dotenv').config();
const express = require('express');
const path = require('path');
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

// 自动清理：启动时自动清理 7 天前的旧聊天日志
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

// Gemini 配置：密钥只放在服务器环境变量，绝不能放到前端
const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;

if (!apiKey) {
  console.error("[Gemini] 缺少 GEMINI_API_KEY。请在服务器环境变量中配置。");
}

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
  res.json({ ok: true, provider: "Gemini", configured: !!apiKey, model: GEMINI_MODEL });
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

You are the customer service assistant for a beauty salon business serving Dubai/UAE. Reply in the same language as the customer (English, Arabic, or Chinese). Be warm, concise, professional and helpful. Never claim a booking is confirmed unless the customer has clearly provided a date, time and phone number and the booking system has successfully created it. Do not invent prices, services, availability, addresses or policies; ask a short follow-up question when details are missing.
Today in Dubai is ${today}.
Return ONLY valid JSON with exactly these keys: {"reply":"string","has_booking_intent":false,"appointment_date":null,"appointment_time":null}. Set has_booking_intent=true only when the customer clearly asks to make an appointment, not merely asks about prices or services. Use YYYY-MM-DD for a clearly specified date and HH:MM (24-hour) for a clearly specified time. If date or time is unclear, return null for that field.`;

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
            has_booking_intent: { type: "BOOLEAN" },
            appointment_date: { type: "STRING", nullable: true },
            appointment_time: { type: "STRING", nullable: true }
          },
          required: ["reply", "has_booking_intent", "appointment_date", "appointment_time"]
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

    res.json({ ok: true, provider: "Gemini", model: GEMINI_MODEL, customer_phone: phone, ai_reply: aiReply, auto_appointment_created: autoAppointmentCreated, appointment_number: apptNumber, extracted_date: apptDate, extracted_time: apptTime });
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
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; margin: 0; padding: 12px; color: #f8fafc; }
    .container { max-width: 1400px; margin: 0 auto; background: #1e293b; padding: 18px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #334155; }
    .header-bar { border-bottom: 2px solid #334155; padding-bottom: 12px; margin-bottom: 16px; }
    .header-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
    h2 { color: #38bdf8; margin: 0; font-size: 20px; }
    .nav-buttons-scroll { display: flex; gap: 10px; overflow-x: auto; white-space: nowrap; padding: 4px 2px 10px 2px; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .nav-buttons-scroll::-webkit-scrollbar { display: none; }
    .nav-btn { flex: 0 0 auto; background: #0f172a; color: #38bdf8; border: 1px solid #334155; padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .nav-btn:hover, .nav-btn:active { background: #38bdf8; color: #0f172a; }
    .lang-btn { background: linear-gradient(135deg, #6366f1, #4f46e5); color: #fff; border: none; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: bold; cursor: pointer; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 25px; }
    .stat-card { padding: 18px; border-radius: 14px; color: #fff; box-shadow: 0 6px 16px rgba(0,0,0,0.25); display: flex; flex-direction: column; justify-content: space-between; transition: transform 0.2s; }
    .stat-card:hover { transform: translateY(-3px); }
    .stat-card.blue { background: linear-gradient(135deg, #3b82f6, #1d4ed8); }
    .stat-card.purple { background: linear-gradient(135deg, #a855f7, #6b21a8); }
    .stat-card.pink { background: linear-gradient(135deg, #ec4899, #be185d); }
    .stat-card.emerald { background: linear-gradient(135deg, #10b981, #047857); }
    .stat-card h4 { margin: 0 0 6px 0; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; opacity: 0.9; }
    .stat-card .num { font-size: 28px; font-weight: bold; margin-bottom: 12px; }
    .card-action-btn { background: rgba(255, 255, 255, 0.2); border: 1px solid rgba(255, 255, 255, 0.4); color: #fff; padding: 6px 12px; border-radius: 8px; font-size: 12px; font-weight: bold; cursor: pointer; text-align: center; transition: background 0.2s; }
    .card-action-btn:hover { background: rgba(255, 255, 255, 0.35); }
    .card { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 16px; margin-bottom: 20px; }
    h3 { color: #f1f5f9; margin-top: 0; border-bottom: 2px solid #334155; padding-bottom: 8px; font-size: 16px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; align-items: end; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-weight: 600; font-size: 12px; color: #94a3b8; }
    .form-group input, .form-group select, .form-group textarea { padding: 10px 12px; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 8px; font-size: 14px; outline: none; width: 100%; }
    button { padding: 10px 14px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; transition: transform 0.1s; width: 100%; }
    button:active { transform: scale(0.97); }
    button.primary { background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; }
    button.secondary { background: linear-gradient(135deg, #64748b, #475569); color: #fff; }
    button.success { background: linear-gradient(135deg, #22c55e, #15803d); color: #fff; }
    button.danger { background: linear-gradient(135deg, #ef4444, #b91c1c); color: #fff; }
    button.whatsapp { background: linear-gradient(135deg, #25d366, #128c7e); color: #fff; }
    button.purple-btn { background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff; }
    .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; min-width: 600px; }
    th, td { border: 1px solid #334155; padding: 10px; text-align: left; }
    th { background-color: #1e293b; font-weight: 600; color: #38bdf8; text-transform: uppercase; font-size: 11px; }
    tr:nth-child(even) { background-color: rgba(30, 41, 59, 0.4); }
    .badge { padding: 3px 8px; border-radius: 20px; font-size: 11px; font-weight: bold; display: inline-block; }
    .badge.fb { background: #1d4ed8; color: #bfdbfe; }
    .badge.ig { background: #be185d; color: #fce7f3; }
    .badge.tk { background: #374151; color: #f3f4f6; border: 1px solid #6b7280; }
    .chat-box { height: 280px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
    .msg { padding: 8px 12px; border-radius: 8px; max-width: 85%; font-size: 13px; line-height: 1.4; word-break: break-word; }
    .msg.customer { background: #334155; color: #f8fafc; align-self: flex-start; }
    .msg.ai { background: #0284c7; color: #fff; align-self: flex-end; }
    .chat-input-group { display: flex; flex-direction: column; gap: 8px; }
    @media(min-width: 640px) {
      .chat-input-group { flex-direction: row; }
      body { padding: 20px; }
      h2 { font-size: 24px; }
    }
  </style>
</head>
<body>

  <div class="container" id="mainApp">
    <div class="header-bar" id="sec-dashboard">
      <div class="header-top">
        <h2>🚀 AI Lead Master CRM</h2>
        <div style="display: flex; align-items: center; gap: 10px;">
          <button class="lang-btn" onclick="toggleLanguage()">🌐 EN / 中文</button>
          <span id="currentUserDisplay" style="font-weight: bold; color: #38bdf8; background: #0f172a; padding: 4px 8px; border-radius: 6px; font-size:12px; border: 1px solid #334155;">👤 Admin Mode</span>
        </div>
      </div>
      <div class="nav-buttons-scroll">
        <button class="nav-btn" onclick="scrollToSec('sec-dashboard')" data-i18n="nav_dashboard">📊 仪表盘</button>
        <button class="nav-btn" onclick="scrollToSec('sec-ai-chat')" data-i18n="nav_ai">🤖 美业助理</button>
        <button class="nav-btn" onclick="scrollToSec('sec-ai-edit')" data-i18n="nav_edit_ai">✍️ 助理设置</button>
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
      },

        btn_save_config: "💾 Save Config",
        social_title: "👤 1. Social Media Accounts Isolation",
        platform_label: "Platform:",
        label_label: "Label:",
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
      if (el) el.scrollIntoView({ behavior: 'smooth' });
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

    window.addEventListener("DOMContentLoaded", () => {
      applyLanguage();
      loadAllData();
    });

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
        aiDiv.textContent = res.ai_reply;
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
