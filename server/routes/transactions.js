const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../db");

const COST_TYPES = ["materials", "taxi", "designer", "installer", "other"];

// Проверяет и нормализует привязку операции к заказу.
// Возвращает { order_id, cost_type } или бросает ошибку 400.
async function resolveOrderLink(orgId, type, order_id, cost_type) {
  if (!order_id) return { order_id: null, cost_type: null };
  const { rows } = await pool.query("SELECT id FROM orders WHERE id = $1 AND org_id = $2", [order_id, orgId]);
  if (!rows[0]) {
    const err = new Error("Заказ не найден в этой организации");
    err.status = 400;
    throw err;
  }
  if (type === "income") return { order_id: rows[0].id, cost_type: null };
  return { order_id: rows[0].id, cost_type: COST_TYPES.includes(cost_type) ? cost_type : "other" };
}

// Операции по организации (?account=cash|bank, по умолчанию cash)
// Показываются только проведённые операции (status = 'paid'); «к оплате» живут в заказах.
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
      `SELECT t.*, c.name AS category_name, c.color AS category_color, u.name AS who_name,
              o.title AS order_title, o.customer AS order_customer
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN users u ON u.id = t.who_id
       LEFT JOIN orders o ON o.id = t.order_id
       WHERE t.org_id = $1 AND t.account = $2 AND t.status = 'paid' ${whoClause}
       ORDER BY t.occurred_on DESC, t.occurred_at DESC NULLS LAST, t.id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Новая операция (в т.ч. оплата/затрата заказа, если передан order_id)
router.post("/:orgId/transactions", async (req, res, next) => {
  try {
    const orgId = req.params.orgId;
    const {
      type, amount, category_id, source, description,
      occurred_on, occurred_at, comment, account,
      order_id, cost_type, status, client_key,
    } = req.body;

    if (!type || !amount || !occurred_on) {
      return res.status(400).json({ error: "Обязательны: type, amount, occurred_on" });
    }
    const acc = account === "bank" ? "bank" : "cash";
    const st = status === "planned" ? "planned" : "paid";
    const link = await resolveOrderLink(orgId, type, order_id, cost_type);

    // Кто внёс операцию — берётся из токена авторизации, а не из тела запроса.
    // Исключение — импорт из Excel админом: колонка «Кто» (who_name) сохраняет исходного сотрудника,
    // иначе все импортированные деньги «переезжали» на админа и личные остатки не сходились.
    const userId = req.user.id;
    let whoId = userId;
    if (req.user.is_admin && req.body.who_name) {
      const { rows: u } = await pool.query("SELECT id FROM users WHERE lower(name) = lower($1) LIMIT 1", [String(req.body.who_name).trim()]);
      if (u[0]) whoId = u[0].id;
    }
    const key = client_key ? String(client_key).slice(0, 80) : null;

    // ON CONFLICT по client_key: повторная отправка той же формы вернёт уже созданную операцию
    const { rows } = await pool.query(
      `INSERT INTO transactions
         (org_id, account, type, amount, category_id, source, description, occurred_on, occurred_at,
          who_id, comment, created_by, order_id, cost_type, status, client_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (client_key) WHERE client_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [orgId, acc, type, amount, category_id || null, source || null, description || null,
       occurred_on, occurred_at || null, whoId, comment || null, userId,
       link.order_id, link.cost_type, st, key]
    );
    if (!rows[0]) {
      const { rows: dup } = await pool.query("SELECT * FROM transactions WHERE client_key = $1", [key]);
      return res.status(200).json({ ...dup[0], duplicate: true });
    }

    req.app.get("broadcast")(orgId);
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Перевод между кассой и банком одной организации: { from: 'cash'|'bank', amount, occurred_on, occurred_at, comment }
// Создаёт две связанные операции — расход «откуда» и приход «куда» — в одной транзакции БД.
router.post("/:orgId/transfers", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const orgId = req.params.orgId;
    const from = req.body.from === "bank" ? "bank" : "cash";
    const to = from === "cash" ? "bank" : "cash";
    const amount = Number(req.body.amount);
    const { occurred_on, occurred_at, comment, client_key } = req.body;
    if (!amount || amount <= 0 || !occurred_on) {
      return res.status(400).json({ error: "Обязательны: amount, occurred_on" });
    }
    const label = from === "cash" ? "Перевод: касса → банк" : "Перевод: банк → касса";
    const transferId = crypto.randomUUID();
    const key = client_key ? String(client_key).slice(0, 80) : null;

    await client.query("BEGIN");
    const ins = (account, type, k) => client.query(
      `INSERT INTO transactions
         (org_id, account, type, amount, source, description, occurred_on, occurred_at,
          who_id, comment, created_by, status, transfer_id, client_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,'paid',$11,$12)
       ON CONFLICT (client_key) WHERE client_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [orgId, account, type, amount,
       type === "income" ? label : null, type === "expense" ? label : null,
       occurred_on, occurred_at || null, req.user.id, comment || null, transferId, k]
    );
    const out = await ins(from, "expense", key ? key + ":out" : null);
    if (!out.rows[0]) {           // эту форму уже отправляли — второй раз не проводим
      await client.query("ROLLBACK");
      return res.status(200).json({ duplicate: true });
    }
    await ins(to, "income", key ? key + ":in" : null);
    await client.query("COMMIT");

    req.app.get("broadcast")(orgId);
    res.status(201).json({ transfer_id: transferId });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// Изменить операцию — только тот, кто её создал, или админ.
// Поля account / order_id / cost_type / status меняются, только если переданы в запросе.
router.put("/transactions/:id", async (req, res, next) => {
  try {
    const { rows: existingRows } = await pool.query("SELECT * FROM transactions WHERE id = $1", [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Операция не найдена" });
    if (!req.user.is_admin && String(existing.created_by) !== String(req.user.id)) {
      return res.status(403).json({ error: "Редактировать может только тот, кто создал операцию" });
    }
    if (existing.transfer_id) {
      return res.status(400).json({ error: "Перевод нельзя изменить — удалите его и внесите заново" });
    }

    const { type, amount, category_id, source, description, occurred_on, occurred_at, comment } = req.body;
    if (!type || !amount || !occurred_on) {
      return res.status(400).json({ error: "Обязательны: type, amount, occurred_on" });
    }

    const account = req.body.account === undefined ? existing.account : (req.body.account === "bank" ? "bank" : "cash");
    const status = req.body.status === undefined ? existing.status : (req.body.status === "planned" ? "planned" : "paid");
    const link = req.body.order_id === undefined
      ? await resolveOrderLink(existing.org_id, type, existing.order_id,
          req.body.cost_type === undefined ? existing.cost_type : req.body.cost_type)
      : await resolveOrderLink(existing.org_id, type, req.body.order_id, req.body.cost_type);

    const { rows } = await pool.query(
      `UPDATE transactions
         SET type=$1, amount=$2, category_id=$3, source=$4, description=$5,
             occurred_on=$6, occurred_at=$7, comment=$8,
             account=$9, status=$10, order_id=$11, cost_type=$12
       WHERE id=$13
       RETURNING *`,
      [type, amount, category_id || null, source || null, description || null,
       occurred_on, occurred_at || null, comment || null,
       account, status, link.order_id, link.cost_type, req.params.id]
    );

    req.app.get("broadcast")(existing.org_id);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// Отметить «к оплате» как оплаченное (провести в кассу/банк).
// Можно сразу указать, откуда платили и какой датой: { account, occurred_on }.
router.post("/transactions/:id/pay", async (req, res, next) => {
  try {
    const { rows: existingRows } = await pool.query("SELECT * FROM transactions WHERE id = $1", [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: "Операция не найдена" });
    if (!(req.user.is_admin || req.user.can_view_all) && String(existing.created_by) !== String(req.user.id)) {
      return res.status(403).json({ error: "Нет прав на эту операцию" });
    }
    const account = req.body.account === "bank" ? "bank" : req.body.account === "cash" ? "cash" : existing.account;
    const occurredOn = req.body.occurred_on || new Date().toISOString().slice(0, 10);

    // who_id — тот, кто фактически провёл оплату (влияет на его личный остаток в кассе)
    const { rows } = await pool.query(
      `UPDATE transactions SET status='paid', account=$1, occurred_on=$2, who_id=$3
       WHERE id=$4 RETURNING *`,
      [account, occurredOn, req.user.id, req.params.id]
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

    if (existing.transfer_id) {
      // обе половины перевода — иначе одна сторона останется и остатки разъедутся
      await pool.query("DELETE FROM transactions WHERE transfer_id = $1", [existing.transfer_id]);
    } else {
      await pool.query("DELETE FROM transactions WHERE id = $1", [req.params.id]);
    }
    req.app.get("broadcast")(existing.org_id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
