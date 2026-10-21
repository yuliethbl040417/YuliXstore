import express from "express";
import dotenv from "dotenv";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import crypto from "crypto";

dotenv.config();

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  console.warn("Faltan DATABASE_URL o JWT_SECRET en .env");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(express.json({ limit: "8mb" }));
app.set("trust proxy", 1);

const allowedOrigins = (process.env.FRONTEND_ORIGINS || "https://yuliethbl040417.github.io,https://yulixstore.com,https://www.yulixstore.com")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes("*") || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
app.use("/api/", apiLimiter);

async function q(text, params = []) {
  return pool.query(text, params);
}

function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "No autorizado" });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    if (req.admin.role !== "admin") return res.status(403).json({ error: "Acceso de administrador requerido" });
    next();
  } catch {
    return res.status(401).json({ error: "Sesión inválida" });
  }
}

function makeOrderNumber() {
  return `YX-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}


const JADH_BASE_URL = (process.env.JADH_BASE_URL || "https://jadh.co/api/v1").replace(/\/+$/, "");

function jadhHeaders() {
  const key = process.env.JADH_API_KEY;
  if (!key) throw new Error("Falta JADH_API_KEY en las variables de entorno.");
  return {
    "Content-Type": "application/json",
    "X-API-Key": key
  };
}

async function jadhRequest(path, options = {}) {
  const response = await fetch(`${JADH_BASE_URL}${path}`, {
    ...options,
    headers: { ...jadhHeaders(), ...(options.headers || {}) }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || data?.error || `JADH respondió ${response.status}`;
    throw new Error(message);
  }
  return data;
}

/*
  Mapeo de los productos de YuliXstore a JADH.
  Ejemplo de variable de entorno:
  JADH_PRODUCT_MAP={"110":{"package_id":"...","product_id":"..."}}
  Los IDs reales deben salir de GET /products de JADH.
*/
function jadhProductMap() {
  const confirmed = {
    "110":  { package_id: "269", product_id: "57" },
    "341":  { package_id: "270", product_id: "57" },
    "572":  { package_id: "271", product_id: "57" },
    "1166": { package_id: "272", product_id: "57" },
    "2398": { package_id: "273", product_id: "57" },
    "6160": { package_id: "274", product_id: "57" }
  };

  if (!process.env.JADH_PRODUCT_MAP) return confirmed;

  try {
    return { ...confirmed, ...JSON.parse(process.env.JADH_PRODUCT_MAP) };
  } catch {
    throw new Error("JADH_PRODUCT_MAP no contiene JSON válido.");
  }
}

function getJadhProduct(diamonds) {
  const map = jadhProductMap();
  const item = map[String(diamonds)];
  if (!item?.package_id || !item?.product_id) {
    throw new Error(`No hay mapeo JADH configurado para ${diamonds} diamantes.`);
  }
  return item;
}

async function jadhGetProducts() {
  return jadhRequest("/products", { method: "GET" });
}

async function jadhGetBalance() {
  return jadhRequest("/balance", { method: "GET" });
}

async function sendDiamondOrderToJadh(order) {
  const mapped = getJadhProduct(order.product_diamonds);

  const payload = {
    package_id: mapped.package_id,
    product_id: mapped.product_id,
    player_id: order.player_id,
    external_order_id: order.order_number,
    wait: false
  };

  if (mapped.quantity != null) payload.quantity = Number(mapped.quantity);
  if (mapped.fields != null) payload.fields = mapped.fields;
  if (mapped.player_id2 != null) payload.player_id2 = String(mapped.player_id2);

  const data = await jadhRequest("/recharge", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  return {
    provider_order_id: String(data?.order_id ?? data?.id ?? data?.order?.id ?? ""),
    provider_status: String(data?.status ?? data?.order?.status ?? "EN_COLA"),
    raw: data
  };
}

function normalizeJadhStatus(value) {
  const s = String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (s.includes("fall") || s.includes("fail") || s.includes("error")) return "FAILED";
  if (s.includes("complet") || s.includes("success")) return "COMPLETED";
  if (s.includes("proces") || s.includes("revision") || s.includes("review")) return "PROCESSING";
  if (s.includes("cola") || s.includes("queue") || s.includes("pend")) return "QUEUED";
  return null;
}

function extractJadhStatus(data) {
  return data?.status ?? data?.order?.status ?? data?.data?.status ?? data?.data?.order?.status ?? "";
}

async function jadhGetOrderStatus(externalOrderId) {
  const data = await jadhRequest(`/order-status?external_order_id=${encodeURIComponent(externalOrderId)}`, { method: "GET" });
  return {
    raw: data,
    provider_order_id: String(data?.order_id ?? data?.id ?? data?.order?.id ?? data?.data?.order_id ?? data?.data?.id ?? "") || null,
    provider_status: String(extractJadhStatus(data) || "") || null
  };
}

async function syncPendingJadhOrders() {
  try {
    const r = await q(`SELECT id,order_number,provider_order_id,topup_status FROM orders WHERE provider_name='JADH' AND topup_status IN ('QUEUED','PROCESSING') ORDER BY updated_at ASC LIMIT 50`);
    for (const order of r.rows) {
      try {
        const result = await jadhGetOrderStatus(order.order_number);
        const normalized = normalizeJadhStatus(result.provider_status);
        if (!normalized) continue;
        await q(`UPDATE orders SET topup_status=$1, provider_order_id=COALESCE($2,provider_order_id), provider_status=COALESCE($3,provider_status), updated_at=NOW() WHERE id=$4`, [normalized,result.provider_order_id,result.provider_status,order.id]);
      } catch (e) {
        console.warn(`JADH status ${order.order_number}:`, e.message || e);
      }
    }
  } catch (e) {
    console.warn("JADH status sync:", e.message || e);
  }
}

async function processApprovedJadhOrder(order) {
  if (order.payment_status !== "APPROVED") {
    throw new Error("El pago del pedido todavía no está aprobado.");
  }

  if (order.topup_status === "COMPLETED" || order.topup_status === "PROCESSING") {
    return {
      skipped: true,
      message: "El pedido ya fue enviado/procesado y no se debe reenviar."
    };
  }

  const result = await sendDiamondOrderToJadh(order);

  return result;
}

async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      diamonds INTEGER NOT NULL UNIQUE,
      display_diamonds TEXT NOT NULL,
      price_cop INTEGER NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      player_id TEXT NOT NULL,
      player_nickname TEXT,
      product_id BIGINT NOT NULL REFERENCES products(id),
      product_diamonds INTEGER NOT NULL,
      amount_cop INTEGER NOT NULL,
      payment_method TEXT,
      payment_status TEXT NOT NULL DEFAULT 'PENDING',
      payment_reference TEXT,
      receipt_url TEXT,
      payment_note TEXT,
      topup_status TEXT NOT NULL DEFAULT 'NOT_SENT',
      provider_name TEXT,
      provider_order_id TEXT,
      provider_status TEXT,
      approved_at TIMESTAMPTZ,
      approved_by BIGINT REFERENCES admins(id),
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

    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS receipt_url TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_note TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payer_name TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payer_email TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS payer_phone TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS provider_name TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS approved_by BIGINT REFERENCES admins(id);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
    ALTER TABLE orders ALTER COLUMN product_id DROP NOT NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS catalog_item_id BIGINT REFERENCES catalog_items(id);
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_kind TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS player_region TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS player_email TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS wompi_transaction_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS orders_wompi_transaction_id_uq ON orders(wompi_transaction_id) WHERE wompi_transaction_id IS NOT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
    ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS support_whatsapp TEXT NOT NULL DEFAULT '573136636853';
    ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS attention_hours TEXT NOT NULL DEFAULT '10:00 a. m. a 12:00 a. m.';


    ALTER TABLE payments ADD COLUMN IF NOT EXISTS method TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_url TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS note TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS raw_data JSONB;
    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

  `);
  await q(`INSERT INTO store_settings(id) VALUES(1) ON CONFLICT (id) DO NOTHING`);
  // Actualiza los precios de los productos especiales sin activar entregas no configuradas.
  await q(`UPDATE catalog_items SET title='Fragmentos universales',subtitle='Entrega digital',price_cop=155,
    metadata=metadata || '{"min_quantity":35,"max_quantity":1400}'::jsonb,updated_at=NOW() WHERE kind='tokens'`);
  await q(`UPDATE catalog_items SET title='Cajas universales',subtitle='Entrega digital',price_cop=775,
    metadata=metadata || '{"min_quantity":7,"max_quantity":280}'::jsonb,updated_at=NOW() WHERE kind='boxes'`);
  await q(`UPDATE catalog_items SET subtitle='Entrega digital en tu cuenta',updated_at=NOW() WHERE kind='pass_email'`);
  // Migrate the known legacy promo values to the owner's confirmed prices, preserving later admin edits.
  await q(`UPDATE catalog_items SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{prices}','[3000,8500,14000,25000,55000,135000]'::jsonb,true),price_cop=3000,updated_at=NOW()
    WHERE kind='one_time' AND (NOT (COALESCE(metadata,'{}'::jsonb) ? 'prices') OR metadata->'prices'='[3000,9500,15000,28000,57000,135000]'::jsonb)`);
}

