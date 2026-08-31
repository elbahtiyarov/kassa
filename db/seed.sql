-- Демо-данные: организации, категории, пользователи и реальные записи по «Аланди» за август 2026

INSERT INTO organizations (name) VALUES ('Аланди'), ('Зия')
ON CONFLICT (name) DO NOTHING;

-- Пользователи (Админ/Алма/Динара) создаются отдельно в migrate.js —
-- там пароли по-настоящему хешируются через bcrypt, а не хранятся текстом.

-- Категории для каждой организации
INSERT INTO categories (org_id, name, color)
SELECT o.id, c.name, c.color
FROM organizations o
CROSS JOIN (VALUES
    ('Логистика/Доставка', '#F3A26D'),
    ('Материалы',          '#5FCBBF'),
    ('Зарплата/Авансы',    '#F4D35E'),
    ('Аренда',              '#B08BFF'),
    ('Такси',               '#7FB2F0'),
    ('Реклама',             '#F08FC0'),
    ('Оборудование',        '#8FD19E'),
    ('Личные вложения',     '#E39B9B'),
    ('Прочее',              '#C9C2D9')
) AS c(name, color)
ON CONFLICT (org_id, name) DO NOTHING;

-- Реальные операции по «Аланди» (перенесены из исходного файла расходов)
WITH org AS (SELECT id FROM organizations WHERE name = 'Аланди'),
     alma AS (SELECT id FROM users WHERE name = 'Алма'),
     dinara AS (SELECT id FROM users WHERE name = 'Динара')
INSERT INTO transactions (org_id, type, amount, category_id, source, description, occurred_on, who_id, comment, created_by)
SELECT org.id, 'income', 50000, NULL, 'аланди', NULL, '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 1090, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Логистика/Доставка'), NULL, 'доставка', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 1950, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Логистика/Доставка'), NULL, 'доставка', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 2000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Материалы'), NULL, 'краска', '2026-08-21'::date, alma.id, 'для колы буквы', alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 10000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Прочее'), NULL, 'нурбек кола', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 5000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Материалы'), NULL, 'болты шурупы', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 4770, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Логистика/Доставка'), NULL, 'доставка', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 1800, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Логистика/Доставка'), NULL, 'доставка', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 3980, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Логистика/Доставка'), NULL, 'доставка', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 8000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Логистика/Доставка'), NULL, 'доставка', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 11410, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Зарплата/Авансы'), NULL, 'аванс Алма', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'income', 50000, NULL, 'Едил', NULL, '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 9000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Прочее'), NULL, 'уборка', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'income', 30000, NULL, 'Жанара', NULL, '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 42000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Аренда'), NULL, 'аренда фермы', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 4450, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Материалы'), NULL, 'саморез', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 4860, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Такси'), NULL, 'такси', '2026-08-21'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 4000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Такси'), NULL, 'такси', '2026-08-21'::date, NULL, 'Остаток на конец дня: 15690 ₸', alma.id FROM org, alma
UNION ALL SELECT org.id, 'income', 50000, NULL, 'аланди', NULL, '2026-08-22'::date, dinara.id, NULL, dinara.id FROM org, dinara
UNION ALL SELECT org.id, 'expense', 5000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Зарплата/Авансы'), NULL, 'турсун аванс', '2026-08-22'::date, dinara.id, NULL, dinara.id FROM org, dinara
UNION ALL SELECT org.id, 'expense', 10000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Зарплата/Авансы'), NULL, 'нурбек аванс', '2026-08-22'::date, dinara.id, NULL, dinara.id FROM org, dinara
UNION ALL SELECT org.id, 'expense', 35000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Зарплата/Авансы'), NULL, 'талгат за работы', '2026-08-22'::date, dinara.id, NULL, dinara.id FROM org, dinara
UNION ALL SELECT org.id, 'expense', 5100, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Такси'), NULL, 'такси кола нурбек', '2026-08-22'::date, alma.id, 'остаток 15690', alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 3460, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Такси'), NULL, 'такси', '2026-08-22'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 4920, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Такси'), NULL, 'такси', '2026-08-23'::date, alma.id, NULL, alma.id FROM org, alma
UNION ALL SELECT org.id, 'expense', 3890, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Такси'), NULL, 'такси', '2026-08-23'::date, alma.id, '1680 добавила Алма', alma.id FROM org, alma
UNION ALL SELECT org.id, 'income', 65000, NULL, 'аланди', NULL, '2026-08-23'::date, dinara.id, NULL, dinara.id FROM org, dinara
UNION ALL SELECT org.id, 'expense', 65000, (SELECT id FROM categories WHERE org_id = org.id AND name = 'Зарплата/Авансы'), NULL, 'сымбат 1 неделя зп', '2026-08-23'::date, dinara.id, NULL, dinara.id FROM org, dinara;
