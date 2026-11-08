// Касса — «Сверка с выпиской»: загружаем Excel-выписку банка (проверено на Kaspi Business)
// и сравниваем с операциями вкладки «Банк». Показываем:
//   • остатки по выписке и в программе на каждый день и итоговую разницу;
//   • что есть в выписке, но не внесено в программу (можно внести одной кнопкой);
//   • что внесено в программу, но в выписке нет (проверить / исправить / удалить);
//   • что совпало — в т.ч. когда одна запись в программе = несколько операций в банке.
// Всё считается в браузере; выписка никуда не сохраняется.

// ============================== Движок (без DOM) ==============================

const RECON = (() => {
  const pad = n => String(n).padStart(2, "0");
  const toCents = v => Math.round(Number(v) * 100);
  const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dayDiff = (a, b) => Math.round((new Date(a + "T00:00:00Z") - new Date(b + "T00:00:00Z")) / 86400000);

  function parseNumber(v) {
    if (v === null || v === undefined || v === "") return 0;
    if (typeof v === "number") return v;
    const s = String(v).replace(/[\s ₸]/g, "").replace(/[−–]/g, "-").replace(",", ".");
    const n = Number(s);
    return isFinite(n) ? n : 0;
  }

  // «05.11.2026 18:02:15» / Date / серийный номер Excel → { date: 'YYYY-MM-DD', time: 'HH:MM' }
  function parseDateTime(v) {
    if (v instanceof Date && !isNaN(v)) {
      return { date: `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`, time: `${pad(v.getHours())}:${pad(v.getMinutes())}` };
    }
    if (typeof v === "number" && v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return { date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`, time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` };
    }
    const m = String(v || "").trim().match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) return { date: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, time: m[4] ? `${pad(m[4])}:${m[5]}` : "" };
    const m2 = String(v || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
    if (m2) return { date: `${m2[1]}-${m2[2]}-${m2[3]}`, time: m2[4] ? `${m2[4]}:${m2[5]}` : "" };
    return null;
  }

  // rows — массив строк листа (XLSX.utils.sheet_to_json(ws, { header: 1 }))
  function parseStatement(rows) {
    const meta = { account: "", holder: "", period: "", opening: null, closing: null, lastMove: "" };
    const cellAfter = (row, from) => { for (let j = from + 1; j < row.length; j++) if (row[j] !== "" && row[j] != null) return row[j]; return ""; };
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 60); i++) {
      const row = rows[i] || [];
      for (let j = 0; j < row.length; j++) {
        const c = String(row[j] ?? "").trim();
        if (/^Текущий сч[её]т/i.test(c) || /^Номер сч[её]та/i.test(c) || /^IBAN/i.test(c)) meta.account = String(cellAfter(row, j)).trim();
        else if (/^Наименование\s*:/i.test(c) || /^Владелец/i.test(c)) meta.holder = String(cellAfter(row, j)).trim();
        else if (/^Период/i.test(c)) meta.period = String(cellAfter(row, j)).trim();
        else if (/^Входящий остаток/i.test(c)) meta.opening = parseNumber(cellAfter(row, j));
        else if (/^Исходящий остаток/i.test(c)) meta.closing = parseNumber(cellAfter(row, j));
        else if (/^Дата последнего движения/i.test(c)) meta.lastMove = String(cellAfter(row, j)).trim();
      }
      if (headerIdx < 0 && row.some(c => /Дата\s*операции|^Дата$/i.test(String(c ?? "").trim())) &&
          row.some(c => /Дебет|Списание|Расход/i.test(String(c ?? ""))) && row.some(c => /Кредит|Зачисление|Приход/i.test(String(c ?? "")))) {
        headerIdx = i;
      }
    }
    if (headerIdx < 0) throw new Error("Не нашёл таблицу операций: нужна строка заголовков с колонками «Дата операции», «Дебет», «Кредит».");
    const h = rows[headerIdx].map(c => String(c ?? "").replace(/\s+/g, " ").trim());
    const col = re => h.findIndex(c => re.test(c));
    const cDate = col(/Дата\s*операции|^Дата$/i), cDeb = col(/Дебет|Списание|Расход/i), cCred = col(/Кредит|Зачисление|Приход/i);
    const cName = col(/Наименование|Контрагент|Получатель|Отправитель/i), cPurp = col(/Назначение/i), cDoc = col(/№|Номер документа/i), cKnp = col(/КНП/i);

    const ops = [];
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      const dt = parseDateTime(row[cDate]);
      if (!dt) continue;                         // пропускаем строку «1 2 3 4…», итоги и подписи
      const deb = parseNumber(row[cDeb]), cred = parseNumber(row[cCred]);
      if (!deb && !cred) continue;
      ops.push({
        key: `s${i}`, row: i + 1, date: dt.date, time: dt.time,
        type: deb ? "expense" : "income", cents: toCents(deb || cred),
        name: String(row[cName] ?? "").split("\n")[0].trim(),
        purpose: String(row[cPurp] ?? "").replace(/\s+/g, " ").trim(),
        doc: String(row[cDoc] ?? "").trim(), knp: String(row[cKnp] ?? "").trim(),
      });
    }
    if (!ops.length) throw new Error("В выписке не найдено ни одной операции.");
    if (meta.opening === null) throw new Error("В выписке нет строки «Входящий остаток» — без неё нельзя сверить остатки.");
    ops.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    const pm = meta.period.match(/(\d{2}\.\d{2}\.\d{4})\s*[-–—]\s*(\d{2}\.\d{2}\.\d{4})/);
    meta.from = pm ? parseDateTime(pm[1]).date : ops[0].date;
    meta.to = pm ? parseDateTime(pm[2]).date : ops[ops.length - 1].date;
    return { meta, ops };
  }

  // Поиск подмножества сумм (несколько операций = одна запись). Ограничено, чтобы не зависнуть.
  function findSubset(cands, target, maxSize = 12, limit = 60000) {
    const items = cands.filter(c => c.cents <= target).sort((a, b) => b.cents - a.cents);
    if (items.length < 2) return null;
    const suffix = []; let acc = 0;
    for (let i = items.length - 1; i >= 0; i--) { acc += items[i].cents; suffix[i] = acc; }
    if (suffix[0] < target) return null;
    let steps = 0; const pick = [];
    const dfs = (i, rest) => {
      if (rest === 0) return pick.length >= 2;
      if (i >= items.length || pick.length >= maxSize || suffix[i] < rest || ++steps > limit) return false;
      if (items[i].cents <= rest) {
        pick.push(items[i]);
        if (dfs(i + 1, rest - items[i].cents)) return true;
        pick.pop();
      }
      return dfs(i + 1, rest);
    };
    return dfs(0, target) ? [...pick] : null;
  }

  // stmt — из parseStatement; prog — операции банка из программы: { id, date, type, cents, text, ... }
  function reconcile(stmt, progAll, opts = {}) {
    const firstProg = progAll.length ? progAll.reduce((m, p) => p.date < m ? p.date : m, progAll[0].date) : stmt.meta.from;
    const start = opts.start || (firstProg > stmt.meta.from ? firstProg : stmt.meta.from);
    const end = opts.end || stmt.meta.to;
    const signed = o => (o.type === "income" ? 1 : -1) * o.cents;

    const stmtOpening = toCents(stmt.meta.opening) + stmt.ops.filter(o => o.date < start).reduce((s, o) => s + signed(o), 0);
    const progOpening = progAll.filter(p => p.date < start).reduce((s, p) => s + signed(p), 0);
    const S = stmt.ops.filter(o => o.date >= start && o.date <= end).map(o => ({ ...o, used: false }));
    const P = progAll.filter(p => p.date >= start && p.date <= end).map(p => ({ ...p, used: false }));
    const matches = [];

    // 1) Один к одному: та же сумма и тип, сначала тот же день, потом ±1…±3 дня (сдвиг показываем как «проверьте»)
    for (let d = 0; d <= 3; d++) {
      for (const p of P) {
        if (p.used) continue;
        const s = S.find(s => !s.used && s.type === p.type && s.cents === p.cents && Math.abs(dayDiff(s.date, p.date)) === d);
        if (s) { s.used = p.used = true; matches.push({ kind: "exact", prog: [p], stmt: [s], shift: dayDiff(p.date, s.date) }); }
      }
    }
    // 1б) «Комиссии банка за ММ.ГГГГ (N шт.)» — запись, которую сверка сама вносит одной строкой за месяц
    for (const p of P) {
      if (p.used || p.type !== "expense") continue;
      const m = String(p.text || "").match(/^Комиссии банка за (\d{2})\.(\d{4})/);
      if (!m) continue;
      const month = `${m[2]}-${m[1]}`;
      const cands = S.filter(s => !s.used && s.type === "expense" && s.date.slice(0, 7) === month && classify(s).kind === "fee");
      const total = cands.reduce((a, s) => a + s.cents, 0);
      const sub = total === p.cents ? cands : findSubset(cands, p.cents, 60, 200000);
      if (sub) { sub.forEach(s => s.used = true); p.used = true; matches.push({ kind: "group", prog: [p], stmt: sub }); }
    }

    // 2) Одна запись в программе = несколько операций в банке (в тот же день или ±1)
    for (const win of [0, 1]) {
      for (const p of [...P].sort((a, b) => b.cents - a.cents)) {
        if (p.used) continue;
        const cands = S.filter(s => !s.used && s.type === p.type && Math.abs(dayDiff(s.date, p.date)) <= win);
        if (cands.length > 26) continue;
        const sub = findSubset(cands, p.cents);
        if (sub) { sub.forEach(s => s.used = true); p.used = true; matches.push({ kind: "group", prog: [p], stmt: sub }); }
      }
    }
    // 3) Одна операция в банке = несколько записей в программе
    for (const win of [0, 1]) {
      for (const s of [...S].sort((a, b) => b.cents - a.cents)) {
        if (s.used) continue;
        const cands = P.filter(p => !p.used && p.type === s.type && Math.abs(dayDiff(p.date, s.date)) <= win);
        if (cands.length > 26) continue;
        const sub = findSubset(cands, s.cents);
        if (sub) { sub.forEach(p => p.used = true); s.used = true; matches.push({ kind: "group", prog: sub, stmt: [s] }); }
      }
    }

    const missingInProg = S.filter(s => !s.used);
    const missingInBank = P.filter(p => !p.used);

    // Остатки по дням
    const days = [...new Set([...S.map(s => s.date), ...P.map(p => p.date)])].sort();
    let sb = stmtOpening, pb = progOpening, prevDiff = pb - sb;
    const daily = days.map(date => {
      const sd = S.filter(s => s.date === date), pd = P.filter(p => p.date === date);
      const sIn = sd.filter(o => o.type === "income").reduce((a, o) => a + o.cents, 0);
      const sOut = sd.filter(o => o.type === "expense").reduce((a, o) => a + o.cents, 0);
      const pIn = pd.filter(o => o.type === "income").reduce((a, o) => a + o.cents, 0);
      const pOut = pd.filter(o => o.type === "expense").reduce((a, o) => a + o.cents, 0);
      sb += sIn - sOut; pb += pIn - pOut;
      const diff = pb - sb, change = diff - prevDiff; prevDiff = diff;
      return { date, sIn, sOut, pIn, pOut, sBal: sb, pBal: pb, diff, change };
    });

    const sumSigned = list => list.reduce((a, o) => a + signed(o), 0);
    return {
      start, end, stmtOpening, progOpening,
      stmtClosing: sb, progClosing: pb,
      diffStart: progOpening - stmtOpening,
      diffEnd: pb - sb,
      missingInProg, missingInBank, matches, daily,
      missingInProgSum: sumSigned(missingInProg),   // + означает «в банк пришло, а в программе нет»
      missingInBankSum: sumSigned(missingInBank),
      closingCheck: stmt.meta.closing !== null && stmt.meta.to <= end ? toCents(stmt.meta.closing) - sb : 0,
    };
  }

  // Подсказка, как внести операцию из выписки
  function classify(o) {
    const t = `${o.purpose} ${o.name}`;
    if (/процессинг|комисси|абонентск/i.test(t)) return { kind: "fee", category: "Комиссии банка", label: "Комиссия банка" };
    if (/пенсион|социальн|медицинск|налог|ОСМС|ОПВ|взнос/i.test(t)) return { kind: "tax", category: "Налоги и взносы", label: "Налоги и взносы" };
    if (/снятия наличных|снятие наличных|банкомат/i.test(t)) return { kind: "atm", category: "Перевод на карту", label: "Снятие наличных" };
    if (/перевод собственных средств|на карту|kaspi gold/i.test(t)) return { kind: "card", category: "Перевод на карту", label: "Перевод на карту" };
    if (/продажи с kaspi/i.test(t)) return { kind: "sales", category: null, label: "Продажи Kaspi" };
    return { kind: "other", category: null, label: "" };
  }

  return { parseStatement, reconcile, classify, toCents, dayDiff, addDays, parseDateTime };
})();