async function seedProducts() {
  const products = [
    [110, "110", 3500],
    [341, "341", 10000],
    [572, "572", 15500],
    [1166, "1.166", 30000],
    [2398, "2.398", 60000],
    [6160, "6.160", 145000]
  ];

  for (const [diamonds, display, price] of products) {
    const existing = await q(
      `SELECT id FROM products WHERE diamonds=$1`,
      [diamonds]
    );
    if (existing.rowCount === 0) {
      await q(
        `INSERT INTO products(diamonds,display_diamonds,price_cop,active)
         VALUES($1,$2,$3,true)`,
        [diamonds, display, price]
      );
    } else {
      await q(
        `UPDATE products SET display_diamonds=$2, updated_at=NOW() WHERE diamonds=$1`,
        [diamonds, display]
      );
    }
  }
  // Correct only the known legacy value; do not overwrite later admin-edited prices.
  await q("UPDATE products SET price_cop=10000,updated_at=NOW() WHERE diamonds=341 AND price_cop=9500");
}


async function seedAdminFromEnv() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!email || !password) return;
  const count = await q("SELECT COUNT(*)::int AS count FROM admins");
  if (count.rows[0].count > 0) return;
  if (password.length < 12) throw new Error("ADMIN_PASSWORD debe tener al menos 12 caracteres.");
  const hash = await bcrypt.hash(password, 12);
  await q("INSERT INTO admins(email,password_hash) VALUES($1,$2)", [email, hash]);
  console.log("Administrador inicial creado desde ADMIN_EMAIL.");
}

async function seedCatalog() {
  const count = await q("SELECT COUNT(*)::int AS count FROM catalog_items");
  if (count.rows[0].count > 0) return;
  const rows = [
    ["pass_id","Pase por ID","Compra por WhatsApp",9500,true,10],
    ["pass_email","Pase por correo","Entrega digital en tu cuenta",7500,true,20],
    ["membership_weekly","Membresía semanal","340 💎",6900,true,30],
    ["membership_monthly","Membresía mensual","1.800 💎",32500,true,40],
    ["tokens","Fragmentos universales","Entrega digital",136,true,50],
    ["boxes","Cajas universales","Entrega digital",680,true,60],
    ["one_time","Diamantes 1 vez por ID","Promoción especial para algunos usuarios",3000,true,70]
  ];
  for (const [kind,title,subtitle,price,active,sort_order] of rows) {
    await q(`INSERT INTO catalog_items(kind,title,subtitle,price_cop,active,sort_order,whatsapp) VALUES($1,$2,$3,$4,$5,$6,true)`,[kind,title,subtitle,price,active,sort_order]);
  }
  await q(`UPDATE catalog_items SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{prices}','[3000,8500,14000,25000,55000,135000]'::jsonb,true),price_cop=3000,updated_at=NOW() WHERE kind='one_time'`);
}



// Integración de pagos. Las llaves privadas permanecen únicamente en el servidor.
const WOMPI_API_BASE = (process.env.WOMPI_API_BASE ||
  (process.env.WOMPI_ENV === "production" ? "https://production.wompi.co/v1" : "https://sandbox.wompi.co/v1")).replace(/\/+$/, "");
