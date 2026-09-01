// Подключение к PostgreSQL — параметры берутся из .env
const { Pool, types } = require("pg");

// По умолчанию pg возвращает BIGINT (id операций) как строку, а не число —
// чтобы не терять точность у очень больших чисел. Для наших ID (в пределах
// обычного числа) это не нужно и только мешает сравнениям на фронтенде,
// поэтому явно приводим BIGINT (OID 20) к обычному числу.
types.setTypeParser(20, (val) => parseInt(val, 10));

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

module.exports = pool;
