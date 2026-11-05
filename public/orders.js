// Касса — вкладка «Заказы». Один заказ — одна строка, как в Excel-шаблоне:
// цена, оплаты клиента (наличными / в банк), затраты по статьям, результат и долг клиента.
// Оплаты и затраты — обычные операции кассы/банка с order_id; «к оплате» (status = planned)
// входят в заказ, но в остатки кассы попадают только после оплаты.
// Общие переменные и функции (api, fmt, currentOrg, currentUser, categories, escapeHtml…) — из app.js.

const COST_TYPES = [
  { key: "materials", label: "Материалы", cat: [/матер/i] },
  { key: "taxi",      label: "Такси",     cat: [/такси/i, /логист/i] },
  { key: "designer",  label: "Дизайнер",  cat: [/дизайн/i, /зарплат/i] },
  { key: "installer", label: "Монтажник", cat: [/монтаж/i, /зарплат/i] },
  { key: "other",     label: "Прочие затраты", cat: [/проч/i] },
];
const costLabel = key => (COST_TYPES.find(c => c.key === key) || COST_TYPES[4]).label;

let orders = [];
let orderEntities = [];
let orderOptions = [];       // короткий список для формы операции (виден всем)
let orderPeriod = "all";
let showOrderDupsOnly = false;   // чекбокс «Показать только повторы» во вкладке «Заказы»     // month | prev | year | all | custom
let openOrderId = null;      // заказ, открытый в окне деталей
let openOrderData = null;    // { order, items }
let detailsFocus = null;     // что показать в деталях: cash | bank | materials | … | costs | null
let editingOrderId = null;
let editingItemId = null;
let itemDups = new Map();
let itemType = "income";
let itemStatus = "paid";
let itemKey = null;          // защита от двойного сохранения оплаты/затраты
let savingOrderForm = false;

const isPartner = () => !!(currentUser && (currentUser.is_admin || currentUser.can_view_all));
const num = v => Number(v || 0);
const fmtN = n => new Intl.NumberFormat("ru-RU").format(Math.round(n || 0));
const dateRu = d => d ? new Date(d.slice(0, 10) + "T00:00:00").toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";
const localDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function orderCalc(o) {
  const paid = num(o.paid_cash) + num(o.paid_bank);
  const costs = num(o.costs_total);
  return { paid, costs, result: num(o.price) - costs, debt: num(o.price) - paid };
}

function initOrdersUI() {
  document.getElementById("fCostType").innerHTML =
    COST_TYPES.map(c => `<option value="${c.key}">${c.label}</option>`).join("");
  document.getElementById("iCostType").innerHTML =
    COST_TYPES.map(c => `<option value="${c.key}">${c.label}</option>`).join("");
  markPeriodButtons();
}

// ---------- Список заказов для формы операции ----------

async function loadOrderOptions() {
  if (!currentOrg) return;
  try {
    orderOptions = await api(`/orgs/${currentOrg.id}/orders/options`);
  } catch (err) {
    orderOptions = [];
  }
}

function fillOrderSelect(selectedId) {
  const sel = document.getElementById("fOrder");
  const opts = [...orderOptions];
  // если операция привязана к старому заказу, которого нет в коротком списке — всё равно покажем
  if (selectedId && !opts.find(o => o.id === selectedId)) opts.unshift({ id: selectedId, title: `заказ #${selectedId}`, customer: "" });
  sel.innerHTML = `<option value="">— без заказа —</option>` + opts.map(o =>
    `<option value="${o.id}">${escapeHtml(o.title)}${o.customer ? " · " + escapeHtml(o.customer) : ""}${o.ordered_on ? " · " + dateRu(o.ordered_on).slice(0, 5) : ""}</option>`
  ).join("");
  sel.value = selectedId ? String(selectedId) : "";
  document.getElementById("orderLinkRow").style.display = opts.length ? "" : "none";
}

// ---------- Фильтры ----------

