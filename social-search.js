Async function ssRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "请求失败");
  }

  return result;
}

// 加载社交账号
async function loadSocialAccounts() {
  const select = document.getElementById("ssAccount");

  try {
    const accounts = await ssRequest("/api/social-accounts");

    select.innerHTML =
      '<option value="">请选择账号</option>';

    accounts.forEach(account => {
      const option = document.createElement("option");

      option.value = account.id;
      option.dataset.platform = account.platform;
      option.textContent =
        account.platform + " - " + account.label;

      select.appendChild(option);
    });

  } catch (error) {
    alert(error.message);
  }
}

// 选择账号时自动匹配平台
document.getElementById("ssAccount")
  .addEventListener("change", function () {
    const option = this.selectedOptions[0];

    if (option && option.dataset.platform) {
      document.getElementById("ssPlatform").value =
        option.dataset.platform;
    }
  });

// 保存搜索任务
document.getElementById("socialSearchForm")
  .addEventListener("submit", async function (event) {
    event.preventDefault();

    const data = {
      account_id: Number(
        document.getElementById("ssAccount").value
      ),
      platform:
        document.getElementById("ssPlatform").value,
      country:
        document.getElementById("ssCountry").value,
      city:
        document.getElementById("ssCity").value,
      keywords:
        document.getElementById("ssKeywords").value,
      gender:
        document.getElementById("ssGender").value
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

// 加载搜索任务
async function loadSocialSearchTasks() {
  const tbody = document.getElementById("socialSearchList");

  try {
    const tasks = await ssRequest("/api/social-search");

    tbody.innerHTML = "";

    if (!tasks.length) {
      tbody.innerHTML =
        '<tr><td colspan="8">暂时没有搜索任务</td></tr>';
      return;
    }

    tasks.forEach(task => {
      const tr = document.createElement("tr");

      const values = [
        task.platform,
        task.account_id,
        task.country,
        task.city,
        task.keywords,
        task.gender,
        task.enabled ? "已启用" : "已停用"
      ];

      values.forEach(value => {
        const td = document.createElement("td");
        td.textContent = value ?? "";
        tr.appendChild(td);
      });

      const action = document.createElement("td");

      const run = document.createElement("button");
      run.className = "primary";
      run.textContent = "执行搜索";
      run.onclick = () => runSocialSearch(task.id);

      const toggle = document.createElement("button");
      toggle.className = "secondary";
      toggle.textContent = task.enabled ? "停用" : "启用";
      toggle.onclick = () => toggleSocialSearch(task);

      const remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "删除";
      remove.onclick = () => deleteSocialSearch(task.id);

      action.append(run, toggle, remove);
      tr.appendChild(action);

      tbody.appendChild(tr);
    });

  } catch (error) {
    tbody.innerHTML =
      '<tr><td colspan="8">' +
      error.message +
      '</td></tr>';
  }
}

// 执行搜索
async function runSocialSearch(id) {
  try {
    const result = await ssRequest(
      `/api/social-search/${id}/run`,
      { method: "POST" }
    );

    alert(
      "搜索页面已打开！\n" +
      "平台：" + result.platform + "\n" +
      "账号：" + result.account
    );

  } catch (error) {
    alert(error.message);
  }
}

// 启用 / 停用
async function toggleSocialSearch(task) {
  try {
    await ssRequest(`/api/social-search/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        enabled: !task.enabled
      })
    });

    loadSocialSearchTasks();

  } catch (error) {
    alert(error.message);
  }
}

// 删除任务
async function deleteSocialSearch(id) {
  if (!confirm("确定删除这个搜索任务吗？")) return;

  try {
    await ssRequest(`/api/social-search/${id}`, {
      method: "DELETE"
    });

    loadSocialSearchTasks();

  } catch (error) {
    alert(error.message);
  }
}

// 打开页面时加载数据
async function initSocialSearch() {
  await loadSocialAccounts();
  await loadSocialSearchTasks();
}
