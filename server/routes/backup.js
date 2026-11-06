// Резервная копия всей базы одним .sql файлом — без pg_dump и без доступа к Railway.
// Файл самодостаточный: сначала схема (db/schema.sql), потом все данные.
// Восстановление:  psql "postgresql://..." -f kassa-backup-....sql
// ВНИМАНИЕ: при восстановлении текущие данные в базе заменяются данными из копии.
const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();
const pool = require("../db");

// Права админа перепроверяем по базе, а не только по токену
async function requireAdminDb(req, res, next) {
  try {
    const { rows } = await pool.query("SELECT is_admin FROM users WHERE id = $1", [req.user && req.user.id]);
    if (!rows[0] || !rows[0].is_admin) {
      return res.status(403).json({ error: "Резервную копию может скачать только администратор" });
    }
    next();
  } catch (err) {
    next(err);
  }
}

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';

// Таблицы в порядке зависимостей: сначала те, на которые ссылаются
async function tablesInOrder(client) {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  const { rows: deps } = await client.query(
    `SELECT DISTINCT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
     FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.contype = 'f' AND n.nspname = 'public' AND c.conrelid <> c.confrelid`
  );
  const names = tables.map((t) => t.table_name);
  const parents = new Map(names.map((n) => [n, new Set()]));
  for (const d of deps) {
    const child = d.child.replace(/^"|"$/g, "");
    const parent = d.parent.replace(/^"|"$/g, "");
    if (parents.has(child) && parents.has(parent)) parents.get(child).add(parent);
  }
  const ordered = [];
  const done = new Set();
  const visit = (n, stack = new Set()) => {
    if (done.has(n) || stack.has(n)) return;
    stack.add(n);
    for (const p of parents.get(n)) visit(p, stack);
    done.add(n);
    ordered.push(n);
  };
  names.forEach((n) => visit(n));
  return ordered;
}

router.get("/", requireAdminDb, async (req, res, next) => {
  const client = await pool.connect();
  try {
    // Снимок на один момент времени — все таблицы согласованы между собой
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = await tablesInOrder(client);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
    const schema = fs.readFileSync(path.join(__dirname, "..", "..", "db", "schema.sql"), "utf8");

    const out = [];
    const counts = [];
    out.push(
      `-- Касса — резервная копия базы`,
      `-- Создана: ${now.toISOString()} пользователем «${req.user.name || req.user.id}»`,
      `--`,
      `-- Как восстановить (заменит ВСЕ текущие данные в базе на данные из этой копии):`,
      `--   psql "postgresql://ПОЛЬЗОВАТЕЛЬ:ПАРОЛЬ@ХОСТ:ПОРТ/БАЗА" -f этот_файл.sql`,
      `-- Восстановление идёт одной транзакцией: при любой ошибке база останется как была.`,
      ``,
      `\\set ON_ERROR_STOP on`,
      `BEGIN;`,
      ``,
      `-- ===== Схема (как в db/schema.sql) =====`,
      schema,
      ``,
      `-- ===== Данные =====`,
      `-- триггеры (например, история изменений) на время загрузки отключаем, чтобы не плодить лишние записи`,
      `DO $$ BEGIN SET LOCAL session_replication_role = replica;`,
      `EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'Без прав суперпользователя — триггеры останутся включены'; END $$;`,
      `TRUNCATE ${tables.map(qi).join(", ")} RESTART IDENTITY CASCADE;`,
      ``
    );

    for (const t of tables) {
      const { rows: cols } = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'
         ORDER BY ordinal_position`,
        [t]
      );
      if (!cols.length) continue;
      const colList = cols.map((c) => qi(c.column_name)).join(", ");
      // Значения превращает в SQL-литералы сам Postgres (quote_nullable) — точно для любых типов
      const valuesExpr = cols.map((c) => `quote_nullable(${qi(c.column_name)})`).join(` || ', ' || `);
      const { rows } = await client.query(
        `SELECT '(' || ${valuesExpr} || ')' AS v FROM ${qi(t)} ORDER BY 1`
      );
      counts.push(`${t}: ${rows.length}`);
      out.push(`-- ${t}: ${rows.length} строк`);
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => r.v).join(",\n  ");
        out.push(`INSERT INTO ${qi(t)} (${colList}) VALUES\n  ${chunk};`);
      }
      out.push("");
    }

    // Счётчики id — чтобы новые записи после восстановления не конфликтовали со старыми
    const { rows: seqCols } = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_default LIKE 'nextval(%'`
    );
    out.push(`-- ===== Счётчики id =====`);
    for (const s of seqCols) {
      out.push(
        `SELECT setval(pg_get_serial_sequence('${qi(s.table_name)}', '${s.column_name}'), ` +
        `COALESCE((SELECT MAX(${qi(s.column_name)}) FROM ${qi(s.table_name)}), 1), ` +
        `(SELECT MAX(${qi(s.column_name)}) FROM ${qi(s.table_name)}) IS NOT NULL);`
      );
    }
    out.push(``, `COMMIT;`, `-- Итого строк: ${counts.join(", ")}`, ``);
    await client.query("COMMIT");

    res.setHeader("Content-Type", "application/sql; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="kassa-backup-${stamp}.sql"`);
    res.setHeader("X-Backup-Rows", encodeURIComponent(counts.join(", ")));
    res.send(out.join("\n"));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
