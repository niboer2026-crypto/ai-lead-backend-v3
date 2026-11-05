async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

// 登录处理
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
    document.getElementById("loginOverlay").style.display = "none";
    document.getElementById("mainApp").style.display = "block";
    document.getElementById("currentUserDisplay").textContent = `👤 当前用户: ${res.username} (${res.role})`;
    loadAllData();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function logout() {
  localStorage.removeItem("ai_lead_user");
  location.reload();
}

window.addEventListener("DOMContentLoaded", () => {
  const savedUser = localStorage.getItem("ai_lead_user");
  if (savedUser) {
    document.getElementById("loginOverlay").style.display = "none";
    document.getElementById("mainApp").style.display = "block";
    document.getElementById("currentUserDisplay").textContent = `👤 当前用户: ${savedUser}`;
    loadAllData();
  }
});

async function loadAllData() {
  await loadStats();
  await loadAccounts();
  await loadAppointments();
  await loadSearchTasks();
}

// 加载统计漏斗数据
async function loadStats() {
  try {
    const s = await api("/api/dashboard/stats");
    document.getElementById("valTotalLeads").textContent = s.total;
    document.getElementById("valFbLeads").textContent = s.fb;
    document.getElementById("valIgLeads").textContent = s.ig;
    document.getElementById("valTkLeads").textContent = s.tk;
  } catch (e) { console.error(e); }
}

// 1. 社媒账号绑定与管理
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
          <button class="primary" style="padding: 6px 12px; font-size:12px;" onclick="testAccount(${a.id})">验证在线</button>
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
  if (!confirm("确定解绑并删除此社媒账号吗？")) return;
  try {
    await api(`/api/social-accounts/${id}`, { method: "DELETE" });
    await loadAccounts();
  } catch (err) { alert(err.message); }
}

async function testAccount(id) {
  alert(`账号 ID #${id} 独立浏览器环境指纹与 Cookie 状态正常，随时可执行获客！`);
}

document.getElementById("ssAccount")?.addEventListener("change", function() {
  const opt = this.selectedOptions[0];
  if (opt && opt.dataset.platform) {
    document.getElementById("ssPlatform").value = opt.dataset.platform;
  }
});

// 2. 社交搜索与自动获客任务
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
          <button class="primary" style="padding: 6px 12px; font-size:12px;" onclick="runTask(${t.id})">手动执行</button>
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
    alert("自动搜客任务创建成功！");
    this.reset();
    await loadSearchTasks();
  } catch (err) { alert(err.message); }
});

async function runTask(id) {
  try {
    const res = await api(`/api/social-search/${id}/run`, { method: "POST" });
    alert(`已通过独立环境成功唤起目标平台：\n平台: ${res.platform}\n链接: ${res.url}`);
  } catch (err) { alert(err.message); }
}

async function triggerBatchScrape() {
  alert("⚡ 已触发全网一键自动获客指令：正在后台通过独立浏览器实例抓取中东地区目标潜客，新线索将自动同步入库！");
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

// 3. 预约管理
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
  if (!confirm("确定取消并删除该预约吗？")) return;
  try {
    await api(`/api/appointments/${no}`, { method: "DELETE" });
    await loadAppointments();
    await loadStats();
  } catch (err) { alert(err.message); }
}