const WOMPI_PUBLIC_KEY = process.env.WOMPI_PUBLIC_KEY || "";
const WOMPI_PRIVATE_KEY = process.env.WOMPI_PRIVATE_KEY || "";
const WOMPI_INTEGRITY_SECRET = process.env.WOMPI_INTEGRITY_SECRET || "";
const WOMPI_EVENTS_SECRET = process.env.WOMPI_EVENTS_SECRET || "";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function safeEqualHex(a, b) {
  try {
    const aa = Buffer.from(String(a || ""), "hex");
    const bb = Buffer.from(String(b || ""), "hex");
    return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
  } catch { return false; }
}
async function wompiRequest(path, options = {}) {
  if (!WOMPI_PUBLIC_KEY || !WOMPI_PRIVATE_KEY) throw new Error("Falta configurar la pasarela en el servidor.");
  const response = await fetch(`${WOMPI_API_BASE}${path}`, {
    ...options,
    headers: { Accept: "application/json", "Content-Type": "application/json",
      Authorization: `Bearer ${WOMPI_PRIVATE_KEY}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Payment API error", response.status, JSON.stringify(data).slice(0, 600));
    throw new Error("No se pudo iniciar el pago. Verifica los datos o intenta otro método.");
  }
  return data?.data ?? data;
}
async function wompiAcceptanceToken() {
  const merchant = await wompiRequest(`/merchants/${encodeURIComponent(WOMPI_PUBLIC_KEY)}`, { method: "GET" });
  const token = merchant?.presigned_acceptance?.acceptance_token;
  if (!token) throw new Error("No fue posible preparar la aceptación del pago.");
  return token;
}
function wompiPaymentMethodType(method) {
  return ({
    card: "CARD",
    nequi: "NEQUI",
    bancolombia: "BANCOLOMBIA_TRANSFER",
    qr: "BANCOLOMBIA_QR",
    pse: "PSE",
    daviplata: "DAVIPLATA"
  })[String(method || "").toLowerCase()] || null;
}
function safePublicError(err) {
  // Never expose provider/API internals to customers.
  const msg = String(err?.message || "");
  return /Falta configurar|No fue posible|No se pudo iniciar|datos/i.test(msg)
    ? msg : "No pudimos iniciar el pago en este momento. Inténtalo nuevamente.";
}

const SIXOFIRE_BASE_URL = (process.env.SIXOFIRE_BASE_URL || "https://api.sixofire.net").replace(/\/+$/, "");

const SIXOFIRE_REGIONS = ["SAC","BR","US","NA","IND","CIS","ID","PK","ME","RU","SG","TH","TW","VN"];
function accountNickname(data) {
  const candidates = [
    data?.data?.basicInfo?.nickname, data?.data?.basicInfo?.player_name,
    data?.player_name, data?.nickname, data?.name, data?.username,
    data?.account?.player_name, data?.account?.nickname, data?.account?.name,
    data?.data?.player_name, data?.data?.nickname, data?.data?.name,
    data?.data?.account?.player_name, data?.data?.account?.nickname, data?.data?.account?.name
  ];
  return candidates.find(v => typeof v === "string" && v.trim())?.trim() || "";
}
async function lookupSixofireAccount(uid) {
  const apiKey = process.env.SIXOFIRE_API_KEY;
  if (!apiKey) throw Object.assign(new Error("La verificación no está disponible en este momento."), { status: 503 });
  let lastStatus = 404;
  for (const region of SIXOFIRE_REGIONS) {
    const url = `${SIXOFIRE_BASE_URL}/account/info?uid=${encodeURIComponent(uid)}&region=${encodeURIComponent(region)}`;
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { "X-API-Key": apiKey, "Accept": "application/json" },
        signal: AbortSignal.timeout(8000)
      });
    } catch (error) {
      // A timeout/network failure is not evidence that the ID is invalid.
      console.warn("Account verification temporarily unavailable");
      throw Object.assign(new Error("No fue posible verificar la cuenta en este momento. Inténtalo nuevamente."), { status: 502 });
    }
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
      const nickname = accountNickname(data);
      if (nickname) {
        const reportedRegion = String(data?.data?.basicInfo?.region || data?.data?.region || data?.region || region).trim().toUpperCase();
        return { nickname, region: SIXOFIRE_REGIONS.includes(reportedRegion) ? reportedRegion : region };
      }
      // A 200 response without account identity is not a successful verification.
      continue;
    }
    lastStatus = response.status;
    if ([401,403,429].includes(response.status)) {
      console.error("Account verification service unavailable", response.status);
      throw Object.assign(new Error("No fue posible verificar la cuenta en este momento. Inténtalo más tarde."), { status: 502 });
    }
    // 404 / region mismatch: try the next supported region automatically.
  }
  throw Object.assign(new Error(lastStatus === 404 ? "No se encontró una cuenta verificable con ese ID." : "No se pudo verificar la cuenta. Revisa el ID e inténtalo nuevamente."), { status: 404 });
}

app.post("/api/verify-name-sixofire", async (req, res) => {
  const uid = String(req.body?.player_id || req.body?.uid || "").trim();
  if (!/^\d{8,12}$/.test(uid)) return res.status(400).json({ error: "El ID debe tener entre 8 y 12 dígitos." });
  try {
    const account = await lookupSixofireAccount(uid);
    // Provider name and internal API details are intentionally not exposed to the customer.
    return res.json({ ok: true, player_id: uid, player_name: account.nickname, nickname: account.nickname, region: account.region });
  } catch (e) {
    const status = Number(e.status) || 502;
    return res.status(status).json({ error: e.message || "No fue posible verificar la cuenta en este momento." });
  }
});

app.get("/", (_req, res) => res.json({ service: "YuliXstore API", status: "online", health: "/api/health" }));

app.get("/api/health", async (_req, res) => {
  try {
    await q("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch {
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});


app.post("/api/account/register", async (req,res)=>{
  try{
    const name=String(req.body.name||"").trim(); const email=String(req.body.email||"").trim().toLowerCase(); const password=String(req.body.password||"");
    if(!name||!email||password.length<8) return res.status(400).json({error:"Completa tu nombre, correo y una contraseña de al menos 8 caracteres."});
    const exists=await q("SELECT id FROM users WHERE email=$1",[email]); if(exists.rows[0]) return res.status(409).json({error:"Ya existe una cuenta con ese correo."});
    const hash=await bcrypt.hash(password,12); const r=await q("INSERT INTO users(name,email,password_hash) VALUES($1,$2,$3) RETURNING id,name,email",[name,email,hash]);
    const u=r.rows[0]; const token=jwt.sign({id:u.id,email:u.email,role:"user"},process.env.JWT_SECRET,{expiresIn:"30d"}); res.status(201).json({token,user:u});
  }catch(e){console.error(e);res.status(500).json({error:"No se pudo crear la cuenta."});}
});
app.post("/api/account/login", async (req,res)=>{
  try{const email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");const r=await q("SELECT id,name,email,password_hash FROM users WHERE email=$1",[email]);const u=r.rows[0];if(!u||!(await bcrypt.compare(password,u.password_hash)))return res.status(401).json({error:"Correo o contraseña incorrectos."});const token=jwt.sign({id:u.id,email:u.email,role:"user"},process.env.JWT_SECRET,{expiresIn:"30d"});res.json({token,user:{id:u.id,name:u.name,email:u.email}});}catch(e){console.error(e);res.status(500).json({error:"No se pudo iniciar sesión."});}
});
function userAuth(req,res,next){const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");if(!token)return res.status(401).json({error:"Debes iniciar sesión."});try{const p=jwt.verify(token,process.env.JWT_SECRET);if(p.role!=="user")return res.status(403).json({error:"Sesión de cliente inválida."});req.user=p;next();}catch{return res.status(401).json({error:"Sesión inválida."});}}
app.get("/api/account/me",userAuth,async(req,res)=>{const r=await q("SELECT id,name,email,created_at FROM users WHERE id=$1",[req.user.id]);if(!r.rows[0])return res.status(404).json({error:"Cuenta no encontrada."});res.json({user:r.rows[0]});});
app.get("/api/account/orders",userAuth,async(req,res)=>{const r=await q("SELECT order_number,player_id,player_nickname,product_diamonds,amount_cop,payment_method,payment_status,topup_status,provider_name,provider_status,created_at,updated_at FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[req.user.id]);res.json({orders:r.rows});});

app.post("/api/admin/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const envEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const envPassword = String(process.env.ADMIN_PASSWORD || "");
    if (envEmail && envPassword && email === envEmail && password === envPassword && envPassword.length >= 12) {
      const hash = await bcrypt.hash(envPassword, 12);
      await q(`INSERT INTO admins(email,password_hash) VALUES($1,$2) ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash`, [envEmail, hash]);
    }
    const result = await q("SELECT id,email,password_hash FROM admins WHERE email=$1", [email]);
    const admin = result.rows[0];

    if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
      return res.status(401).json({ error: "Credenciales incorrectas" });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: "admin" },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({ token, admin: { id: admin.id, email: admin.email } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo iniciar sesión" });
  }
});

app.post("/api/admin/setup", async (req, res) => {
  try {
    const count = await q("SELECT COUNT(*)::int AS count FROM admins");
    if (count.rows[0].count > 0) {
      return res.status(403).json({ error: "La configuración inicial ya fue realizada" });
    }

    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || password.length < 12) {
      return res.status(400).json({ error: "Usa un correo y una contraseña de al menos 12 caracteres" });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await q(
      "INSERT INTO admins(email,password_hash) VALUES($1,$2) RETURNING id,email",
      [email, hash]
    );
    res.status(201).json({ admin: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo crear el administrador" });
  }
});


app.post("/api/verify-name", async (req, res) => {
  const playerId = String(req.body.player_id || "").trim();
  if (!/^\d{5,15}$/.test(playerId)) return res.status(400).json({ error: "ID de jugador inválido." });
  try {
    const data = await jadhRequest("/verify-name", { method:"POST", body: JSON.stringify({ game:"freefire", player_id:playerId }) });
    return res.json({ ok:true, player_id:playerId, player_name:data.player_name || "" });
  } catch (e) {
    const msg = String(e.message || "");
    if (/404|no existe|not found/i.test(msg)) return res.status(404).json({ error:"No encontramos una cuenta de Free Fire con ese ID." });
    if (/503|no disponible|unavailable/i.test(msg)) return res.status(503).json({ error:"La verificación de la cuenta no está disponible en este momento." });
    console.error("JADH verify-name:",e);
    return res.status(502).json({ error:"No se pudo verificar el ID en este momento." });
  }
});

app.get("/api/store/config", async (_req,res)=>{
  try {
    const s=(await q("SELECT maintenance,maintenance_message,floating_active,floating_message,notice_active,notice_title,notice_message,notice_type,notice_button_text,notice_button_url,support_whatsapp,attention_hours FROM store_settings WHERE id=1")).rows[0];
    const items=(await q("SELECT id,kind,title,subtitle,quantity,secondary_quantity,price_cop,delivery_note,whatsapp,active,sort_order,metadata FROM catalog_items WHERE active=true ORDER BY sort_order,id")).rows;
    res.setHeader("Cache-Control","no-store"); res.json({settings:s||{},items});
  } catch(e){console.error(e);res.status(500).json({error:"No se pudo cargar la configuración de la tienda."});}
});

app.get("/api/store/catalog", async (_req,res)=>{
  res.setHeader("Cache-Control", "no-store");
  const items=(await q("SELECT id,kind,title,subtitle,quantity,secondary_quantity,price_cop,delivery_note,whatsapp,active,sort_order,metadata FROM catalog_items WHERE active=true ORDER BY sort_order,id")).rows;
  res.json({items});
});

app.get("/api/store/payment-methods", async (_req,res)=>{
  res.json({nequi_number:process.env.NEQUI_NUMBER||"",breb_key:process.env.BREB_KEY||"",qr_url:process.env.PAYMENT_QR_URL||""});
});


// Devuelve solo la llave pública necesaria para iniciar el checkout en el navegador.
app.get("/api/store/payment-config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ public_key: WOMPI_PUBLIC_KEY, api_base: WOMPI_API_BASE });
});

app.get("/api/wompi/pse-banks", async (_req, res) => {
  try {
    if (!WOMPI_PUBLIC_KEY) return res.status(503).json({ error: "El pago bancario no está configurado." });
    const response = await fetch(`${WOMPI_API_BASE}/pse/financial_institutions`, {
      headers: { Authorization: `Bearer ${WOMPI_PUBLIC_KEY}`, Accept: "application/json" },
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("No fue posible cargar la lista de bancos.");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ institutions: data?.data || [] });
  } catch (e) {
    res.status(502).json({ error: safePublicError(e) });
  }
});

function validateSpecialProduct(kind, catalogItem) {
  const allowed = new Set(["pass_email", "tokens", "boxes", "membership_weekly", "membership_monthly"]);
  return allowed.has(String(kind || "").toLowerCase()) && catalogItem && catalogItem.kind === String(kind).toLowerCase();
}
function sixofireProductMap() {
  // IDs supplied in the owner's SixoFire documentation. Quantity support is
  // intentionally off until the authenticated catalog confirms `amount`.
  const defaults = {
    pass_email: { product_id: "76828" },
    tokens: { product_id: "17729", supports_amount: true, min_amount: 35, max_amount: 1400 },
    boxes: { product_id: "8816", supports_amount: true, min_amount: 7, max_amount: 280 },
    membership_weekly: { product_id: "8509" },
    membership_monthly: { product_id: "3752" }
  };
  try {
    const configured = JSON.parse(process.env.SIXOFIRE_PRODUCT_MAP || "{}");
    return configured && typeof configured === "object"
      ? Object.fromEntries(Object.entries(defaults).map(([kind, value]) => [kind, { ...value, ...(configured[kind] || {}) }]).concat(Object.entries(configured).filter(([kind]) => !(kind in defaults))))
      : defaults;
  } catch { throw new Error("La configuración de productos no es válida."); }
}
async function sixofireRequest(path, options = {}) {
  const key = process.env.SIXOFIRE_API_KEY;
  if (!key) throw new Error("La entrega de este producto aún no está configurada.");
  const response = await fetch(`${SIXOFIRE_BASE_URL}${path}`, {
    ...options,
    headers: { "X-API-Key": key, Accept: "application/json", "Content-Type": "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(30000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("Special delivery response", response.status, JSON.stringify(data).slice(0, 500));
    throw new Error("No se pudo completar la entrega automática.");
  }
  return data;
}
async function sendSpecialOrderToSixofire(order) {
  const mapping = sixofireProductMap()[order.product_kind];
  const providerProductId = String(mapping?.product_id || mapping?.id || "");
  // Do not guess provider product IDs: they must come from the authenticated catalog.
  if (!/^\d{4,5}$/.test(providerProductId)) throw new Error("Este producto todavía no tiene una referencia de entrega configurada.");
  const body = { uid: String(order.player_id), product_id: providerProductId };
  const quantity = Math.max(1, Number(order.quantity || 1));
  if (!Number.isInteger(quantity)) throw new Error("La cantidad del producto no es válida.");
  if (quantity > 1 && mapping?.supports_amount !== true) {
    throw new Error("La cantidad de este producto aún no está configurada para entrega automática.");
  }
  if (mapping?.min_amount != null && quantity < Number(mapping.min_amount)) {
    throw new Error(`La cantidad mínima para este producto es ${Number(mapping.min_amount)}.`);
  }
  if (mapping?.max_amount != null && quantity > Number(mapping.max_amount)) {
    throw new Error(`La cantidad máxima para este producto es ${Number(mapping.max_amount)}.`);
  }
  if (quantity > 1) body.amount = quantity;
  // Según la documentación, message solo aplica a artículos de tipo GIFT.
  // No se envía por defecto para evitar rechazos MESSAGE_NOT_APPLICABLE.
  if (String(mapping?.type || "").toUpperCase() === "GIFT" && mapping?.message) {
    body.message = String(mapping.message).slice(0, 120);
  }
  const data = await sixofireRequest("/account/shop/order", { method: "POST", body: JSON.stringify(body) });
  return {
    provider_order_id: String(data?.order_id ?? data?.id ?? data?.data?.order_id ?? data?.data?.id ?? "") || null,
    provider_status: String(data?.status ?? data?.data?.status ?? "PROCESSING"),
    raw: data
  };
}

async function deliverPaidOrder(orderNumber) {
  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT * FROM orders WHERE order_number=$1 FOR UPDATE", [orderNumber]);
    order = found.rows[0];
    if (!order) { await client.query("ROLLBACK"); return; }
    if (order.payment_status !== "APPROVED" || ["PROCESSING","COMPLETED"].includes(order.topup_status)) {
      await client.query("ROLLBACK"); return;
    }
    await client.query("UPDATE orders SET topup_status='PROCESSING',updated_at=NOW() WHERE id=$1", [order.id]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    throw e;
  } finally { client.release(); }

  try {
    let result;
    if (order.product_kind) {
      result = await sendSpecialOrderToSixofire(order);
      const status = normalizeJadhStatus(result.provider_status) || "PROCESSING";
      await q(`UPDATE orders SET topup_status=$1,provider_name='SPECIAL',provider_order_id=COALESCE($2,provider_order_id),provider_status=COALESCE($3,provider_status),updated_at=NOW() WHERE id=$4`,
        [status,result.provider_order_id,result.provider_status,order.id]);
    } else {
      result = await sendDiamondOrderToJadh(order);
      const status = normalizeJadhStatus(result.provider_status) || "PROCESSING";
      await q(`UPDATE orders SET topup_status=$1,provider_name='JADH',provider_order_id=COALESCE($2,provider_order_id),provider_status=COALESCE($3,provider_status),updated_at=NOW() WHERE id=$4`,
        [status,result.provider_order_id,result.provider_status,order.id]);
    }
  } catch (e) {
    console.error("Delivery failed for order", orderNumber, e.message || e);
    await q(`UPDATE orders SET topup_status='FAILED',provider_status=$1,updated_at=NOW() WHERE id=$2`, [String(e.message || "Delivery failed").slice(0,500),order.id]);
  }
}

// Hosted Wompi checkout: el cliente ingresa los datos de pago directamente en Wompi.
app.post("/api/checkout/hosted", async (req, res) => {
  try {
    if (!WOMPI_PUBLIC_KEY || !WOMPI_INTEGRITY_SECRET) {
      return res.status(503).json({ error: "El pago en línea aún no está configurado." });
    }
    const body = req.body || {};
    const playerId = String(body.player_id || "").trim();
    if (!/^\d{5,15}$/.test(playerId)) return res.status(400).json({ error: "Verifica el ID de jugador." });

    const isSpecial = Boolean(body.kind);
    let product = null, catalogItem = null, quantity = 1, amount = 0;
    let verifiedRegion = String(body.player_region || "").toUpperCase();
    if (isSpecial) {
      if (!/^\d{8,12}$/.test(playerId)) return res.status(400).json({ error: "El ID debe tener entre 8 y 12 dígitos." });
      const verifiedAccount = await lookupSixofireAccount(playerId);
      verifiedRegion = verifiedAccount.region;
      const kind = String(body.kind || "").toLowerCase();
      quantity = Number(body.quantity || 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1400) return res.status(400).json({ error: "La cantidad no es válida." });
      const found = await q("SELECT * FROM catalog_items WHERE id=$1 AND active=true", [Number(body.catalog_item_id)]);
      catalogItem = found.rows[0];
      if (!validateSpecialProduct(kind, catalogItem)) return res.status(400).json({ error: "Este producto no está disponible para compra en línea." });
      if (kind === "tokens" && (quantity < 35 || quantity > 1400)) return res.status(400).json({ error: "La cantidad de fragmentos debe estar entre 35 y 1.400." });
      if (kind === "boxes" && (quantity < 7 || quantity > 280)) return res.status(400).json({ error: "La cantidad de cajas debe estar entre 7 y 280." });
      const deliveryMap = sixofireProductMap()[kind];
      const deliveryId = String(deliveryMap?.product_id || deliveryMap?.id || "");
      if (!/^\d{4,5}$/.test(deliveryId) || (quantity > 1 && deliveryMap?.supports_amount !== true)) {
        return res.status(409).json({ error: "Este producto aún no está disponible para compra en línea: falta confirmar su configuración de entrega." });
      }
      amount = Math.round(Number(catalogItem.price_cop) * quantity);
    } else {
      const found = await q("SELECT * FROM products WHERE id=$1 AND active=true", [Number(body.product_id)]);
      product = found.rows[0];
      if (!product) return res.status(404).json({ error: "Producto no disponible." });
      amount = Number(product.price_cop);
    }
    if (!Number.isSafeInteger(amount) || amount < 100) return res.status(400).json({ error: "El total del pedido no es válido." });
    const playerEmail = String(body.player_email || "").trim();

    const orderNumber = makeOrderNumber();
    const amountInCents = amount * 100;
    const signature = sha256(`${orderNumber}${amountInCents}COP${WOMPI_INTEGRITY_SECRET}`);
    const userId = optionalUserId(req);
    const playerNickname = String(body.player_nickname || "").trim() || null;
    const playerRegion = isSpecial ? verifiedRegion : (String(body.player_region || "SAC").toUpperCase());
    const insert = await q(`INSERT INTO orders(
      order_number,player_id,player_nickname,user_id,product_id,product_diamonds,amount_cop,
      payment_method,payment_status,payment_reference,topup_status,catalog_item_id,product_kind,quantity,player_region,player_email
    ) VALUES($1,$2,$3,$4,$5,$6,$7,'wompi','PENDING',$8,'NOT_SENT',$9,$10,$11,$12,$13)
    RETURNING id,order_number,amount_cop`, [orderNumber,playerId,playerNickname,userId,product?.id || null,product?.diamonds || 0,amount,
      orderNumber,catalogItem?.id || null,catalogItem?.kind || null,quantity,playerRegion,playerEmail || null]);
    await q(`INSERT INTO payments(order_id,method,reference,status,amount_cop,raw_data)
      VALUES($1,'wompi',$2,'PENDING',$3,$4)`, [insert.rows[0].id,orderNumber,amount,JSON.stringify({source:"hosted_checkout"})]);

    const params = new URLSearchParams({
      "public-key": WOMPI_PUBLIC_KEY,
      currency: "COP",
      "amount-in-cents": String(amountInCents),
      reference: orderNumber,
      "signature:integrity": signature,
      "redirect-url": `${process.env.STORE_PUBLIC_URL || "https://yulixstore.com"}/?order=${encodeURIComponent(orderNumber)}`
    });
    return res.status(201).json({ ok:true, order_number:orderNumber, checkout_url:`https://checkout.wompi.co/p/?${params.toString()}` });
  } catch (e) {
    console.error("Hosted checkout:", e.message || e);
    return res.status(500).json({ error: safePublicError(e) });
  }
});

app.post("/api/checkout/create", async (req, res) => {
  try {
    if (!WOMPI_PUBLIC_KEY || !WOMPI_PRIVATE_KEY || !WOMPI_INTEGRITY_SECRET) {
      return res.status(503).json({ error: "El pago en línea aún no está configurado." });
    }
    const body = req.body || {};
    const method = String(body.payment_method || "").toLowerCase();
    const type = wompiPaymentMethodType(method);
    if (!type) return res.status(400).json({ error: "Selecciona un método de pago válido." });

    const playerId = String(body.player_id || "").trim();
    if (!/^\d{5,15}$/.test(playerId)) return res.status(400).json({ error: "Verifica el ID de jugador." });
    const isSpecial = Boolean(body.kind);
    let product, catalogItem = null, quantity = 1, amount;
    if (isSpecial) {
      const kind = String(body.kind || "").toLowerCase();
      quantity = Number(body.quantity || 1);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1400) return res.status(400).json({ error: "La cantidad no es válida." });
      const found = await q("SELECT * FROM catalog_items WHERE id=$1 AND active=true", [Number(body.catalog_item_id)]);
      catalogItem = found.rows[0];
      if (!validateSpecialProduct(kind, catalogItem)) return res.status(400).json({ error: "Este producto no está disponible para compra en línea." });
      if (kind === "tokens" && (quantity < 35 || quantity > 1400)) return res.status(400).json({ error: "La cantidad de fragmentos debe estar entre 35 y 1.400." });
      if (kind === "boxes" && (quantity < 7 || quantity > 280)) return res.status(400).json({ error: "La cantidad de cajas debe estar entre 7 y 280." });
      const deliveryMap = sixofireProductMap()[kind];
      const deliveryId = String(deliveryMap?.product_id || deliveryMap?.id || "");
      if (!/^\d{4,5}$/.test(deliveryId) ||
          (quantity > 1 && deliveryMap?.supports_amount !== true)) {
        return res.status(409).json({ error: "Este producto aún no está disponible para compra en línea." });
      }
      amount = Math.round(Number(catalogItem.price_cop) * quantity);
      if (!Number.isSafeInteger(amount) || amount < 100) return res.status(400).json({ error: "El total del pedido no es válido." });
    } else {
      const found = await q("SELECT * FROM products WHERE id=$1 AND active=true", [Number(body.product_id)]);
      product = found.rows[0];
      if (!product) return res.status(404).json({ error: "Producto no disponible." });
      amount = Number(product.price_cop);
    }

    // Datos requeridos por cada método se validan en el servidor.
    const phone = String(body.phone_number || "").replace(/\D/g, "");
    const email = String(body.customer_email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Escribe un correo electrónico válido para el recibo de pago." });
    const fullName = String(body.full_name || "").trim();
    const docType = String(body.document_type || "CC").toUpperCase();
    const docNumber = String(body.document_number || "").replace(/\s/g, "");
    if (method === "nequi" && !/^\d{10}$/.test(phone)) return res.status(400).json({ error: "Escribe el celular de 10 dígitos registrado en Nequi." });
    if (["pse","daviplata"].includes(method)) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName || !docNumber || !["CC","NIT","CE","TI","PP"].includes(docType)) {
        return res.status(400).json({ error: "Completa los datos requeridos para el método de pago seleccionado." });
      }
    }
    if (["pse","daviplata"].includes(method) && !/^\d{7,15}$/.test(docNumber)) return res.status(400).json({ error: "Revisa el número de documento." });
    if (method === "pse" && (!body.financial_institution_code || !phone)) return res.status(400).json({ error: "Selecciona el banco e ingresa un celular." });
    if (method === "bancolombia" && !["PERSON"].includes(String(body.user_type || "PERSON"))) return res.status(400).json({ error: "Tipo de cliente no válido." });
    if (method === "card" && !String(body.card_token || "").startsWith("tok_")) return res.status(400).json({ error: "No se pudo tokenizar la tarjeta. Revisa sus datos e inténtalo nuevamente." });

    const orderNumber = makeOrderNumber();
    const reference = orderNumber;
    const userId = optionalUserId(req);
    const playerNickname = String(body.player_nickname || "").trim() || null;
    const playerRegion = String(body.player_region || "SAC").toUpperCase();
    const playerEmail = String(body.player_email || "").trim() || null;
    const orderInsert = await q(`INSERT INTO orders(
      order_number,player_id,player_nickname,user_id,product_id,product_diamonds,amount_cop,
      payment_method,payment_status,payment_reference,payer_name,payer_email,payer_phone,topup_status,
      catalog_item_id,product_kind,quantity,player_region,player_email
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11,$12,'NOT_SENT',$13,$14,$15,$16,$17)
    RETURNING id,order_number,amount_cop`,
    [orderNumber,playerId,playerNickname,userId,product?.id || null,product?.diamonds || 0,amount,method,reference,
     fullName || null,email || null,phone || null,catalogItem?.id || null,catalogItem?.kind || null,quantity,playerRegion,playerEmail]);

    const amountInCents = amount * 100;
    const acceptanceToken = await wompiAcceptanceToken();
    const signature = sha256(`${reference}${amountInCents}COP${WOMPI_INTEGRITY_SECRET}`);
    const paymentMethod = { type };
    if (method === "nequi") paymentMethod.phone_number = phone;
    if (method === "bancolombia") {
      paymentMethod.payment_description = `Compra YuliXstore ${orderNumber}`.slice(0,64);
      paymentMethod.user_type = "PERSON";
    }
    if (method === "qr") paymentMethod.payment_description = `Compra YuliXstore ${orderNumber}`.slice(0,64);
    if (method === "pse") Object.assign(paymentMethod, {
      user_type: Number(body.user_type || 0), user_legal_id_type: docType, user_legal_id: docNumber,
      financial_institution_code: String(body.financial_institution_code),
      payment_description: `Compra YuliXstore ${orderNumber}`.slice(0,64)
    });
    if (method === "daviplata") Object.assign(paymentMethod, {
      user_legal_id_type: docType, user_legal_id: docNumber,
      payment_description: `Compra YuliXstore ${orderNumber}`.slice(0,30)
    });
    if (method === "card") Object.assign(paymentMethod, { token: String(body.card_token), installments: Math.min(36,Math.max(1,Number(body.installments||1))) });

    const transactionBody = {
      amount_in_cents: amountInCents, currency: "COP", customer_email: email,
      reference, signature, acceptance_token: acceptanceToken, payment_method: paymentMethod,
      payment_method_type: type, redirect_url: `${process.env.STORE_PUBLIC_URL || "https://yulixstore.com"}/?order=${encodeURIComponent(orderNumber)}`
    };
    if (fullName || phone) transactionBody.customer_data = { ...(fullName ? {full_name:fullName} : {}), ...(phone ? {phone_number: phone.startsWith("57") ? phone : `57${phone}`} : {}) };
    if (method === "pse") transactionBody.customer_data = { full_name: fullName, phone_number: phone.startsWith("57") ? phone : `57${phone}` };
    const created = await wompiRequest("/transactions", { method: "POST", body: JSON.stringify(transactionBody) });
    const transactionId = String(created?.id || "");
    if (!transactionId) throw new Error("No se recibió la referencia del pago.");
    await q(`UPDATE orders SET wompi_transaction_id=$1,updated_at=NOW() WHERE order_number=$2`, [transactionId,orderNumber]);
    await q(`INSERT INTO payments(order_id,method,reference,status,amount_cop,raw_data)
      VALUES($1,$2,$3,'PENDING',$4,$5)`, [orderInsert.rows[0].id,method,reference,amount,JSON.stringify({transaction_id:transactionId})]);

    let paymentUrl = created?.payment_method?.extra?.async_payment_url || created?.payment_method?.extra?.url || null;
    let qrImage = created?.payment_method?.extra?.qr_image || created?.payment_method?.qr_image || null;
    // Some asynchronous methods expose their URL/QR a moment after creation.
    if (!paymentUrl && !qrImage && ["bancolombia","qr","pse","daviplata"].includes(method)) {
      for (let attempt=0; attempt<5; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 900));
        try {
          const latest = await wompiRequest(`/transactions/${encodeURIComponent(transactionId)}`, { method: "GET" });
          paymentUrl = latest?.payment_method?.extra?.async_payment_url || latest?.payment_method?.extra?.url || paymentUrl;
          qrImage = latest?.payment_method?.extra?.qr_image || latest?.payment_method?.qr_image || qrImage;
          if (paymentUrl || qrImage) break;
        } catch {}
      }
    }
    res.status(201).json({
      ok: true, order_number: orderNumber, amount_cop: amount, transaction_id: transactionId,
      payment_status: created?.status || "PENDING", payment_url: paymentUrl,
      qr_image: qrImage, qr_id: created?.payment_method?.extra?.qr_id || null,
      instructions: method === "nequi" ? "Revisa la notificación en tu aplicación y confirma el pago." : null
    });
  } catch (e) {
    console.error("Checkout create:", e.message || e);
    res.status(400).json({ error: safePublicError(e) });
  }
});