if (typeof module !== "undefined") module.exports = RECON;

// ============================== Интерфейс ==============================
// Используются глобальные: api, fmt, fmtN, escapeHtml, dateRu, transactions, categories,
// currentOrg, currentAccount, isPartner, editTx, removeTx, loadTransactions, showToast, newKey

let reconStmt = null;        // разобранная выписка
let reconRes = null;         // результат сверки
let reconTab = "missingProg";
let reconChoice = {};        // key → { checked, action, category, desc }
let reconRange = { start: null, end: null };
let reconBusy = false;

const rcF = c => (c < 0 ? "−" : "") + new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(c) / 100) + " ₸";
const rcN = c => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(c / 100);
const rcSigned = (type, c) => `<span style="color:${type === "income" ? "var(--income)" : "var(--expense)"}">${type === "income" ? "+" : "−"}${rcN(c)}</span>`;

function updateReconButton() {
  const b = document.getElementById("reconBtn");
  if (b) b.style.display = currentAccount === "bank" && isPartner() ? "" : "none";
}

function openRecon() {
  if (currentAccount !== "bank") return;
  document.getElementById("reconOverlay").style.display = "flex";
  document.getElementById("reconTitle").textContent = `Сверка с выпиской · Банк · ${currentOrg.name}`;
  if (!reconStmt) renderReconUpload();
  else runRecon();
}

