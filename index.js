require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);

let GROUP_ID = process.env.CHANNEL_ID || null;

// Safety guard: prevent mass removals if dates/config go wrong
const MAX_AUTOREMOVE_PER_RUN = Number(process.env.MAX_AUTOREMOVE_PER_RUN || 3);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("DB connected"))
  .catch(console.error);

function isoToDisplay(iso) {
  if (!iso || typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(iso);
  const [y, m, d] = iso.split('-');
  const months = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const mm = Number(m);
  return `${Number(d)} ${months[mm - 1] || m} ${y}`;
}

async function createTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      subscription_status TEXT DEFAULT 'inactive',
      subscription_end DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscriptions(
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT DEFAULT 'active',
      is_renewal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments(
      id SERIAL PRIMARY KEY,
      subscription_id INTEGER REFERENCES subscriptions(id),
      amount NUMERIC(10,2) NOT NULL,
      currency TEXT DEFAULT 'COP',
      method TEXT,
      paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_renewal BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS method TEXT;`);

  console.log("Tables ready - BI ready ✅");
}

createTables();

async function sendMessage(chatId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text }
    );
  } catch (e) {
    console.error('SendMessage error:', e.response?.data || e.message);
  }
}

async function removeFromGroup(userId) {
  if (!GROUP_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`,
      { chat_id: GROUP_ID, user_id: userId }
    );
  } catch (e) {
    console.error("Remove error:", e.response?.data || e.message);
  }
}

let adminSession = null;

async function registerUser(user) {
  await pool.query(`
    INSERT INTO users(telegram_id, username, first_name)
    VALUES($1, $2, $3)
    ON CONFLICT(telegram_id) DO NOTHING
  `, [user.id, user.username || null, user.first_name || null]);
}

async function renewUser(telegramId, days, amount, paymentMethod) {
  const userRes = await pool.query(
    `SELECT id FROM users WHERE telegram_id=$1`,
    [telegramId]
  );

  if (!userRes.rowCount) return "❌ Usuario no encontrado en base de datos";

  const userId = userRes.rows[0].id;

  // Close previous active subscriptions for this user
  await pool.query(`
    UPDATE subscriptions SET status='expired'
    WHERE user_id=$1 AND status='active'
  `, [userId]);

  // Determine renewal
  const prevSubs = await pool.query(
    `SELECT 1 FROM subscriptions WHERE user_id=$1 LIMIT 1`,
    [userId]
  );
  const isRenewal = prevSubs.rowCount > 0;

  // IMPORTANT: Return end_date as ISO string and store DATE in DB (no locale strings)
  const sub = await pool.query(`
    INSERT INTO subscriptions(user_id, start_date, end_date, status, is_renewal)
    VALUES($1, CURRENT_DATE, (CURRENT_DATE + $2 * INTERVAL '1 day')::date, 'active', $3)
    RETURNING id, end_date::text AS end_date
  `, [userId, days, isRenewal]);

  const subId = sub.rows[0].id;
  const endDateIso = sub.rows[0].end_date; // YYYY-MM-DD

  await pool.query(`
    INSERT INTO payments(subscription_id, amount, method)
    VALUES($1, $2, $3)
  `, [subId, amount, paymentMethod || 'manual']);

  await pool.query(`
    UPDATE users
    SET subscription_status='active', subscription_end=$1::date
    WHERE id=$2
  `, [endDateIso, userId]);

  return `✅ Suscripción registrada!\nVence: ${isoToDisplay(endDateIso)} (${endDateIso})\nTipo: ${isRenewal ? '🔄 Renovación' : '➕ Alta nueva'}\nMonto: $${amount} (${paymentMethod})`;
}

