// Касса — фронтенд, работает с реальным API (server/routes) и PostgreSQL
const API = "/api";

let orgs = [];
let currentOrg = null;
let categories = [];
let transactions = [];
let currentType = "expense";
let currentAccount = "cash"; // 'cash' | 'bank' | 'orders' (вкладка «Заказы», см. orders.js)
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
  const login = document.getElementById("loginPhone").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.style.display = "none";
  try {
    const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ login, password }) });
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
          <span class="user-row-name">${escapeHtml(u.name)}${u.is_admin ? '<span class="admin-badge">админ</span>' : ""}${!u.is_admin && u.can_view_all ? '<span class="view-all-badge">видит всех</span>' : ""}</span>
          <div class="user-row-meta">логин: ${escapeHtml(u.username || "—")}${u.phone ? " · " + escapeHtml(u.phone) : ""}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="user-row-del" title="Задать имя пользователя" onclick="editUsername(${u.id}, '${(u.username || "").replace(/'/g, "\\'")}')">✎</button>
          ${!u.is_admin ? `<label class="checkbox-row" style="margin:0;font-size:12px;"><input type="checkbox" ${u.can_view_all ? "checked" : ""} onchange="toggleViewAll(${u.id}, this.checked)"> видит всех</label>` : ""}
          ${u.id !== currentUser.id ? `<button class="user-row-del" onclick="deleteUser(${u.id})">🗑</button>` : ""}
        </div>
      </div>
    `).join("") || `<div style="color:var(--muted);font-size:13px;">Пользователей нет</div>`;
  } catch (err) {
    listEl.innerHTML = `<div style="color:var(--expense);font-size:13px;">${err.message}</div>`;
  }
}

async function toggleViewAll(id, value) {
  try {
    await api(`/users/${id}`, { method: "PUT", body: JSON.stringify({ can_view_all: value }) });
  } catch (err) {
    alert(err.message);
    loadUsers();
  }
}

async function editUsername(id, current) {
  const value = prompt("Имя пользователя для входа:", current || "");
  if (value === null || !value.trim() || value.trim() === current) return;
  try {
    await api(`/users/${id}`, { method: "PUT", body: JSON.stringify({ username: value.trim() }) });
    loadUsers();
  } catch (err) {
    alert(err.message);
  }
}

async function createUser() {
  const name = document.getElementById("newUserName").value.trim();
  const username = document.getElementById("newUserUsername").value.trim();
  const phone = document.getElementById("newUserPhone").value.trim();
  const password = document.getElementById("newUserPassword").value;
  const role = document.getElementById("newUserRole").value;
  const canViewAll = document.getElementById("newUserViewAll").checked;
  if (!name || !username || !password) return alert("Заполните имя, имя пользователя и пароль");
  try {
    await api("/users", {
      method: "POST",
      body: JSON.stringify({ name, username, phone: phone || null, password, is_admin: role === "admin", can_view_all: canViewAll }),
    });
    document.getElementById("newUserName").value = "";
    document.getElementById("newUserUsername").value = "";
    document.getElementById("newUserPhone").value = "";
    document.getElementById("newUserPassword").value = "";
    document.getElementById("newUserRole").value = "user";
    document.getElementById("newUserViewAll").checked = false;
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

  await Promise.all([loadTransactions(org.id), loadPersonBalances(), loadOrderOptions()]);
  connectWebSocket(org.id);
}

function switchAccount(account) {
  if (currentAccount === account || !currentOrg) return;
  if (account === "orders" && !isPartner()) return;
  currentAccount = account;
  personFilter = null;
  updateAccountTabsUI();
  if (account === "orders") return loadOrders();
  loadTransactions(currentOrg.id);
  if (account === "cash") loadPersonBalances();
}

function updateAccountTabsUI() {
  const isOrders = currentAccount === "orders";
  document.getElementById("tabCash").classList.toggle("active", currentAccount === "cash");
  document.getElementById("tabBank").classList.toggle("active", currentAccount === "bank");
  document.getElementById("tabOrders").classList.toggle("active", isOrders);
  document.getElementById("tabOrders").style.display = isPartner() ? "" : "none";
  document.getElementById("ordersView").style.display = isOrders ? "block" : "none";
  document.getElementById("kassaView").style.display = isOrders ? "none" : "block";
  document.getElementById("importBtn").style.display = isOrders ? "none" : "";
  document.getElementById("ordEntity").style.display = isOrders ? "" : "none";
  document.getElementById("fabLabel").textContent = isOrders ? "Новый заказ" : "Добавить операцию";
  document.getElementById("mainTitleSub").textContent =
    isOrders ? "Заказы: цена, оплаты клиентов, затраты и результат"
    : currentAccount === "cash" ? "Касса и учёт операций" : "Банковский счёт и движения по нему";
  if (isOrders) return;
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
  const list = orderPeriod === "all" ? personBalances : personBalancesForPeriod();
  if (list.length === 0) {
    el.innerHTML = "";
    return;
  }
  const canBrowseOthers = currentUser && (currentUser.is_admin || currentUser.can_view_all);
  el.innerHTML = list.map(p => `
    <div class="person-card ${personFilter === p.who_id ? 'active' : ''}" ${canBrowseOthers ? `onclick="togglePersonFilter(${p.who_id})"` : ""} style="${canBrowseOthers ? "" : "cursor:default;"}">
      <div class="person-card-name">${escapeHtml(p.who_name || "—")}${!canBrowseOthers ? ' <span style="color:var(--muted);font-weight:400;">(вы)</span>' : ""}</div>
      <div class="person-card-balance" style="color:${Number(p.balance) < 0 ? 'var(--expense)' : 'var(--income)'}">${fmt(p.balance)}</div>
      <div class="person-card-detail">получено ${fmt(p.total_income)} · потрачено ${fmt(p.total_expense)}</div>
    </div>
  `).join("");
}

function togglePersonFilter(whoId) {
  if (!currentUser || !(currentUser.is_admin || currentUser.can_view_all)) return;
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
        loadOrderOptions();
        if (currentAccount === "orders") {
          loadOrders(true);
          refreshOpenOrderDetails();
          return;
        }
        loadTransactions(currentOrg.id, true);
        if (currentAccount === "cash") loadPersonBalances();
      }
    };
  } catch (err) {}
}

// ---------- Период для «Кассы» и «Банка» ----------
// Получено / потрачено — за выбранный период; остаток — на конец периода (всё до даты «по»).

function inPeriod(t) {
  const [from, to] = periodRange();
  const d = t.occurred_on.slice(0, 10);
  return (!from || d >= from) && (!to || d <= to);
}
function beforePeriodEnd(t) {
  const to = periodRange()[1];
  return !to || t.occurred_on.slice(0, 10) <= to;
}

function personBalancesForPeriod() {
  const map = new Map();
  for (const t of transactions) {
    if (!t.who_id || !beforePeriodEnd(t)) continue;
    if (!map.has(t.who_id)) map.set(t.who_id, { who_id: t.who_id, who_name: t.who_name, total_income: 0, total_expense: 0, balance: 0 });
    const p = map.get(t.who_id);
    const a = Number(t.amount) * (t.type === "income" ? 1 : -1);
    p.balance += a;
    if (inPeriod(t)) t.type === "income" ? (p.total_income += Number(t.amount)) : (p.total_expense += Number(t.amount));
  }
  return [...map.values()].sort((a, b) => String(a.who_name).localeCompare(String(b.who_name)));
}

function onPeriodChange() {
  if (currentAccount === "orders") return loadOrders();
  renderPersonBalances();
  render();
}

function render() {
  const byPerson = personFilter
    ? transactions.filter(t => t.who_id === personFilter)
    : transactions;
  const filtered = byPerson.filter(inPeriod);

  const sorted = [...filtered].sort((a, b) =>
    (b.occurred_on + (b.occurred_at || "")).localeCompare(a.occurred_on + (a.occurred_at || ""))
  );
  const income = filtered.filter(t => t.type === "income").reduce((s, t) => s + Number(t.amount), 0);
  const expense = filtered.filter(t => t.type === "expense").reduce((s, t) => s + Number(t.amount), 0);
  document.getElementById("kpiIncome").textContent = fmt(income);
  document.getElementById("kpiExpense").textContent = fmt(expense);
  const balance = byPerson.filter(beforePeriodEnd)
    .reduce((s, t) => s + (t.type === "income" ? 1 : -1) * Number(t.amount), 0);
  document.getElementById("kpiBalance").textContent = fmt(balance);
  const periodEnd = periodRange()[1];
  const isPeriod = orderPeriod !== "all";
  document.getElementById("kpiBalanceLabel").textContent =
    periodEnd && isPeriod && periodEnd < localDate(new Date()) ? `Остаток на ${dateRu(periodEnd)}` : "Остаток";
  document.getElementById("emptyState").textContent = isPeriod
    ? "За выбранный период операций нет"
    : "Пока нет операций — добавьте первую через кнопку «Добавить операцию»";

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
    const orderTag = t.order_id ? `<div><span class="order-tag" title="Заказ: ${escapeHtml(t.order_customer || "")}">📋 ${escapeHtml(t.order_title || "заказ")}</span></div>` : "";
    const canEdit = currentUser && (currentUser.is_admin || String(t.created_by) === String(currentUser.id));
    return `<tr>
      <td>${dateFmt}</td>
      <td style="color:var(--muted)">${t.occurred_at ? t.occurred_at.slice(0,5) : "—"}</td>
      <td>${catCell}${orderTag}</td>
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
          ${t.order_id ? `<span class="order-tag">📋 ${escapeHtml(t.order_title || "заказ")}</span>` : ""}
        </div>
      </div>
      <div class="tx-amount" style="color:${t.type === "income" ? "var(--income)" : "var(--expense)"};">${t.type === "income" ? "+" : "−"}${fmt(t.amount)}</div>
      ${canEdit ? `<button class="del-btn" onclick='editTx(${t.id})'>✎</button><button class="del-btn" onclick="removeTx(${t.id})">🗑</button>` : ""}
    </div>`;
  }).join("");
}

function drawDynamicsChart() {
  const svg = document.getElementById("dynamicsSvg");
  const sortedAsc = [...transactions].filter(beforePeriodEnd).sort((a, b) =>
    (a.occurred_on + (a.occurred_at || "")).localeCompare(b.occurred_on + (b.occurred_at || ""))
  );
  if (sortedAsc.length === 0) {
    svg.innerHTML = `<text x="300" y="80" fill="var(--muted)" font-size="13" text-anchor="middle">Пока нет операций для графика</text>`;
    return;
  }

  let running = 0;
  const points = sortedAsc.map(t => {
    running += t.type === "income" ? Number(t.amount) : -Number(t.amount);
    return { date: t.occurred_on, balance: running, show: inPeriod(t) };
  }).filter(p => p.show);
  if (points.length === 0) {
    svg.innerHTML = `<text x="300" y="80" fill="var(--muted)" font-size="13" text-anchor="middle">За выбранный период движений нет</text>`;
    return;
  }

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
    transactions = transactions.filter(t => String(t.id) !== String(id));
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
  fillOrderSelect(null);
  document.getElementById("fCostType").value = "other";
  setType("expense");
  document.getElementById("modalOverlay").style.display = "flex";
}

function editTx(id) {
  const t = transactions.find(tx => String(tx.id) === String(id));
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
  fillOrderSelect(t.order_id);
  document.getElementById("fCostType").value = t.cost_type || "other";
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
  updateCostTypeVisibility();
}

// Поле «Статья заказа» нужно только для расхода, привязанного к заказу
function updateCostTypeVisibility() {
  const hasOrder = !!document.getElementById("fOrder").value;
  document.getElementById("costTypeField").style.display = hasOrder && currentType === "expense" ? "block" : "none";
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
  payload.order_id = Number(document.getElementById("fOrder").value) || null;
  payload.cost_type = payload.order_id && currentType === "expense" ? document.getElementById("fCostType").value : null;

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
  document.getElementById("orderForm").addEventListener("submit", submitOrderForm);
  document.getElementById("itemForm").addEventListener("submit", submitItemForm);
  initOrdersUI();
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

// ---------- Экспорт / импорт в Excel ----------

// Кнопка «⬇ Excel» и плавающая «+» работают по текущей вкладке
function exportCurrentView() {
  return currentAccount === "orders" ? exportOrdersToExcel() : exportToExcel();
}
function primaryAction() {
  return currentAccount === "orders" ? openOrderForm() : openForm();
}

const EXPORT_HEADERS = ["Дата", "Время", "Тип", "Категория", "Источник", "Описание", "Сумма", "Кто", "Комментарий"];

function exportToExcel() {
  if (!currentOrg) return alert("Сначала выберите организацию");
  const filtered = (personFilter ? transactions.filter(t => t.who_id === personFilter) : transactions).filter(inPeriod);
  if (filtered.length === 0) return alert("Нет операций для выгрузки за выбранный период");

  const sorted = [...filtered].sort((a, b) =>
    (a.occurred_on + (a.occurred_at || "")).localeCompare(b.occurred_on + (b.occurred_at || ""))
  );

  const rows = sorted.map(t => ([
    t.occurred_on.slice(0, 10),
    t.occurred_at ? t.occurred_at.slice(0, 5) : "",
    t.type === "income" ? "Приход" : "Расход",
    t.type === "expense" ? (t.category_name || "") : "",
    t.type === "income" ? (t.source || "") : "",
    t.type === "expense" ? (t.description || "") : "",
    Number(t.amount),
    t.who_name || "",
    t.comment || "",
  ]));

  const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADERS, ...rows]);
  ws["!cols"] = [{ wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 20 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 14 }, { wch: 26 }];
  const wb = XLSX.utils.book_new();
  const sheetName = currentAccount === "cash" ? "Касса" : "Банк";
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const filename = `${currentOrg.name}-${sheetName}-${todayStr()}.xlsx`;
  XLSX.writeFile(wb, filename);
}

async function handleImportFile(event) {
  const file = event.target.files[0];
  event.target.value = ""; // чтобы можно было выбрать тот же файл повторно
  if (!file || !currentOrg) return;

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

    if (rows.length === 0) return alert("В файле нет строк с данными");

    let ok = 0, skipped = 0;
    for (const row of rows) {
      const parsed = parseImportRow(row);
      if (!parsed) { skipped++; continue; }
      try {
        await api(`/orgs/${currentOrg.id}/transactions`, { method: "POST", body: JSON.stringify(parsed) });
        ok++;
      } catch (err) {
        skipped++;
      }
    }

    await loadTransactions(currentOrg.id, true);
    if (currentAccount === "cash") await loadPersonBalances();
    alert(`Импорт завершён: добавлено ${ok}, пропущено ${skipped}${skipped ? " (проверьте формат этих строк)" : ""}.`);
  } catch (err) {
    alert("Не удалось прочитать файл: " + err.message);
  }
}

function excelDateToStr(val) {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).trim();
  // поддержка формата DD.MM.YYYY на случай ручного ввода в Excel
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s.slice(0, 10);
}

function parseImportRow(row) {
  const typeRaw = String(row["Тип"] || "").trim().toLowerCase();
  const type = typeRaw.startsWith("приход") ? "income" : typeRaw.startsWith("расход") ? "expense" : null;
  const amount = Number(row["Сумма"]);
  const occurred_on = excelDateToStr(row["Дата"]);

  if (!type || !amount || amount <= 0 || !occurred_on || !/^\d{4}-\d{2}-\d{2}$/.test(occurred_on)) {
    return null;
  }

  const payload = {
    type,
    amount,
    account: currentAccount,
    occurred_on,
    occurred_at: row["Время"] ? String(row["Время"]).trim().slice(0, 5) : null,
    comment: row["Комментарий"] ? String(row["Комментарий"]).trim() : null,
  };

  if (type === "expense") {
    const catName = String(row["Категория"] || "").trim().toLowerCase();
    const cat = categories.find(c => c.name.toLowerCase() === catName);
    payload.category_id = cat ? cat.id : null;
    payload.description = row["Описание"] ? String(row["Описание"]).trim() : null;
  } else {
    payload.source = row["Источник"] ? String(row["Источник"]).trim() : null;
  }

  return payload;
}

init();
