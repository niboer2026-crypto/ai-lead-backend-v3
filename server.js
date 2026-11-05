const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 10000;

// ==================== 1. 自愈式前端与目录保护 ====================
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const indexPath = path.join(publicDir, 'index.html');
const defaultHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Lead Master - 智能跨境 CRM 控制台</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; margin: 0; padding: 20px; color: #f8fafc; }
    .container { max-width: 1400px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid #334155; }
    .header-bar { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #334155; padding-bottom: 15px; margin-bottom: 25px; }
    h2 { color: #38bdf8; margin: 0; font-size: 24px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .stat-card { padding: 20px; border-radius: 12px; color: #fff; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .stat-card.blue { background: linear-gradient(135deg, #3b82f6, #1d4ed8); }
    .stat-card.purple { background: linear-gradient(135deg, #a855f7, #6b21a8); }
    .stat-card.pink { background: linear-gradient(135deg, #ec4899, #be185d); }
    .stat-card.emerald { background: linear-gradient(135deg, #10b981, #047857); }
    .stat-card h4 { margin: 0 0 10px 0; font-size: 14px; text-transform: uppercase; }
    .stat-card .num { font-size: 32px; font-weight: bold; }

    .card { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 24px; margin-bottom: 25px; }
    h3 { color: #f1f5f9; margin-top: 0; border-bottom: 2px solid #334155; padding-bottom: 10px; font-size: 18px; }
    
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 18px; align-items: end; }
    .form-group { display: flex; flex-direction: column; gap: 6px; }
    .form-group label { font-weight: 600; font-size: 13px; color: #94a3b8; }
    .form-group input, .form-group select { padding: 10px 14px; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 8px; font-size: 14px; outline: none; }

    button { padding: 10px 18px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 14px; transition: transform 0.1s; }
    button:active { transform: scale(0.97); }
    button.primary { background: linear-gradient(135deg, #0ea5e9, #0284c7); color: #fff; }
    button.secondary { background: linear-gradient(135deg, #64748b, #475569); color: #fff; }
    button.success { background: linear-gradient(135deg, #22c55e, #15803d); color: #fff; }
    button.danger { background: linear-gradient(135deg, #ef4444, #b91c1c); color: #fff; }
    button.whatsapp { background: linear-gradient(135deg, #25d366, #128c7e); color: #fff; }
    button.purple-btn { background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff; }

    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; }
    th, td { border: 1px solid #334155; padding: 14px; text-align: left; }
    th { background-color: #1e293b; font-weight: 600; color: #38bdf8; text-transform: uppercase; font-size: 12px; }
    tr:nth-child(even) { background-color: rgba(30, 41, 59, 0.4); }

    #loginOverlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(15,23,42,0.95); display: flex; justify-content: center; align-items: center; z-index: 9999; backdrop-filter: blur(8px); }
    .login-box { background: #1e293b; padding: 40px; border-radius: 16px; width: 380px; border: 1px solid #334155; box-shadow: 0 15px 35px rgba(0,0,0,0.6); }
    .badge { padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; display: inline-block; }
    .badge.fb { background: #1d4ed8; color: #bfdbfe; }
    .badge.ig { background: #be185d; color: #fce7f3; }
    .badge.tk { background: #374151; color: #f3f4f6; border: 1px solid #6b7280; }
  </style>
</head>
<body>

  <div id="loginOverlay">
    <div class="login-box">
      <h3 style="text-align:center; color:#38bdf8; margin-bottom:25px; font-size: 22px;">🔐 AI Lead Master 登录</h3>
      <form id="loginForm" style="display:flex; flex-direction:column; gap:18px;">
        <div class="form-group">
          <label>用户名 (Username)：</label>
          <input type="text" id="loginUser" placeholder="请输入用户名" required>
        </div>
        <div class="form-group">
          <label>密码 (Password)：</label>
          <input type="password" id="loginPass" placeholder="请输入密码" required>
        </div>
        <button type="submit" class="primary" style="padding: 14px; margin-top: 10px; font-size: 16px;">安 全 登 录 系 统</button>
        <div id="loginError" style="color:#f87171; font-size:13px; text-align:center;"></div>
      </form>
    </div>
  </div>

  <div class="container" id="mainApp" style="display:none;">
    <div class="header-bar">
      <h2>🚀 AI Lead Master - 跨境智能 CRM 控制台</h2>
      <div style="display: flex; align-items: center; gap: 15px;">
        <span id="currentUserDisplay" style="font-weight: bold; color: #38bdf8; background: #0f172a; padding: 6px 12px; border-radius: 6px; border: 1px solid #334155;"></span>
        <button class="danger" onclick="logout()">退出登录</button>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card blue">
        <h4>📦 聚合总线索量 (Total Leads)</h4>
        <div class="num" id="valTotalLeads">0</div>
      </div>
      <div class="stat-card purple">
        <h4>📘 Facebook 获客线索</h4>
        <div class="num" id="valFbLeads">0</div>
      </div>
      <div class="stat-card pink">
        <h4>📸 Instagram 互动线索</h4>
        <div class="num" id="valIgLeads">0</div>
      </div>
      <div class="stat-card emerald">
        <h4>🎵 TikTok 流量线索</h4>
        <div class="num" id="valTkLeads">0</div>
      </div>
    </div>

    <div class="card" id="userManagementSection" style="display:none;">
      <h3>👑 超级管理员权限：员工 / 子账号开通与管理</h3>
      <form id="createUserForm" class="form-grid">
        <div class="form-group">
          <label>新账号用户名：</label>
          <input type="text" id="newUsername" placeholder="例如: staff_dubai01" required>
        </div>
        <div class="form-group">
          <label>新账号密码：</label>
          <input type="password" id="newPassword" placeholder="设置登录密码" required>
        </div>
        <div class="form-group">
          <label>权限角色：</label>
          <select id="newRole">
            <option value="staff">员工 / 业务员 (Staff)</option>
            <option value="admin">管理员 (Admin)</option>
          </select>
        </div>
        <button type="submit" class="success">➕ 立即开通子账号</button>
      </form>
      <h4 style="margin-top: 25px; color: #38bdf8;">已有系统账号管理列表</h4>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>用户名</th>
            <th>权限角色</th>
            <th>开通时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="usersTableList"></tbody>
      </table>
    </div>

    <div class="card">
      <h3>👤 1. 社媒平台多账号隔离与自动化配置</h3>
      <form id="accountForm" class="form-grid">
        <div class="form-group">
          <label>所属社媒平台：</label>
          <select id="accPlatform" required>
            <option value="Facebook">📘 Facebook</option>
            <option value="Instagram">📸 Instagram</option>
            <option value="TikTok">🎵 TikTok</option>
          </select>
        </div>
        <div class="form-group">
          <label>账号备注 / 门店标签：</label>
          <input type="text" id="accLabel" placeholder="例如: 迪拜美业旗舰店号" required>
        </div>
        <div class="form-group">
          <label>独立浏览器 Profile ID：</label>
          <input type="text" id="accProfileId" placeholder="例如: prof_dubai_01" required>
        </div>
        <button type="submit" class="primary">🔗 绑 定 新 账 号</button>
      </form>
      <h4 style="margin-top: 25px; color: #38bdf8;">已授权的社媒账号列表</h4>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>平台</th>
            <th>备注标签</th>
            <th>Profile 环境标识</th>
            <th>绑定时间</th>
            <th>控制动作</th>
          </tr>
        </thead>
        <tbody id="accountTableList"></tbody>
      </table>
    </div>

    <div class="card">
      <h3>🌐 2. 全自动社媒定向搜客与 AI 意向提取任务</h3>
      <form id="socialSearchForm" class="form-grid">
        <div class="form-group">
          <label>选择执行账号：</label>
          <select id="ssAccount" required><option value="">请先在上文绑定账号</option></select>
        </div>
        <div class="form-group">
          <label>目标平台：</label>
          <input type="text" id="ssPlatform" readonly placeholder="自动匹配" style="background: #0f172a;">
        </div>
        <div class="form-group">
          <label>目标国家 (Country)：</label>
          <input type="text" id="ssCountry" placeholder="UAE / Saudi / Qatar">
        </div>
        <div class="form-group">
          <label>目标城市 (City)：</label>
          <input type="text" id="ssCity" placeholder="Dubai / Riyadh / Doha">
        </div>
        <div class="form-group">
          <label>搜索/监控关键词：</label>
          <input type="text" id="ssKeywords" placeholder="Salon & Spa / E-commerce" required>
        </div>
        <div class="form-group">
          <label>目标性别筛选：</label>
          <select id="ssGender">
            <option value="不限">不限 / All</option>
            <option value="男性">男性 / Male</option>
            <option value="女性">女性 / Female</option>
          </select>
        </div>
        <div style="grid-column: 1 / -1; margin-top: 10px; display: flex; gap: 12px;">
          <button type="submit" class="primary" style="flex: 2; padding: 12px;">💾 保存并创建自动抓取任务</button>
          <button type="button" class="purple-btn" style="flex: 1; padding: 12px;" onclick="triggerBatchScrape()">⚡ 立即全网一键自动获客</button>
        </div>
      </form>
      <h4 style="margin-top: 25px; color: #38bdf8;">当前获客与定向搜索任务调度</h4>
      <table>
        <thead>
          <tr>
            <th>平台</th>
            <th>关联账号</th>
            <th>国家</th>
            <th>城市</th>
            <th>关键词</th>
            <th>性别</th>
            <th>运行状态</th>
            <th>快捷操作</th>
          </tr>
        </thead>
        <tbody id="socialSearchList"></tbody>
      </table>
    </div>

    <div class="card">
      <h3>📅 3. 智能预约排班与 WhatsApp 快捷转化管理</h3>
      <form id="appointmentForm" class="form-grid">
        <div class="form-group">
          <label>分配接待员工/技师：</label>
          <input type="text" id="apptStaff"
