const http = require("node:http");
const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ msg: "Backend is running", ok: true }));
});

server.listen(PORT, () => {
  console.log("✅ 服务启动成功，端口：" + PORT);
});
