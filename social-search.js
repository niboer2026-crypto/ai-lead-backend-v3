async function ssRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败");
  return result;
}

async function loadSocialAccounts() {
  const select = document.getElementById("ssAccount");
  if (!select) return;
  try {
    const accounts = await ssRequest("/api/social-accounts");
    select.innerHTML = '<option value="">请选择账号</option>';
    accounts.forEach(account => {
      const option = document.createElement("option");
      option.value = account.id;
      option.dataset.platform = account.platform;
      option.textContent = `${account.platform} - ${account.label}`;
      select.appendChild(option);
    });
  } catch (error) {
    console.error("加载社交账号失败:", error.message);
  }
}

const ssAccountEl = document.getElementById("ssAccount");
if (ssAccountEl) {
  ssAccountEl.addEventListener("change", function () {
    const option = this.selectedOptions[0];
    if (option && option.dataset.platform) {
      const platformInput = document.getElementById("ssPlatform");
      if (platformInput) platformInput.value = option.dataset.platform;
    }
  });
}

const socialSearchFormEl = document.getElementById("socialSearchForm");
if (socialSearchFormEl) {
  socialSearchFormEl.addEventListener("submit", async function (event) {
    event.preventDefault();
    const data = {
      account_id: Number(document.getElementById("ssAccount").value),
      platform: document.getElementById("ssPlatform").value,
      country: document.getElementById("ssCountry").value,
      city: document.getElementById("ssCity").value,
      keywords: document.getElementById("ssKeywords").value,
      gender: document.getElementById("ssGender").value
    };
    if (!data.account_id) {
      alert("请先选择社交账号");
      return;
    }
    try {
      await ssRequest("/api/social-search", {
        method: "POST",
        body: JSON.stringify(data)
      });
      alert("搜索任务保存成功！");
      this.reset();
      await loadSocialSearchTasks();
    } catch (error) {
      alert(error.message);
    }
  });
}

async function loadSocialSearchTasks() {
  const tbody = document.getElementById("socialSearchList");
  if (!tbody) return;
  try {
    const tasks = await ssRequest("/api/social-search");
    tbody.innerHTML = "";
    if (!tasks.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 15px;">暂时没有搜索任务</td></tr>';
      return;
    }
    tasks.forEach(task => {
      const tr = document.createElement("tr");
      const values = [task.platform, task.account_id, task.country || "全球/不限", task.city || "不限", task.keywords, task.gender, task.enabled ? "已启用" : "已停用"];
      values.forEach(value => {
        const td = document.createElement("td");
        td.style.padding = "8px";
        td.textContent = value ?? "";
        tr.appendChild(td);
      });
      const actionTd = document.createElement("td");
      actionTd.style.padding = "8px";
      actionTd.style.display = "flex";
      actionTd.style.gap = "5px";

      const runBtn = document.createElement("button");
      runBtn.className = "primary";
      runBtn.textContent = "执行搜索";
      runBtn.onclick = () => runSocialSearch(task.id);

      const toggleBtn = document.createElement("button");
      toggleBtn.className = "secondary";
      toggleBtn.textContent = task.enabled ? "停用" : "启用";
      toggleBtn.onclick = () => toggleSocialSearch(task);

      const removeBtn = document.createElement("button");
      removeBtn.className = "danger";
      removeBtn.textContent = "删除";
      removeBtn.onclick = () => deleteSocialSearch(task.id);

      actionTd.append(runBtn, toggleBtn, removeBtn);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    });
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:red; text-align:center;">${error.message}</td></tr>`;
  }
}

async function runSocialSearch(id) {
  try {
    const result = await ssRequest(`/api/social-search/${id}/run`, { method: "POST" });
    alert(`搜索页面已在独立浏览器打开！\n平台: ${result.platform}\n账号: ${result.account}`);
  } catch (error) {
    alert(error.message);
  }
}

async function toggleSocialSearch(task) {
  try {
    await ssRequest(`/api/social-search/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !task.enabled })
    });
    await loadSocialSearchTasks();
  } catch (error) {
    alert(error.message);
  }
}

async function deleteSocialSearch(id) {
  if (!confirm("确定删除这个搜索任务吗？")) return;
  try {
    await ssRequest(`/api/social-search/${id}`, { method: "DELETE" });
    await loadSocialSearchTasks();
  } catch (error) {
    alert(error.message);
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  await loadSocialAccounts();
  await loadSocialSearchTasks();
});
