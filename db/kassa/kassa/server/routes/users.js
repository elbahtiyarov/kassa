const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db");
const requireAdmin = require("../middleware/requireAdmin");

// Список пользователей — только админ
router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, phone, is_admin, created_at FROM users ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новый пользователь — только админ
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const { name, phone, password, is_admin } = req.body;
    if (!name || !name.trim() || !phone || !phone.trim() || !password) {
      return res.status(400).json({ error: "Укажите имя, телефон и пароль" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, phone, password_hash, is_admin)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, phone, is_admin`,
      [name.trim(), phone.trim(), hash, !!is_admin]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Такой телефон уже зарегистрирован" });
    }
    next(err);
  }
});

// Удалить пользователя — только админ, себя удалить нельзя
router.delete("/:id", requireAdmin, async (req, res, next) => {
  try {
    if (String(req.user.id) === String(req.params.id)) {
      return res.status(400).json({ error: "Нельзя удалить самого себя" });
    }
    await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
