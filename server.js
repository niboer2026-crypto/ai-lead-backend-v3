require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 10000;

// 初始化 SQLite 数据库
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

for (const [column, type] of [
  ['external_id', 'TEXT'], ['category', 'TEXT'], ['address', 'TEXT'],
  ['website', 'TEXT'], ['email', 'TEXT'], ['latitude', 'REAL'],
  ['longitude', 'REAL'], ['maps_url', 'TEXT']
]) {
  try { db.exec(`ALTER TABLE leads ADD COLUMN ${column} ${type}`); } catch (e) {}
}

const defaultWelcome = "👋 您好！我是 Beauty Corner 专属美业助理，请问有什么可以帮您的？";
const defaultPrompt = "You are a senior beauty consultant for a high-end beauty salon in Dubai. Professional, warm, and attentive. Detect language and reply in the same language.";

const existingConfig = db.prepare('SELECT * FROM ai_config WHERE id = 1').get();
if (!existingConfig) {
  db.prepare('INSERT INTO ai_config (id, welcome_msg, system_prompt) VALUES (1, ?, ?)').run(defaultWelcome, defaultPrompt);
}

app.use(express.json());

const AUTH_SECRET = process.env.APP_ENCRYPTION_KEY || process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE_NAME = 'alm_session';
function signToken(payload) { const body=Buffer.from(JSON.stringify(payload)).toString('base64url'); const sig=crypto.createHmac('sha256',AUTH_SECRET).update(body).digest('base64url'); return body+'.'+sig; }
function verifyToken(token) { try { const [body,sig]=String(token||'').split('.'); const expected=crypto.createHmac('sha256',AUTH_SECRET).update(body).digest(); const actual=Buffer.from(sig,'base64url'); if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected)) return null; const d=JSON.parse(Buffer.from(body,'base64url').toString()); return d.exp>Date.now()?d:null; } catch { return null; } }
function getSession(req) { const c=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE_NAME+'=')); return c?verifyToken(decodeURIComponent(c.slice(COOKIE_NAME.length+1))):null; }
function hashPassword(password,salt=crypto.randomBytes(16).toString('hex')) { return {salt,hash:crypto.scryptSync(password,salt,64).toString('hex')}; }
function checkPassword(password,salt,hash) { const a=crypto.scryptSync(password,salt,64), b=Buffer.from(hash,'hex'); return a.length===b.length&&crypto.timingSafeEqual(a,b); }