function periodRange() {
  const now = new Date();
  if (orderPeriod === "month") return [localDate(new Date(now.getFullYear(), now.getMonth(), 1)), localDate(new Date(now.getFullYear(), now.getMonth() + 1, 0))];
  if (orderPeriod === "prev")  return [localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), localDate(new Date(now.getFullYear(), now.getMonth(), 0))];
  if (orderPeriod === "year")  return [`${now.getFullYear()}-01-01`, `${now.getFullYear()}-12-31`];
  if (orderPeriod === "custom") return [document.getElementById("ordFrom").value, document.getElementById("ordTo").value];
  return ["", ""];
}

function markPeriodButtons() {
  document.querySelectorAll("#periodSeg button").forEach(b => b.classList.toggle("active", b.dataset.p === orderPeriod));
  document.getElementById("customRange").style.display = orderPeriod === "custom" ? "flex" : "none";
}

function setOrderPeriod(p) {
  orderPeriod = p;
  if (p === "custom" && !document.getElementById("ordFrom").value) {
    const now = new Date();
    document.getElementById("ordFrom").value = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
    document.getElementById("ordTo").value = localDate(now);
  }
  markPeriodButtons();
  onPeriodChange();
}

// ---------- Загрузка и таблица ----------

async function loadOrders(silent) {
  if (!currentOrg || !isPartner()) return;
  const [from, to] = periodRange();
  const entity = document.getElementById("ordEntity").value;
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (entity) qs.set("entity", entity);

  const loading = document.getElementById("ordersLoading");
  const errEl = document.getElementById("ordersError");
  if (!silent) loading.style.display = "block";
  errEl.style.display = "none";
  try {
    const data = await api(`/orgs/${currentOrg.id}/orders?${qs}`);
    orders = data.orders;
    orderEntities = data.entities;
    renderEntityFilter(entity);
    renderOrders();
  } catch (err) {
    errEl.textContent = "Не удалось загрузить заказы: " + err.message;
    errEl.style.display = "block";
  }
  loading.style.display = "none";
}

function renderEntityFilter(selected) {
  const sel = document.getElementById("ordEntity");
  sel.innerHTML = `<option value="">Все ИП / ТОО</option>`
    + orderEntities.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join("")
    + `<option value="__none__">Без ИП / ТОО</option>`;
  sel.value = selected || "";
  document.getElementById("entityList").innerHTML = orderEntities.map(e => `<option value="${escapeHtml(e)}">`).join("");
}

function amt(orderId, focus, value, cls = "") {
  const v = num(value);
  return `<button class="amt-link ${cls} ${v === 0 ? "zero" : ""}" onclick="openOrderDetails(${orderId}, '${focus}')">${v === 0 ? "—" : fmtN(v)}</button>`;
}

