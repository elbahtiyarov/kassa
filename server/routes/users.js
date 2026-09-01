const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db");
const requireAdmin = require("../middleware/requireAdmin");

// Список пользователей — только админ
router.get("/", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, username, phone, is_admin, can_view_all, created_at FROM users ORDER BY name"
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новый пользователь — только админ
// Имя пользователя (username) — обязательный логин для входа.
// Телефон — необязателен, нужен только для восстановления пароля по SMS.
router.post("/", requireAdmin, async (req, res, next) => {
  try {
    const { name, username, phone, password, is_admin, can_view_all } = req.body;
    if (!name || !name.trim() || !username || !username.trim() || !password) {
      return res.status(400).json({ error: "Укажите имя, имя пользователя и пароль" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, phone, password_hash, is_admin, can_view_all)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, username, phone, is_admin, can_view_all`,
      [name.trim(), username.trim(), phone && phone.trim() ? phone.trim() : null, hash, !!is_admin, !!can_view_all]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Такое имя пользователя или телефон уже зарегистрированы" });
    }
    next(err);
  }
});

// Изменить пользователя — только админ
router.put("/:id", requireAdmin, async (req, res, next) => {
  try {
    const { can_view_all, is_admin, username, phone } = req.body;
    const { rows } = await pool.query(
      `UPDATE users SET
         can_view_all = COALESCE($1, can_view_all),
         is_admin = COALESCE($2, is_admin),
         username = COALESCE($3, username),
         phone = COALESCE($4, phone)
       WHERE id = $5
       RETURNING id, name, username, phone, is_admin, can_view_all`,
      [
        typeof can_view_all === "boolean" ? can_view_all : null,
        typeof is_admin === "boolean" ? is_admin : null,
        username && username.trim() ? username.trim() : null,
        phone !== undefined ? (phone && phone.trim() ? phone.trim() : null) : null,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: "Пользователь не найден" });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "Такое имя пользователя или телефон уже зарегистрированы" });
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
