// Касса — вкладка «Отчёт»: сколько наличными (касса) и сколько по безналу (банк).
// Данные считает сервер (/api/report). Период — общий фильтр над вкладками.
// Переводы касса↔банк не считаются ни приходом, ни расходом — показываются отдельно.
// Общие функции (api, fmt, fmtN, periodRange, dateRu, escapeHtml, currentOrg…) — из app.js и orders.js.

let reportScope = "org";   // org | all
let reportData = null;

function setReportScope(s) {
  reportScope = s;
  loadReport();
}

async function loadReport(silent) {
  if (!currentOrg || !isPartner()) return;
  document.querySelectorAll("#reportScope button").forEach(b => b.classList.toggle("active", b.dataset.s === reportScope));
  const [from, to] = periodRange();
  const qs = new URLSearchParams({ org: reportScope === "all" ? "all" : currentOrg.id });
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const loading = document.getElementById("reportLoading");
  const errEl = document.getElementById("reportError");
  if (!silent) loading.style.display = "block";
  errEl.style.display = "none";
  const seq = ++loadReport.seq;   // если пока ждали, запросили другой период — этот ответ устарел
  try {
    const data = await api(`/report?${qs}`);
    if (seq !== loadReport.seq) return;
    reportData = data;
    renderReport();
  } catch (err) {
    errEl.textContent = "Не удалось построить отчёт: " + err.message;
    errEl.style.display = "block";
  }
  loading.style.display = "none";
}

// Суммирует итоги по счёту (по одной организации или по всем)
function sumTotals(rows, account) {
  const keys = ["opening", "income", "expense", "transfer_in", "transfer_out", "closing", "ops"];
  const r = Object.fromEntries(keys.map(k => [k, 0]));
  rows.filter(t => t.account === account).forEach(t => keys.forEach(k => r[k] += Number(t[k])));
  return r;
}

const sgn = v => v > 0 ? "+" + fmtN(v) : v < 0 ? "−" + fmtN(-v) : "—";
const pct = (part, total) => total > 0 ? Math.round(part / total * 100) : 0;

function splitBar(cash, bank) {
  const total = cash + bank;
  if (!total) return `<div class="split-bar empty"></div>`;
  const c = cash / total * 100;
  return `<div class="split-bar" title="Наличные ${pct(cash, total)}% · Безнал ${pct(bank, total)}%">
    <span class="sb-cash" style="width:${c}%"></span><span class="sb-bank" style="width:${100 - c}%"></span></div>`;
}

function periodLabel() {
  const [from, to] = periodRange();
  if (!from && !to) return "за всё время";
  if (from && to) return `с ${dateRu(from)} по ${dateRu(to)}`;
  return from ? `с ${dateRu(from)}` : `по ${dateRu(to)}`;
}

