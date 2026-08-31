-- Схема базы данных: касса / учёт расходов
-- PostgreSQL 14+

CREATE TABLE IF NOT EXISTS organizations (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    phone         TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- на случай, если таблица уже существовала без этой колонки (старая база)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS user_organizations (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer')),
    PRIMARY KEY (user_id, org_id)
);

CREATE TABLE IF NOT EXISTS password_resets (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code        TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
    id      SERIAL PRIMARY KEY,
    org_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    color   TEXT NOT NULL DEFAULT '#C9C2D9',
    UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS transactions (
    id          BIGSERIAL PRIMARY KEY,
    org_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    type        TEXT NOT NULL CHECK (type IN ('income', 'expense')),
    amount      NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    category_id INTEGER REFERENCES categories(id),
    source      TEXT,
    description TEXT,
    occurred_on DATE NOT NULL,
    occurred_at TIME,
    who_id      INTEGER REFERENCES users(id),
    comment     TEXT,
    created_by  INTEGER REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_org_date ON transactions (org_id, occurred_on DESC);

CREATE TABLE IF NOT EXISTS transaction_history (
    id              BIGSERIAL PRIMARY KEY,
    transaction_id  BIGINT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    changed_by      INTEGER REFERENCES users(id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    old_values      JSONB NOT NULL,
    new_values      JSONB NOT NULL
);

CREATE OR REPLACE FUNCTION log_transaction_change() RETURNS TRIGGER AS $$
BEGIN
    IF (OLD.amount, OLD.type, OLD.category_id, OLD.description) IS DISTINCT FROM
       (NEW.amount, NEW.type, NEW.category_id, NEW.description) THEN
        INSERT INTO transaction_history (transaction_id, changed_by, old_values, new_values)
        VALUES (OLD.id, NEW.created_by, to_jsonb(OLD), to_jsonb(NEW));
    END IF;
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transaction_history ON transactions;
CREATE TRIGGER trg_transaction_history
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION log_transaction_change();

CREATE OR REPLACE VIEW org_balances AS
SELECT
    org_id,
    COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0)  AS total_income,
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS total_expense,
    COALESCE(SUM(amount) FILTER (WHERE type = 'income'), 0) -
    COALESCE(SUM(amount) FILTER (WHERE type = 'expense'), 0) AS balance
FROM transactions
GROUP BY org_id;
