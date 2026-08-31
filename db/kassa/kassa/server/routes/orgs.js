const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAdmin = require("../middleware/requireAdmin");

// Список организаций (виден любому вошедшему пользователю)
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT id, name FROM organizations ORDER BY name");
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новая организация — только админ
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Название организации обязательно" });
    }
    const { rows } = await pool.query(
      "INSERT INTO organizations (name) VALUES ($1) RETURNING id, name",
      [name.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Организация с таким именем уже существует" });
    }
    next(err);
  }
});

// Переименовать организацию — только админ
router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Название организации обязательно" });
    }
    const { rows } = await pool.query(
      "UPDATE organizations SET name = $1 WHERE id = $2 RETURNING id, name",
      [name.trim(), req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Организация не найдена" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Организация с таким именем уже существует" });
    }
    next(err);
  }
});

// Удалить организацию (вместе со всеми операциями и категориями) — только админ
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query("DELETE FROM organizations WHERE id = $1 RETURNING id", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Организация не найдена" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// Категории организации
router.get("/:orgId/categories", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, color FROM categories WHERE org_id = $1 ORDER BY name",
      [req.params.orgId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Остаток по счёту организации (?account=cash|bank, по умолчанию cash)
router.get("/:orgId/balance", async (req, res, next) => {
  try {
    const account = req.query.account === "bank" ? "bank" : "cash";
    const { rows } = await pool.query(
      "SELECT * FROM org_balances WHERE org_id = $1 AND account = $2",
      [req.params.orgId, account]
    );
    res.json(rows[0] || { total_income: 0, total_expense: 0, balance: 0 });
  } catch (err) {
    next(err);
  }
});

// Остатки по каждому сотруднику отдельно (?account=cash|bank, по умолчанию cash)
// Обычный пользователь видит только свою строку — админ видит всех.
router.get("/:orgId/person-balances", async (req, res, next) => {
  try {
    const account = req.query.account === "bank" ? "bank" : "cash";
    const params = [req.params.orgId, account];
    let whoClause = "";
    if (!req.user.is_admin) {
      params.push(req.user.id);
      whoClause = "AND who_id = $3";
    }
    const { rows } = await pool.query(
      `SELECT who_id, who_name, total_income, total_expense, balance
       FROM person_balances
       WHERE org_id = $1 AND account = $2 ${whoClause}
       ORDER BY who_name`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