async function stats() {
  try {
    const active = await pool.query(`SELECT COUNT(*) FROM users WHERE subscription_status='active'`);

    const monthStart = new Date();
    monthStart.setDate(1);

    const mrr = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) total FROM payments WHERE paid_at >= $1::timestamp`,
      [monthStart]
    );
    const totalRevenue = await pool.query(`SELECT COALESCE(SUM(amount), 0) total FROM payments`);
    const avgTicket = await pool.query(`SELECT COALESCE(AVG(amount), 0) avg FROM payments`);

    const newSubs = await pool.query(`
      SELECT COUNT(*) FROM subscriptions s
      JOIN payments p ON s.id = p.subscription_id
      WHERE s.is_renewal = FALSE AND p.paid_at >= $1::timestamp
    `, [monthStart]);

    const renewals = await pool.query(`
      SELECT COUNT(*) FROM subscriptions s
      JOIN payments p ON s.id = p.subscription_id
      WHERE s.is_renewal = TRUE AND p.paid_at >= $1::timestamp
    `, [monthStart]);

    const arpu = Number(newSubs.rows[0].count) > 0
      ? (Number(mrr.rows[0].total) / Number(newSubs.rows[0].count)).toFixed(2)
      : '0.00';

    return `\n📊 STATS MES ACTUAL\n👥 Usuarios activos: ${active.rows[0].count}\n💰 Ingresos mes: $${Number(mrr.rows[0].total).toFixed(2)}\n💎 Ingresos total: $${Number(totalRevenue.rows[0].total).toFixed(2)}\n➕ Altas nuevas: ${newSubs.rows[0].count}\n🔄 Renovaciones: ${renewals.rows[0].count}\n📈 Ticket promedio: $${Number(avgTicket.rows[0].avg).toFixed(2)}\n🎯 ARPU: $${arpu}`;
  } catch (e) {
    console.error('Stats error:', e);
    return '❌ Error calculando stats';
  }
}

async function monthReport(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12) return "❌ Uso: /month YYYY MM (ej: /month 2026 3)";

  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));

  const revenue = await pool.query(
    `SELECT COALESCE(SUM(amount),0) total\n     FROM payments\n     WHERE paid_at >= $1::timestamptz AND paid_at < $2::timestamptz`,
    [start.toISOString(), end.toISOString()]
  );

  const newSubs = await pool.query(
    `SELECT COUNT(*)\n     FROM subscriptions s\n     JOIN payments p ON p.subscription_id = s.id\n     WHERE s.is_renewal = FALSE\n       AND p.paid_at >= $1::timestamptz AND p.paid_at < $2::timestamptz`,
    [start.toISOString(), end.toISOString()]
  );

  const renewals = await pool.query(
    `SELECT COUNT(*)\n     FROM subscriptions s\n     JOIN payments p ON p.subscription_id = s.id\n     WHERE s.is_renewal = TRUE\n       AND p.paid_at >= $1::timestamptz AND p.paid_at < $2::timestamptz`,
    [start.toISOString(), end.toISOString()]
  );

  return `📅 REPORTE ${y}-${String(m).padStart(2,"0")}\nIngresos: $${Number(revenue.rows[0].total).toFixed(2)}\nAltas nuevas: ${newSubs.rows[0].count}\nRenovaciones: ${renewals.rows[0].count}`;
}

cron.schedule("0 9 * * *", async () => {
  console.log("Daily check");

  // Notify expiring today
  const expiring = await pool.query(`
    SELECT telegram_id, username
    FROM users
    WHERE subscription_status='active'
      AND subscription_end IS NOT NULL
      AND subscription_end = CURRENT_DATE
  `);

  for (const u of expiring.rows) {
    await sendMessage(
      ADMIN_ID,
      `⚠️ Vence hoy:\nUsername: ${u.username || 'sin username'}\nTelegram ID: ${u.telegram_id}`
    );
  }

  // Auto-remove after 3 days past end date
  const expired = await pool.query(`
    SELECT telegram_id, id, username, subscription_end
    FROM users
    WHERE subscription_status='active'
      AND subscription_end IS NOT NULL
      AND subscription_end <= (CURRENT_DATE - INTERVAL '3 days')
  `);

  if (expired.rowCount > MAX_AUTOREMOVE_PER_RUN) {
    await sendMessage(
      ADMIN_ID,
      `🚨 Seguridad: ${expired.rowCount} usuarios cumplen condición de expulsión.\nNo se ejecutó auto-expulsión.\nRevisa users.subscription_end.`
    );
    return;
  }

  for (const u of expired.rows) {
    await removeFromGroup(u.telegram_id);
    await pool.query(`UPDATE users SET subscription_status='inactive' WHERE id=$1`, [u.id]);
    await sendMessage(
      ADMIN_ID,
      `❌ Removido por no renovar:\nUsername: ${u.username || 'sin username'}\nTelegram ID: ${u.telegram_id}\nVenció: ${u.subscription_end}`
    );
  }
});

app.post("/webhook", async (req, res) => {
  const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (incomingSecret !== SECRET_TOKEN) return res.sendStatus(403);

  const update = req.body;
  console.log("Webhook received:", JSON.stringify(update));

  if (update.message?.new_chat_members) {
    const chatId = update.message.chat.id;
    if (!GROUP_ID) {
      GROUP_ID = chatId;
      console.log("GROUP_ID:", GROUP_ID);
      await sendMessage(ADMIN_ID, `✅ Grupo detectado: ${GROUP_ID}`);
    }

    for (const member of update.message.new_chat_members) {
      if (member.is_bot) continue;
      await registerUser(member);
      await sendMessage(
        ADMIN_ID,
        `👤 Usuario entró:\nUsername: ${member.username || 'sin username'}\nTelegram ID: ${member.id}`
      );
    }

    return res.sendStatus(200);
  }

  if (!update.message) return res.sendStatus(200);
  const msg = update.message;

  if (msg.from.id !== ADMIN_ID) return res.sendStatus(200);

  const text = (msg.text || "").trim();
  const chatId = msg.chat.id;

  if (text.startsWith("/month ")) {
    const parts = text.split(" ");
    const year = parts[1];
    const month = parts[2];
    const r = await monthReport(year, month);
    await sendMessage(chatId, r);
    return res.sendStatus(200);
  }

  if (text === "/stats") {
    const s = await stats();
    await sendMessage(chatId, s);
    return res.sendStatus(200);
  }

  if (text.startsWith("/renew ")) {
    const telegramId = text.split(" ")[1];
    if (!telegramId || isNaN(telegramId)) {
      await sendMessage(chatId, "❌ Uso: /renew TELEGRAM_ID\nEj: /renew 5863380360");
      return res.sendStatus(200);
    }

    adminSession = { step: 'days', telegramId, chatId };
    await sendMessage(chatId, `👤 Renovar/Alta: ${telegramId}\n\n¿Cuántos días contrató?`);
    return res.sendStatus(200);
  }

  if (adminSession && adminSession.chatId === chatId) {
    const response = text;

    if (adminSession.step === 'days') {
      const days = parseInt(response);
      if (isNaN(days) || days <= 0) {
        await sendMessage(chatId, "❌ Días inválido (número > 0)");
        return res.sendStatus(200);
      }
      adminSession.days = days;
      adminSession.step = 'amount';
      await sendMessage(chatId, "¿Cuánto pagó?");
      return res.sendStatus(200);

    } else if (adminSession.step === 'amount') {
      const amount = parseFloat(response);
      if (isNaN(amount) || amount <= 0) {
        await sendMessage(chatId, "❌ Monto inválido (número > 0)");
        return res.sendStatus(200);
      }
      adminSession.amount = amount;
      adminSession.step = 'method';
      await sendMessage(chatId, "¿Método? (transferencia, nequi, etc)");
      return res.sendStatus(200);

    } else if (adminSession.step === 'method') {
      const result = await renewUser(adminSession.telegramId, adminSession.days, adminSession.amount, response);
      await sendMessage(chatId, result);
      adminSession = null;
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

app.get("/", (_, res) => res.send("Subscription Bot - FIXED DATE STORAGE + GUARD ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));