function closeRecon() {
  document.getElementById("reconOverlay").style.display = "none";
}

// после любой правки операций (✎, 🗑, импорт, обновление от других) — пересчитать, если окно открыто
function reconOnTransactionsChanged() {
  if (reconStmt && currentAccount === "bank" && document.getElementById("reconOverlay").style.display === "flex") runRecon();
}

function resetReconFile() {
  reconStmt = null; reconRes = null; reconChoice = {}; reconRange = { start: null, end: null };
  renderReconUpload();
}

function renderReconUpload(error) {
  document.getElementById("reconBody").innerHTML = `
    <div class="recon-upload" id="reconDrop">
      <div class="recon-upload-icon">📄</div>
      <div class="recon-upload-title">Загрузите выписку банка в Excel</div>
      <div class="recon-upload-sub">Kaspi Business: «Выписка по счёту» → период → скачать в Excel (.xlsx).<br>
        Программа сравнит её с вкладкой «Банк» организации <b>${escapeHtml(currentOrg.name)}</b> и покажет, что не сходится.
        Выписка никуда не сохраняется.</div>
      <button class="save-btn" style="max-width:260px;margin:14px auto 0;" onclick="document.getElementById('reconFile').click()">Выбрать файл выписки</button>
      ${error ? `<div class="error-state" style="margin-top:14px;">${escapeHtml(error)}</div>` : ""}
    </div>`;
  const drop = document.getElementById("reconDrop");
  drop.ondragover = e => { e.preventDefault(); drop.classList.add("drag"); };
  drop.ondragleave = () => drop.classList.remove("drag");
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove("drag"); if (e.dataTransfer.files[0]) readReconFile(e.dataTransfer.files[0]); };
}

