require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");

const authRouter = require("./routes/auth");
const orgsRouter = require("./routes/orgs");
const transactionsRouter = require("./routes/transactions");
const usersRouter = require("./routes/users");
const ordersRouter = require("./routes/orders");
const backupRouter = require("./routes/backup");
const authMiddleware = require("./middleware/auth");
const errorHandler = require("./middleware/errorHandler");

const app = express();
app.use(cors());
app.use(express.json());

// Отдаём фронтенд из /public
app.use(express.static(path.join(__dirname, "..", "public")));

// /api/auth/* открыт всем (вход и сброс пароля), остальное — только вошедшим пользователям
app.use("/api/auth", authRouter);
app.use("/api/orgs", authMiddleware, orgsRouter);
app.use("/api/orgs", authMiddleware, transactionsRouter); // /:orgId/transactions живёт внутри этого роутера
app.use("/api/orgs", authMiddleware, ordersRouter);       // /:orgId/orders и /orders/:id
app.use("/api/users", authMiddleware, usersRouter);
app.use("/api/backup", authMiddleware, backupRouter);  // резервная копия базы — только админ

app.use(errorHandler);

// При каждом запуске применяем db/schema.sql. Схема безопасна для повторного запуска
// (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) и ничего не удаляет из данных —
// так новые таблицы/колонки появляются сами после обновления кода (Railway и т.п.),
// без ручного «node db/migrate.js». Демо-данные (seed) здесь НЕ загружаются.
async function applySchema() {
  const fs = require("fs");
  const pool = require("./db");
  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(schema);
  console.log("Схема базы проверена/обновлена");

  // Аварийный сброс пароля без консоли: задайте в Railway переменную RESET_PASSWORD
  // (и при необходимости RESET_LOGIN, по умолчанию admin), перезапустите, войдите —
  // и удалите переменную, иначе пароль будет сбрасываться при каждом запуске.
  if (process.env.RESET_PASSWORD) {
    const bcrypt = require("bcryptjs");
    const login = (process.env.RESET_LOGIN || "admin").trim();
    const hash = await bcrypt.hash(process.env.RESET_PASSWORD, 10);
    const { rowCount } = await pool.query(
      "UPDATE users SET password_hash = $1 WHERE username = $2 OR phone = $2", [hash, login]
    );
    console.log(rowCount
      ? `Пароль пользователя «${login}» сброшен из RESET_PASSWORD. Удалите эту переменную после входа!`
      : `RESET_PASSWORD: пользователь «${login}» не найден — проверьте RESET_LOGIN`);
  }
}

const PORT = process.env.PORT || 3001;
let server;
applySchema()
  .catch((err) => console.error("Не удалось обновить схему базы:", err.message))
  .finally(() => {
    server = app.listen(PORT, () => {
      console.log(`Касса запущена: http://localhost:${PORT}`);
    });
    server.on("upgrade", onUpgrade);
  });

// --- WebSocket: realtime-обновления между несколькими пользователями ---
const wss = new WebSocketServer({ noServer: true });
const orgSockets = new Map(); // orgId -> Set<ws>

function broadcast(orgId) {
  const sockets = orgSockets.get(String(orgId));
  if (!sockets) return;
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "updated", orgId }));
  }
}
app.set("broadcast", broadcast);

function onUpgrade(req, socket, head) {
  if (!req.url.startsWith("/ws")) return;
  wss.handleUpgrade(req, socket, head, (ws) => {
    const orgId = new URL(req.url, "http://x").searchParams.get("orgId");
    if (!orgSockets.has(orgId)) orgSockets.set(orgId, new Set());
    orgSockets.get(orgId).add(ws);
    ws.on("close", () => orgSockets.get(orgId)?.delete(ws));
  });
}
