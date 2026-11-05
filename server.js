const http = require('node:http');

const PORT = process.env.PORT || 10000;

// 模拟数据库集合 (后续挂载至 Cloud Firestore)
const apiCostLogsDB = []; // API 调用与成本日志
const accountsDB = [];   // 多 WhatsApp / 平台账号
const leadsDB = [];      // 统一 CRM 客户线索
const appointmentsDB = []; // 预约记录

// 实用函数：API 成本记录工具
function logApiUsage(service, endpoint, tokensOrUnits, estimatedCostUSD) {
  const logEntry = {
    id: 'LOG-' + Date.now(),
    service, // 如 'Google Maps API', 'OpenAI API'
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. 健康检查
  if (req.url === '/' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ msg: 'AI Lead Master Backend is active', ok: true }));
    return;
  }

  // 2. 管理员查看 API 成本与使用量看板数据 (GET /api/admin/api-costs)
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

  // 3. 客户智能查重与新增接口 (POST /api/leads/add)
  if (req.url === '/api/leads/add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const lead = JSON.parse(body || '{}');
        // 校验必填字段与重复检测
        const isDuplicate = leadsDB.some(l => l.phone === lead.phone && l.center === lead.center);
        
        if (isDuplicate) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Duplicate customer identified by phone number' }));
          return;
        }

        lead.id = 'LEAD-' + Date.now();
        lead.createdAt = new Date().toISOString();
        leadsDB.push(lead);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: 'Lead saved successfully', data: lead }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // 4. 自动生成预约编号与时间冲突检查 (POST /api/appointments/create)
  if (req.url === '/api/appointments/create' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const apt = JSON.parse(body || '{}');
        const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
        const count = appointmentsDB.length + 1;
        const aptNumber = `APT-${dateStr}-${String(count).padStart(3, '0')}`;

        // 时间冲突检查
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

  // 未匹配路由
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' }));
});

server.listen(PORT, () => {
  console.log(`AI Lead Master backend running on port ${PORT}`);
});
