// Заказы: один заказ — одна строка.
// Оплаты клиента и затраты — обычные операции (transactions) с order_id, см. db/schema.sql.
const express = require("express");
const router = express.Router();
const pool = require("../db");

// Таблица заказов с деньгами — только для партнёров: админ или «видит всех»
function requirePartner(req, res, next) {
  if (req.user && (req.user.is_admin || req.user.can_view_all)) return next();
  return res.status(403).json({ error: "Заказы доступны только администратору и партнёрам" });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readOrderBody(body) {
  const { ordered_on, legal_entity, customer, title, price, comment } = body;
  if (!ordered_on || !DATE_RE.test(ordered_on)) return { error: "Укажите дату заказа" };
  if (!customer || !String(customer).trim()) return { error: "Укажите заказчика" };
  if (!title || !String(title).trim()) return { error: "Укажите, что за заказ" };
  const p = Number(price);
  if (!Number.isFinite(p) || p < 0) return { error: "Цена заказа должна быть числом ≥ 0" };
  return {
    values: [
      ordered_on,
      legal_entity && String(legal_entity).trim() ? String(legal_entity).trim() : null,
      String(customer).trim(),
      String(title).trim(),
      p,
      comment && String(comment).trim() ? String(comment).trim() : null,
    ],
  };
}

async function getOrder(id) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  return rows[0];
}

// Короткий список заказов для выпадающего списка в форме операции — виден всем,
// чтобы любой сотрудник мог привязать расход («такси на монтаж») к заказу.
router.get("/:orgId/orders/options", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ordered_on, customer, title FROM orders
       WHERE org_id = $1 ORDER BY ordered_on DESC, id DESC LIMIT 300`,
      [req.params.orgId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Таблица заказов с итогами по каждому. Фильтры: ?from=YYYY-MM-DD&to=YYYY-MM-DD&entity=ИП...
router.get("/:orgId/orders", requirePartner, async (req, res, next) => {
  try {
    const params = [req.params.orgId];
    const where = ["o.org_id = $1"];
    if (DATE_RE.test(req.query.from || "")) { params.push(req.query.from); where.push(`o.ordered_on >= $${params.length}`); }
    if (DATE_RE.test(req.query.to || ""))   { params.push(req.query.to);   where.push(`o.ordered_on <= $${params.length}`); }
    if (req.query.entity) {
      if (req.query.entity === "__none__") where.push("o.legal_entity IS NULL");
      else { params.push(req.query.entity); where.push(`o.legal_entity = $${params.length}`); }
    }

    const { rows } = await pool.query(
      `SELECT o.*, u.name AS created_by_name,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='income' AND t.status='paid' AND t.account='cash'), 0) AS paid_cash,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='income' AND t.status='paid' AND t.account='bank'), 0) AS paid_bank,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='income' AND t.status='planned'), 0)                  AS income_planned,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.cost_type='materials'), 0) AS cost_materials,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.cost_type='taxi'), 0)      AS cost_taxi,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.cost_type='designer'), 0)  AS cost_designer,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.cost_type='installer'), 0) AS cost_installer,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND (t.cost_type='other' OR t.cost_type IS NULL)), 0) AS cost_other,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense'), 0)                       AS costs_total,
         COALESCE(SUM(t.amount) FILTER (WHERE t.type='expense' AND t.status='planned'), 0) AS costs_planned
       FROM orders o
       LEFT JOIN transactions t ON t.order_id = o.id
       LEFT JOIN users u ON u.id = o.created_by
       WHERE ${where.join(" AND ")}
       GROUP BY o.id, u.name
       ORDER BY o.ordered_on DESC, o.id DESC`,
      params
    );

    // Список всех ИП/ТОО этой организации — для фильтра (без учёта текущих фильтров)
    const { rows: ents } = await pool.query(
      `SELECT DISTINCT legal_entity FROM orders WHERE org_id = $1 AND legal_entity IS NOT NULL ORDER BY legal_entity`,
      [req.params.orgId]
    );

    res.json({ orders: rows, entities: ents.map((e) => e.legal_entity) });
  } catch (err) {
    next(err);
  }
});

// Новый заказ
router.post("/:orgId/orders", requirePartner, async (req, res, next) => {
  try {
    const parsed = readOrderBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { rows } = await pool.query(
      `INSERT INTO orders (org_id, ordered_on, legal_entity, customer, title, price, comment, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.orgId, ...parsed.values, req.user.id]
    );
    req.app.get("broadcast")(req.params.orgId);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Изменить заказ
router.put("/orders/:id", requirePartner, async (req, res, next) => {
  try {
    const existing = await getOrder(req.params.id);
    if (!existing) return res.status(404).json({ error: "Заказ не найден" });
    const parsed = readOrderBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { rows } = await pool.query(
      `UPDATE orders SET ordered_on=$1, legal_entity=$2, customer=$3, title=$4, price=$5, comment=$6, updated_at=now()
       WHERE id=$7 RETURNING *`,
      [...parsed.values, req.params.id]
    );
    req.app.get("broadcast")(existing.org_id);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Удалить заказ. Неоплаченные («к оплате») записи удаляются вместе с ним,
// а проведённые операции остаются в кассе/банке — деньги-то реально двигались, — просто без привязки.
router.delete("/orders/:id", requirePartner, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const existing = await getOrder(req.params.id);
    if (!existing) return res.status(404).json({ error: "Заказ не найден" });
    await client.query("BEGIN");
    await client.query("DELETE FROM transactions WHERE order_id = $1 AND status = 'planned'", [req.params.id]);
    await client.query("UPDATE transactions SET cost_type = NULL WHERE order_id = $1", [req.params.id]);
    await client.query("DELETE FROM orders WHERE id = $1", [req.params.id]);
    await client.query("COMMIT");
    req.app.get("broadcast")(existing.org_id);
    res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Все платежи и затраты заказа — для окна «детали» по клику на сумму
router.get("/orders/:id/items", requirePartner, async (req, res, next) => {
  try {
    const order = await getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "Заказ не найден" });
    const { rows } = await pool.query(
      `SELECT t.*, c.name AS category_name, u.name AS who_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN users u ON u.id = t.who_id
       WHERE t.order_id = $1
       ORDER BY t.occurred_on, t.occurred_at NULLS LAST, t.id`,
      [req.params.id]
    );
    res.json({ order, items: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
