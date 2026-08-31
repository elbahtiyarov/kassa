// Касса — фронтенд, работает с реальным API (server/routes) и PostgreSQL
const API = "/api";

let orgs = [];
let currentOrg = null;
let categories = [];
let transactions = [];
let currentType = "expense";
let currentAccount = "cash"; // 'cash' | 'bank'
let personFilter = null;     // who_id, чтобы показывать операции только одного человека
let personBalances = [];
let ws = null;
let authToken = null;
let currentUser = null; // {id, name, is_admin}

const fmt = n => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0)) + " ₸";
const todayStr = () => new Date().toISOString().slice(0, 10);
const nowStr = () => new Date().toTimeString().slice(0, 5);
const catColor = name => (categories.find(c => c.name === name) || {}).color || "#C9C2D9";

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    ...options,
  });
  if (res.status === 401) {
    logout();
    throw new Error("Сессия истекла — войдите заново");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Ошибка запроса: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- Вход / выход ----------

function loadSession() {
  authToken = localStorage.getItem("kassa_token");
  const userRaw = localStorage.getItem("kassa_user");
  currentUser = userRaw ? JSON.parse(userRaw) : null;
}

function saveSession(token, user) {
  authToken = token;
  currentUser = user;
  localStorage.setItem("kassa_token", token);
  localStorage.setItem("kassa_user", JSON.stringify(user));
}

function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem("kassa_token");
  localStorage.removeItem("kassa_user");
  document.getElementById("appLayout").style.display = "none";
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("loginPassword").value = "";
  showLogin();
}

async function submitLogin(e) {
  e.preventDefault();
  const phone = document.getElementById("loginPhone").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.style.display = "none";
  try {
    const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ phone, password }) });
    saveSession(data.token, data.user);
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("appLayout").style.display = "flex";
    await bootApp();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

// ---------- Сброс пароля ----------

function showLogin() {
  document.getElementById("loginForm").style.display = "block";
  document.getElementById("forgotStep1Form").style.display = "none";
  document.getElementById("forgotStep2Form").style.display = "none";
  document.getElementById("loginError").style.display = "none";
}

function showForgotStep1() {
  document.getElementById("loginForm").style.display = "none";
  document.getElementById("forgotStep1Form").style.display = "block";
  document.getElementById("forgotStep2Form").style.display = "none";
  document.getElementById("loginError").style.display = "none";
}

let forgotPhoneValue = "";