function renderOrders() {
  const tot = { price: 0, cash: 0, bank: 0, materials: 0, taxi: 0, designer: 0, installer: 0, other: 0, costs: 0, planned: 0, incomePlanned: 0, result: 0, debt: 0 };
  orders.forEach(o => {
    const c = orderCalc(o);
    tot.price += num(o.price); tot.cash += num(o.paid_cash); tot.bank += num(o.paid_bank);
    tot.materials += num(o.cost_materials); tot.taxi += num(o.cost_taxi); tot.designer += num(o.cost_designer);
    tot.installer += num(o.cost_installer); tot.other += num(o.cost_other);
    tot.costs += c.costs; tot.planned += num(o.costs_planned); tot.incomePlanned += num(o.income_planned);
    tot.result += c.result; tot.debt += Math.max(0, c.debt);
  });

  document.getElementById("okPrice").textContent = fmt(tot.price);
  document.getElementById("okCount").textContent = `${orders.length} ${plural(orders.length, "заказ", "заказа", "заказов")}`;
  document.getElementById("okPaid").textContent = fmt(tot.cash + tot.bank);
  document.getElementById("okPaidSub").textContent = `нал ${fmtN(tot.cash)} · банк ${fmtN(tot.bank)}`;
  document.getElementById("okCosts").textContent = fmt(tot.costs);
  document.getElementById("okCostsSub").textContent = tot.planned ? `из них к оплате ${fmtN(tot.planned)} ₸` : "всё оплачено";
  document.getElementById("okDebt").textContent = fmt(tot.debt);
  document.getElementById("okDebtSub").textContent = tot.incomePlanned ? `ожидается ${fmtN(tot.incomePlanned)} ₸` : `${orders.filter(o => orderCalc(o).debt > 0).length} с долгом`;
  document.getElementById("okResult").textContent = fmt(tot.result);

  // Повторы заказов: та же дата, заказчик, название и цена
  const oDups = groupDuplicates(orders, o => [o.ordered_on, String(o.customer).trim().toLowerCase(),
    String(o.title).trim().toLowerCase(), num(o.price)].join("|"));
  if (!oDups.size) showOrderDupsOnly = false;
  renderDupBanner("ordersDupBanner", oDups.size, "заказ", "заказа", "заказов", "toggleOrderDupsOnly");
  const shown = showOrderDupsOnly
    ? orders.filter(o => oDups.has(o.id)).sort((a, b) => oDups.get(a.id) - oDups.get(b.id) || a.id - b.id)
    : orders;
  const dupMark = o => oDups.has(o.id) ? `<span class="dup-mark" title="Похоже на повтор: есть такой же заказ">⚠</span> ` : "";
  const grp = (o, base) => showOrderDupsOnly ? `${base} dup-row dup-g${oDups.get(o.id) % 2}${isGroupStart(shown, o, oDups) ? " dup-first" : ""}` : base;

  const empty = orders.length === 0;
  document.getElementById("ordersEmpty").style.display = empty ? "block" : "none";
  document.getElementById("ordersTableWrap").classList.toggle("hidden", empty);
  document.querySelector(".orders-hint").style.display = empty ? "none" : "";

  document.getElementById("ordersBody").innerHTML = shown.map(o => {
    const c = orderCalc(o);
    return `<tr class="${grp(o, "")}">
      <td class="nowrap">${dateRu(o.ordered_on)}</td>
      <td class="muted nowrap">${escapeHtml(o.legal_entity || "—")}</td>
      <td class="clip">${escapeHtml(o.customer)}</td>
      <td class="clip">${dupMark(o)}<button class="title-link" onclick="openOrderDetails(${o.id}, null)">${escapeHtml(o.title)}</button>${o.comment ? `<div class="cell-sub">${escapeHtml(o.comment)}</div>` : ""}</td>
      <td class="num strong">${amt(o.id, null, o.price)}</td>
      <td class="num">${amt(o.id, "cash", o.paid_cash, "inc")}</td>
      <td class="num">${amt(o.id, "bank", o.paid_bank, "inc")}</td>
      <td class="num">${amt(o.id, "materials", o.cost_materials)}</td>
      <td class="num">${amt(o.id, "taxi", o.cost_taxi)}</td>
      <td class="num">${amt(o.id, "designer", o.cost_designer)}</td>
      <td class="num">${amt(o.id, "installer", o.cost_installer)}</td>
      <td class="num">${amt(o.id, "other", o.cost_other)}</td>
      <td class="num">${amt(o.id, "costs", c.costs, "exp")}${num(o.costs_planned) ? `<div class="cell-sub warn">к оплате ${fmtN(o.costs_planned)}</div>` : ""}</td>
      <td class="num strong" style="color:${c.result < 0 ? "var(--expense)" : "var(--text)"}">${fmtN(c.result)}</td>
      <td class="num">${debtBadge(o.id, c.debt)}</td>
      <td><button class="del-btn" title="Изменить заказ" onclick="openOrderForm(${o.id})">✎</button></td>
    </tr>`;
  }).join("");

  document.getElementById("ordersFoot").innerHTML = empty ? "" : `<tr>
    <td colspan="4">Всего</td>
    <td class="num">${fmtN(tot.price)}</td><td class="num">${fmtN(tot.cash)}</td><td class="num">${fmtN(tot.bank)}</td>
    <td class="num">${fmtN(tot.materials)}</td><td class="num">${fmtN(tot.taxi)}</td><td class="num">${fmtN(tot.designer)}</td>
    <td class="num">${fmtN(tot.installer)}</td><td class="num">${fmtN(tot.other)}</td><td class="num">${fmtN(tot.costs)}</td>
    <td class="num">${fmtN(tot.result)}</td><td class="num">${fmtN(tot.debt)}</td><td></td>
  </tr>`;

  document.getElementById("ordersCards").innerHTML = shown.map(o => {
    const c = orderCalc(o);
    return `<div class="${grp(o, "order-card")}" onclick="openOrderDetails(${o.id}, null)">
      <div class="order-card-top">
        <div class="order-card-title">${dupMark(o)}${escapeHtml(o.title)}</div>
        <div class="order-card-price">${fmt(o.price)}</div>
      </div>
      <div class="tx-meta">${escapeHtml(o.customer)} · ${dateRu(o.ordered_on).slice(0, 5)}${o.legal_entity ? " · " + escapeHtml(o.legal_entity) : ""}</div>
      <div class="order-card-grid">
        <div><span>Получено</span><b style="color:var(--income)">${fmtN(c.paid)}</b></div>
        <div><span>Затраты</span><b style="color:var(--expense)">${fmtN(c.costs)}</b></div>
        <div><span>Результат</span><b>${fmtN(c.result)}</b></div>
        <div><span>Долг</span><b style="color:${c.debt > 0 ? "var(--warn)" : "var(--muted)"}">${c.debt > 0 ? fmtN(c.debt) : "нет"}</b></div>
      </div>
    </div>`;
  }).join("");
}

