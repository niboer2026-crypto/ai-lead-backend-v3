const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.PORT || 10000;

// 内存数据库模拟 (后续挂载至 Cloud Firestore)
const apiCostLogsDB = [];    // API 调用与成本日志
const accountsDB = [];      // 多平台账号 (WhatsApp, FB, IG, TikTok)
const leadsDB = [];         // 统一 CRM 客户线索
const appointmentsDB = [];  // 预约记录

// 实用函数：API 成本记录工具
function logApiUsage(service, endpoint, tokensOrUnits, estimatedCostUSD) {
  const logEntry = {
    id: 'LOG-' + Date.now(),
    service, // 例如: 'Facebook Leads API', 'TikTok Leads API', 'OpenAI API'
    endpoint,
    units: tokensOrUnits,
    costUSD: estimatedCostUSD,
    timestamp: new Date().toISOString()
  };
  apiCostLogsDB.push(logEntry);
  console.log(`[API Cost Logged] ${service} - Cost: $${estimatedCostUSD}`);
  return logEntry;
}

const server = http.createServer((req, res) => {
  // CORS 跨域设置
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. 首页直接渲染前端 index.html 网页
  if (req.url === '/' && req.method === 'GET') {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(indexPath));
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html 文件未找到，请检查仓库根目录。');
      return;
    }
  }

  // 2. 健康检查 API
  if (req.url === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ msg: 'AI Lead Master Backend is active', ok: true }));
    return;
  }

  // 3. 管理员查看 API 成本与使用量看板数据 (GET /api/admin/api-costs)
  if (req.url === '/api/admin/api-costs' && req.method === 'GET') {
    const totalCost = apiCostLogsDB.reduce((sum, item) => sum + item.costUSD, 0);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      totalCostUSD: Number(totalCost.toFixed(4)),
      logsCount: apiCostLogsDB.length,
      logs: apiCostLogsDB
    }));
    return;
  }

  // 4. 客户智能查重与新增接口 (POST /api/leads/add)
  if (req.url === '/api/leads/add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const lead = JSON.parse(body || '{}');
        const isDuplicate = leadsDB.some(l => l.phone === lead.phone && l.center === lead.center);
        
        if (isDuplicate) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Duplicate customer identified by phone number' }));
          return;
        }

        lead.id = 'LEAD-' + Date.now();
        lead.createdAt = new Date().toISOString();
        leadsDB.push(lead);

        logApiUsage('CRM Deduplication', '/api/leads/add', 1, 0.0001);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: 'Lead saved successfully', data: lead }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // 5. Facebook 广告线索 Webhook 接收端 (POST /api/webhooks/facebook)
  if (req.url === '/api/webhooks/facebook' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        // 解析 Facebook Lead Ads 传来的线索
        const leadName = payload.name || 'FB User';
        const leadPhone = payload.phone || 'Unknown';
        
        const isDuplicate = leadsDB.some(l => l.phone === leadPhone);
        if (!isDuplicate && leadPhone !== 'Unknown') {
          leadsDB.push({
            id: 'LEAD-FB-' + Date.now(),
            name: leadName,
            phone: leadPhone,
            source: 'Facebook Ads',
            center: 'B2C',
            createdAt: new Date().toISOString()
          });
        }
        logApiUsage('Facebook Webhook', '/api/webhooks/facebook', 1, 0.0000);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Webhook parse error' }));
      }
    });
    return;
  }

  // 6. TikTok 获客线索 Webhook 接收端 (POST /api/webhooks/tiktok)
  if (req.url === '/api/webhooks/tiktok' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const leadName = payload.name || 'TikTok User';
        const leadPhone = payload.phone || 'Unknown';

        const isDuplicate = leadsDB.some(l => l.phone === leadPhone);
        if (!isDuplicate && leadPhone !== 'Unknown') {
          leadsDB.push({
            id: 'LEAD-TT-' + Date.now(),
            name: leadName,
            phone: leadPhone,
            source: 'TikTok Ads',
            center: 'B2C',
            createdAt: new Date().toISOString()
          });
        }
        logApiUsage('TikTok Webhook', '/api/webhooks/tiktok', 1, 0.0000);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Webhook parse error' }));
      }
    });
    return;
  }

  // 7. Instagram 线索/私信同步端 (POST /api/webhooks/instagram)
  if (req.url === '/api/webhooks/instagram' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const leadName = payload.name || 'Instagram User';
        const leadPhone = payload.phone || 'Unknown';

        const isDuplicate = leadsDB.some(l => l.phone === leadPhone);
        if (!isDuplicate && leadPhone !== 'Unknown') {
          leadsDB.push({
            id: 'LEAD-IG-' + Date.now(),
            name: leadName,
            phone: leadPhone,
            source: 'Instagram Direct',
            center: 'B2C',
            createdAt: new Date().toISOString()
          });
        }
        logApiUsage('Instagram Webhook', '/api/webhooks/instagram', 1, 0.0000);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: /true/i }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Webhook parse error' }));
      }
    });
    return;
  }

  // 8. 自动生成预约编号与时间冲突检查 (POST /api/appointments/create)
  if (req.url === '/api/appointments/create' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const apt = JSON.parse(body || '{}');
        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const count = appointmentsDB.length + 1;
        const aptNumber = `APT-${dateStr}-${String(count).padStart(3, '0')}`;

        const hasConflict = appointmentsDB.some(
          a => a.staffId === apt.staffId && a.date === apt.date && a.time === apt.time
        );

        if (hasConflict) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Staff member time conflict detected' }));
          return;
        }

        const newAppointment = {
          ...apt,
          appointmentNumber: aptNumber,
          status: 'confirmed',
          createdAt: new Date().toISOString()
        };
        appointmentsDB.push(newAppointment);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: 'Appointment generated', data: newAppointment }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // 404 未找到
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' }));
});

server.listen(PORT, () => {
  console.log(`AI Lead Master backend running on port ${PORT}`);
});