app.get('/api/auth/status',(req,res)=>{ const admin=db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get(); const session=getSession(req); res.json({setupRequired:!admin,authenticated:!!session,username:session?.username||null}); });
app.post('/api/auth/setup',(req,res)=>{ if(db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) return res.status(409).json({error:'管理员已经创建。'}); const username=String(req.body?.username||'').trim(), password=String(req.body?.password||''); if(!username || password.length<6) return res.status(400).json({error:'用户名不能为空，密码至少6位'}); const h=hashPassword(password); db.prepare('INSERT INTO users(username,password,role) VALUES(?,?,?)').run(username,h.salt+':'+h.hash,'admin'); const token=signToken({username,exp:Date.now()+7*86400000}); res.setHeader('Set-Cookie',`${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`); res.json({ok:true,username}); });
app.post('/api/auth/login',(req,res)=>{ const username=String(req.body?.username||'').trim(), password=String(req.body?.password||''); const row=db.prepare("SELECT * FROM users WHERE username=? AND role='admin'").get(username); if(!row) return res.status(401).json({error:'账号或密码错误'}); const [salt,hash]=String(row.password).split(':'); const valid=checkPassword(password,salt,hash); if(!valid) return res.status(401).json({error:'账号或密码错误'}); const token=signToken({username,exp:Date.now()+7*86400000}); res.setHeader('Set-Cookie',`${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`); res.json({ok:true,username}); });
app.post('/api/auth/logout',(req,res)=>{res.setHeader('Set-Cookie',`${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);res.json({ok:true});});

app.use('/api',(req,res,next)=>{if(['/auth/status','/auth/setup','/auth/login','/auth/logout'].includes(req.path))return next();if(!getSession(req))return res.status(401).json({error:'请先登录',code:'AUTH_REQUIRED'});next();});

// 更新为官方最新要求的 gemini-3.8-flash 模型
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const ENC_KEY = crypto.createHash('sha256').update(AUTH_SECRET).digest();
function encryptSecret(value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',ENC_KEY,iv),data=Buffer.concat([c.update(value,'utf8'),c.final()]);return{encrypted_key:data.toString('base64'),iv:iv.toString('base64'),auth_tag:c.getAuthTag().toString('base64')};}
function decryptSecret(row){const d=crypto.createDecipheriv('aes-256-gcm',ENC_KEY,Buffer.from(row.iv,'base64'));d.setAuthTag(Buffer.from(row.auth_tag,'base64'));return Buffer.concat([d.update(Buffer.from(row.encrypted_key,'base64')),d.final()]).toString('utf8');}
function loadStoredKey(){try{const r=db.prepare('SELECT encrypted_key,iv,auth_tag FROM ai_secrets WHERE id=1').get();return r?decryptSecret(r):'';}catch{return '';}}
let apiKey=(process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY||loadStoredKey()||'').trim();
let ai=apiKey?new GoogleGenAI({apiKey}):null;

async function callGeminiWithRetry(payload, retries = 3, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await ai.models.generateContent(payload);
    } catch (err) {
      const isOverloaded = /503|unavailable|high demand|overloaded/i.test(err.message || '');
      if (isOverloaded && attempt < retries) {
        console.warn(`[Gemini 503 Overloaded] 第 ${attempt} 次请求遇到高负载，正在等待 ${delay}ms 后自动重试...`);
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

app.get('/api/ai/status', (req, res) => {
  res.json({ok:true,model:GEMINI_MODEL,configured:!!apiKey&&!!ai});
});

app.post('/api/ai/key',(req,res)=>{try{const key=String(req.body?.apiKey||'').trim();if(!key)return res.status(400).json({error:'请输入有效的 Key'});const e=encryptSecret(key);db.prepare(`INSERT INTO ai_secrets(id,encrypted_key,iv,auth_tag,updated_at) VALUES(1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET encrypted_key=excluded.encrypted_key,iv=excluded.iv,auth_tag=excluded.auth_tag,updated_at=CURRENT_TIMESTAMP`).run(e.encrypted_key,e.iv,e.auth_tag);apiKey=key;ai=new GoogleGenAI({apiKey});res.json({ok:true,message:'API Key 保存成功'});}catch(err){res.status(500).json({error:err.message});}});

app.post('/api/ai/key-test', async (req, res) => {
  try {
    if (!apiKey || !ai) return res.status(503).json({ ok: false, error: '未配置 Gemini API Key' });
    const result = await callGeminiWithRetry({ model: GEMINI_MODEL, contents: 'Reply OK' });
    res.json({ ok: true, message: '连接成功', preview: String(result.text || '').slice(0, 50) });
  } catch (err) { res.status(502).json({ ok: false, error: err.message }); }
});

app.get('/api/ai/config', (req, res) => {
  res.json(db.prepare('SELECT welcome_msg, system_prompt FROM ai_config WHERE id = 1').get() || { welcome_msg: defaultWelcome, system_prompt: defaultPrompt });
});

app.post('/api/ai/config', (req, res) => {
  const { welcome_msg, system_prompt } = req.body || {};
  db.prepare('UPDATE ai_config SET welcome_msg = ?, system_prompt = ? WHERE id = 1').run(welcome_msg || defaultWelcome, system_prompt || defaultPrompt);
  res.json({ ok: true });
});

app.get('/api/dashboard/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as cnt FROM leads').get().cnt;
  const fb = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Facebook%'").get().cnt;
  const ig = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%Instagram%'").get().cnt;
  const tk = db.prepare("SELECT COUNT(*) as cnt FROM leads WHERE source LIKE '%TikTok%'").get().cnt;
  res.json({ ok: true, total, fb, ig, tk });
});

app.get('/api/social-accounts', (req, res) => { res.json(db.prepare('SELECT * FROM social_accounts ORDER BY id DESC').all()); });
app.post('/api/social-accounts', (req, res) => {
  const { platform, label, profile_id } = req.body || {};
  db.prepare('INSERT INTO social_accounts (platform, label, profile_id) VALUES (?, ?, ?)').run(platform, label, profile_id);
  res.json({ ok: true });
});
app.delete('/api/social-accounts/:id', (req, res) => { db.prepare('DELETE FROM social_accounts WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

app.get('/api/appointments', (req, res) => { res.json(db.prepare('SELECT * FROM appointments ORDER BY created_at DESC').all()); });
app.post('/api/appointments', (req, res) => {
  const b = req.body || {};
  const apptNo = 'APT-' + Date.now().toString().slice(-6);
  db.prepare(`INSERT INTO appointments (appointment_number, staff_id, phone, date, time, status, created_at) VALUES (?, ?, ?, ?, ?, 'Confirmed', ?)`).run(apptNo, b.staff_id || 'Staff', b.phone, b.date, b.time, new Date().toISOString());
  res.json({ ok: true, appointment_number: apptNo });
});
app.delete('/api/appointments/:no', (req, res) => { db.prepare('DELETE FROM appointments WHERE appointment_number = ?').run(req.params.no); res.json({ ok: true }); });

// 免费真实商家搜索 (OpenStreetMap)
const OSM_USER_AGENT = 'AILeadMaster/1.0';
let lastNominatim = 0;
async function nominatimGeocode(query) {
  const wait = Math.max(0, 1100 - (Date.now() - lastNominatim));
  if (wait) await new Promise(r => setTimeout(r, wait));
  lastNominatim = Date.now();
  const res = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=' + encodeURIComponent(query), { headers: { 'User-Agent': OSM_USER_AGENT } });
  const rows = await res.json();
  if (!rows.length) throw new Error('未找到该城市/国家');
  return { lat: Number(rows[0].lat), lon: Number(rows[0].lon), display_name: rows[0].display_name };
}

app.post('/api/maps/search', async (req, res) => {
  try {
    const { country, city, keyword } = req.body || {};
    if (!country || !city || !keyword) return res.status(400).json({ ok: false, error: '请填写完整国家、城市和关键词' });
    const loc = await nominatimGeocode(`${city}, ${country}`);
    const query = `[out:json][timeout:25];(nwr(around:5000,${loc.lat},${loc.lon})[name~"${keyword}",i];nwr(around:5000,${loc.lat},${loc.lon})[shop];);out center tags 50;`;
    const overpass = await fetch('https://overpass.private.coffee/api/interpreter', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query)
    });
    const data = await overpass.json();
    const results = (data.elements || []).map(el => {
      const tags = el.tags || {};
      const name = tags.name || tags.brand;
      if (!name) return null;
      const id = `osm:${el.type}:${el.id}`;
      return {
        id, external_id: id, name, phone: tags.phone || tags['contact:phone'] || '',
        source: 'OpenStreetMap', center: `${city}, ${country}`, created_at: new Date().toISOString(),
        category: tags.shop || tags.amenity || 'business', address: [tags['addr:street'], tags['addr:city']].filter(Boolean).join(', '),
        website: tags.website || '', email: tags.email || '', latitude: el.lat || el.center?.lat, longitude: el.lon || el.center?.lon,
        maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ', ' + city)}`
      };
    }).filter(Boolean);

    const insert = db.prepare(`INSERT INTO leads (id,name,phone,source,center,created_at,external_id,category,address,website,email,latitude,longitude,maps_url)
      VALUES (@id,@name,@phone,@source,@center,@created_at,@external_id,@category,@address,@website,@email,@latitude,@longitude,@maps_url)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone`);
    results.forEach(r => insert.run(r));
    res.json({ ok: true, results, searched: results.length, saved: results.length, location: loc.display_name, notice: '搜索成功' });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get('/api/leads', (req, res) => {
  res.json({ ok: true, leads: db.prepare("SELECT * FROM leads ORDER BY created_at DESC LIMIT 100").all() });
});

// AI 智能客服接口
app.post('/api/ai/chat-reply', async (req, res) => {
  const { customer_phone, customer_message, platform } = req.body || {};
  const phone = String(customer_phone || "Web Visitor").trim();
  const message = String(customer_message || "").trim();
  if (!message) return res.status(400).json({ ok: false, error: "消息不能为空" });
  if (!apiKey || !ai) return res.status(503).json({ ok: false, error: "未配置 Gemini API Key" });

  try {
    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'customer', ?, ?)`).run(phone, platform || 'Website', message, new Date().toISOString());
    const cfg = db.prepare('SELECT system_prompt FROM ai_config WHERE id = 1').get();

    const response = await callGeminiWithRetry({
      model: GEMINI_MODEL,
      contents: `Customer message: ${message}`,
      config: {
        systemInstruction: cfg?.system_prompt || defaultPrompt,
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

    const parsed = JSON.parse(response.text || '{}');
    const aiReply = parsed.reply || "Hello! How can I help you today?";
    db.prepare(`INSERT INTO chat_logs (customer_phone, platform, sender, message, created_at) VALUES (?, ?, 'ai', ?, ?)`).run(phone, platform || 'Website', aiReply, new Date().toISOString());

    let apptNumber = null;
    if (parsed.has_booking_intent && parsed.appointment_date && parsed.appointment_time && phone) {
      apptNumber = 'APT-' + Date.now().toString().slice(-6);
      db.prepare(`INSERT INTO appointments (appointment_number, staff_id, phone, date, time, status, created_at) VALUES (?, 'Gemini AI', ?, ?, ?, 'Confirmed', ?)`).run(apptNumber, phone, parsed.appointment_date, parsed.appointment_time, new Date().toISOString());
    }

    res.json({ ok: true, ai_reply: aiReply, detected_language: parsed.detected_language, auto_appointment_created: !!apptNumber, appointment_number: apptNumber });
  } catch (err) {
    res.status(502).json({ ok: false, error: "Gemini 接口繁忙或调用失败: " + err.message });
  }
});

app.get('/api/ai/chat-logs', (req, res) => {
  res.json(db.prepare('SELECT * FROM chat_logs ORDER BY id DESC LIMIT 50').all().reverse());
});

// 前端完整 UI 面板
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Master - 美业 CRM 后台</title>
  <style>
    :root{--bg:#f8fafc;--card:#fff;--text:#1e293b;--primary:#6366f1;--border:#e2e8f0}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:20px}
    .container{max-width:1200px;margin:0 auto}
    .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;margin-bottom:20px;box-shadow:0 4px 6px -1px rgba(0,0,0,.05)}
    h2,h3{margin-top:0}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:20px}
    .stat-box{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:20px;border-radius:12px;font-weight:bold}
    .stat-box.purple{background:linear-gradient(135deg,#ec4899,#f43f5e)}
    .stat-box.emerald{background:linear-gradient(135deg,#10b981,#059669)}
    input,select,textarea{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;font-size:14px;margin-top:6px;box-sizing:border-box}
    button{background:var(--primary);color:#fff;border:0;padding:10px 18px;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:10px}
    button:hover{opacity:.9}button.danger{background:#ef4444}button.success{background:#10b981}
    table{width:100%;border-collapse:collapse;margin-top:10px;font-size:14px}
    th,td{border-bottom:1px solid var(--border);padding:10px;text-align:left}th{background:#f1f5f9;color:#475569}
    .chat-box{height:300px;border:1px solid var(--border);border-radius:8px;padding:12px;overflow-y:auto;background:#f8fafc;margin-bottom:10px;display:flex;flex-direction:column;gap:8px}
    .msg{padding:8px 12px;border-radius:8px;max-width:80%;font-size:13px}
    .msg.customer{background:#fff;border:1px solid var(--border);align-self:flex-start}
    .msg.ai{background:#6366f1;color:#fff;align-self:flex-end}
    #authModal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:999}
    #authCard{background:#fff;padding:30px;border-radius:16px;width:360px;box-shadow:0 20px 25px -5px rgba(0,0,0,.1)}
  </style>
</head>
<body>
  <div id="authModal">
    <div id="authCard">
      <h3 id="authModalTitle">管理员登录</h3>
      <form id="authForm">
        <input id="authName" placeholder="用户名" required>
        <input id="authPass" type="password" placeholder="密码（至少6位）" required>
        <button type="submit" style="width:100%">进入系统</button>
        <p id="authErr" style="color:#ef4444;font-size:13px;margin-top:8px"></p>
      </form>
    </div>
  </div>

  <div class="container" id="appContent" style="display:none">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <h2>🚀 AI Lead Master & 美业 CRM 控制台</h2>
      <button class="danger" onclick="logout()" style="margin:0">退出登录</button>
    </div>

    <!-- 统计卡片 -->
    <div class="grid">
      <div class="stat-box"><div>总线索量</div><div id="statTotal" style="font-size:28px;margin-top:5px">0</div></div>
      <div class="stat-box purple"><div>Facebook 线索</div><div id="statFb" style="font-size:28px;margin-top:5px">0</div></div>
      <div class="stat-box emerald"><div>预约单数量</div><div id="statAppt" style="font-size:28px;margin-top:5px">0</div></div>
    </div>

    <!-- AI 配置与密钥设置 -->
    <div class="card">
      <h3>🔐 Gemini API Key 设置</h3>
      <div style="display:flex;gap:10px">
        <input id="apiKeyInput" type="password" placeholder="粘贴 Google AI Studio Gemini API Key">
        <button onclick="saveApiKey()" style="white-space:nowrap">保存 Key</button>
        <button class="success" onclick="testKey()" style="white-space:nowrap">测试连接</button>
      </div>
      <p id="keyStatus" style="font-size:13px;color:#64748b;margin-top:8px">状态：检查中...</p>
    </div>

    <!-- AI 助理对话测试 -->
    <div class="card">
      <h3>🤖 AI 美业客服助理实时测试</h3>
      <div class="chat-box" id="chatContainer">
        <div class="msg ai">👋 您好！我是 Beauty Corner 专属美业助理，请问有什么可以帮您的？</div>
      </div>
      <div style="display:flex;gap:10px">
        <input id="chatPhone" placeholder="客户手机号 (可选)" style="width:180px">
        <input id="chatMsg" placeholder="输入咨询内容 (例如: 帮我预约明天下午3点美甲)" onkeypress="if(event.key==='Enter')sendChat()">
        <button onclick="sendChat()" style="white-space:nowrap">发送</button>
      </div>
    </div>

    <!-- 地图商家搜索 -->
    <div class="card">
      <h3>🗺️ 免费地图商家获客 (OpenStreetMap)</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:10px;align-items:end">
        <div><label>国家</label><input id="mapCountry" value="United Arab Emirates"></div>
        <div><label>城市</label><input id="mapCity" value="Dubai"></div>
        <div><label>关键词</label><input id="mapKeyword" value="salon"></div>
        <button onclick="searchMaps()">搜索商家</button>
      </div>
      <div style="margin-top:15px;overflow-x:auto">
        <table>
          <thead><tr><th>商家名称</th><th>类别</th><th>电话</th><th>网站</th><th>地址</th><th>操作</th></tr></thead>
          <tbody id="mapResults"><tr><td colspan="6" style="text-align:center;color:#64748b">暂无搜索结果</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    async function init() {
      const st = await fetch('/api/auth/status').then(r => r.json());
      if (st.authenticated) {
        document.getElementById('authModal').style.display = 'none';
        document.getElementById('appContent').style.display = 'block';
        loadAll();
      } else {
        document.getElementById('authModalTitle').textContent = st.setupRequired ? '首次使用：创建管理员账号' : '管理员登录';
      }
    }

    document.getElementById('authForm').addEventListener('submit', async e => {
      e.preventDefault();
      const st = await fetch('/api/auth/status').then(r => r.json());
      const endpoint = st.setupRequired ? '/api/auth/setup' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('authName').value, password: document.getElementById('authPass').value })
      });
      const data = await res.json();
      if (res.ok) { location.reload(); } else { document.getElementById('authErr').textContent = data.error; }
    });

    async function logout() {
      await fetch('/api/auth/logout', { method: 'POST' });
      location.reload();
    }

    async function loadAll() {
      const stats = await fetch('/api/dashboard/stats').then(r => r.json());
      document.getElementById('statTotal').textContent = stats.total;
      document.getElementById('statFb').textContent = stats.fb;
      
      const appts = await fetch('/api/appointments').then(r => r.json());
      document.getElementById('statAppt').textContent = appts.length;

      const aiStatus = await fetch('/api/ai/status').then(r => r.json());
      document.getElementById('keyStatus').textContent = aiStatus.configured ? '状态：Gemini AI 已就绪 (Online)' : '状态：未配置 API Key';

      loadChatLogs();
      loadLeads();
    }

    async function saveApiKey() {
      const apiKey = document.getElementById('apiKeyInput').value.trim();
      const res = await fetch('/api/ai/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }) });
      const data = await res.json();
      alert(data.message || data.error);
      loadAll();
    }

    async function testKey() {
      const res = await fetch('/api/ai/key-test', { method: 'POST' });
      const data = await res.json();
      alert(data.ok ? '连接成功！' : '连接失败: ' + data.error);
    }

    async function sendChat() {
      const phone = document.getElementById('chatPhone').value.trim();
      const message = document.getElementById('chatMsg').value.trim();
      if (!message) return;
      const box = document.getElementById('chatContainer');
      box.innerHTML += \`<div class="msg customer">[\${phone || 'Web'}] \${message}</div>\`;
      document.getElementById('chatMsg').value = '';
      box.scrollTop = box.scrollHeight;

      const res = await fetch('/api/ai/chat-reply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_phone: phone, customer_message: message })
      });
      const data = await res.json();
      if (data.ok) {
        box.innerHTML += \`<div class="msg ai">\${data.ai_reply}</div>\`;
        if (data.auto_appointment_created) {
          alert('🔥 成功识别预约意向并生成预约单：' + data.appointment_number);
          loadAll();
        }
      } else {
        box.innerHTML += \`<div class="msg customer" style="background:#fee2e2">错误: \${data.error}</div>\`;
      }
      box.scrollTop = box.scrollHeight;
    }

    async function loadChatLogs() {
      const logs = await fetch('/api/ai/chat-logs').then(r => r.json());
      const box = document.getElementById('chatContainer');
      if (logs.length > 0) {
        box.innerHTML = '';
        logs.forEach(l => {
          box.innerHTML += \`<div class="msg \${l.sender === 'ai' ? 'ai' : 'customer'}">[\${l.customer_phone}] \${l.message}</div>\`;
        });
        box.scrollTop = box.scrollHeight;
      }
    }

    async function searchMaps() {
      const country = document.getElementById('mapCountry').value;
      const city = document.getElementById('mapCity').value;
      const keyword = document.getElementById('mapKeyword').value;
      const tbody = document.getElementById('mapResults');
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center">正在搜索...</td></tr>';

      const res = await fetch('/api/maps/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country, city, keyword })
      });
      const data = await res.json();
      if (data.ok) {
        tbody.innerHTML = '';
        if (!data.results.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center">未找到匹配商家</td></tr>'; return; }
        data.results.forEach(r => {
          tbody.innerHTML += \`<tr><td>\${r.name}</td><td>\${r.category}</td><td>\${r.phone || '-'}</td><td><a href="\${r.website}" target="_blank">\${r.website ? '链接' : '-'}</a></td><td>\-</td><td><a href="\${r.maps_url}" target="_blank">Google Maps</a></td></tr>\`;
        });
        loadAll();
      } else {
        tbody.innerHTML = \`<tr><td colspan="6" style="text-align:center;color:red">搜索失败: \${data.error}</td></tr>\`;
      }
    }

    async function loadLeads() {}

    init();
  </script>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