function toggleOrderDupsOnly(on) {
  showOrderDupsOnly = !!on;
  renderOrders();
}

function debtBadge(orderId, debt) {
  if (debt > 0) return `<button class="amt-link debt" onclick="openOrderDetails(${orderId}, 'payments')">${fmtN(debt)}</button>`;
  if (debt < 0) return `<span class="overpaid" title="Клиент заплатил больше цены заказа">переплата ${fmtN(-debt)}</span>`;
  return `<span class="paid-ok">оплачен</span>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---------- Новый / изменить заказ ----------

function openOrderForm(id) {
  if (!currentOrg) return alert("Сначала выберите организацию");
  const o = id ? (orders.find(x => x.id === id) || (openOrderData && openOrderData.order)) : null;
  editingOrderId = o ? o.id : null;
  document.getElementById("orderModalTitle").textContent = o ? "Изменить заказ" : `Новый заказ · ${currentOrg.name}`;
  document.getElementById("oDate").value = o ? o.ordered_on.slice(0, 10) : localDate(new Date());
  document.getElementById("oEntity").value = o ? (o.legal_entity || "") : "";
  document.getElementById("oCustomer").value = o ? o.customer : "";
  document.getElementById("oTitle").value = o ? o.title : "";
  document.getElementById("oPrice").value = o ? num(o.price) : "";
  document.getElementById("oComment").value = o ? (o.comment || "") : "";
  document.getElementById("saveOrderBtn").textContent = o ? "Сохранить изменения" : "Создать заказ";
  document.getElementById("deleteOrderBtn").style.display = o ? "block" : "none";
  document.getElementById("orderOverlay").style.display = "flex";
}

function closeOrderForm() {
  document.getElementById("orderOverlay").style.display = "none";
  editingOrderId = null;
}

function editOpenOrder() {
  if (openOrderId) openOrderForm(openOrderId);
}

async function submitOrderForm(e) {
  e.preventDefault();
  if (savingOrderForm) return;
  savingOrderForm = true;
  document.getElementById("saveOrderBtn").disabled = true;
  const payload = {
    ordered_on: document.getElementById("oDate").value,
    legal_entity: document.getElementById("oEntity").value.trim() || null,
    customer: document.getElementById("oCustomer").value.trim(),
    title: document.getElementById("oTitle").value.trim(),
    price: Number(document.getElementById("oPrice").value) || 0,
    comment: document.getElementById("oComment").value.trim() || null,
  };
  try {
    let saved;
    if (editingOrderId) {
      saved = await api(`/orgs/orders/${editingOrderId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      saved = await api(`/orgs/${currentOrg.id}/orders`, { method: "POST", body: JSON.stringify(payload) });
    }
    const wasNew = !editingOrderId;
    closeOrderForm();
    await Promise.all([loadOrders(true), loadOrderOptions()]);
    if (wasNew) openOrderDetails(saved.id, null);   // сразу можно внести оплаты и затраты
    else refreshOpenOrderDetails();
  } catch (err) {
    alert("Не удалось сохранить заказ: " + err.message);
  } finally {
    savingOrderForm = false;
    document.getElementById("saveOrderBtn").disabled = false;
  }
}