function handleReconFile(event) {
  const f = event.target.files[0];
  event.target.value = "";
  if (f) readReconFile(f);
}

async function readReconFile(file) {
  try {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    let parsed = null, lastErr = null;
    for (const name of wb.SheetNames) {
      try { parsed = RECON.parseStatement(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true })); break; }
      catch (e) { lastErr = e; }
    }
    if (!parsed) throw lastErr || new Error("Не удалось прочитать выписку");
    reconStmt = parsed; reconChoice = {}; reconRange = { start: null, end: null }; reconTab = "missingProg";
    runRecon();
  } catch (err) {
    renderReconUpload(err.message);
  }
}

function progOpsForRecon() {
  return transactions.filter(t => t.account === "bank" && t.status !== "planned").map(t => ({
    id: t.id, date: t.occurred_on.slice(0, 10), type: t.type, cents: RECON.toCents(t.amount),
    text: t.transfer_id ? (t.source || t.description || "Перевод") : (t.type === "income" ? (t.source || "") : (t.description || t.category_name || "")),
    who: t.who_name || "", t,
  }));
}

function runRecon() {
  reconRes = RECON.reconcile(reconStmt, progOpsForRecon(), { start: reconRange.start, end: reconRange.end });
  reconRange = { start: reconRes.start, end: reconRes.end };
  for (const s of reconRes.missingInProg) if (!reconChoice[s.key]) reconChoice[s.key] = defaultChoice(s);
  renderRecon();
}

function defaultChoice(s) {
  const c = RECON.classify(s);
  let desc = s.purpose;
  if (c.kind === "sales") desc = "";
  if (desc.length > 90) desc = desc.slice(0, 88) + "…";
  return {
    checked: c.kind === "fee" || c.kind === "tax",     // комиссии и налоги почти всегда просто не внесли
    action: s.type,                                    // income | expense | transfer
    category: c.category || "",
    desc,
    source: s.type === "income" ? (c.kind === "sales" ? "Продажи Kaspi" : s.name) : "",
    kind: c.kind, label: c.label,
  };
}

function setReconRange() {
  const st = document.getElementById("rcStart").value, en = document.getElementById("rcEnd").value;
  reconRange = { start: st || null, end: en || null };
  runRecon();
}

function setReconTab(t) { reconTab = t; renderRecon(); }