function verifyWompiEvent(event) {
  const signature = event?.signature;
  if (!WOMPI_EVENTS_SECRET || !signature?.checksum || !Array.isArray(signature?.properties)) return false;
  const values = signature.properties.map(path => {
    const value = String(path).split(".").reduce((obj,key) => obj == null ? undefined : obj[key], event.data);
    return value == null ? "" : String(value);
  });
  const base = values.join("") + String(event.timestamp) + WOMPI_EVENTS_SECRET;
  return safeEqualHex(sha256(base), signature.checksum);
}

app.post(["/api/webhooks/wompi", "/api/wompi/events"], async (req, res) => {
  const event = req.body || {};
  if (!verifyWompiEvent(event)) {
    console.warn("Payment webhook rejected: invalid signature");
    return res.status(401).json({ error: "Notificación no válida." });
  }
  const transaction = event?.data?.transaction || event?.data;
  const eventType = String(event?.event || "");
  const eventId = `${String(transaction?.id || "")}:${String(transaction?.status || "")}:${String(event?.timestamp || "")}`;
  if (!transaction?.id || eventType !== "transaction.updated") return res.status(200).json({ received: true });
  const reference = String(transaction?.reference || "");
  const status = String(transaction?.status || "").toUpperCase();
  const amountInCents = Number(transaction?.amount_in_cents);
  const currency = String(transaction?.currency || "");
  const client = await pool.connect();
  let order;
  try {
    await client.query("BEGIN");
    const inserted = await client.query(`INSERT INTO payment_webhook_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id`, [eventId,eventType]);
    if (!inserted.rows.length) { await client.query("ROLLBACK"); return res.status(200).json({ received: true, duplicate: true }); }
    const found = await client.query("SELECT * FROM orders WHERE order_number=$1 FOR UPDATE", [reference]);
    order = found.rows[0];
    if (!order || (order.wompi_transaction_id && order.wompi_transaction_id !== String(transaction.id)) || amountInCents !== Number(order.amount_cop)*100 || currency !== "COP") {
      await client.query("ROLLBACK");
      console.warn("Payment webhook did not match order", reference);
      return res.status(200).json({ received: true });
    }
    const mapped = status === "APPROVED" ? "APPROVED" : (["DECLINED","VOIDED","ERROR"].includes(status) ? "REJECTED" : "PENDING");
    const methodType = String(transaction?.payment_method_type || transaction?.payment_method?.type || "").toUpperCase();
    const instantTypes = new Set(["CARD","PSE","NEQUI","BANCOLOMBIA_TRANSFER","BANCOLOMBIA_QR","DAVIPLATA"]);
    const holdForSettlement = mapped === "APPROVED" && !instantTypes.has(methodType);
    await client.query(`UPDATE orders SET payment_status=$1, wompi_transaction_id=COALESCE(wompi_transaction_id,$2), topup_status=CASE WHEN $3 THEN 'HOLD_FOR_SETTLEMENT' ELSE topup_status END, provider_status=CASE WHEN $3 THEN 'Pago aprobado; entrega retenida hasta confirmar el desembolso.' ELSE provider_status END, payment_note=CASE WHEN $1='REJECTED' THEN 'El pago no fue aprobado.' ELSE payment_note END, approved_at=CASE WHEN $1='APPROVED' THEN COALESCE(approved_at,NOW()) ELSE approved_at END, updated_at=NOW() WHERE id=$4`, [mapped,String(transaction.id),holdForSettlement,order.id]);
    await client.query(`UPDATE payments SET status=$1,raw_data=COALESCE(raw_data,'{}'::jsonb) || $2::jsonb WHERE reference=$3`, [mapped,JSON.stringify({wompi_status:status,transaction_id:eventId}),reference]);
    await client.query("COMMIT");
    if (mapped === "APPROVED" && !holdForSettlement && ["NOT_SENT","QUEUED"].includes(String(order.topup_status || ""))) await deliverPaidOrder(reference);
    return res.status(200).json({ received: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Payment webhook processing:", e.message || e);
    return res.status(500).json({ error: "Webhook processing failed" });
  } finally { client.release(); }
});


app.get("/api/ranking", async (req,res)=>{
  try {
    const period = String(req.query.period || "day").toLowerCase();
    const valid = new Set(["day","week","month","year"]);
    if (!valid.has(period)) return res.status(400).json({ error: "Periodo inválido." });

    // Los periodos usan el calendario de Colombia, no la zona horaria del servidor.
    // Hoy se reinicia a las 00:00 de America/Bogota; semana comienza el lunes.
    const trunc = { day: "day", week: "week", month: "month", year: "year" }[period];
    const r = await q(
      `SELECT player_id,
              COALESCE(MAX(NULLIF(player_nickname,'')), 'Jugador') AS player_nickname,
              COALESCE(SUM(product_diamonds),0)::int AS diamonds
       FROM orders
       WHERE topup_status='COMPLETED'
         AND created_at >= (date_trunc($1, NOW() AT TIME ZONE 'America/Bogota') AT TIME ZONE 'America/Bogota')
       GROUP BY player_id
       ORDER BY diamonds DESC, MAX(created_at) DESC
       LIMIT 10`,
      [trunc]
    );
    res.setHeader("Cache-Control", "no-store");
    res.json(r.rows);
  } catch(e) {
    console.error("ranking:",e);
    res.status(500).json({error:"No se pudo cargar el top de recargas."});
  }
});

app.get("/api/products", async (_req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const r = await q(
      "SELECT id,diamonds,display_diamonds,price_cop,active FROM products WHERE active=true ORDER BY diamonds"
    );
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudieron cargar los productos" });
  }
});

app.get("/api/admin/products", auth, async (_req, res) => {
  const r = await q(
    "SELECT id,diamonds,display_diamonds,price_cop,active FROM products ORDER BY diamonds"
  );
  res.json(r.rows);
});

app.post("/api/admin/products", auth, async (req, res) => {
  const diamonds = Number(req.body.diamonds);
  const display = String(req.body.display_diamonds || diamonds);
  const price = Number(req.body.price_cop);

  if (!Number.isInteger(diamonds) || diamonds <= 0 || !Number.isInteger(price) || price <= 0) {
    return res.status(400).json({ error: "Producto inválido" });
  }

  const r = await q(
    "INSERT INTO products(diamonds,display_diamonds,price_cop) VALUES($1,$2,$3) RETURNING *",
    [diamonds, display, price]
  );
  res.status(201).json(r.rows[0]);
});

app.patch("/api/admin/products/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  const price = req.body.price_cop == null ? null : Number(req.body.price_cop);
  const active = req.body.active == null ? null : Boolean(req.body.active);

  const r = await q(
    `UPDATE products SET
      price_cop=COALESCE($1,price_cop),
      active=COALESCE($2,active),
      updated_at=NOW()
     WHERE id=$3 RETURNING *`,
    [price, active, id]
  );

  if (!r.rows[0]) return res.status(404).json({ error: "Producto no encontrado" });
  res.json(r.rows[0]);
});