async function deleteOrder() {
  if (!editingOrderId) return;
  if (!confirm("Удалить заказ?\n\nЗатраты и оплаты «к оплате» удалятся вместе с ним. Уже проведённые операции останутся в кассе и банке, просто без привязки к заказу.")) return;
  try {
    await api(`/orgs/orders/${editingOrderId}`, { method: "DELETE" });
    if (openOrderId === editingOrderId) closeOrderDetails();
    closeOrderForm();
    await Promise.all([loadOrders(true), loadOrderOptions()]);
  } catch (err) {
    alert("Не удалось удалить: " + err.message);
  }
}

// ---------- Детали заказа: все платежи и затраты ----------

async function openOrderDetails(id, focus) {
  openOrderId = id;
  detailsFocus = focus || null;
  document.getElementById("detailsOverlay").style.display = "flex";
  document.getElementById("detailsItems").innerHTML = `<div class="loading" style="padding:30px 0;">Загрузка…</div>`;
  await refreshOpenOrderDetails();
}

function closeOrderDetails() {
  document.getElementById("detailsOverlay").style.display = "none";
  openOrderId = null;
  openOrderData = null;
}

async function refreshOpenOrderDetails() {
  if (!openOrderId) return;
  try {
    openOrderData = await api(`/orgs/orders/${openOrderId}/items`);
    renderOrderDetails();
  } catch (err) {
    document.getElementById("detailsItems").innerHTML = `<div class="error-state">${escapeHtml(err.message)}</div>`;
  }
}

const FOCUS_LABELS = {
  cash: "Оплаты наличными", bank: "Оплаты в банк", payments: "Оплаты клиента",
  costs: "Все затраты", materials: "Материалы", taxi: "Такси", designer: "Дизайнер", installer: "Монтажник", other: "Прочие затраты",
};

function focusMatch(t) {
  switch (detailsFocus) {
    case null: return true;
    case "cash": case "bank": return t.type === "income" && t.account === detailsFocus;
    case "payments": return t.type === "income";
    case "costs": return t.type === "expense";
    case "other": return t.type === "expense" && (!t.cost_type || t.cost_type === "other");
    default: return t.type === "expense" && t.cost_type === detailsFocus;
  }
}

