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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("DB connected"))
  .catch(console.error);

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
      currency TEXT DEFAULT 'USD',
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
    VALUES($1, $2, $3) ON CONFLICT(telegram_id) DO NOTHING
  `, [user.id, user.username || null, user.first_name || null]);
}

async function renewUser(telegramId, days, amount, paymentMethod) {
  const userRes = await pool.query(
    `SELECT id FROM users WHERE telegram_id=$1`,
    [telegramId]
  );

  if (!userRes.rowCount) return "❌ Usuario no encontrado en base de datos";

  const userId = userRes.rows[0].id;

  await pool.query(`
    UPDATE subscriptions SET status='expired'
    WHERE user_id=$1 AND status='active'
  `, [userId]);

  const prevSubs = await pool.query(
    `SELECT 1 FROM subscriptions WHERE user_id=$1 LIMIT 1`,
    [userId]
  );
  const isRenewal = prevSubs.rowCount > 0;

  const sub = await pool.query(`
    INSERT INTO subscriptions(user_id, start_date, end_date, status, is_renewal)
    VALUES($1, CURRENT_DATE, CURRENT_DATE + $2 * INTERVAL '1 day', 'active', $3)
    RETURNING id, end_date
  `, [userId, days, isRenewal]);

  const subId = sub.rows[0].id;
  const endDate = sub.rows[0].end_date;

  await pool.query(`
    INSERT INTO payments(subscription_id, amount, method)
    VALUES($1, $2, $3)
  `, [subId, amount, paymentMethod || 'manual']);

  await pool.query(`
    UPDATE users SET subscription_status='active', subscription_end=$1
    WHERE id=$2
  `, [endDate, userId]);

  return `✅ Suscripción registrada!
Vence: ${endDate}
Tipo: ${isRenewal ? '🔄 Renovación' : '➕ Alta nueva'}
Monto: $${amount} (${paymentMethod})`;
}

async function stats() {
  try {
    const active = await pool.query(`SELECT COUNT(*) FROM users WHERE subscription_status='active'`);

    const monthStart = new Date();
    monthStart.setDate(1);

    const mrr = await pool.query(`SELECT COALESCE(SUM(amount), 0) total FROM payments WHERE paid_at >= $1::timestamp`, [monthStart]);
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

    const arpu = newSubs.rows[0].count > 0 ? (mrr.rows[0].total / newSubs.rows[0].count).toFixed(2) : 0;

    return `
📊 STATS MES ACTUAL
👥 Usuarios activos: ${active.rows[0].count}
💰 Ingresos mes: $${Number(mrr.rows[0].total).toFixed(2)}
💎 Ingresos total: $${Number(totalRevenue.rows[0].total).toFixed(2)}
➕ Altas nuevas: ${newSubs.rows[0].count}
🔄 Renovaciones: ${renewals.rows[0].count}
📈 Ticket promedio: $${Number(avgTicket.rows[0].avg).toFixed(2)}
🎯 ARPU: $${arpu}`;
  } catch (e) {
    console.error('Stats error:', e);
    return '❌ Error calculando stats';
  }
}

cron.schedule("0 9 * * *", async () => {
  console.log("Daily check");

  const expiring = await pool.query(`
    SELECT telegram_id, username FROM users 
    WHERE subscription_status='active' AND subscription_end = CURRENT_DATE
  `);

  for (const u of expiring.rows) {
    await sendMessage(ADMIN_ID, `⚠️ Vence hoy: ${u.username || u.telegram_id}`);
  }

  const expired = await pool.query(`
    SELECT telegram_id, id, username FROM users 
    WHERE subscription_status='active' AND subscription_end <= CURRENT_DATE - INTERVAL '3 days'
  `);

  for (const u of expired.rows) {
    await removeFromGroup(u.telegram_id);
    await pool.query(`UPDATE users SET subscription_status='inactive' WHERE id=$1`, [u.id]);
    await sendMessage(ADMIN_ID, `❌ Removido: ${u.username || u.telegram_id}`);
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

      await sendMessage(ADMIN_ID, 
        `👤 Usuario entró:
Username: ${member.username || 'sin username'}
Telegram ID: ${member.id}`
      );
    }
    return res.sendStatus(200);
  }

  if (!update.message) return res.sendStatus(200);
  const msg = update.message;

  if (msg.from.id !== ADMIN_ID) return res.sendStatus(200);

  const text = msg.text || "";
  const chatId = msg.chat.id;

  // COMANDOS
  if (text === "/stats") {
    const s = await stats();
    await sendMessage(chatId, s);
    return res.sendStatus(200);
  }

  // FLUJO RENEW
  if (text.startsWith("/renew ")) {
    const parts = text.split(" ");
    const telegramId = parts[1];
    if (!telegramId) {
      await sendMessage(chatId, "❌ Uso: /renew TELEGRAM_ID");
      return res.sendStatus(200);
    }

    adminSession = { step: 'days', telegramId, chatId };
    await sendMessage(chatId, `👤 Nuevo: ${telegramId}\n¿Cuántos días?`);
    return res.sendStatus(200);
  }

  // RESPUESTAS FLUJO
  if (adminSession && adminSession.chatId === chatId) {
    const response = parseFloat(text) || text.trim();

    if (adminSession.step === 'days') {
      const days = parseInt(response);
      if (isNaN(days) || days <= 0) {
        await sendMessage(chatId, "❌ Días inválido");
        return res.sendStatus(200);
      }
      adminSession.days = days;
      adminSession.step = 'amount';
      await sendMessage(chatId, "¿Cuánto pagó?");
      return res.sendStatus(200);

    } else if (adminSession.step === 'amount') {
      const amount = parseFloat(response);
      if (isNaN(amount) || amount <= 0) {
        await sendMessage(chatId, "❌ Monto inválido");
        return res.sendStatus(200);
      }
      adminSession.amount = amount;
      adminSession.step = 'method';
      await sendMessage(chatId, "¿Método de pago?");
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

app.get("/", (_, res) => res.send("Subscription Bot v2.0 ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on ${PORT}`));