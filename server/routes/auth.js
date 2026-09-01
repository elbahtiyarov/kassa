const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../db");
const auth = require("../middleware/auth");
const { sendSms } = require("../sms");

// Вход по логину (имя пользователя или телефон — что удобнее) и паролю
router.post("/login", async (req, res, next) => {
  try {
    const { login, password, phone } = req.body;
    const identifier = (login || phone || "").trim(); // phone — для старых клиентов фронтенда
    if (!identifier || !password) {
      return res.status(400).json({ error: "Укажите логин и пароль" });
    }

    const { rows } = await pool.query(
      "SELECT * FROM users WHERE username = $1 OR phone = $1",
      [identifier]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Неверный логин или пароль" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Неверный логин или пароль" });

    const token = jwt.sign(
      { id: user.id, name: user.name, is_admin: user.is_admin, can_view_all: user.can_view_all },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ token, user: { id: user.id, name: user.name, is_admin: user.is_admin, can_view_all: user.can_view_all } });
  } catch (err) {
    next(err);
  }
});

// Проверка текущей сессии (используется фронтендом при загрузке страницы)
router.get("/me", auth, (req, res) => {
  res.json(req.user);
});

// Шаг 1 сброса пароля: отправить код на телефон
router.post("/forgot-password", async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Укажите телефон" });

    const { rows } = await pool.query("SELECT id FROM users WHERE phone = $1", [phone.trim()]);
    const user = rows[0];

    // Не сообщаем, зарегистрирован ли такой номер — иначе номера можно перебирать
    if (user) {
      const code = String(crypto.randomInt(100000, 999999));
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await pool.query(
        "INSERT INTO password_resets (user_id, code, expires_at) VALUES ($1, $2, $3)",
        [user.id, code, expiresAt]
      );
      await sendSms(phone.trim(), `Касса: код для сброса пароля — ${code}. Действителен 10 минут.`);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Шаг 2 сброса пароля: код + новый пароль
router.post("/reset-password", async (req, res, next) => {
  try {
    const { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) {
      return res.status(400).json({ error: "Укажите телефон, код и новый пароль" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Пароль должен быть не короче 6 символов" });
    }

    const { rows } = await pool.query("SELECT id FROM users WHERE phone = $1", [phone.trim()]);
    const user = rows[0];
    if (!user) return res.status(400).json({ error: "Неверный код" });

    const { rows: resets } = await pool.query(
      `SELECT * FROM password_resets
       WHERE user_id = $1 AND code = $2 AND used = false AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [user.id, code]
    );
    const reset = resets[0];
    if (!reset) return res.status(400).json({ error: "Неверный или истёкший код" });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, user.id]);
    await pool.query("UPDATE password_resets SET used = true WHERE id = $1", [reset.id]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