function renderOrderDetails() {
  const { order, items } = openOrderData;
  const paid = items.filter(t => t.type === "income" && t.status === "paid").reduce((s, t) => s + num(t.amount), 0);
  const expected = items.filter(t => t.type === "income" && t.status === "planned").reduce((s, t) => s + num(t.amount), 0);
  const costs = items.filter(t => t.type === "expense").reduce((s, t) => s + num(t.amount), 0);
  const costsPlanned = items.filter(t => t.type === "expense" && t.status === "planned").reduce((s, t) => s + num(t.amount), 0);
  const debt = num(order.price) - paid;

  document.getElementById("detailsTitle").textContent = order.title;
  document.getElementById("detailsSub").textContent =
    [order.customer, order.legal_entity, dateRu(order.ordered_on)].filter(Boolean).join(" · ") + (order.comment ? ` · ${order.comment}` : "");

  document.getElementById("detailsSummary").innerHTML = `
    <div><span>Цена</span><b>${fmt(order.price)}</b></div>
    <div><span>Получено</span><b style="color:var(--income)">${fmt(paid)}</b>${expected ? `<i>ожидается ${fmtN(expected)}</i>` : ""}</div>
    <div><span>Затраты</span><b style="color:var(--expense)">${fmt(costs)}</b>${costsPlanned ? `<i>к оплате ${fmtN(costsPlanned)}</i>` : ""}</div>
    <div><span>Результат</span><b>${fmt(num(order.price) - costs)}</b></div>
    <div><span>Долг клиента</span><b style="color:${debt > 0 ? "var(--warn)" : "var(--muted)"}">${debt > 0 ? fmt(debt) : debt < 0 ? "переплата " + fmtN(-debt) : "нет"}</b></div>`;

  document.getElementById("detailsFocus").innerHTML = detailsFocus
    ? `Показано: <b>${FOCUS_LABELS[detailsFocus]}</b> <button onclick="detailsFocus=null;renderOrderDetails()">Показать всё по заказу ✕</button>`
    : "";

  itemDups = findDuplicateIds(items);
  const shown = items.filter(focusMatch);
  const incomes = shown.filter(t => t.type === "income");
  const expenses = shown.filter(t => t.type === "expense");
  const section = (title, list, emptyText) => `
    <div class="detail-section-title">${title}</div>
    ${list.length ? list.map(itemRow).join("") : `<div class="detail-empty">${emptyText}</div>`}`;

  const parts = [];
  if (!detailsFocus || incomes.length || ["cash", "bank", "payments"].includes(detailsFocus)) {
    parts.push(section("Оплаты клиента", incomes, "Оплат пока нет"));
  }
  if (!detailsFocus || expenses.length || !["cash", "bank", "payments"].includes(detailsFocus)) {
    parts.push(section("Затраты", expenses, "Затрат пока нет"));
  }
  document.getElementById("detailsItems").innerHTML = parts.join("");
}

function itemRow(t) {
  const canEdit = currentUser && (currentUser.is_admin || String(t.created_by) === String(currentUser.id));
  const planned = t.status === "planned";
  const title = t.type === "income"
    ? escapeHtml(t.description || t.source || "Оплата")
    : escapeHtml(t.description || costLabel(t.cost_type));
  return `<div class="item-row ${planned ? "planned" : ""}">
    <div class="item-main">
      <div class="item-title">${itemDups.has(t.id) ? `<span class="dup-mark" title="Похоже на повтор: такая же сумма, дата и описание">⚠</span> ` : ""}${title}</div>
      <div class="item-meta">
        <span>${dateRu(t.occurred_on)}</span>
        ${t.type === "expense" ? `<span class="badge">${costLabel(t.cost_type)}</span>` : ""}
        <span class="badge">${t.account === "bank" ? "🏦 Банк" : "💵 Касса"}</span>
        ${t.who_name ? `<span>${escapeHtml(t.who_name)}</span>` : ""}
      </div>
    </div>
    <span class="status ${planned ? "st-planned" : "st-paid"}">${planned ? (t.type === "income" ? "ожидается" : "к оплате") : "оплачено"}</span>
    <div class="item-amount" style="color:${t.type === "income" ? "var(--income)" : "var(--expense)"}">${t.type === "income" ? "+" : "−"}${fmtN(t.amount)}</div>
    <div class="item-actions">
      ${planned ? `<button class="pay-btn" onclick="payItem(${t.id})" title="Провести в ${t.account === "bank" ? "банк" : "кассу"} сегодняшним числом">✓ Оплачено</button>` : ""}
      ${canEdit ? `<button class="del-btn" onclick="openItemForm('${t.type}', ${t.id})">✎</button><button class="del-btn" onclick="deleteItem(${t.id})">🗑</button>` : ""}
    </div>
  </div>`;
}

