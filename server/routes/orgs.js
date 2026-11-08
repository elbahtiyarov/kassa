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

// Найти или создать категорию по названию (нужно сверке с выпиской: «Комиссии банка», «Налоги и взносы»…).
// Доступно администратору и партнёрам.
const NEW_CAT_COLORS = { "комиссии банка": "#9AA5B8", "налоги и взносы": "#E8A0A0", "перевод на карту": "#7FD3E0" };
router.post("/:orgId/categories", async (req, res, next) => {
  try {
    if (!(req.user.is_admin || req.user.can_view_all)) {
      return res.status(403).json({ error: "Создавать категории могут администратор и партнёры" });
    }
    const name = String(req.body.name || "").trim().slice(0, 60);
    if (!name) return res.status(400).json({ error: "Укажите название категории" });
    const color = /^#[0-9a-f]{6}$/i.test(req.body.color || "") ? req.body.color : (NEW_CAT_COLORS[name.toLowerCase()] || "#C9C2D9");
    const { rows: found } = await pool.query(
      "SELECT id, name, color FROM categories WHERE org_id = $1 AND lower(name) = lower($2)", [req.params.orgId, name]
    );
    if (found[0]) return res.json(found[0]);
    const { rows } = await pool.query(
      `INSERT INTO categories (org_id, name, color) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, color`,
      [req.params.orgId, name, color]
    );
    res.status(201).json(rows[0]);
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
    if (!(req.user.is_admin || req.user.can_view_all)) {
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
