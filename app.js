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
    
    // 登录成功，保存状态并显示主应用
    localStorage.setItem("ai_lead_user", res.username);
    document.getElementById("loginOverlay").style.display = "none";
    document.getElementById("mainApp").style.display = "block";
    document.getElementById("currentUserDisplay").textContent = `当前用户: ${res.username} (${res.role})`;
    
    // 初始化加载数据
    loadAllData();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function logout() {
  localStorage.removeItem("ai_lead_user");
  location.reload();
}

// 检查本地登录态
window.addEventListener("DOMContentLoaded", () => {
  const savedUser = localStorage.getItem("ai_lead_user");
  if (savedUser) {
    document.getElementById("loginOverlay").style.display = "none";
    document.getElementById("mainApp").style.display = "block";
    document.getElementById("currentUserDisplay").textContent = `当前用户: ${savedUser}`;
    loadAllData();
  }
});

async function loadAllData() {
  await loadAccounts();
  await loadAppointments();
  await loadSearchTasks();
}

// 加载社媒账号
async function loadAccounts() {
  const sel = document.getElementById("ssAccount");
  if (!sel) return;
  try {
    const accs = await api("/api/social-accounts");
    sel.innerHTML = '<option value="">请选择账号</option>';
    accs.forEach(a => {
      const opt = document.createElement("option");
      opt.value = a.id;
      opt.dataset.platform = a.platform;
      opt.textContent = `${a.platform} - ${a.label}`;
      sel.appendChild(opt);
    });
  } catch (e) { console.error(e); }
}

document.getElementById("ssAccount")?.addEventListener("change", function() {
  const opt = this.selectedOptions[0];
  if (opt && opt.dataset.platform) {
    document.getElementById("ssPlatform").value = opt.dataset.platform;
  }
});

// 预约管理
async function loadAppointments() {
  const tbody = document.getElementById("appointmentList");
  if (!tbody) return;
  try {
    const appts = await api("/api/appointments");
    tbody.innerHTML = "";
    if (!appts.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#718096;">暂无预约记录</td></tr>';
      return;
    }
    appts.forEach(ap => {
      const tr = document.createElement("tr");
      const cleanPhone = ap.phone.replace(/[^0-9]/g, "");
      tr.innerHTML = `
        <td><b>${ap.appointment_number}</b></td>
        <td>${ap.staff_id}</td>
        <td>${ap.phone}</td>
        <td>${ap.date} ${ap.time}</td>
        <td><span style="color: green; font-weight: bold;">${ap.status}</span></td>
        <td style="display: flex; gap: 6px;">
          <a href="https://wa.me/${cleanPhone}" target="_blank"><button class="whatsapp">WhatsApp</button></a>
          <button class="danger" onclick="deleteAppt('${ap.appointment_number}')">删除</button>
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
    alert("预约创建成功！");
    this.reset();
    await loadAppointments();
  } catch (err) { alert(err.message); }
});

async function deleteAppt(no) {
  if (!confirm("确定删除该预约吗？")) return;
  try {
    await api(`/api/appointments/${no}`, { method: "DELETE" });
    await loadAppointments();
  } catch (err) { alert(err.message); }
}

// 社交搜索任务
async function loadSearchTasks() {
  const tbody = document.getElementById("socialSearchList");
  if (!tbody) return;
  try {
    const tasks = await api("/api/social-search");
    tbody.innerHTML = "";
    if (!tasks.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:#718096;">暂无搜索任务</td></tr>';
      return;
    }
    tasks.forEach(t => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${t.platform}</td>
        <td>${t.account_id}</td>
        <td>${t.country || '全球'}</td>
        <td>${t.city || '不限'}</td>
        <td>${t.keywords}</td>
        <td>${t.gender}</td>
        <td>${t.enabled ? '已启用' : '已停用'}</td>
        <td style="display: flex; gap: 5px;">
          <button class="primary" onclick="runTask(${t.id})">执行</button>
          <button class="secondary" onclick="toggleTask(${t.id}, ${t.enabled})">${t.enabled ? '停用' : '启用'}</button>
          <button class="danger" onclick="deleteTask(${t.id})">删除</button>
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
    alert("搜索任务创建成功！");
    this.reset();
    await loadSearchTasks();
  } catch (err) { alert(err.message); }
});

async function runTask(id) {
  try {
    const res = await api(`/api/social-search/${id}/run`, { method: "POST" });
    alert(`已在独立环境中打开目标链接：\n${res.url}`);
  } catch (err) { alert(err.message); }
}

async function toggleTask(id, current) {
  try {
    await api(`/api/social-search/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !current }) });
    await loadSearchTasks();
  } catch (err) { alert(err.message); }
}

async function deleteTask(id) {
  if (!confirm("确定删除此任务吗？")) return;
  try {
    await api(`/api/social-search/${id}`, { method: "DELETE" });
    await loadSearchTasks();
  } catch (err) { alert(err.message); }
}
