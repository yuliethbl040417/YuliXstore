CREATE TABLE IF NOT EXISTS admins (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  diamonds INTEGER UNIQUE NOT NULL CHECK (diamonds > 0),
  display_diamonds TEXT NOT NULL,
  price_cop INTEGER NOT NULL CHECK (price_cop > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  player_id TEXT NOT NULL,
  player_nickname TEXT,
  product_id BIGINT REFERENCES products(id),
  product_diamonds INTEGER NOT NULL,
  amount_cop INTEGER NOT NULL,
  payment_method TEXT,
  payment_status TEXT NOT NULL DEFAULT 'PENDING',
  payment_reference TEXT,
  receipt_url TEXT,
  payment_note TEXT,
  payer_name TEXT,
  payer_phone TEXT,
  topup_status TEXT NOT NULL DEFAULT 'NOT_SENT',
  provider_name TEXT,
  provider_order_id TEXT,
  provider_status TEXT,
  approved_at TIMESTAMPTZ,
  approved_by BIGINT REFERENCES admins(id),
  user_id BIGINT REFERENCES users(id),
  catalog_item_id BIGINT,
  product_kind TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  player_region TEXT,
  player_email TEXT,
  wompi_transaction_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  reference TEXT,
  status TEXT NOT NULL,
  amount_cop INTEGER,
  receipt_url TEXT,
  note TEXT,
  raw_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS orders_wompi_transaction_id_uq
  ON orders(wompi_transaction_id) WHERE wompi_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS store_settings (
  id INTEGER PRIMARY KEY CHECK (id=1),
  maintenance BOOLEAN NOT NULL DEFAULT FALSE,
  maintenance_message TEXT NOT NULL DEFAULT 'Estamos realizando mejoras. Volveremos muy pronto.',
  floating_active BOOLEAN NOT NULL DEFAULT TRUE,
  floating_message TEXT NOT NULL DEFAULT 'Horario de atención: 10:00 a. m. a 12:00 a. m.',
  notice_active BOOLEAN NOT NULL DEFAULT FALSE,
  notice_title TEXT NOT NULL DEFAULT '',
  notice_message TEXT NOT NULL DEFAULT '',
  notice_type TEXT NOT NULL DEFAULT 'info',
  notice_button_text TEXT NOT NULL DEFAULT '',
  notice_button_url TEXT NOT NULL DEFAULT '',
  support_whatsapp TEXT NOT NULL DEFAULT '573136636853',
  attention_hours TEXT NOT NULL DEFAULT '10:00 a. m. a 12:00 a. m.',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT,
  quantity INTEGER,
  secondary_quantity INTEGER,
  price_cop INTEGER NOT NULL DEFAULT 0,
  delivery_note TEXT,
  whatsapp BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS promotions (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO store_settings(id) VALUES(1) ON CONFLICT (id) DO NOTHING;

INSERT INTO products(diamonds,display_diamonds,price_cop,active) VALUES
(110,'110',3500,true),(341,'341',10000,true),(572,'572',15500,true),
(1166,'1.166',30000,true),(2398,'2.398',60000,true),(6160,'6.160',145000,true)
ON CONFLICT (diamonds) DO NOTHING;

INSERT INTO catalog_items(kind,title,subtitle,price_cop,active,sort_order,whatsapp)
SELECT v.kind,v.title,v.subtitle,v.price_cop,v.active,v.sort_order,v.whatsapp
FROM (VALUES
('pass_id','Pase por ID','Compra por WhatsApp',9500,true,10,true),
('pass_email','Pase por correo','Entrega digital en tu cuenta',7500,false,20,false),
('membership_weekly','Membresía semanal','340 💎',6900,true,30,true),
('membership_monthly','Membresía mensual','1.800 💎',32500,true,40,true),
('tokens','Fragmentos universales','Entrega digital',155,false,50,false),
('boxes','Cajas universales','Entrega digital',775,false,60,false),
('one_time','Diamantes 1 vez por ID','Promoción especial para algunos usuarios',3000,true,70,true)
) AS v(kind,title,subtitle,price_cop,active,sort_order,whatsapp)
WHERE NOT EXISTS (SELECT 1 FROM catalog_items c WHERE c.kind=v.kind);

-- Migraciones seguras para bases creadas con versiones anteriores.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payer_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payer_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS support_whatsapp TEXT NOT NULL DEFAULT '573136636853';
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS attention_hours TEXT NOT NULL DEFAULT '10:00 a. m. a 12:00 a. m.';
ALTER TABLE orders DROP COLUMN IF EXISTS wompi_transaction_id;
ALTER TABLE orders DROP COLUMN IF EXISTS wompi_reference;
ALTER TABLE payments DROP COLUMN IF EXISTS wompi_transaction_id;
ALTER TABLE payments DROP COLUMN IF EXISTS raw_event;