app.delete("/api/admin/products/:id", auth, async (req, res) => {
  const r = await q(
    "DELETE FROM products WHERE id=$1 RETURNING id",
    [Number(req.params.id)]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Producto no encontrado" });
  res.status(204).end();
});

/*
  Crea un pedido y lo deja PENDING.
  No se envía ninguna recarga al proveedor en este punto.
*/
function optionalUserId(req){const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");if(!token)return null;try{const p=jwt.verify(token,process.env.JWT_SECRET);return p.role==="user"?Number(p.id):null}catch{return null;}}

app.post("/api/orders", async (req, res) => {
  try {
    const playerId = String(req.body.player_id || "").trim();
    const productId = Number(req.body.product_id);
    const paymentMethod = String(req.body.payment_method || "").trim().toLowerCase();
    const paymentReference = String(req.body.payment_reference || "").trim() || null;
    const receiptUrl = String(req.body.receipt_url || req.body.receipt_data_url || "").trim() || null;
    const paymentNote = String(req.body.payment_note || "").trim() || null;
    const playerNickname = String(req.body.player_nickname || "").trim() || null;
    const userId = optionalUserId(req);

    const validMethods = new Set(["nequi", "qr", "breb"]);
    if (!playerId || !Number.isInteger(productId)) {
      return res.status(400).json({ error: "ID de jugador y producto son obligatorios" });
    }
    if (paymentMethod && !validMethods.has(paymentMethod)) {
      return res.status(400).json({ error: "Método de pago no válido" });
    }

    const p = await q(
      "SELECT * FROM products WHERE id=$1 AND active=true",
      [productId]
    );
    if (!p.rows[0]) return res.status(404).json({ error: "Producto no disponible" });

    const product = p.rows[0];
    const orderNumber = makeOrderNumber();

    const r = await q(
      `INSERT INTO orders(
        order_number,player_id,player_nickname,user_id,product_id,product_diamonds,amount_cop,
        payment_method,payment_status,payment_reference,receipt_url,payment_note,payer_name,payer_phone,topup_status
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11,$12,$13,'NOT_SENT')
      RETURNING order_number,amount_cop,payment_status,topup_status,created_at`,
      [
        orderNumber,
        playerId,
        playerNickname,
        userId,
        product.id,
        product.diamonds,
        product.price_cop,
        paymentMethod || null,
        paymentReference,
        receiptUrl,
        paymentNote,
        String(req.body.payer_name || '').trim() || null,
        String(req.body.payer_phone || '').trim() || null
      ]
    );

    const order = r.rows[0];

    if (paymentMethod || paymentReference || receiptUrl || paymentNote) {
      await q(
        `INSERT INTO payments(order_id,method,reference,status,amount_cop,receipt_url,note,raw_data)
         SELECT id,$2,$3,'PENDING',amount_cop,$4,$5,$6
         FROM orders WHERE order_number=$1`,
        [
          orderNumber,
          paymentMethod || "unknown",
          paymentReference,
          receiptUrl,
          paymentNote,
          JSON.stringify({ source: "store_checkout" })
        ]
      );
    }

    res.status(201).json({
      order_number: order.order_number,
      amount_cop: order.amount_cop,
      payment_status: order.payment_status,
      topup_status: order.topup_status,
      message: "Pedido creado. Queda pendiente de verificación del pago."
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo crear el pedido" });
  }
});

app.get("/api/orders/:orderNumber", async (req, res) => {
  const r = await q(
    `SELECT order_number,player_id,player_nickname,payer_name,payer_phone,product_diamonds,amount_cop,
            payment_method,payment_status,payment_reference,receipt_url,product_kind,quantity,
            topup_status,provider_name,provider_order_id,provider_status,
            approved_at,created_at,updated_at
     FROM orders WHERE order_number=$1`,
    [req.params.orderNumber]
  );

  if (!r.rows[0]) return res.status(404).json({ error: "Pedido no encontrado" });
  res.json(r.rows[0]);
});


app.get("/api/admin/settings",auth,async(_req,res)=>{const s=(await q("SELECT * FROM store_settings WHERE id=1")).rows[0];res.json(s);});
app.patch("/api/admin/settings",auth,async(req,res)=>{
  try {
    const b=req.body||{};
    const r=await q(`UPDATE store_settings SET
      maintenance=COALESCE($1,maintenance),
      maintenance_message=COALESCE($2,maintenance_message),
      floating_active=COALESCE($3,floating_active),
      floating_message=COALESCE($4,floating_message),
      notice_active=COALESCE($5,notice_active),
      notice_title=COALESCE($6,notice_title),
      notice_message=COALESCE($7,notice_message),
      notice_type=COALESCE($8,notice_type),
      notice_button_text=COALESCE($9,notice_button_text),
      notice_button_url=COALESCE($10,notice_button_url),
      support_whatsapp=COALESCE($11,support_whatsapp),
      attention_hours=COALESCE($12,attention_hours),
      updated_at=NOW()
      WHERE id=1 RETURNING *`,[
        b.maintenance==null?null:Boolean(b.maintenance),
        b.maintenance_message==null?null:String(b.maintenance_message).slice(0,500),
        b.floating_active==null?null:Boolean(b.floating_active),
        b.floating_message==null?null:String(b.floating_message).slice(0,300),
        b.notice_active==null?null:Boolean(b.notice_active),
        b.notice_title==null?null:String(b.notice_title).slice(0,120),
        b.notice_message==null?null:String(b.notice_message).slice(0,1000),
        b.notice_type==null?null:String(b.notice_type).slice(0,20),
        b.notice_button_text==null?null:String(b.notice_button_text).slice(0,80),
        b.notice_button_url==null?null:String(b.notice_button_url).slice(0,500),
        b.support_whatsapp==null?null:String(b.support_whatsapp).replace(/\D/g,'').slice(0,20),
        b.attention_hours==null?null:String(b.attention_hours).slice(0,120)
      ]);
    if(!r.rows[0]) return res.status(404).json({error:"No se encontró la configuración de la tienda."});
    res.setHeader("Cache-Control","no-store");
    res.json(r.rows[0]);
  } catch(e) { console.error("admin settings patch:",e); res.status(500).json({error:"No se pudo guardar la configuración."}); }
});
app.get("/api/admin/catalog",auth,async(_req,res)=>{res.json((await q("SELECT * FROM catalog_items ORDER BY sort_order,id")).rows);});
app.patch("/api/admin/catalog/:id",auth,async(req,res)=>{const b=req.body||{};const metadata=b.metadata==null?null:(typeof b.metadata==='object'&&b.metadata!==null?b.metadata:{});const r=await q(`UPDATE catalog_items SET active=COALESCE($1,active),price_cop=COALESCE($2,price_cop),title=COALESCE($3,title),subtitle=COALESCE($4,subtitle),metadata=COALESCE($5,metadata),updated_at=NOW() WHERE id=$6 RETURNING *`,[b.active==null?null:Boolean(b.active),b.price_cop==null?null:Number(b.price_cop),b.title==null?null:String(b.title).slice(0,120),b.subtitle==null?null:String(b.subtitle).slice(0,250),metadata,Number(req.params.id)]);if(!r.rows[0])return res.status(404).json({error:"Producto no encontrado."});res.json(r.rows[0]);});

app.get("/api/admin/sixofire/items", auth, async (_req, res) => {
  try {
    const data = await sixofireRequest("/account/shop/items", { method: "GET" });
    res.setHeader("Cache-Control", "no-store");
    res.json(data);
  } catch (e) {
    console.error("Admin item catalog check:", e.message || e);
    res.status(502).json({ error: "No se pudo consultar el catálogo de productos." });
  }
});

app.post("/api/admin/orders/:orderNumber/confirm-settlement", auth, async (req, res) => {
  try {
    const found = await q("SELECT order_number,payment_status,topup_status FROM orders WHERE order_number=$1", [req.params.orderNumber]);
    const order = found.rows[0];
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    if (order.payment_status !== "APPROVED" || order.topup_status !== "HOLD_FOR_SETTLEMENT") return res.status(409).json({ error: "Este pedido no está retenido por confirmación del desembolso." });
    await q("UPDATE orders SET topup_status='NOT_SENT',provider_status='Desembolso confirmado manualmente por administración.',updated_at=NOW() WHERE order_number=$1", [order.order_number]);
    await deliverPaidOrder(order.order_number);
    const updated = await q("SELECT order_number,payment_status,topup_status,provider_status FROM orders WHERE order_number=$1", [order.order_number]);
    res.json({ ok: true, order: updated.rows[0] });
  } catch (e) {
    console.error("Settlement confirmation:", e.message || e);
    res.status(500).json({ error: "No se pudo procesar el pedido." });
  }
});

app.post("/api/admin/orders/:orderNumber/retry-delivery", auth, async (req, res) => {
  try {
    const found = await q("SELECT order_number,payment_status,topup_status,product_kind FROM orders WHERE order_number=$1", [req.params.orderNumber]);
    const order = found.rows[0];
    if (!order) return res.status(404).json({ error: "Pedido no encontrado." });
    if (order.payment_status !== "APPROVED") return res.status(409).json({ error: "El pago no está confirmado." });
    if (order.topup_status !== "FAILED") return res.status(409).json({ error: "Solo se pueden reintentar entregas fallidas." });
    await deliverPaidOrder(order.order_number);
    const updated = await q("SELECT order_number,payment_status,topup_status,provider_status FROM orders WHERE order_number=$1", [order.order_number]);
    res.json({ ok: true, order: updated.rows[0] });
  } catch (e) {
    console.error("Retry delivery:", e.message || e);
    res.status(500).json({ error: "No se pudo reintentar la entrega." });
  }
});

app.get("/api/admin/stats",auth,async(_req,res)=>{const [o,u,p,c,done,failed]=await Promise.all([q("SELECT COUNT(*)::int count FROM orders"),q("SELECT COUNT(*)::int count FROM users"),q("SELECT COUNT(*)::int count FROM orders WHERE payment_status='PENDING'"),q("SELECT COUNT(*)::int count FROM orders WHERE topup_status='PROCESSING'"),q("SELECT COUNT(*)::int count FROM orders WHERE topup_status='COMPLETED'"),q("SELECT COUNT(*)::int count FROM orders WHERE topup_status='FAILED'")]);const sales=await q("SELECT COALESCE(SUM(amount_cop),0)::int total FROM orders WHERE payment_status='APPROVED'");res.json({orders:o.rows[0].count,users:u.rows[0].count,pending_payments:p.rows[0].count,processing:c.rows[0].count,completed:done.rows[0].count,failed:failed.rows[0].count,sales:sales.rows[0].total});});

app.get("/api/admin/orders", auth, async (_req, res) => {
  const r = await q(
    `SELECT order_number,player_id,player_nickname,payer_name,payer_phone,product_diamonds,amount_cop,
            payment_method,payment_status,payment_reference,receipt_url,payment_note,product_kind,quantity,player_region,player_email,wompi_transaction_id,
            topup_status,provider_name,provider_order_id,provider_status,
            approved_at,approved_by,created_at,updated_at
     FROM orders ORDER BY created_at DESC LIMIT 500`
  );
  res.json(r.rows);
});

/*
  El administrador marca manualmente el pago como aprobado.
  La entrega automática se inicia desde el flujo de pago confirmado. Los productos especiales requieren credenciales activas y mapeo real en SIXOFIRE_PRODUCT_MAP; no se inventan IDs.
*/
app.patch("/api/admin/orders/:orderNumber/payment", auth, async (req, res) => {
  const status = String(req.body.status || "").trim().toUpperCase();
  const note = String(req.body.note || "").trim() || null;

  if (!["APPROVED", "REJECTED", "UNDER_REVIEW"].includes(status)) {
    return res.status(400).json({
      error: "Estado inválido. Usa APPROVED, REJECTED o UNDER_REVIEW."
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT * FROM orders WHERE order_number=$1 FOR UPDATE",
      [req.params.orderNumber]
    );
    const order = found.rows[0];

    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    if (status === "APPROVED" && order.payment_status === "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "El pago ya está aprobado" });
    }

    const topupStatus = status === "APPROVED" ? "QUEUED" : "NOT_SENT";
    const approvedAt = status === "APPROVED" ? "NOW()" : "NULL";
    const approvedBy = status === "APPROVED" ? req.admin.id : "NULL";

    const updated = await client.query(
      `UPDATE orders
       SET payment_status=$1,
           payment_note=COALESCE($2,payment_note),
           topup_status=$3,
           approved_at=${approvedAt},
           approved_by=${approvedBy},
           updated_at=NOW()
       WHERE id=$4
       RETURNING order_number,payment_status,topup_status,approved_at,approved_by`,
      [status, note, topupStatus, order.id]
    );

    await client.query(
      `INSERT INTO payments(order_id,method,reference,status,amount_cop,note,raw_data)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        order.id,
        order.payment_method || "unknown",
        order.payment_reference,
        status,
        order.amount_cop,
        note,
        JSON.stringify({ admin_id: req.admin.id })
      ]
    );

    await client.query("COMMIT");
    res.json({
      ...updated.rows[0],
      message: status === "APPROVED"
        ? "Pago aprobado. El pedido quedó listo para enviarse a JADH."
        : `Pago marcado como ${status}.`
    });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "No se pudo actualizar el pago" });
  } finally {
    client.release();
  }
});

app.patch("/api/admin/orders/:orderNumber/topup", auth, async (req, res) => {
  const status = String(req.body.status || "").trim().toUpperCase();
  const providerOrderId = String(req.body.provider_order_id || "").trim() || null;
  const providerStatus = String(req.body.provider_status || "").trim() || null;

  const allowed = ["NOT_SENT", "QUEUED", "PROCESSING", "COMPLETED", "FAILED"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Estado de recarga inválido" });
  }

  const r = await q(
    `UPDATE orders
     SET topup_status=$1,
         provider_order_id=COALESCE($2,provider_order_id),
         provider_status=COALESCE($3,provider_status),
         updated_at=NOW()
     WHERE order_number=$4
     RETURNING order_number,payment_status,topup_status,provider_order_id,provider_status`,
    [status, providerOrderId, providerStatus, req.params.orderNumber]
  );

  if (!r.rows[0]) return res.status(404).json({ error: "Pedido no encontrado" });
  res.json(r.rows[0]);
});


app.get("/api/admin/jadh/mapping", auth, async (_req, res) => {
  res.json({
    product_id: "57",
    packages: jadhProductMap()
  });
});

app.get("/api/admin/jadh/products", auth, async (_req, res) => {
  try {
    const data = await jadhGetProducts();
    res.json(data);
  } catch (e) {
    console.error("JADH products:", e);
    res.status(502).json({ error: e.message || "No se pudo consultar JADH" });
  }
});

app.get("/api/admin/jadh/balance", auth, async (_req, res) => {
  try {
    const data = await jadhGetBalance();
    res.json(data);
  } catch (e) {
    console.error("JADH balance:", e);
    res.status(502).json({ error: e.message || "No se pudo consultar el saldo de JADH" });
  }
});

/*
  Envía a JADH un pedido cuyo pago ya fue aprobado.
  El external_order_id es el número de pedido de YuliXstore para evitar
  duplicar la recarga si se reintenta la operación.
*/
app.post("/api/admin/orders/:orderNumber/send-jadh", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const found = await client.query(
      "SELECT * FROM orders WHERE order_number=$1 FOR UPDATE",
      [req.params.orderNumber]
    );
    const order = found.rows[0];

    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Pedido no encontrado" });
    }

    if (order.payment_status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Primero debes aprobar el pago." });
    }

    if (order.topup_status === "PROCESSING" || order.topup_status === "COMPLETED") {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Este pedido ya está procesándose o fue completado. No se reenvía."
      });
    }

    await client.query(
      `UPDATE orders
       SET topup_status='PROCESSING',
           provider_name='JADH',
           updated_at=NOW()
       WHERE id=$1`,
      [order.id]
    );

    await client.query("COMMIT");

    try {
      const result = await processApprovedJadhOrder({
        ...order,
        topup_status: "NOT_SENT"
      });

      const providerId = result.provider_order_id || null;
      const providerStatus = result.provider_status || null;

      await q(
        `UPDATE orders
         SET topup_status=$1,
             provider_name='JADH',
             provider_order_id=COALESCE($2,provider_order_id),
             provider_status=COALESCE($3,provider_status),
             updated_at=NOW()
         WHERE id=$4`,
        [
          normalizeJadhStatus(providerStatus) || "PROCESSING",
          providerId,
          providerStatus,
          order.id
        ]
      );

      return res.json({
        ok: true,
        provider: "JADH",
        order_number: order.order_number,
        provider_order_id: providerId,
        provider_status: providerStatus,
        data: result.raw
      });
    } catch (e) {
      await q(
        `UPDATE orders
         SET topup_status='FAILED',
             provider_name='JADH',
             provider_status=$1,
             updated_at=NOW()
         WHERE id=$2`,
        [e.message || "JADH error", order.id]
      );

      return res.status(502).json({
        error: e.message || "JADH rechazó la recarga",
        order_number: order.order_number
      });
    }
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("send-jadh:", e);
    res.status(500).json({ error: "No se pudo procesar el envío a JADH" });
  } finally {
    client.release();
  }
});

app.get("/", (_req, res) => {
  res.json({ service: "YuliXstore backend", status: "online" });
});

setInterval(() => { syncPendingJadhOrders().catch(() => {}); }, 60000);

app.listen(port, async () => {
  try {
    await ensureSchema();
    await seedProducts();
    await seedCatalog();
    await seedAdminFromEnv();
    console.log("Esquema, catálogo y administrador verificados");
  } catch (e) {
    console.error("No se pudo preparar la base de datos", e);
  }
  console.log(`YuliXstore backend listening on port ${port}`);
});
