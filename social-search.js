// 多语言字典
const i18n = {
  zh: {
    title: "🚀 AI Lead Master - 跨境智能 CRM 控制台",
    totalLeads: "总线索量 (Total Leads)",
    apptTitle: "📅 智能预约与排班管理系统",
    staff: "分配员工 / 技师：",
    phone: "客户手机号：",
    date: "预约日期：",
    time: "预约时间段：",
    createAppt: "确认创建预约",
    apptListTitle: "当前预约排班列表",
    thNo: "预约单号",
    thStaff: "技师/员工",
    thPhone: "客户手机号",
    thTime: "预约时间",
    thStatus: "状态",
    thAction: "操作",
    searchTitle: "🌐 多平台社媒定向搜索与获客任务",
    selectAcc: "选择平台账号：",
    targetPlatform: "目标平台：",
    country: "目标国家 (Country)：",
    city: "目标城市 (City)：",
    keywords: "搜索关键词：",
    gender: "性别筛选：",
    saveSearch: "保存并创建定向搜索任务",
    searchListTitle: "当前社媒定向搜索任务列表",
    whatsappChat: "WhatsApp 沟通"
  },
  en: {
    title: "🚀 AI Lead Master - Cross-Border Smart CRM",
    totalLeads: "Total Leads",
    apptTitle: "📅 Smart Appointment & Roster Management",
    staff: "Assigned Staff:",
    phone: "Client Phone:",
    date: "Appointment Date:",
    time: "Time Slot:",
    createAppt: "Create Appointment",
    apptListTitle: "Current Appointments",
    thNo: "APT Number",
    thStaff: "Staff",
    thPhone: "Phone",
    thTime: "Date & Time",
    thStatus: "Status",
    thAction: "Actions",
    searchTitle: "🌐 Multi-Platform Social Targeted Search",
    selectAcc: "Select Account:",
    targetPlatform: "Target Platform:",
    country: "Target Country:",
    city: "Target City:",
    keywords: "Search Keywords:",
    gender: "Gender Filter:",
    saveSearch: "Save & Create Search Task",
    searchListTitle: "Social Search Tasks",
    whatsappChat: "WhatsApp Chat"
  },
  ar: {
    title: "🚀 AI Lead Master - نظام إدارة علاقات العملاء الذكي",
    totalLeads: "إجمالي العملاء المحتملين",
    apptTitle: "📅 نظام المواعيد والجدولة الذكية",
    staff: "الموظف المسؤول:",
    phone: "رقم هاتف العميل:",
    date: "تاريخ الموعد:",
    time: "الوقت:",
    createAppt: "إنشاء موعد جديد",
    apptListTitle: "قائمة المواعيد الحالية",
    thNo: "رقم الموعد",
    thStaff: "الموظف",
    thPhone: "الهاتف",
    thTime: "الوقت والتاريخ",
    thStatus: "الحالة",
    thAction: "الإجراءات",
    searchTitle: "🌐 البحث الموجه عبر منصات التواصل الاجتماعي",
    selectAcc: "اختر الحساب:",
    targetPlatform: "المنصة المستهدفة:",
    country: "الدولة:",
    city: "المدينة:",
    keywords: "كلمات البحث:",
    gender: "تصفية الجنس:",
    saveSearch: "حفظ وإنشاء مهمة البحث",
    searchListTitle: "مهام البحث النشطة",
    whatsappChat: "واتساب"
  }
};

let currentLang = "zh";

function changeLanguage(lang) {
  currentLang = lang;
  const t = i18n[lang];
  if (!t) return;

  document.getElementById("uiTitle").textContent = t.title;
  document.getElementById("statTotalLeads").textContent = t.totalLeads;
  document.getElementById("secApptTitle").textContent = t.apptTitle;
  document.getElementById("lblStaff").textContent = t.staff;
  document.getElementById("lblClientPhone").textContent = t.phone;
  document.getElementById("lblDate").textContent = t.date;
  document.getElementById("lblTime").textContent = t.time;
  document.getElementById("btnCreateAppt").textContent = t.createAppt;
  document.getElementById("subApptList").textContent = t.apptListTitle;
  
  document.getElementById("thApptNo").textContent = t.thNo;
  document.getElementById("thStaff").textContent = t.thStaff;
  document.getElementById("thPhone").textContent = t.thPhone;
  document.getElementById("thDateTime").textContent = t.thTime;
  document.getElementById("thStatus").textContent = t.thStatus;
  document.getElementById("thAction").textContent = t.thAction;

  document.getElementById("secSearchTitle").textContent = t.searchTitle;
  document.getElementById("lblAcc").textContent = t.selectAcc;
  document.getElementById("lblPlatform").textContent = t.targetPlatform;
  document.getElementById("lblCountry").textContent = t.country;
  document.getElementById("lblCity").textContent = t.city;
  document.getElementById("lblKeywords").textContent = t.keywords;
  document.getElementById("lblGender").textContent = t.gender;
  document.getElementById("btnSaveSearch").textContent = t.saveSearch;
  document.getElementById("subSearchList").textContent = t.searchListTitle;
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "请求失败");
  return data;
}

// 1. 加载统计漏斗
async function loadStats() {
  try {
    const s = await api("/api/dashboard/stats");
    document.getElementById("valTotalLeads").textContent = s.total;
    document.getElementById("valFbLeads").textContent = s.fb;
    document.getElementById("valIgLeads").textContent = s.ig;
    document.getElementById("valTkLeads").textContent = s.tk;
  } catch (e) { console.error(e); }
}

// 2. 加载社媒账号下拉
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

// 3. 预约系统逻辑
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

// 4. 社交搜索任务逻辑
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
          <button class="primary" onclick="runTask(${t.id})">执行搜索</button>
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

window.addEventListener("DOMContentLoaded", async () => {
  await loadStats();
  await loadAccounts();
  await loadAppointments();
  await loadSearchTasks();
});
