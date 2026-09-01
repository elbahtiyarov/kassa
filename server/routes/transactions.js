const express = require("express");
const router = express.Router();
const pool = require("../db");

// Операции по организации (?account=cash|bank, по умолчанию cash)
// Обычный пользователь видит только свои операции (и в кассе, и в банке) — только админ видит всех.
router.get("/:orgId/transactions", async (req, res, next) => {
  try {
    const account = req.query.account === "bank" ? "bank" : "cash";
    const restrictToSelf = !(req.user.is_admin || req.user.can_view_all);

    const params = [req.params.orgId, account];
    let whoClause = "";
    if (restrictToSelf) {
      params.push(req.user.id);
      whoClause = "AND t.who_id = $3";
    }

    const { rows } = await pool.query(
      `SELECT t.*, c.name AS category_name, c.color AS category_color, u.name AS who_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN users u ON u.id = t.who_id
       WHERE t.org_id = $1 AND t.account = $2 ${whoClause}
       ORDER BY t.occurred_on DESC, t.occurred_at DESC NULLS LAST, t.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новая операция
router.post("/:orgId/transactions", async (req, res, next) => {
  try {
    const orgId = req.params.orgId;
    const {
      type, amount, category_id, source, description,
      occurred_on, occurred_at, comment, account,
    } = req.body;

    if (!type || !amount || !occurred_on) {
      return res.status(400).json({ error: "Обязательны: type, amount, occurred_on" });
    }
    const acc = account === "bank" ? "bank" : "cash";

    // Кто внёс операцию — берётся из токена авторизации, а не из тела запроса
    const userId = req.user.id;

    const { rows } = await pool.query(
      `INSERT INTO transactions
         (org_id, account, type, amount, category_id, source, description, occurred_on, occurred_at, who_id, comment, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [orgId, acc, type, amount, category_id || null, source || null, description || null,
       occurred_on, occurred_at || null, userId, comment || null, userId]
    );

    req.app.get("broadcast")(orgId);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Изменить операцию — только тот, кто её создал, или админ
router.put("/transactions/:id", async (req, res, next) => {
  try {
    const { rows: existingRows } = await pool.query("SELECT * FROM transactions WHERE id = $1", [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Операция не найдена" });
    if (!req.user.is_admin && String(existing.created_by) !== String(req.user.id)) {
      return res.status(403).json({ error: "Редактировать может только тот, кто создал операцию" });
    }

    const { type, amount, category_id, source, description, occurred_on, occurred_at, comment } = req.body;
    if (!type || !amount || !occurred_on) {
      return res.status(400).json({ error: "Обязательны: type, amount, occurred_on" });
    }

    const { rows } = await pool.query(
      `UPDATE transactions
         SET type=$1, amount=$2, category_id=$3, source=$4, description=$5,
             occurred_on=$6, occurred_at=$7, comment=$8
       WHERE id=$9
       RETURNING *`,
      [type, amount, category_id || null, source || null, description || null,
       occurred_on, occurred_at || null, comment || null, req.params.id]
    );

    req.app.get("broadcast")(existing.org_id);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Удаление операции — только тот, кто её создал, или админ
router.delete("/transactions/:id", async (req, res, next) => {
  try {
    const { rows: existingRows } = await pool.query("SELECT * FROM transactions WHERE id = $1", [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Операция не найдена" });
    if (!req.user.is_admin && String(existing.created_by) !== String(req.user.id)) {
      return res.status(403).json({ error: "Удалить может только тот, кто создал операцию" });
    }

    await pool.query("DELETE FROM transactions WHERE id = $1", [req.params.id]);
    req.app.get("broadcast")(existing.org_id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
