const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;

// 中间件配置
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 初始化 SQLite 数据库（存放在项目根目录的 data.db）
const dbFile = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('数据库连接失败:', err.message);
    } else {
        console.log('成功连接到 SQLite 数据库: data.db');
    }
});

// 创建必要的表结构
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        phone TEXT,
        source TEXT,
        status TEXT DEFAULT '新线索',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chat_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Helper: 调用 Google Gemini API
function callGeminiAPI(apiKey, prompt, callback) {
    const data = JSON.stringify({
        contents: [{
            parts: [{ text: prompt }]
        }]
    });

    const options = {
        hostname: 'generativelanguage.googleapis.com',
        path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data)
        }
    };

    const req = https.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
            try {
                const parsed = JSON.parse(responseBody);
                if (parsed.candidates && parsed.candidates[0].content.parts[0].text) {
                    callback(null, parsed.candidates[0].content.parts[0].text);
                } else {
                    callback(new Error(parsed.error?.message || 'Gemini API 返回格式错误'));
                }
            } catch (e) {
                callback(e);
            }
        });
    });

    req.on('error', (e) => { callback(e); });
    req.write(data);
    req.end();
}

// ================= API 路由 =================

// 1. 获取系统状态与配置
app.get('/api/status', (req, res) => {
    db.get(`SELECT value FROM settings WHERE key = 'gemini_api_key'`, (err, row) => {
        res.json({
            status: 'online',
            hasApiKey: !!(row && row.value) || !!process.env.GEMINI_API_KEY
        });
    });
});