function renderRecon() {
  const r = reconRes, m = reconStmt.meta;
  const ok = r.diffEnd === 0;
  const holderWarn = m.holder && currentOrg && !m.holder.toLowerCase().includes(currentOrg.name.toLowerCase());
  const shifted = r.matches.filter(x => x.kind === "exact" && x.shift);
  const groups = r.matches.filter(x => x.kind === "group");
  const exact = r.matches.filter(x => x.kind === "exact" && !x.shift);
  const lastMoveNote = m.lastMove && r.end === m.to ? ` (последнее движение в выписке: ${escapeHtml(m.lastMove)})` : "";

  const tabs = [
    ["missingProg", `Нет в программе`, r.missingInProg.length, "warn"],
    ["missingBank", `Нет в выписке`, r.missingInBank.length, "warn"],
    ["matched", `Совпало`, r.matches.length, shifted.length ? "soft" : ""],
    ["daily", `По дням`, null, ""],
  ];

  document.getElementById("reconBody").innerHTML = `
    <div class="rc-file">
      <div><b>${escapeHtml(m.holder || "Выписка")}</b> · ${escapeHtml(m.account || "")}<br>
        <span class="muted small">Период выписки: ${dateRu(m.from)} – ${dateRu(m.to)} · операций: ${reconStmt.ops.length} ·
        входящий остаток ${fmt(m.opening)}${m.closing !== null ? ` · исходящий ${fmt(m.closing)}` : ""}</span></div>
      <button class="pill-btn" onclick="resetReconFile()">Другая выписка</button>
    </div>
    ${holderWarn ? `<div class="rep-hint">⚠ Выписка на «${escapeHtml(m.holder)}», а открыта организация «${escapeHtml(currentOrg.name)}». Убедитесь, что это её счёт.</div>` : ""}

    <div class="rc-range">Сверяю с <input type="date" id="rcStart" value="${r.start}" min="${m.from}" max="${m.to}" onchange="setReconRange()">
      по <input type="date" id="rcEnd" value="${r.end}" min="${m.from}" max="${m.to}" onchange="setReconRange()">
      <span class="muted small">${r.start > m.from ? "— с первой банковской операции в программе" : ""}</span></div>

    <div class="rc-cards">
      <div class="rc-card"><span>Остаток по выписке на ${dateRu(r.end)}</span><b>${rcF(r.stmtClosing)}</b></div>
      <div class="rc-card"><span>В программе на ${dateRu(r.end)}</span><b>${rcF(r.progClosing)}</b></div>
      <div class="rc-card ${ok ? "rc-ok" : "rc-bad"}"><span>Разница</span><b>${ok ? "✓ Сходится" : (r.diffEnd > 0 ? "+" : "−") + rcN(Math.abs(r.diffEnd)) + " ₸"}</b>
        <i>${ok ? "остатки совпадают до тенге" : r.diffEnd > 0 ? "в программе больше, чем на счёте" : "в программе меньше, чем на счёте"}</i></div>
    </div>
    ${r.closingCheck ? `<div class="rep-hint">⚠ Сумма операций в файле не сходится с его «Исходящим остатком» на ${rcN(Math.abs(r.closingCheck))} ₸ — возможно, выписка выгружена не целиком.</div>` : ""}

    ${ok ? "" : `<div class="rc-explain">
      <div class="rc-explain-title">Из чего складывается разница</div>
      ${r.diffStart ? `<div class="rc-ex-row"><span>Разница уже на начало сверки (${dateRu(r.start)}) — то, что внесено до этой даты</span><b>${r.diffStart > 0 ? "+" : "−"}${rcN(Math.abs(r.diffStart))}</b></div>` : ""}
      <div class="rc-ex-row clickable" onclick="setReconTab('missingBank')"><span>Записи в программе, которых нет в выписке (${r.missingInBank.length})</span><b>${r.missingInBankSum >= 0 ? "+" : "−"}${rcN(Math.abs(r.missingInBankSum))}</b></div>
      <div class="rc-ex-row clickable" onclick="setReconTab('missingProg')"><span>Операции из выписки, не внесённые в программу (${r.missingInProg.length})</span><b>${-r.missingInProgSum >= 0 ? "+" : "−"}${rcN(Math.abs(r.missingInProgSum))}</b></div>
      <div class="rc-ex-row total"><span>Итого разница</span><b>${r.diffEnd >= 0 ? "+" : "−"}${rcN(Math.abs(r.diffEnd))}</b></div>
      ${r.diffStart && r.start > m.from ? `<div class="muted small" style="margin-top:6px;">Разница на начало обычно значит, что первая запись в программе — не настоящий остаток счёта на ту дату. Её можно поправить или начать сверку с более ранней даты.</div>` : ""}
    </div>`}

    <div class="rc-tabs">${tabs.map(([k, label, n, cls]) =>
      `<button class="${reconTab === k ? "active" : ""}" onclick="setReconTab('${k}')">${label}${n !== null ? ` <span class="rc-badge ${n && cls ? cls : ""}">${n}</span>` : ""}</button>`).join("")}</div>
    <div id="rcTabBody">${renderReconTab(shifted, groups, exact)}</div>
    ${lastMoveNote ? `<div class="rep-note">Записи в программе за последний день, внесённые после этого времени, могут пока отсутствовать в выписке${lastMoveNote}.</div>` : ""}`;
}

