// Применяет schema.sql и (опционально) seed.sql к базе, заданной в .env
// Запуск: node db/migrate.js          — только схема
//         node db/migrate.js --seed   — схема + демо-пользователи + демо-данные

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Демо-пользователи. Пароли меняются позже в приложении/базе — это только для первого входа.
const DEMO_USERS = [
  { name: "Админ",  phone: "+7000000000", password: "admin123",  is_admin: true },
  { name: "Алма",   phone: "+7700000001", password: "alma123",   is_admin: false },
  { name: "Динара", phone: "+7700000002", password: "dinara123", is_admin: false },
];

async function seedUsers() {
  console.log("Создаю пользователей...");
  for (const u of DEMO_USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    await pool.query(
      `INSERT INTO users (name, phone, password_hash, is_admin)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (phone) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_admin = EXCLUDED.is_admin`,
      [u.name, u.phone, hash, u.is_admin]
    );
  }
  console.log("\nДанные для входа:");
  DEMO_USERS.forEach((u) => {
    console.log(`  ${u.is_admin ? "[админ] " : "        "}${u.name} — телефон: ${u.phone}, пароль: ${u.password}`);
  });
  console.log("");
}

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log("Применяю schema.sql...");
  await pool.query(schema);
  console.log("Схема готова.");

  if (process.argv.includes("--seed")) {
    await seedUsers();
    const seed = fs.readFileSync(path.join(__dirname, "seed.sql"), "utf8");
    console.log("Загружаю seed.sql...");
    await pool.query(seed);
    console.log("Демо-данные загружены.");
  }

  await pool.end();
}

run().catch((err) => {
  console.error("Ошибка миграции:", err);
  process.exit(1);
});