function renderReport() {
  const d = reportData;
  const cash = sumTotals(d.totals, "cash");
  const bank = sumTotals(d.totals, "bank");
  const incomeAll = cash.income + bank.income;
  const expenseAll = cash.expense + bank.expense;
  const scopeName = d.all ? "все организации" : escapeHtml(currentOrg.name);
  const transfersCB = bank.transfer_in;   // касса → банк
  const transfersBC = cash.transfer_in;   // банк → касса

  const card = (icon, title, t, cls) => `
    <div class="rep-card ${cls}">
      <div class="rep-card-title">${icon} ${title}</div>
      <div class="rep-line"><span>Приход</span><b style="color:var(--income)">${fmt(t.income)}</b></div>
      <div class="rep-line"><span>Расход</span><b style="color:var(--expense)">${fmt(t.expense)}</b></div>
      <div class="rep-line rep-total"><span>Остаток на конец</span><b>${fmt(t.closing)}</b></div>
    </div>`;

  // Подсказка: приход наличными с текстом «снял/снятие» — скорее всего это деньги со своего счёта
  const withdrawals = d.sources.filter(s => /снял|снят|с каспи|с банка|со счёта|со счета/i.test(s.source) && Number(s.cash) > 0);
  const wSum = withdrawals.reduce((s, x) => s + Number(x.cash), 0);

  let html = `
    <div class="rep-head">Отчёт: <b>${scopeName}</b>, ${periodLabel()} · операций: ${cash.ops + bank.ops}</div>

    <div class="rep-cards">
      ${card("💵", "Наличные (касса)", cash, "rc-cash")}
      ${card("🏦", "Безнал (банк)", bank, "rc-bank")}
      ${card("Σ", "Всего", { income: incomeAll, expense: expenseAll, closing: cash.closing + bank.closing }, "rc-all")}
    </div>

    <div class="rep-shares">
      <div><span>Приход: наличными ${pct(cash.income, incomeAll)}% · безнал ${pct(bank.income, incomeAll)}%</span>${splitBar(cash.income, bank.income)}</div>
      <div><span>Расход: наличными ${pct(cash.expense, expenseAll)}% · безнал ${pct(bank.expense, expenseAll)}%</span>${splitBar(cash.expense, bank.expense)}</div>
    </div>

    ${wSum ? `<div class="rep-hint">💡 В приходе наличными ${fmt(wSum)} — похоже, это деньги, снятые со своего счёта
      (${withdrawals.map(w => "«" + escapeHtml(w.source) + "»").join(", ")}). Это не выручка, а перемещение денег: такие суммы лучше вносить
      как «↔ Перевод» (банк → касса). Тогда они не будут раздувать приход наличными и расход по безналу.</div>` : ""}

    <div class="rep-section">Движение денег</div>
    <div class="rep-table-wrap"><table class="rep-table">
      <thead><tr><th></th><th class="num">💵 Наличные</th><th class="num">🏦 Безнал</th><th class="num">Всего</th></tr></thead>
      <tbody>
        <tr class="muted-row"><td>Остаток на начало</td><td class="num">${fmtN(cash.opening)}</td><td class="num">${fmtN(bank.opening)}</td><td class="num">${fmtN(cash.opening + bank.opening)}</td></tr>
        <tr><td>Приход</td><td class="num inc">+${fmtN(cash.income)}</td><td class="num inc">+${fmtN(bank.income)}</td><td class="num inc">+${fmtN(incomeAll)}</td></tr>
        <tr><td>Расход</td><td class="num exp">−${fmtN(cash.expense)}</td><td class="num exp">−${fmtN(bank.expense)}</td><td class="num exp">−${fmtN(expenseAll)}</td></tr>
        ${transfersCB || transfersBC ? `
        <tr><td>↔ Переводы касса → банк</td><td class="num">${sgn(-transfersCB)}</td><td class="num">${sgn(transfersCB)}</td><td class="num muted">—</td></tr>
        <tr><td>↔ Переводы банк → касса</td><td class="num">${sgn(transfersBC)}</td><td class="num">${sgn(-transfersBC)}</td><td class="num muted">—</td></tr>` : ""}
        <tr class="total-row"><td>Остаток на конец</td><td class="num">${fmtN(cash.closing)}</td><td class="num">${fmtN(bank.closing)}</td><td class="num">${fmtN(cash.closing + bank.closing)}</td></tr>
      </tbody>
    </table></div>`;

  if (d.all) {
    const orgs = [...new Map(d.totals.map(t => [t.org_id, t.org_name])).entries()];
    html += `
      <div class="rep-section">По организациям</div>
      <div class="rep-table-wrap"><table class="rep-table">
        <thead>
          <tr class="group-row"><th></th><th colspan="3" class="grp">💵 Наличные</th><th colspan="3" class="grp">🏦 Безнал</th><th></th></tr>
          <tr><th>Организация</th><th class="num">Приход</th><th class="num">Расход</th><th class="num">Остаток</th><th class="num">Приход</th><th class="num">Расход</th><th class="num">Остаток</th><th class="num">Всего остаток</th></tr>
        </thead>
        <tbody>${orgs.map(([id, name]) => {
          const c = sumTotals(d.totals.filter(t => t.org_id === id), "cash");
          const b = sumTotals(d.totals.filter(t => t.org_id === id), "bank");
          return `<tr><td><b>${escapeHtml(name)}</b></td>
            <td class="num inc">${fmtN(c.income)}</td><td class="num exp">${fmtN(c.expense)}</td><td class="num">${fmtN(c.closing)}</td>
            <td class="num inc">${fmtN(b.income)}</td><td class="num exp">${fmtN(b.expense)}</td><td class="num">${fmtN(b.closing)}</td>
            <td class="num"><b>${fmtN(c.closing + b.closing)}</b></td></tr>`;
        }).join("")}</tbody>
      </table></div>`;
  }

  const catRows = d.categories.map(c => ({ name: c.category, color: c.color, cash: Number(c.cash), bank: Number(c.bank), ops: Number(c.ops) }));
  html += `
    <div class="rep-section">Расходы по категориям</div>
    ${catRows.length ? `<div class="rep-table-wrap"><table class="rep-table">
      <thead><tr><th>Категория</th><th class="num">💵 Наличные</th><th class="num">🏦 Безнал</th><th class="num">Всего</th><th class="num">Доля</th><th class="bar-col">Нал / безнал</th></tr></thead>
      <tbody>${catRows.map(c => `<tr>
        <td><span class="cat-dot" style="background:${c.color || "var(--muted)"}"></span>${escapeHtml(c.name)} <span class="muted small">· ${c.ops}</span></td>
        <td class="num">${c.cash ? fmtN(c.cash) : "—"}</td><td class="num">${c.bank ? fmtN(c.bank) : "—"}</td>
        <td class="num"><b>${fmtN(c.cash + c.bank)}</b></td><td class="num muted">${pct(c.cash + c.bank, expenseAll)}%</td>
        <td class="bar-col">${splitBar(c.cash, c.bank)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Всего расходов</td><td class="num">${fmtN(cash.expense)}</td><td class="num">${fmtN(bank.expense)}</td><td class="num">${fmtN(expenseAll)}</td><td class="num">100%</td><td></td></tr></tfoot>
    </table></div>` : `<div class="detail-empty">Расходов за этот период нет</div>`}`;

  const srcRows = d.sources.map(s => ({ name: s.source, cash: Number(s.cash), bank: Number(s.bank), ops: Number(s.ops) }));
  html += `
    <div class="rep-section">Приходы по источникам</div>
    ${srcRows.length ? `<div class="rep-table-wrap"><table class="rep-table">
      <thead><tr><th>Источник</th><th class="num">💵 Наличные</th><th class="num">🏦 Безнал</th><th class="num">Всего</th><th class="bar-col">Нал / безнал</th></tr></thead>
      <tbody>${srcRows.map(s => `<tr>
        <td>${escapeHtml(s.name)} <span class="muted small">· ${s.ops}</span></td>
        <td class="num">${s.cash ? fmtN(s.cash) : "—"}</td><td class="num">${s.bank ? fmtN(s.bank) : "—"}</td>
        <td class="num"><b>${fmtN(s.cash + s.bank)}</b></td><td class="bar-col">${splitBar(s.cash, s.bank)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td>Всего приходов</td><td class="num">${fmtN(cash.income)}</td><td class="num">${fmtN(bank.income)}</td><td class="num">${fmtN(incomeAll)}</td><td></td></tr></tfoot>
    </table></div>` : `<div class="detail-empty">Приходов за этот период нет</div>`}

    <div class="rep-note">В отчёт входят только проведённые операции. Затраты «к оплате» из заказов не учитываются, пока их не оплатят.
      Переводы между кассой и банком не считаются ни приходом, ни расходом.</div>`;

  document.getElementById("reportBody").innerHTML = html;
}

loadReport.seq = 0;

function exportReportToExcel() {
  if (!reportData) return;
  const d = reportData;
  const cash = sumTotals(d.totals, "cash");
  const bank = sumTotals(d.totals, "bank");
  const wb = XLSX.utils.book_new();
  const scope = d.all ? "Все организации" : currentOrg.name;

  const s1 = [
    [`Отчёт наличные / безнал — ${scope}, ${periodLabel()}`], [],
    ["", "Наличные (касса)", "Безнал (банк)", "Всего"],
    ["Остаток на начало", cash.opening, bank.opening, cash.opening + bank.opening],
    ["Приход", cash.income, bank.income, cash.income + bank.income],
    ["Расход", cash.expense, bank.expense, cash.expense + bank.expense],
    ["Переводы касса → банк", -bank.transfer_in, bank.transfer_in, 0],
    ["Переводы банк → касса", cash.transfer_in, -cash.transfer_in, 0],
    ["Остаток на конец", cash.closing, bank.closing, cash.closing + bank.closing],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(s1);
  ws1["!cols"] = [{ wch: 26 }, { wch: 18 }, { wch: 18 }, { wch: 18 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Итог");

  if (d.all) {
    const orgs = [...new Map(d.totals.map(t => [t.org_id, t.org_name])).entries()];
    const rows = [["Организация", "Нал: приход", "Нал: расход", "Нал: остаток", "Безнал: приход", "Безнал: расход", "Безнал: остаток", "Всего остаток"]];
    orgs.forEach(([id, name]) => {
      const c = sumTotals(d.totals.filter(t => t.org_id === id), "cash");
      const b = sumTotals(d.totals.filter(t => t.org_id === id), "bank");
      rows.push([name, c.income, c.expense, c.closing, b.income, b.expense, b.closing, c.closing + b.closing]);
    });
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 18 }, ...Array(7).fill({ wch: 15 })];
    XLSX.utils.book_append_sheet(wb, ws, "Организации");
  }

  const cats = [["Категория", "Наличные", "Безнал", "Всего", "Операций"],
    ...d.categories.map(c => [c.category, Number(c.cash), Number(c.bank), Number(c.cash) + Number(c.bank), Number(c.ops)]),
    ["Всего расходов", cash.expense, bank.expense, cash.expense + bank.expense, ""]];
  const ws2 = XLSX.utils.aoa_to_sheet(cats);
  ws2["!cols"] = [{ wch: 24 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Расходы по категориям");

  const src = [["Источник", "Наличные", "Безнал", "Всего", "Операций"],
    ...d.sources.map(s => [s.source, Number(s.cash), Number(s.bank), Number(s.cash) + Number(s.bank), Number(s.ops)]),
    ["Всего приходов", cash.income, bank.income, cash.income + bank.income, ""]];
  const ws3 = XLSX.utils.aoa_to_sheet(src);
  ws3["!cols"] = [{ wch: 28 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, ws3, "Приходы по источникам");

  const [from, to] = periodRange();
  XLSX.writeFile(wb, `Отчёт-нал-безнал-${scope}-${from || "начало"}_${to || localDate(new Date())}.xlsx`);
}
