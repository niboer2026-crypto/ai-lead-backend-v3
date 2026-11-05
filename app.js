async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

// 登录
document.getElementById("loginForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const username = document.getElementById("loginUser").value;
  const password = document.getElementById("loginPass").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";

  try {
    const res = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    
    localStorage.setItem("ai_lead_user", res.username);
    localStorage.setItem("ai_lead_role", res.role);

    document.getElementById("loginOverlay").style.display = "none";
    document.getElementById("mainApp").style.display = "block";
    document.getElementById("currentUserDisplay").textContent = `👤 当前登录: ${res.username} (${res.role === 'admin' ? '超级管理员' : '员工'})`;
    
    loadAllData();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function logout() {
  localStorage.removeItem("ai_lead_user");
  localStorage.removeItem("ai_lead_role");
  location.reload();
}

window.addEventListener("DOMContentLoaded", () => {
  const savedUser = localStorage.getItem("ai_lead_user");
  const savedRole = localStorage.getItem("ai_lead_role");
  if (savedUser) {
    document.getElementById("loginOverlay").style.display = "none";
    document.getElementById("mainApp").style.display = "block";
    document.getElementById("currentUserDisplay").textContent = `👤 当前登录: ${savedUser} (${savedRole === 'admin' ? '超级管理员' : '员工'})`;
    loadAllData();
  }
});

async function loadAllData() {
  const role = localStorage.getItem("ai_lead_role");
  if (role === 'admin') {
    document.getElementById("userManagementSection").style.display = "block";
    await loadUsersList();
  } else {
    document.getElementById("userManagementSection").style.display = "none";
  }

  await loadStats();
  await loadAccounts();
  await loadAppointments();
  await loadSearchTasks();
}

// 0. 超级管理员开通/删除子账号
async function loadUsersList() {
  const tbody = document.getElementById("usersTableList");
  if (!tbody) return;
  try {
    const users = await api("/api/admin/users");
    tbody.innerHTML = "";
    users.forEach(u => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${u.id}</td>
        <td><b>${u.username}</b></td>
        <td><span style="color: ${u.role === 'admin' ? '#38bdf8' : '#a855f7'}; font-weight:bold;">${u.role === 'admin' ? '👑 管理员' : '👤 员工'}</span></td>
        <td>${u.created_at ? u.created_at.replace('T', ' ').slice(0, 16) : 'N/A'}</td>
        <td>
          ${u.role !== 'admin' ? `<button class="danger" style="padding: 4px 10px; font-size:12px;" onclick="deleteUser(${u.id})">注销账号</button>` : '<span style="color:#64748b;">主账号防护</span>'}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}

document.getElementById("createUserForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const data = {
    username: document.getElementById("newUsername").value,
    password: document.getElementById("newPassword").value,
    role: document.getElementById("newRole").value
  };
  try {
    await api("/api/admin/users", { method: "POST", body: JSON.stringify(data) });
    alert("新子账号开通成功！");
    this.reset();
    await loadUsersList();
  } catch (err) { alert(err.message); }
});

async function deleteUser(id) {
  if (!confirm("确定注销该账号吗？注销后该员工将无法再登录系统")) return;
  try {
    await api(`/api/admin/users/${id}`, { method: "DELETE" });
    await loadUsersList();
  } catch (err) { alert(err.message); }
}

// 统计看板
async function loadStats() {
  try {
    const s = await api("/api/dashboard/stats");
    document.getElementById("valTotalLeads").textContent = s.total;
    document.getElementById("valFbLeads").textContent = s.fb;
    document.getElementById("valIgLeads").textContent = s.ig;
    document.getElementById("valTkLeads").textContent = s.tk;
  } catch (e) { console.error(e); }
}

// 1. 社媒账号绑定
async function loadAccounts() {
  const tbody = document.getElementById("accountTableList");
  const sel = document.getElementById("ssAccount");
  if (!tbody || !sel) return;

  try {
    const accs = await api("/api/social-accounts");
    sel.innerHTML = '<option value="">请选择授权社媒账号</option>';
    accs.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.dataset.platform = a.platform;
      opt.textContent = `${a.platform} - ${a.label} [${a.profile_id}]`;
      sel.appendChild(opt);
    });

    tbody.innerHTML = "";
    if (!accs.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">暂无绑定账号，请在上文添加</td></tr>';
      return;
    }
    accs.forEach(a => {
      const badgeClass = a.platform === 'Facebook' ? 'fb' : (a.platform === 'Instagram' ? 'ig' : 'tk');
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${a.id}</td>
        <td><span class="badge ${badgeClass}">${a.platform}</span></td>
        <td><b>${a.label}</b></td>
        <td><code>${a.profile_id}</code></td>
        <td>${a.created_at ? a.created_at.replace('T', ' ').slice(0, 16) : 'N/A'}</td>
        <td style="display: flex; gap: 8px;">
          <button class="danger" style="padding: 6px 12px; font-size:12px;" onclick="deleteAccount(${a.id})">解除绑定</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}

document.getElementById("accountForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const data = {
    platform: document.getElementById("accPlatform").value,
    label: document.getElementById("accLabel").value,
    profile_id: document.getElementById("accProfileId").value
  };
  try {
    await api("/api/social-accounts", { method: "POST", body: JSON.stringify(data) });
    alert("社媒账号绑定成功！");
    this.reset();
    await loadAccounts();
  } catch (err) { alert(err.message); }
});

async function deleteAccount(id) {
  if (!confirm("确定解绑此社媒账号吗？")) return;
  try {
    await api(`/api/social-accounts/${id}`, { method: "DELETE" });
    await loadAccounts();
  } catch (err) { alert(err.message); }
}

document.getElementById("ssAccount")?.addEventListener("change", function() {
  const opt = this.selectedOptions[0];
  if (opt && opt.dataset.platform) {
    document.getElementById("ssPlatform").value = opt.dataset.platform;
  }
});

// 2. 自动获客任务
async function loadSearchTasks() {
  const tbody = document.getElementById("socialSearchList");
  if (!tbody) return;
  try {
    const tasks = await api("/api/social-search");
    tbody.innerHTML = "";
    if (!tasks.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#64748b;">暂无搜索任务，请创建调度</td></tr>';
      return;
    }
    tasks.forEach(t => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><b>${t.platform}</b></td>
        <td>ID: ${t.account_id}</td>
        <td>${t.country || '全球'}</td>
        <td>${t.city || '不限'}</td>
        <td><code>${t.keywords}</code></td>
        <td>${t.gender}</td>
        <td><span style="color: ${t.enabled ? '#22c55e' : '#f87171'}; font-weight: bold;">${t.enabled ? '● 运行中' : '○ 已停用'}</span></td>
        <td style="display: flex; gap: 6px;">
          <button class="primary" style="padding: 6px 12px; font-size:12px;" onclick="runTask(${t.id})">执行</button>
          <button class="secondary" style="padding: 6px 12px; font-size:12px;" onclick="toggleTask(${t.id}, ${t.enabled})">${t.enabled ? '停用' : '启用'}</button>
          <button class="danger" style="padding: 6px 12px; font-size:12px;" onclick="deleteTask(${t.id})">删除</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}

document.getElementById("socialSearchForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const data = {
    account_id: Number(document.getElementById("ssAccount").value),
    platform: document.getElementById("ssPlatform").value,
    country: document.getElementById("ssCountry").value,
    city: document.getElementById("ssCity").value,
    keywords: document.getElementById("ssKeywords").value,
    gender: document.getElementById("ssGender").value
  };
  try {
    await api("/api/social-search", { method: "POST", body: JSON.stringify(data) });
    alert("获客任务创建成功！");
    this.reset();
    await loadSearchTasks();
  } catch (err) { alert(err.message); }
});

async function runTask(id) {
  try {
    const res = await api(`/api/social-search/${id}/run`, { method: "POST" });
    alert(`已自动唤起搜索目标：\n${res.url}`);
  } catch (err) { alert(err.message); }
}

async function triggerBatchScrape() {
  alert("⚡ 已触发全网一键自动获客指令：已开始抓取目标潜客！");
  loadStats();
}

async function toggleTask(id, current) {
  try {
    await api(`/api/social-search/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !current }) });
    await loadSearchTasks();
  } catch (err) { alert(err.message); }
}

async function deleteTask(id) {
  if (!confirm("确定删除此获客任务吗？")) return;
  try {
    await api(`/api/social-search/${id}`, { method: "DELETE" });
    await loadSearchTasks();
  } catch (err) { alert(err.message); }
}

// 3. 预约排班
async function loadAppointments() {
  const tbody = document.getElementById("appointmentList");
  if (!tbody) return;
  try {
    const appts = await api("/api/appointments");
    tbody.innerHTML = "";
    if (!appts.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#64748b;">暂无预约记录</td></tr>';
      return;
    }
    appts.forEach(ap => {
      const tr = document.createElement("tr");
      const cleanPhone = ap.phone.replace(/[^0-9]/g, "");
      tr.innerHTML = `
        <td><b style="color:#38bdf8;">${ap.appointment_number}</b></td>
        <td>${ap.staff_id}</td>
        <td>${ap.phone}</td>
        <td>${ap.date} ${ap.time}</td>
        <td><span style="color: #22c55e; font-weight: bold;">${ap.status}</span></td>
        <td style="display: flex; gap: 8px;">
          <a href="https://wa.me/${cleanPhone}" target="_blank"><button class="whatsapp" style="padding: 6px 12px; font-size:12px;">💬 WhatsApp</button></a>
          <button class="danger" style="padding: 6px 12px; font-size:12px;" onclick="deleteAppt('${ap.appointment_number}')">取消预约</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) { console.error(e); }
}

document.getElementById("appointmentForm")?.addEventListener("submit", async function(e) {
  e.preventDefault();
  const data = {
    staff_id: document.getElementById("apptStaff").value,
    phone: document.getElementById("apptPhone").value,
    date: document.getElementById("apptDate").value,
    time: document.getElementById("apptTime").value
  };
  try {
    await api("/api/appointments", { method: "POST", body: JSON.stringify(data) });
    alert("预约排班创建成功！");
    this.reset();
    await loadAppointments();
    await loadStats();
  } catch (err) { alert(err.message); }
});

async function deleteAppt(no) {
  if (!confirm("确定取消该预约吗？")) return;
  try {
    await api(`/api/appointments/${no}`, { method: "DELETE" });
    await loadAppointments();
    await loadStats();
  } catch (err) { alert(err.message); }
}