function renderReconTab(shifted, groups, exact) {
  const r = reconRes;
  if (reconTab === "missingProg") {
    if (!r.missingInProg.length) return `<div class="detail-empty">Все операции из выписки есть в программе 👍</div>`;
    const selected = r.missingInProg.filter(s => reconChoice[s.key].checked);
    const selSum = selected.reduce((a, s) => a + (s.type === "income" ? 1 : -1) * s.cents, 0);
    const catNames = [...new Set([...categories.map(c => c.name), "Комиссии банка", "Налоги и взносы", "Перевод на карту"])];
    return `
      <div class="rc-hint">Эти операции прошли по счёту, но в программе их нет. Отметьте нужные и нажмите «Внести». Комиссии и налоги уже отмечены.
        Снятия и переводы на карту отметьте сами: если вы уже записали эти деньги в кассу вручную, второй раз их вносить не нужно.</div>
      <div class="rc-toolbar">
        <label class="dup-check"><input type="checkbox" ${selected.length === r.missingInProg.length ? "checked" : ""} onchange="reconSelectAll(this.checked)"><span>Выбрать все</span></label>
        <label class="dup-check"><input type="checkbox" id="rcGroupFees" checked><span>Комиссии банка — одной строкой за месяц</span></label>
        <button class="save-btn rc-import" ${selected.length && !reconBusy ? "" : "disabled"} onclick="importReconSelected()">
          ${reconBusy ? "Вношу…" : `Внести выбранные (${selected.length}) · ${selSum >= 0 ? "+" : "−"}${rcN(Math.abs(selSum))} ₸`}</button>
      </div>
      <div class="rep-table-wrap"><table class="rep-table rc-table">
        <thead><tr><th></th><th>Дата</th><th class="num">Сумма</th><th>Из выписки</th><th>Внести как</th><th>Категория / источник</th><th>Описание</th></tr></thead>
        <tbody>${r.missingInProg.map(s => {
          const c = reconChoice[s.key];
          const actOpts = s.type === "expense"
            ? [["expense", "Расход"], ["transfer", "Перевод в кассу"]]
            : [["income", "Приход"], ["transfer", "Перевод из кассы"]];
          return `<tr class="${c.checked ? "rc-sel" : ""}">
            <td><input type="checkbox" ${c.checked ? "checked" : ""} onchange="reconSet('${s.key}','checked',this.checked)"></td>
            <td class="nowrap">${dateRu(s.date)}<div class="muted small">${s.time}</div></td>
            <td class="num">${rcSigned(s.type, s.cents)}</td>
            <td class="rc-purpose">${c.label ? `<span class="badge">${c.label}</span> ` : ""}<b>${escapeHtml(s.name)}</b><div class="muted small">${escapeHtml(s.purpose)}</div></td>
            <td><select onchange="reconSet('${s.key}','action',this.value)">${actOpts.map(([v, l]) => `<option value="${v}" ${c.action === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
            <td>${c.action === "transfer" ? `<span class="muted small">—</span>` : s.type === "expense"
              ? `<select onchange="reconSet('${s.key}','category',this.value)"><option value="">— без категории —</option>${catNames.map(n => `<option ${c.category === n ? "selected" : ""}>${escapeHtml(n)}</option>`).join("")}</select>`
              : `<input type="text" value="${escapeHtml(c.source)}" onchange="reconSet('${s.key}','source',this.value)" placeholder="от кого">`}</td>
            <td><input type="text" value="${escapeHtml(c.desc)}" onchange="reconSet('${s.key}','desc',this.value)"></td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`;
  }

  if (reconTab === "missingBank") {
    if (!r.missingInBank.length) return `<div class="detail-empty">Все записи программы нашлись в выписке 👍</div>`;
    return `
      <div class="rc-hint">Эти записи есть во вкладке «Банк», но по счёту таких операций не было. Частые причины: деньги были наличными (перенесите в «Кассу» через ✎),
        неверная дата или сумма, повтор или запись «для выравнивания». Исправьте или удалите — сверка пересчитается сама.</div>
      <div class="rep-table-wrap"><table class="rep-table rc-table">
        <thead><tr><th>Дата</th><th class="num">Сумма</th><th>Запись в программе</th><th>Кто внёс</th><th></th></tr></thead>
        <tbody>${r.missingInBank.map(p => `<tr>
          <td class="nowrap">${dateRu(p.date)}</td>
          <td class="num">${rcSigned(p.type, p.cents)}</td>
          <td>${escapeHtml(p.text || "—")}${p.t.category_name ? ` <span class="muted small">· ${escapeHtml(p.t.category_name)}</span>` : ""}${p.t.comment ? `<div class="muted small">${escapeHtml(p.t.comment)}</div>` : ""}</td>
          <td class="muted">${escapeHtml(p.who)}</td>
          <td class="nowrap"><button class="del-btn" style="opacity:1" title="Изменить" onclick="editTx(${p.id})">✎</button><button class="del-btn" style="opacity:1" title="Удалить" onclick="removeTx(${p.id})">🗑</button></td>
        </tr>`).join("")}</tbody>
      </table></div>`;
  }

  if (reconTab === "matched") {
    const row = (m, note) => `<tr>
      <td>${m.prog.map(p => `<div>${dateRu(p.date)} · ${rcSigned(p.type, p.cents)} · ${escapeHtml(p.text || "—")}</div>`).join("")}</td>
      <td>${m.stmt.map(s => `<div>${dateRu(s.date)} · ${rcSigned(s.type, s.cents)} · <span class="muted">${escapeHtml((s.name ? s.name + " — " : "") + s.purpose).slice(0, 70)}</span></div>`).join("")}</td>
      <td class="muted small">${note}</td></tr>`;
    const table = (title, list, noteFn, hint) => list.length ? `
      <div class="rep-section">${title} <span class="muted small">(${list.length})</span></div>
      ${hint ? `<div class="rc-hint">${hint}</div>` : ""}
      <div class="rep-table-wrap"><table class="rep-table rc-table"><thead><tr><th>В программе</th><th>В выписке</th><th></th></tr></thead>
      <tbody>${list.map(m => row(m, noteFn(m))).join("")}</tbody></table></div>` : "";
    return (shifted.length || groups.length || exact.length) ? `
      ${table("⚠ Совпало по сумме, но дата отличается", shifted, m => `в программе на ${Math.abs(m.shift)} дн. ${m.shift > 0 ? "позже" : "раньше"}`,
        "Сумма та же, но день другой. Обычно это одна и та же операция, внесённая другим числом. Проверьте, особенно если на счёте было несколько одинаковых сумм.")}
      ${table("Одна запись = несколько операций", groups, m => m.stmt.length > 1 ? `${m.stmt.length} операций в банке одной записью` : `${m.prog.length} записей = 1 операция в банке`)}
      ${table("Совпало точно", exact, () => "")}` : `<div class="detail-empty">Совпадений нет</div>`;
  }

  // по дням
  return `
    <div class="rc-hint">Остаток на конец каждого дня по выписке и в программе. Жёлтым — дни, когда разница изменилась: там и стоит искать ошибку.</div>
    <div class="rep-table-wrap"><table class="rep-table rc-table">
      <thead><tr><th>Дата</th><th class="num">Выписка +</th><th class="num">Выписка −</th><th class="num">Программа +</th><th class="num">Программа −</th>
        <th class="num">Остаток выписки</th><th class="num">Остаток программы</th><th class="num">Разница</th></tr></thead>
      <tbody>${r.daily.map(d => `<tr class="${d.change ? "rc-changed" : ""}">
        <td class="nowrap">${dateRu(d.date)}</td>
        <td class="num inc">${d.sIn ? rcN(d.sIn) : ""}</td><td class="num exp">${d.sOut ? rcN(d.sOut) : ""}</td>
        <td class="num inc">${d.pIn ? rcN(d.pIn) : ""}</td><td class="num exp">${d.pOut ? rcN(d.pOut) : ""}</td>
        <td class="num">${rcN(d.sBal)}</td><td class="num">${rcN(d.pBal)}</td>
        <td class="num"><b>${d.diff ? (d.diff > 0 ? "+" : "−") + rcN(Math.abs(d.diff)) : "0"}</b>${d.change ? `<div class="small" style="color:var(--warn)">${d.change > 0 ? "+" : "−"}${rcN(Math.abs(d.change))} за день</div>` : ""}</td>
      </tr>`).join("")}</tbody>
    </table></div>`;
}

function reconSet(key, field, value) {
  reconChoice[key][field] = value;
  if (field === "checked" || field === "action") renderRecon();
}

function reconSelectAll(on) {
  reconRes.missingInProg.forEach(s => reconChoice[s.key].checked = on);
  renderRecon();
}

// djb2 — короткий стабильный ключ, чтобы повторное внесение той же операции не создавало дубль
function reconHash(str) { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); }

async function importReconSelected() {
  if (reconBusy) return;
  const selected = reconRes.missingInProg.filter(s => reconChoice[s.key].checked);
  if (!selected.length) return;
  const groupFees = document.getElementById("rcGroupFees").checked;
  const acc = (reconStmt.meta.account || "acc").slice(-8);
  const total = selected.reduce((a, s) => a + (s.type === "income" ? 1 : -1) * s.cents, 0);
  if (!confirm(`Внести ${selected.length} операций во вкладку «Банк» организации «${currentOrg.name}»?\nИтого: ${total >= 0 ? "+" : "−"}${rcN(Math.abs(total))} ₸`)) return;

  reconBusy = true; renderRecon();
  try {
    // 1) категории, которых ещё нет у организации — создаём
    const needCats = [...new Set(selected.map(s => reconChoice[s.key]).filter(c => c.action === "expense" && c.category).map(c => c.category))]
      .filter(n => !categories.some(c => c.name.toLowerCase() === n.toLowerCase()));
    for (const name of needCats) {
      const cat = await api(`/orgs/${currentOrg.id}/categories`, { method: "POST", body: JSON.stringify({ name }) });
      categories.push(cat);
    }
    const catId = name => (categories.find(c => c.name.toLowerCase() === String(name).toLowerCase()) || {}).id || null;

    // 2) готовим записи; мелкие комиссии — по месяцам одной строкой
    const jobs = [];
    const feeGroups = new Map();
    for (const s of selected) {
      const c = reconChoice[s.key];
      const keyBase = `stmt:${acc}:${s.doc || s.row}:${s.date}:${s.cents}`;
      if (groupFees && c.kind === "fee" && c.action === "expense") {
        const k = s.date.slice(0, 7) + "|" + (c.category || "");
        if (!feeGroups.has(k)) feeGroups.set(k, []);
        feeGroups.get(k).push(s);
        continue;
      }
      if (c.action === "transfer") {
        jobs.push({ url: `/orgs/${currentOrg.id}/transfers`, body: { from: s.type === "expense" ? "bank" : "cash", amount: s.cents / 100, occurred_on: s.date, occurred_at: s.time || null, comment: c.desc || null, client_key: "t" + reconHash(keyBase) } });
      } else {
        const body = { type: s.type, account: "bank", amount: s.cents / 100, occurred_on: s.date, occurred_at: s.time || null, client_key: "s" + reconHash(keyBase), comment: "из выписки" };
        if (s.type === "expense") { body.category_id = catId(c.category); body.description = c.desc || s.purpose.slice(0, 90) || null; }
        else { body.source = c.source || s.name || null; body.description = c.desc || null; }
        jobs.push({ url: `/orgs/${currentOrg.id}/transactions`, body });
      }
    }
    for (const [k, list] of feeGroups) {
      const [month, catName] = k.split("|");
      const last = list.reduce((m, s) => s.date > m ? s.date : m, list[0].date);
      const sum = list.reduce((a, s) => a + s.cents, 0);
      const [y, mo] = month.split("-");
      jobs.push({ url: `/orgs/${currentOrg.id}/transactions`, body: {
        type: "expense", account: "bank", amount: sum / 100, occurred_on: last, occurred_at: null,
        category_id: catId(catName), description: `Комиссии банка за ${mo}.${y} (${list.length} шт.)`, comment: "из выписки",
        client_key: "f" + reconHash(`fees:${acc}:` + list.map(s => s.doc || s.row).sort().join(",")),
      } });
    }

    // 3) вносим по одной (сервер не создаст дубль, если ту же операцию уже вносили)
    let ok = 0, dup = 0;
    for (const j of jobs) {
      const r = await api(j.url, { method: "POST", body: JSON.stringify(j.body) });
      if (r && r.duplicate) dup++; else ok++;
    }
    selected.forEach(s => delete reconChoice[s.key]);
    showToast(`Внесено записей: ${ok}${dup ? ` · уже были: ${dup}` : ""}`);
  } catch (err) {
    alert("Не всё удалось внести: " + err.message + "\nСверка пересчитается — повторное нажатие не создаст дублей.");
  } finally {
    reconBusy = false;
    await loadTransactions(currentOrg.id, true);   // → render() → reconOnTransactionsChanged()
  }
}
