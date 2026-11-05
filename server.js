const http = require('node:http');

const PORT = process.env.PORT || 10000;

// 模拟内存数据库（后续可以替换为真实数据库）
const productsDB = [
  { barcode: '6901234567890', name: '高级洗发水 500ml', price: 45.00, stock: 120 },
  { barcode: '6909876543210', name: '精油美发护发素', price: 68.00, stock: 85 }
];

const staffDB = [
  { username: 'admin', pin: '8888', role: 'manager', branch: 'Main' },
  { username: 'staff01', pin: '1234', role: 'cashier', branch: 'Branch-A' }
];

const server = http.createServer((req, res) => {
  // 设置 CORS 跨域响应头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 处理预检请求 (OPTIONS)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. 基础健康检查接口
  if (req.url === '/' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ msg: 'Backend is running smoothly', ok: true }));
    return;
  }

  // 2. 员工登录鉴权接口 (POST /api/auth/login)
  if (req.url === '/api/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { username, pin } = JSON.parse(body || '{}');
        const staff = staffDB.find(s => s.username === username && s.pin === pin);
        
        if (staff) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            msg: 'Login successful', 
            ok: true, 
            data: { username: staff.username, role: staff.role, branch: staff.branch } 
          }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid username or PIN', ok: false }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', ok: false }));
      }
    });
    return;
  }

  // 3. SmartPOS 扫码查询商品接口 (POST /api/pos/scan)
  if (req.url === '/api/pos/scan' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { barcode } = JSON.parse(body || '{}');
        const product = productsDB.find(p => p.barcode === barcode);

        if (product) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ msg: 'Product found', ok: true, data: product }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Product not found', ok: false }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', ok: false }));
      }
    });
    return;
  }

  // 4. SmartPOS 结算收银接口 (POST /api/pos/checkout)
  if (req.url === '/api/pos/checkout' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { items, totalAmount, cashier } = JSON.parse(body || '{}');
        
        // 生成模拟订单号
        const orderId = 'ORD-' + Date.now();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          msg: 'Checkout success', 
          ok: true, 
          data: { orderId, totalAmount, cashier, timestamp: new Date() } 
        }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Checkout failed', ok: false }));
      }
    });
    return;
  }

  // 未匹配到路由
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Route not found', ok: false }));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