async function payItem(id) {
  const t = openOrderData.items.find(x => x.id === id);
  if (!t) return;
  const where = t.account === "bank" ? "банк" : "кассу";
  if (!confirm(`Отметить как оплачено и провести ${fmt(t.amount)} в ${where} сегодняшним числом?`)) return;
  try {
    await api(`/orgs/transactions/${id}/pay`, { method: "POST", body: JSON.stringify({ account: t.account }) });
    await Promise.all([refreshOpenOrderDetails(), loadOrders(true)]);
  } catch (err) {
    alert(err.message);
  }
}

async function deleteItem(id) {
  if (!confirm("Удалить эту запись? Если она уже проведена, она исчезнет и из кассы/банка.")) return;
  try {
    await api(`/orgs/transactions/${id}`, { method: "DELETE" });
    await Promise.all([refreshOpenOrderDetails(), loadOrders(true)]);
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Новая / изменить оплату или затрату ----------

function openItemForm(type, id) {
  if (!openOrderData) return;
  const t = id ? openOrderData.items.find(x => x.id === id) : null;
  editingItemId = t ? t.id : null;
  itemKey = t ? null : newKey();

  document.getElementById("iCategory").innerHTML = `<option value="">— без категории —</option>` +
    categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  // по клику «+ Затрата» в деталях «Такси» — сразу ставим статью «Такси»
  const focusCost = COST_TYPES.find(c => c.key === detailsFocus);
  document.getElementById("iCostType").value = t ? (t.cost_type || "other") : (focusCost ? focusCost.key : "materials");
  document.getElementById("iAmount").value = t ? num(t.amount) : (type === "income" && !t ? Math.max(0, suggestDebt()) || "" : "");
  document.getElementById("iDate").value = t ? t.occurred_on.slice(0, 10) : localDate(new Date());
  document.getElementById("iAccount").value = t ? t.account : (detailsFocus === "bank" ? "bank" : "cash");
  document.getElementById("iDesc").value = t ? (t.type === "income" ? (t.description || "") : (t.description || "")) : "";
  setItemType(type, !!t);
  setItemStatus(t ? t.status : "paid");
  if (t && t.category_id) document.getElementById("iCategory").value = t.category_id;
  else syncItemCategory();

  document.getElementById("itemModalTitle").textContent =
    `${t ? "Изменить" : "Новая"} ${type === "income" ? "оплата" : "затрата"} · ${openOrderData.order.title}`;
  document.getElementById("itemOverlay").style.display = "flex";
}

function suggestDebt() {
  const { order, items } = openOrderData;
  const got = items.filter(t => t.type === "income").reduce((s, t) => s + num(t.amount), 0);
  return num(order.price) - got;
}

function closeItemForm() {
  document.getElementById("itemOverlay").style.display = "none";
  editingItemId = null;
}

function setItemType(type, locked) {
  itemType = type;
  document.getElementById("iBtnIncome").className = type === "income" ? "active-income" : "";
  document.getElementById("iBtnExpense").className = type === "expense" ? "active-expense" : "";
  document.getElementById("iBtnIncome").disabled = !!locked && type !== "income";
  document.getElementById("iBtnExpense").disabled = !!locked && type !== "expense";
  document.getElementById("iCostTypeField").style.display = type === "expense" ? "block" : "none";
  document.getElementById("iCategoryField").style.display = type === "expense" ? "block" : "none";
  document.getElementById("iDescLabel").textContent = type === "income" ? "Комментарий" : "Описание";
  document.getElementById("iDesc").placeholder = type === "income" ? "напр. предоплата 50%" : "напр. Нурали монтаж";
  if (type === "expense") syncItemCategory();
}

function setItemStatus(st) {
  itemStatus = st;
  document.getElementById("iStPaid").className = st === "paid" ? "active-income" : "";
  document.getElementById("iStPlanned").className = st === "planned" ? "active-warn" : "";
  document.getElementById("iDateLabel").textContent = st === "planned" ? "Срок оплаты" : "Дата оплаты";
}

// Подбираем категорию кассы по статье заказа (Материалы → «Материалы», Такси → «Такси» и т.д.)
function syncItemCategory() {
  const ct = COST_TYPES.find(c => c.key === document.getElementById("iCostType").value);
  if (!ct) return;
  for (const re of ct.cat) {
    const cat = categories.find(c => re.test(c.name));
    if (cat) { document.getElementById("iCategory").value = cat.id; return; }
  }
  document.getElementById("iCategory").value = "";
}

async function submitItemForm(e) {
  e.preventDefault();
  if (savingOrderForm) return;
  const amount = Number(document.getElementById("iAmount").value);
  if (!amount || amount <= 0) return alert("Укажите сумму");
  savingOrderForm = true;
  document.querySelector("#itemForm .save-btn").disabled = true;
  const order = openOrderData.order;
  const desc = document.getElementById("iDesc").value.trim();
  const payload = {
    type: itemType,
    amount,
    account: document.getElementById("iAccount").value,
    status: itemStatus,
    occurred_on: document.getElementById("iDate").value,
    order_id: order.id,
  };
  if (itemType === "income") {
    payload.source = order.customer;   // в кассе строка будет «Приход · <заказчик>»
    payload.description = desc || null;
  } else {
    payload.cost_type = document.getElementById("iCostType").value;
    payload.category_id = Number(document.getElementById("iCategory").value) || null;
    payload.description = desc || `${costLabel(payload.cost_type)} · ${order.title}`;
  }
  try {
    if (editingItemId) {
      const old = openOrderData.items.find(x => x.id === editingItemId);
      payload.occurred_at = old && old.occurred_at ? old.occurred_at.slice(0, 5) : null;
      payload.comment = old ? old.comment : null;
      await api(`/orgs/transactions/${editingItemId}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      payload.occurred_at = itemStatus === "paid" ? nowStr() : null;
      payload.client_key = itemKey;
      await api(`/orgs/${currentOrg.id}/transactions`, { method: "POST", body: JSON.stringify(payload) });
    }
    closeItemForm();
    await Promise.all([refreshOpenOrderDetails(), loadOrders(true)]);
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
  } finally {
    savingOrderForm = false;
    document.querySelector("#itemForm .save-btn").disabled = false;
  }
}

// ---------- Excel ----------

function exportOrdersToExcel() {
  if (!currentOrg) return;
  if (orders.length === 0) return alert("Нет заказов для выгрузки");
  const headers = ["Дата заказа", "ИП / ТОО", "Заказчик", "Заказ", "Цена заказа", "Получено наличными", "Получено в банк",
    "Материалы", "Такси", "Дизайнер", "Монтажник", "Прочие затраты", "Все затраты", "Из них к оплате", "Результат заказа", "Долг клиента"];
  const sorted = [...orders].sort((a, b) => a.ordered_on.localeCompare(b.ordered_on) || a.id - b.id);
  const rows = sorted.map(o => {
    const c = orderCalc(o);
    return [dateRu(o.ordered_on), o.legal_entity || "", o.customer, o.title, num(o.price), num(o.paid_cash), num(o.paid_bank),
      num(o.cost_materials), num(o.cost_taxi), num(o.cost_designer), num(o.cost_installer), num(o.cost_other),
      c.costs, num(o.costs_planned), c.result, c.debt];
  });
  const totals = ["", "", "", "Всего"];
  for (let i = 4; i < headers.length; i++) totals.push(rows.reduce((s, r) => s + r[i], 0));

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows, [], totals]);
  ws["!cols"] = [{ wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 22 }, ...Array(12).fill({ wch: 13 })];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Заказы");
  const [from, to] = periodRange();
  const suffix = from || to ? `${from || "…"}_${to || "…"}` : localDate(new Date());
  XLSX.writeFile(wb, `${currentOrg.name}-Заказы-${suffix}.xlsx`);
}
