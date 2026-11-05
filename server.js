const http = require('node:http');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  // 设置 CORS 跨域响应头，允许前端应用调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 处理预检请求 (Options)
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 基础健康检查接口
  if (req.url === '/' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ msg: 'Backend is running smoothly', ok: true }));
    return;
  }

  // 示例：接收来自前端的数据 (POST)
  if (req.url === '/api/data' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ msg: 'Data received', data: payload, ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON', ok: false }));
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
