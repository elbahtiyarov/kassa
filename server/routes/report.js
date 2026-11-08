// Отчёт «наличные / безнал»: сколько пришло и ушло наличными (касса) и по безналу (банк),
// остатки на начало и конец периода, переводы касса↔банк и расходы по категориям.
// GET /api/report?org=<id>|all&from=YYYY-MM-DD&to=YYYY-MM-DD
// Учитываются только проведённые операции (status = 'paid'); «к оплате» в отчёт не входят.
const express = require("express");
const router = express.Router();
const pool = require("../db");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requirePartner(req, res, next) {
  if (req.user && (req.user.is_admin || req.user.can_view_all)) return next();
  return res.status(403).json({ error: "Отчёт доступен администратору и партнёрам" });
}

router.get("/", requirePartner, async (req, res, next) => {
  try {
    const all = req.query.org === "all";
    const orgId = Number(req.query.org);
    if (!all && !orgId) return res.status(400).json({ error: "Укажите организацию" });
    const from = DATE_RE.test(req.query.from || "") ? req.query.from : null;
    const to = DATE_RE.test(req.query.to || "") ? req.query.to : null;

    const params = [];
    const orgCond = all ? "TRUE" : (params.push(orgId), `t.org_id = $${params.length}`);
    const fromIdx = from ? (params.push(from), params.length) : null;
    const toIdx = to ? (params.push(to), params.length) : null;
    const inPeriod = [fromIdx ? `t.occurred_on >= $${fromIdx}` : "TRUE", toIdx ? `t.occurred_on <= $${toIdx}` : "TRUE"].join(" AND ");
    const beforeFrom = fromIdx ? `t.occurred_on < $${fromIdx}` : "FALSE";
    const upToEnd = toIdx ? `t.occurred_on <= $${toIdx}` : "TRUE";
    const signed = "CASE WHEN t.type = 'income' THEN t.amount ELSE -t.amount END";

    // Итоги по организации и счёту
    const { rows: totals } = await pool.query(
      `SELECT o.id AS org_id, o.name AS org_name, acc.account,
         COALESCE(SUM(${signed}) FILTER (WHERE ${beforeFrom}), 0) AS opening,
         COALESCE(SUM(t.amount) FILTER (WHERE ${inPeriod} AND t.type='income'  AND t.transfer_id IS NULL), 0) AS income,
         COALESCE(SUM(t.amount) FILTER (WHERE ${inPeriod} AND t.type='expense' AND t.transfer_id IS NULL), 0) AS expense,
         COALESCE(SUM(t.amount) FILTER (WHERE ${inPeriod} AND t.type='income'  AND t.transfer_id IS NOT NULL), 0) AS transfer_in,
         COALESCE(SUM(t.amount) FILTER (WHERE ${inPeriod} AND t.type='expense' AND t.transfer_id IS NOT NULL), 0) AS transfer_out,
         COALESCE(SUM(${signed}) FILTER (WHERE ${upToEnd}), 0) AS closing,
         COUNT(t.id) FILTER (WHERE ${inPeriod}) AS ops
       FROM organizations o
       CROSS JOIN (VALUES ('cash'), ('bank')) AS acc(account)
       LEFT JOIN transactions t ON t.org_id = o.id AND t.account = acc.account AND t.status = 'paid'
       WHERE ${all ? "TRUE" : `o.id = $1`}
       GROUP BY o.id, o.name, acc.account
       ORDER BY o.name, acc.account`,
      params
    );

    // Расходы по категориям: наличные / безнал (без переводов)
    const { rows: cats } = await pool.query(
      `SELECT COALESCE(c.name, 'Без категории') AS category,
              MAX(c.color) AS color,
              COALESCE(SUM(t.amount) FILTER (WHERE t.account='cash'), 0) AS cash,
              COALESCE(SUM(t.amount) FILTER (WHERE t.account='bank'), 0) AS bank,
              COUNT(*) AS ops
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE ${orgCond} AND ${inPeriod} AND t.status='paid' AND t.type='expense' AND t.transfer_id IS NULL
       GROUP BY COALESCE(c.name, 'Без категории')
       ORDER BY SUM(t.amount) DESC`,
      params
    );

    // Приходы по источникам (топ-15 по сумме), остальное — одной строкой
    const { rows: srcAll } = await pool.query(
      `SELECT COALESCE(NULLIF(trim(t.source), ''), 'Без источника') AS source,
              COALESCE(SUM(t.amount) FILTER (WHERE t.account='cash'), 0) AS cash,
              COALESCE(SUM(t.amount) FILTER (WHERE t.account='bank'), 0) AS bank,
              COUNT(*) AS ops
       FROM transactions t
       WHERE ${orgCond} AND ${inPeriod} AND t.status='paid' AND t.type='income' AND t.transfer_id IS NULL
       GROUP BY 1
       ORDER BY SUM(t.amount) DESC`,
      params
    );
    let sources = srcAll.slice(0, 15);
    if (srcAll.length > 15) {
      const rest = srcAll.slice(15);
      sources.push({
        source: `Остальные (${rest.length})`,
        cash: rest.reduce((s, r) => s + Number(r.cash), 0),
        bank: rest.reduce((s, r) => s + Number(r.bank), 0),
        ops: rest.reduce((s, r) => s + Number(r.ops), 0),
        rest: true,
      });
    }

    res.json({ from, to, all, totals, categories: cats, sources });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
