require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());

/* ================= ENV ================= */

const {
  BOT_TOKEN,
  SECRET_TOKEN,
  ADMIN_ID,
  CHANNEL_ID,
  DATABASE_URL,
  PORT
} = process.env;

if (!BOT_TOKEN || !SECRET_TOKEN || !ADMIN_ID || !CHANNEL_ID || !DATABASE_URL) {
  console.error("❌ Missing environment variables");
  process.exit(1);
}

/* ================= DATABASE ================= */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("✅ DB connected"))
  .catch(err => {
    console.error("DB connection error:", err);
    process.exit(1);
  });

/* ================= MIGRATIONS ================= */

async function runMigrations() {
  try {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username TEXT,
        first_name TEXT,
        subscription_status TEXT DEFAULT 'pending',
        subscription_end DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions(
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        start_date DATE,
        end_date DATE,
        status TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments(
        id SERIAL PRIMARY KEY,
        subscription_id INTEGER REFERENCES subscriptions(id),
        method TEXT,
        amount NUMERIC,
        currency TEXT DEFAULT 'USD',
        paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Índice único parcial → solo 1 activa por usuario
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_subscription
      ON subscriptions(user_id)
      WHERE status='active';
    `);

    console.log("✅ Migrations complete");

  } catch (err) {
    console.error("Migration error:", err);
  }
}

runMigrations();

/* ================= TELEGRAM ================= */

async function sendMessage(chatId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text }
    );
  } catch (err) {
    console.error("Telegram error:", err.response?.data || err.message);
  }
}

async function removeFromGroup(userId) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`,
      { chat_id: CHANNEL_ID, user_id: userId }
    );
  } catch (err) {
    console.error("Remove error:", err.response?.data || err.message);
  }
}

/* ================= REGISTER ================= */

async function registerUser(member) {
  try {

    await pool.query(`
      INSERT INTO users(telegram_id, username, first_name)
      VALUES($1,$2,$3)
      ON CONFLICT (telegram_id) DO NOTHING
    `, [
      member.id,
      member.username || null,
      member.first_name || null
    ]);

    await sendMessage(
      ADMIN_ID,
      `🆕 Nuevo usuario\nID: ${member.id}\nUsername: @${member.username || "N/A"}\n\nUsa:\n/renew ${member.id} 30 20`
    );

  } catch (err) {
    console.error("Register error:", err);
  }
}

/* ================= RENEW (PRO MODEL) ================= */

async function renewUser(telegramId, days, amount) {
  try {

    const userRes = await pool.query(
      `SELECT id FROM users WHERE telegram_id=$1`,
      [telegramId]
    );

    if (!userRes.rowCount)
      return "❌ Usuario no encontrado";

    const userId = userRes.rows[0].id;

    // 1️⃣ Cerrar activa anterior
    await pool.query(`
      UPDATE subscriptions
      SET status='expired'
      WHERE user_id=$1 AND status='active'
    `, [userId]);

    // 2️⃣ Crear nueva activa
    const sub = await pool.query(`
      INSERT INTO subscriptions(user_id, start_date, end_date, status)
      VALUES(
        $1,
        CURRENT_DATE,
        CURRENT_DATE + $2 * INTERVAL '1 day',
        'active'
      )
      RETURNING id, end_date
    `, [userId, days]);

    const subId = sub.rows[0].id;
    const endDate = sub.rows[0].end_date;

    // 3️⃣ Registrar pago
    await pool.query(`
      INSERT INTO payments(subscription_id, method, amount)
      VALUES($1,$2,$3)
    `, [subId, "Manual", amount]);

    // 4️⃣ Actualizar usuario
    await pool.query(`
      UPDATE users
      SET subscription_status='active',
          subscription_end=$1
      WHERE id=$2
    `, [endDate, userId]);

    const cleanDate = endDate.toISOString().split("T")[0];
    return `✅ Renovado hasta ${cleanDate}`;

  } catch (err) {
    console.error("Renew error:", err);
    return "❌ Error interno";
  }
}

/* ================= STATS ================= */

async function stats() {
  try {

    const active = await pool.query(`
      SELECT COUNT(*) FROM users WHERE subscription_status='active'
    `);

    const pending = await pool.query(`
      SELECT COUNT(*) FROM users WHERE subscription_status='pending'
    `);

    const totalRevenue = await pool.query(`
      SELECT COALESCE(SUM(amount),0) total FROM payments
    `);

    const mrr = await pool.query(`
      SELECT COALESCE(SUM(amount),0) total
      FROM payments
      WHERE date_trunc('month',paid_at)=date_trunc('month',CURRENT_DATE)
    `);

    return `
📊 BUSINESS ANALYTICS

Active Users: ${active.rows[0].count}
Pending Users: ${pending.rows[0].count}

Total Revenue: $${totalRevenue.rows[0].total}
MRR: $${mrr.rows[0].total}
`;

  } catch (err) {
    console.error("Stats error:", err);
    return "❌ Error generando estadísticas";
  }
}

/* ================= CRON ================= */

cron.schedule("0 9 * * *", async () => {

  try {

    const expiring = await pool.query(`
      SELECT telegram_id
      FROM users
      WHERE subscription_status='active'
      AND subscription_end=CURRENT_DATE
    `);

    for (const u of expiring.rows) {
      await sendMessage(
        ADMIN_ID,
        `⚠️ Vence hoy: ${u.telegram_id}`
      );
    }

    const remove = await pool.query(`
      SELECT id, telegram_id
      FROM users
      WHERE subscription_status='active'
      AND subscription_end <= CURRENT_DATE - INTERVAL '3 day'
    `);

    for (const u of remove.rows) {

      await removeFromGroup(u.telegram_id);

      await pool.query(`
        UPDATE users
        SET subscription_status='removed'
        WHERE id=$1
      `, [u.id]);

      await sendMessage(
        ADMIN_ID,
        `❌ Usuario removido: ${u.telegram_id}`
      );
    }

  } catch (err) {
    console.error("Cron error:", err);
  }

});

/* ================= WEBHOOK ================= */

app.post("/webhook", async (req, res) => {

  if (req.headers["x-telegram-bot-api-secret-token"] !== SECRET_TOKEN)
    return res.sendStatus(403);

  const update = req.body;

  if (update.message?.new_chat_members) {

    for (const member of update.message.new_chat_members) {
      if (!member.is_bot)
        await registerUser(member);
    }

    return res.sendStatus(200);
  }

  if (!update.message) return res.sendStatus(200);
  if (update.message.from.id != ADMIN_ID) return res.sendStatus(200);

  const text = update.message.text || "";

  if (text.startsWith("/renew")) {

    const parts = text.split(" ");

    const response = await renewUser(
      parts[1],
      Number(parts[2]),
      Number(parts[3] || 0)
    );

    await sendMessage(update.message.chat.id, response);
  }

  if (text === "/stats") {
    const s = await stats();
    await sendMessage(update.message.chat.id, s);
  }

  res.sendStatus(200);
});

/* ================= ROOT ================= */

app.get("/", (_, res) => {
  res.send("Bot running 🚀");
});

app.listen(PORT || 3000, () => {
  console.log("🚀 Server started");
});