async function submitForgotStep1(e) {
  e.preventDefault();
  const phone = document.getElementById("forgotPhone").value.trim();
  const errEl = document.getElementById("loginError");
  errEl.style.display = "none";
  try {
    await api("/auth/forgot-password", { method: "POST", body: JSON.stringify({ phone }) });
    forgotPhoneValue = phone;
    document.getElementById("forgotStep1Form").style.display = "none";
    document.getElementById("forgotStep2Form").style.display = "block";
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

async function submitForgotStep2(e) {
  e.preventDefault();
  const code = document.getElementById("resetCode").value.trim();
  const newPassword = document.getElementById("resetPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.style.display = "none";
  try {
    await api("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ phone: forgotPhoneValue, code, newPassword }),
    });
    showLogin();
    document.getElementById("loginPhone").value = forgotPhoneValue;
    document.getElementById("loginPassword").value = "";
    errEl.style.color = "var(--income)";
    errEl.style.borderColor = "var(--income)";
    errEl.textContent = "Пароль изменён — войдите с новым паролем.";
    errEl.style.display = "block";
  } catch (err) {
    errEl.style.color = "var(--expense)";
    errEl.style.borderColor = "var(--expense)";
    errEl.textContent = err.message;
    errEl.style.display = "block";
  }
}

// ---------- Управление пользователями (админ) ----------

function openUsersModal() {
  document.getElementById("usersOverlay").style.display = "flex";
  loadUsers();
}
function closeUsersModal() {
  document.getElementById("usersOverlay").style.display = "none";
}

async function loadUsers() {
  const listEl = document.getElementById("usersList");
  listEl.innerHTML = `<div style="color:var(--muted);font-size:13px;">Загрузка…</div>`;
  try {
    const users = await api("/users");
    listEl.innerHTML = users.map(u => `
      <div class="user-row">
        <div>
          <span class="user-row-name">${escapeHtml(u.name)}${u.is_admin ? '<span class="admin-badge">админ</span>' : ""}</span>
          <div class="user-row-meta">${escapeHtml(u.phone || "—")}</div>
        </div>
        ${u.id !== currentUser.id ? `<button class="user-row-del" onclick="deleteUser(${u.id})">🗑</button>` : ""}
      </div>
    `).join("") || `<div style="color:var(--muted);font-size:13px;">Пользователей нет</div>`;
  } catch (err) {
    listEl.innerHTML = `<div style="color:var(--expense);font-size:13px;">${err.message}</div>`;
  }
}

async function createUser() {
  const name = document.getElementById("newUserName").value.trim();
  const phone = document.getElementById("newUserPhone").value.trim();
  const password = document.getElementById("newUserPassword").value;
  const role = document.getElementById("newUserRole").value;
  if (!name || !phone || !password) return alert("Заполните имя, телефон и пароль");
  try {
    await api("/users", {
      method: "POST",
      body: JSON.stringify({ name, phone, password, is_admin: role === "admin" }),
    });
    document.getElementById("newUserName").value = "";
    document.getElementById("newUserPhone").value = "";
    document.getElementById("newUserPassword").value = "";
    document.getElementById("newUserRole").value = "user";
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

async function deleteUser(id) {
  if (!confirm("Удалить этого пользователя?")) return;
  try {
    await api(`/users/${id}`, { method: "DELETE" });
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Загрузка приложения ----------

async function bootApp() {
  try {
    orgs = await api("/orgs");
    if (orgs.length === 0) {
      showError(currentUser.is_admin
        ? "Организаций пока нет. Добавьте первую через сайдбар."
        : "Организаций пока нет. Обратитесь к администратору.");
    } else {
      currentOrg = orgs[0];
    }
    renderNav();
    if (currentOrg) await switchOrg(currentOrg);
  } catch (err) {
    showError("Не удалось подключиться к серверу: " + err.message);
  }
}

function showError(msg) {
  const el = document.getElementById("errorState");
  el.textContent = msg;
  el.style.display = "block";
  document.getElementById("loadingState").style.display = "none";
}

// ---------- Навигация по организациям ----------

function renderNav() {
  const isAdmin = currentUser && currentUser.is_admin;
  const orgRows = orgs.map(o => `
    <div class="org-row">
      <button class="org-btn ${currentOrg && o.id===currentOrg.id?'active':''}" onclick="switchOrgById(${o.id})">${escapeHtml(o.name)}</button>
      ${isAdmin ? `
        <button class="org-action" title="Переименовать" onclick="renameOrgPrompt(${o.id}, event)">✎</button>
        <button class="org-action" title="Удалить" onclick="deleteOrgPrompt(${o.id}, event)">🗑</button>
      ` : ""}
    </div>
  `).join("");

  const html = `
    <div class="brand">
      <div class="brand-icon">🏢</div>
      <div><div class="brand-title">Касса</div><div class="brand-sub">Учёт расходов</div></div>
    </div>
    <div class="nav-label">Организации</div>
    ${orgRows}
    ${isAdmin ? `<button class="add-org-btn" onclick="showAddOrg(this)">+ организация</button>` : ""}
    <div class="sidebar-footer">
      ${isAdmin ? `<button class="add-org-btn" style="margin-bottom:8px;" onclick="openUsersModal()">👤 Пользователи</button>` : ""}
      <div class="user-chip">
        <div>
          <div class="user-name">${currentUser ? escapeHtml(currentUser.name) : ""}</div>
          <div class="user-role">${isAdmin ? "Администратор" : "Пользователь"}</div>
        </div>
        <button class="logout-btn" onclick="logout()">Выйти</button>
      </div>
    </div>
  `;
  document.getElementById("sidebar").innerHTML = html;
  document.getElementById("drawerContent").innerHTML = html;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function showAddOrg(btn) {
  btn.outerHTML = `
    <div class="add-org-row">
      <input id="newOrgInput" placeholder="Название" onkeydown="if(event.key==='Enter')addOrg()">
      <button onclick="addOrg()">✓</button>
      <button class="cancel" onclick="renderNav()">✕</button>
    </div>`;
  document.getElementById("newOrgInput").focus();
}

async function addOrg() {
  const input = document.getElementById("newOrgInput");
  const name = input.value.trim();
  if (!name) return;
  try {
    const org = await api("/orgs", { method: "POST", body: JSON.stringify({ name }) });
    orgs.push(org);
    closeDrawer();
    await switchOrg(org);
  } catch (err) {
    alert(err.message);
  }
}

async function renameOrgPrompt(id, evt) {
  evt.stopPropagation();
  const org = orgs.find(o => o.id === id);
  if (!org) return;
  const name = prompt("Новое название организации:", org.name);
  if (!name || !name.trim() || name.trim() === org.name) return;
  try {
    const updated = await api(`/orgs/${id}`, { method: "PUT", body: JSON.stringify({ name: name.trim() }) });
    orgs = orgs.map(o => (o.id === id ? updated : o));
    if (currentOrg && currentOrg.id === id) currentOrg = updated;
    renderNav();
    if (currentOrg && currentOrg.id === id) {
      document.getElementById("mobileOrgName").textContent = updated.name;
      document.getElementById("desktopOrgName").textContent = updated.name;
      document.getElementById("modalOrgName").textContent = updated.name;
    }
  } catch (err) {
    alert(err.message);
  }
}

async function deleteOrgPrompt(id, evt) {
  evt.stopPropagation();
  const org = orgs.find(o => o.id === id);
  if (!org) return;
  if (!confirm(`Удалить организацию «${org.name}» и все её операции? Это необратимо.`)) return;
  try {
    await api(`/orgs/${id}`, { method: "DELETE" });
    orgs = orgs.filter(o => o.id !== id);
    if (currentOrg && currentOrg.id === id) {
      currentOrg = orgs[0] || null;
      if (currentOrg) await switchOrg(currentOrg);
      else {
        transactions = [];
        render();
        document.getElementById("mobileOrgName").textContent = "—";
        document.getElementById("desktopOrgName").textContent = "—";
        showError("Организаций больше нет. Добавьте новую через сайдбар.");
      }
    }
    renderNav();
  } catch (err) {
    alert(err.message);
  }
}

function switchOrgById(id) {
  const org = orgs.find(o => o.id === id);
  if (org) switchOrg(org);
}

async function switchOrg(org) {
  currentOrg = org;
  currentAccount = "cash";
  personFilter = null;
  renderNav();
  document.getElementById("mobileOrgName").textContent = org.name;
  document.getElementById("desktopOrgName").textContent = org.name;
  closeDrawer();
  updateAccountTabsUI();

  try {
    categories = await api(`/orgs/${org.id}/categories`);
    document.getElementById("fCategory").innerHTML =
      categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  } catch (err) {
    categories = [];
  }

  await Promise.all([loadTransactions(org.id), loadPersonBalances()]);
  connectWebSocket(org.id);
}

function switchAccount(account) {
  if (currentAccount === account || !currentOrg) return;
  currentAccount = account;
  personFilter = null;
  updateAccountTabsUI();
  loadTransactions(currentOrg.id);
  if (account === "cash") loadPersonBalances();
}

function updateAccountTabsUI() {
  document.getElementById("tabCash").classList.toggle("active", currentAccount === "cash");
  document.getElementById("tabBank").classList.toggle("active", currentAccount === "bank");
  document.getElementById("mainTitleSub").textContent =
    currentAccount === "cash" ? "Касса и учёт операций" : "Банковский счёт и движения по нему";
  document.getElementById("personBalances").style.display = currentAccount === "cash" ? "grid" : "none";
  document.getElementById("dynamicsChart").style.display = currentAccount === "bank" ? "block" : "none";
}

// ---------- Операции ----------

async function loadTransactions(orgId, silent) {
  if (!silent) {
    document.getElementById("loadingState").style.display = "block";
    document.getElementById("errorState").style.display = "none";
    document.getElementById("tableWrap").style.display = "none";
    document.getElementById("emptyState").style.display = "none";
  }
  try {
    transactions = await api(`/orgs/${orgId}/transactions?account=${currentAccount}`);
    render();
  } catch (err) {
    if (!silent) showError("Не удалось загрузить операции: " + err.message);
  }
  if (!silent) document.getElementById("loadingState").style.display = "none";
}

async function loadPersonBalances() {
  if (!currentOrg) return;
  try {
    personBalances = await api(`/orgs/${currentOrg.id}/person-balances?account=cash`);
  } catch (err) {
    personBalances = [];
  }
  renderPersonBalances();
}

function renderPersonBalances() {
  const el = document.getElementById("personBalances");
  if (currentAccount !== "cash") return;
  if (personBalances.length === 0) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = personBalances.map(p => `
    <div class="person-card ${personFilter === p.who_id ? 'active' : ''}" onclick="togglePersonFilter(${p.who_id})">
      <div class="person-card-name">${escapeHtml(p.who_name || "—")}</div>
      <div class="person-card-balance" style="color:${Number(p.balance) < 0 ? 'var(--expense)' : 'var(--income)'}">${fmt(p.balance)}</div>
      <div class="person-card-detail">получено ${fmt(p.total_income)} · потрачено ${fmt(p.total_expense)}</div>
    </div>
  `).join("");
}

function togglePersonFilter(whoId) {
  personFilter = personFilter === whoId ? null : whoId;
  renderPersonBalances();
  renderPersonFilterBar();
  render();
}

function renderPersonFilterBar() {
  const bar = document.getElementById("personFilterBar");
  if (!personFilter) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  const person = personBalances.find(p => p.who_id === personFilter);
  bar.style.display = "flex";
  bar.innerHTML = `Показаны только операции: <b style="color:var(--text)">${escapeHtml(person ? person.who_name : "")}</b> <button onclick="togglePersonFilter(${personFilter})">Сбросить фильтр ✕</button>`;
}

function connectWebSocket(orgId) {
  if (ws) ws.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    ws = new WebSocket(`${protocol}//${location.host}/ws?orgId=${orgId}`);
    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.type === "updated" && currentOrg && String(msg.orgId) === String(currentOrg.id)) {
        loadTransactions(currentOrg.id, true);
        if (currentAccount === "cash") loadPersonBalances();
      }
    };
  } catch (err) {}
}

function render() {
  const filtered = personFilter
    ? transactions.filter(t => t.who_id === personFilter)
    : transactions;

  const sorted = [...filtered].sort((a, b) =>
    (b.occurred_on + (b.occurred_at || "")).localeCompare(a.occurred_on + (a.occurred_at || ""))
  );
  const income = filtered.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
  const expense = filtered.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  document.getElementById("kpiIncome").textContent = fmt(income);
  document.getElementById("kpiExpense").textContent = fmt(expense);
  document.getElementById("kpiBalance").textContent = fmt(income - expense);

  renderPersonFilterBar();
  if (currentAccount === "bank") drawDynamicsChart();

  const tableWrap = document.getElementById("tableWrap");
  const cardList = document.getElementById("cardList");
  const emptyState = document.getElementById("emptyState");

  if (sorted.length === 0) {
    tableWrap.style.display = "none";
    cardList.innerHTML = "";
    emptyState.style.display = "block";
    return;
  }
  emptyState.style.display = "none";
  tableWrap.style.display = "block";

  document.getElementById("tableBody").innerHTML = sorted.map(t => {
    const dateFmt = new Date(t.occurred_on).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
    const catCell = t.type === "income"
      ? `<span style="color:var(--income)">Приход · ${escapeHtml(t.source || "—")}</span>`
      : currentAccount === "bank"
        ? `<span style="color:var(--expense)">Расход</span>`
        : `<span style="color:${t.category_color || catColor(t.category_name)}">${escapeHtml(t.category_name || "—")}</span>`;
    const descCell = escapeHtml(t.description || "—") + (t.comment ? ` <span style="color:var(--muted);font-style:italic;">· ${escapeHtml(t.comment)}</span>` : "");
    const canEdit = currentUser && (currentUser.is_admin || String(t.created_by) === String(currentUser.id));
    return `<tr>
      <td>${dateFmt}</td>
      <td style="color:var(--muted)">${t.occurred_at ? t.occurred_at.slice(0,5) : "—"}</td>
      <td>${catCell}</td>
      <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${descCell}</td>
      <td style="color:var(--muted)">${escapeHtml(t.who_name || "—")}</td>
      <td class="amount-cell ${t.type}">${t.type === "income" ? "+" : "−"}${fmt(t.amount)}</td>
      <td>${canEdit ? `<button class="del-btn" onclick='editTx(${t.id})'>✎</button><button class="del-btn" onclick="removeTx(${t.id})">🗑</button>` : ""}</td>
    </tr>`;
  }).join("");

  cardList.innerHTML = sorted.map(t => {
    const color = t.type === "income" ? "var(--income)" : (currentAccount === "bank" ? "var(--expense)" : (t.category_color || catColor(t.category_name)));
    const icon = t.type === "income" ? "↓" : "↑";
    const dateFmt = new Date(t.occurred_on).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
    const canEdit = currentUser && (currentUser.is_admin || String(t.created_by) === String(currentUser.id));
    const title = t.type === "income"
      ? "Приход · " + escapeHtml(t.source || "—")
      : escapeHtml(t.description || t.category_name || "Расход");
    return `<div class="tx-card">
      <div class="tx-icon" style="background:${color}22;color:${color};">${icon}</div>
      <div class="tx-info">
        <div class="tx-title">${title}</div>
        <div class="tx-meta">
          <span>${dateFmt}</span>
          ${t.type === "expense" && currentAccount === "cash" ? `<span style="color:${t.category_color || catColor(t.category_name)}">· ${escapeHtml(t.category_name)}</span>` : ""}
          ${t.who_name ? `<span>· ${escapeHtml(t.who_name)}</span>` : ""}
        </div>
      </div>
      <div class="tx-amount" style="color:${t.type === "income" ? "var(--income)" : "var(--expense)"};">${t.type === "income" ? "+" : "−"}${fmt(t.amount)}</div>
      ${canEdit ? `<button class="del-btn" onclick='editTx(${t.id})'>✎</button><button class="del-btn" onclick="removeTx(${t.id})">🗑</button>` : ""}
    </div>`;
  }).join("");
}

function drawDynamicsChart() {
  const svg = document.getElementById("dynamicsSvg");
  const sortedAsc = [...transactions].sort((a, b) =>
    (a.occurred_on + (a.occurred_at || "")).localeCompare(b.occurred_on + (b.occurred_at || ""))
  );
  if (sortedAsc.length === 0) {
    svg.innerHTML = `<text x="300" y="80" fill="var(--muted)" font-size="13" text-anchor="middle">Пока нет операций для графика</text>`;
    return;
  }

  let running = 0;
  const points = sortedAsc.map(t => {
    running += t.type === "income" ? Number(t.amount) : -Number(t.amount);
    return { date: t.occurred_on, balance: running };
  });

  const minBal = Math.min(0, ...points.map(p => p.balance));
  const maxBal = Math.max(0, ...points.map(p => p.balance));
  const range = maxBal - minBal || 1;
  const W = 600, H = 160, PAD = 8;

  const coords = points.map((p, i) => {
    const x = points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - PAD * 2);
    const y = H - PAD - ((p.balance - minBal) / range) * (H - PAD * 2);
    return [x, y];
  });

  const zeroY = H - PAD - ((0 - minBal) / range) * (H - PAD * 2);
  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${coords[coords.length - 1][0].toFixed(1)},${H - PAD} L${coords[0][0].toFixed(1)},${H - PAD} Z`;

  svg.innerHTML = `
    <line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4 4"/>
    <path d="${areaPath}" fill="var(--lilac-deep)" opacity="0.15"/>
    <path d="${linePath}" fill="none" stroke="var(--lilac)" stroke-width="2"/>
    ${coords.map((c, i) => `<circle cx="${c[0].toFixed(1)}" cy="${c[1].toFixed(1)}" r="2.5" fill="${points[i].balance < 0 ? 'var(--expense)' : 'var(--lilac)'}"/>`).join("")}
  `;
}

async function removeTx(id) {
  if (!confirm("Удалить эту операцию?")) return;
  try {
    await api(`/orgs/transactions/${id}`, { method: "DELETE" });
    transactions = transactions.filter(t => t.id !== id);
    render();
    if (currentAccount === "cash") await loadPersonBalances();
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
  }
}

// ---------- UI-утилиты ----------

function openDrawer() { document.getElementById("drawerOverlay").style.display = "flex"; }
function closeDrawer() { document.getElementById("drawerOverlay").style.display = "none"; }

let editingTxId = null;

function openForm() {
  if (!currentOrg) return alert("Сначала выберите организацию");
  editingTxId = null;
  const accountLabel = currentAccount === "cash" ? "касса" : "банк";
  document.getElementById("modalTitle").innerHTML = `Новая операция · ${accountLabel} · <span id="modalOrgName">${escapeHtml(currentOrg.name)}</span>`;
  document.getElementById("saveTxBtn").textContent = "Сохранить";
  document.getElementById("fAmount").value = "";
  document.getElementById("fDesc").value = "";
  document.getElementById("fSource").value = "";
  document.getElementById("fComment").value = "";
  document.getElementById("fDate").value = todayStr();
  document.getElementById("fTime").value = nowStr();
  setType("expense");
  document.getElementById("modalOverlay").style.display = "flex";
}

function editTx(id) {
  const t = transactions.find(tx => tx.id === id);
  if (!t) return;
  editingTxId = id;
  const accountLabel = currentAccount === "cash" ? "касса" : "банк";
  document.getElementById("modalTitle").innerHTML = `Изменить операцию · ${accountLabel} · <span id="modalOrgName">${escapeHtml(currentOrg.name)}</span>`;
  document.getElementById("saveTxBtn").textContent = "Сохранить изменения";
  document.getElementById("fAmount").value = t.amount;
  document.getElementById("fDate").value = t.occurred_on.slice(0, 10);
  document.getElementById("fTime").value = t.occurred_at ? t.occurred_at.slice(0, 5) : "";
  document.getElementById("fDesc").value = t.description || "";
  document.getElementById("fSource").value = t.source || "";
  document.getElementById("fComment").value = t.comment || "";
  setType(t.type);
  if (t.type === "expense" && t.category_id) {
    document.getElementById("fCategory").value = t.category_id;
  }
  document.getElementById("modalOverlay").style.display = "flex";
}

function closeForm() {
  document.getElementById("modalOverlay").style.display = "none";
  editingTxId = null;
}

function setType(t) {
  currentType = t;
  document.getElementById("btnExpense").className = t === "expense" ? "active-expense" : "";
  document.getElementById("btnIncome").className = t === "income" ? "active-income" : "";
  document.getElementById("categoryField").style.display = (t === "expense" && currentAccount === "cash") ? "block" : "none";
  document.getElementById("descField").style.display = t === "expense" ? "block" : "none";
  document.getElementById("sourceField").style.display = t === "income" ? "block" : "none";
}

async function submitForm(e) {
  e.preventDefault();
  const amount = Number(document.getElementById("fAmount").value);
  if (!amount || amount <= 0 || !currentOrg) return;

  const payload = {
    type: currentType,
    amount,
    account: currentAccount,
    occurred_on: document.getElementById("fDate").value,
    occurred_at: document.getElementById("fTime").value || null,
    comment: document.getElementById("fComment").value.trim() || null,
  };
  if (currentType === "expense") {
    payload.category_id = currentAccount === "cash" ? (Number(document.getElementById("fCategory").value) || null) : null;
    payload.description = document.getElementById("fDesc").value.trim() || null;
  } else {
    payload.source = document.getElementById("fSource").value.trim() || null;
  }

  try {
    if (editingTxId) {
      await api(`/orgs/transactions/${editingTxId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api(`/orgs/${currentOrg.id}/transactions`, { method: "POST", body: JSON.stringify(payload) });
    }
    await loadTransactions(currentOrg.id, true);
    if (currentAccount === "cash") await loadPersonBalances();
    closeForm();
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
  }
}

// ---------- Старт ----------

async function init() {
  loadSession();
  document.getElementById("loginForm").addEventListener("submit", submitLogin);
  document.getElementById("forgotStep1Form").addEventListener("submit", submitForgotStep1);
  document.getElementById("forgotStep2Form").addEventListener("submit", submitForgotStep2);
  document.getElementById("txForm").addEventListener("submit", submitForm);
  document.getElementById("drawerOverlay").addEventListener("click", closeDrawer);

  if (authToken && currentUser) {
    try {
      await api("/auth/me"); // проверяем, что токен ещё действителен
      document.getElementById("loginScreen").style.display = "none";
      document.getElementById("appLayout").style.display = "flex";
      await bootApp();
      return;
    } catch (err) {
      logout();
    }
  }
  document.getElementById("loginScreen").style.display = "flex";
}

init();