// 2. 保存 API Key
app.post('/api/settings', (req, res) => {
    const { apiKey } = req.body;
    db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('gemini_api_key', ?)`, [apiKey], (err) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'API Key 保存成功！' });
    });
});

// 3. AI 对话接口
app.post('/api/chat', (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: '消息不能为空' });

    // 优先从数据库读取 API Key，如果没有则取环境变量
    db.get(`SELECT value FROM settings WHERE key = 'gemini_api_key'`, (err, row) => {
        const apiKey = (row && row.value) || process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(400).json({ error: '请先在后台配置 Gemini API Key！' });
        }

        // 记录用户消息
        db.run(`INSERT INTO chat_logs (role, message) VALUES (?, ?)`, ['user', message]);

        callGeminiAPI(apiKey, `你是迪拜高端美甲美睫沙龙(Beauty Corner Ladies Salon)的智能客服。请用热情、专业且带有多语言接待能力的语气回复以下客户咨询：\n\n客户：${message}`, (apiErr, reply) => {
            if (apiErr) {
                return res.status(500).json({ error: apiErr.message });
            }
            // 记录 AI 回复
            db.run(`INSERT INTO chat_logs (role, message) VALUES (?, ?)`, ['ai', reply]);
            res.json({ reply });
        });
    });
});

// 4. 获取所有线索
app.get('/api/leads', (req, res) => {
    db.all(`SELECT * FROM leads ORDER BY id DESC`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 5. 添加新线索
app.post('/api/leads', (req, res) => {
    const { name, phone, source } = req.body;
    db.run(`INSERT INTO leads (name, phone, source) VALUES (?, ?, ?)`, [name, phone, source || '手动录入'], function(err) {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, id: this.lastID });
    });
});

// ================= 前端单页面 (HTML/CSS/JS) =================
app.get('*', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Dubai Beauty CRM & AI 智能营销控制台</title>
    <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
</head>
<body class="bg-slate-50 min-h-screen font-sans text-slate-800">
    <div class="max-w-6xl mx-auto px-4 py-8">
        <!-- 头部 -->
        <header class="bg-white rounded-2xl shadow-sm p-6 mb-6 flex flex-col md:flex-row justify-between items-center gap-4">
            <div>
                <h1 class="text-2xl font-bold text-slate-900">✨ Dubai Beauty CRM 自动化管理后台</h1>
                <p class="text-sm text-slate-500 mt-1">云端 24 小时运行中 | Gemini 2.5 驱动</p>
            </div>
            <div class="flex items-center gap-3">
                <span id="status-badge" class="px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">状态检测中...</span>
            </div>
        </header>

        <!-- 配置卡片 -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
            <div class="bg-white rounded-2xl shadow-sm p-6 md:col-span-1">
                <h2 class="text-lg font-semibold mb-4 text-slate-800">🔑 Gemini API Key 设置</h2>
                <div class="space-y-3">
                    <input type="password" id="api-key-input" placeholder="输入 AIza... 密钥" class="w-full px-4 py-2 border rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-sm">
                    <button onclick="saveApiKey()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 rounded-xl text-sm transition">保存 API Key</button>
                    <p id="key-msg" class="text-xs text-center text-slate-500 mt-1"></p>
                </div>
            </div>

            <!-- AI 聊天测试卡片 -->
            <div class="bg-white rounded-2xl shadow-sm p-6 md:col-span-2 flex flex-col h-[360px]">
                <h2 class="text-lg font-semibold mb-3 text-slate-800">💬 AI 智能客服对话测试</h2>
                <div id="chat-box" class="flex-1 border rounded-xl p-3 overflow-y-auto bg-slate-50 text-sm space-y-2 mb-3">
                    <div class="text-slate-400 text-center text-xs">发送消息测试 Gemini AI 响应...</div>
                </div>
                <div class="flex gap-2">
                    <input type="text" id="chat-input" placeholder="输入咨询内容，例如：我想预约明天下午的美甲..." class="flex-1 px-4 py-2 border rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-sm" onkeypress="if(event.key==='Enter') sendChat()">
                    <button onclick="sendChat()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-xl text-sm font-medium transition">发送</button>
                </div>
            </div>
        </div>

        <!-- 客户线索表格 -->
        <div class="bg-white rounded-2xl shadow-sm p-6">
            <div class="flex justify-between items-center mb-4">
                <h2 class="text-lg font-semibold text-slate-800">📋 客户线索列表 (Leads)</h2>
                <button onclick="loadLeads()" class="text-sm text-indigo-600 hover:underline">刷新列表</button>
            </div>
            <div class="overflow-x-auto">
                <table class="w-full text-left border-collapse text-sm">
                    <thead>
                        <tr class="border-b text-slate-400 font-medium">
                            <th class="py-3 px-4">ID</th>
                            <th class="py-3 px-4">客户姓名</th>
                            <th class="py-3 px-4">电话号码</th>
                            <th class="py-3 px-4">来源渠道</th>
                            <th class="py-3 px-4">状态</th>
                            <th class="py-3 px-4">录入时间</th>
                        </tr>
                    </thead>
                    <tbody id="leads-table-body">
                        <tr><td colspan="6" class="py-4 text-center text-slate-400">加载中...</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    </div>

    <script>
        // 检查系统状态
        async function checkStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                const badge = document.getElementById('status-badge');
                if (data.hasApiKey) {
                    badge.className = 'px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800';
                    badge.innerText = '🟢 已连接 (AI就绪)';
                } else {
                    badge.className = 'px-3 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800';
                    badge.innerText = '🟡 运行中 (请配置API Key)';
                }
            } catch (e) {
                console.error(e);
            }
        }

        // 保存 API Key
        async function saveApiKey() {
            const apiKey = document.getElementById('api-key-input').value.trim();
            const msg = document.getElementById('key-msg');
            if (!apiKey) {
                msg.innerText = '请输入有效的 Key';
                msg.className = 'text-xs text-center text-red-500 mt-1';
                return;
            }
            try {
                const res = await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ apiKey })
                });
                const data = await res.json();
                if (data.success) {
                    msg.innerText = '保存成功！';
                    msg.className = 'text-xs text-center text-emerald-600 mt-1';
                    checkStatus();
                } else {
                    msg.innerText = '保存失败: ' + data.error;
                    msg.className = 'text-xs text-center text-red-500 mt-1';
                }
            } catch (e) {
                msg.innerText = '请求出错';
                msg.className = 'text-xs text-center text-red-500 mt-1';
            }
        }

        // 发送聊天测试
        async function sendChat() {
            const input = document.getElementById('chat-input');
            const chatBox = document.getElementById('chat-box');
            const text = input.value.trim();
            if (!text) return;

            chatBox.innerHTML += \`<div class="text-right"><span class="inline-block bg-indigo-600 text-white px-3 py-1.5 rounded-xl">\${text}</span></div>\`;
            input.value = '';
            chatBox.scrollTop = chatBox.scrollHeight;

            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text })
                });
                const data = await res.json();
                if (data.reply) {
                    chatBox.innerHTML += \`<div class="text-left"><span class="inline-block bg-white border px-3 py-1.5 rounded-xl text-slate-700">\${data.reply}</span></div>\`;
                } else {
                    chatBox.innerHTML += \`<div class="text-left text-red-500 text-xs">错误: \${data.error}</div>\`;
                }
            } catch (e) {
                chatBox.innerHTML += \`<div class="text-left text-red-500 text-xs">网络请求失败</div>\`;
            }
            chatBox.scrollTop = chatBox.scrollHeight;
        }

        // 加载线索
        async function loadLeads() {
            const tbody = document.getElementById('leads-table-body');
            try {
                const res = await fetch('/api/leads');
                const leads = await res.json();
                if (leads.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" class="py-4 text-center text-slate-400">暂无客户线索</td></tr>';
                    return;
                }
                tbody.innerHTML = leads.map(l => \`
                    <tr class="border-b hover:bg-slate-50">
                        <td class="py-3 px-4 text-slate-400">#\${l.id}</td>
                        <td class="py-3 px-4 font-medium">\${l.name || '未命名'}</td>
                        <td class="py-3 px-4">\${l.phone || '-'}</td>
                        <td class="py-3 px-4">\${l.source}</td>
                        <td class="py-3 px-4"><span class="px-2 py-1 bg-emerald-50 text-emerald-700 rounded-md text-xs">\${l.status}</span></td>
                        <td class="py-3 px-4 text-slate-400 text-xs">\${l.created_at}</td>
                    </tr>
                \`).join('');
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="6" class="py-4 text-center text-red-500">加载失败</td></tr>';
            }
        }

        // 初始化加载
        checkStatus();
        loadLeads();
    </script>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
