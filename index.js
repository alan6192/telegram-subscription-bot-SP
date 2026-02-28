require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const axios = require("axios");
const cron = require("node-cron");

const app = express();
app.use(express.json());

/* ======================
   ENV
====================== */

const BOT_TOKEN = process.env.BOT_TOKEN;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const GROUP_ID = process.env.CHANNEL_ID;

if (!BOT_TOKEN || !SECRET_TOKEN || !ADMIN_ID || !GROUP_ID) {
  console.error("❌ Missing environment variables");
  process.exit(1);
}

/* ======================
   DATABASE
====================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("✅ DB connected"))
  .catch(err => {
    console.error("DB error", err);
    process.exit(1);
  });

/* ======================
   CREATE TABLES
====================== */

async function createTables() {

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
  await pool.query(`
  ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS method TEXT;
`);
  `);

  console.log("✅ Tables ready");
}

createTables();

/* ======================
   TELEGRAM HELPERS
====================== */

async function sendMessage(chatId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text }
    );
  } catch (e) {
    console.error("Telegram error:", e.response?.data || e.message);
  }
}

async function removeFromGroup(userId) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`,
      { chat_id: GROUP_ID, user_id: userId }
    );
  } catch (e) {
    console.error("Remove error:", e.response?.data || e.message);
  }
}

/* ======================
   USER REGISTRATION
====================== */

async function registerUser(user) {

  await pool.query(`
    INSERT INTO users(telegram_id, username, first_name)
    VALUES($1,$2,$3)
    ON CONFLICT (telegram_id) DO NOTHING
  `, [user.id, user.username || null, user.first_name || null]);

  await sendMessage(
    ADMIN_ID,
    `🆕 Nuevo usuario detectado\n\nID: ${user.id}\nUsername: @${user.username || "N/A"}\n\nUsa:\n/renew ${user.id} 30 20`
  );
}

/* ======================
   RENEW SUBSCRIPTION
====================== */

async function renewUser(telegramId, days, amount, method="Manual") {

  const userRes = await pool.query(
    `SELECT id FROM users WHERE telegram_id=$1`,
    [telegramId]
  );

  if (!userRes.rowCount) return "❌ Usuario no encontrado";

  const userId = userRes.rows[0].id;

  await pool.query(`
    UPDATE subscriptions
    SET status='expired'
    WHERE user_id=$1 AND status='active'
  `, [userId]);

  const sub = await pool.query(`
    INSERT INTO subscriptions
    (user_id, start_date, end_date, status)
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

  await pool.query(`
    INSERT INTO payments(subscription_id, method, amount)
    VALUES($1,$2,$3)
  `, [subId, method, amount]);

  await pool.query(`
    UPDATE users
    SET subscription_status='active',
        subscription_end=$1
    WHERE id=$2
  `, [endDate, userId]);

  return `✅ Renovado hasta ${endDate}`;
}

/* ======================
   ADVANCED ANALYTICS
====================== */

async function stats() {

  const active = await pool.query(`
    SELECT COUNT(*) FROM users WHERE subscription_status='active'
  `);

  const pending = await pool.query(`
    SELECT COUNT(*) FROM users WHERE subscription_status='pending'
  `);

  const expired = await pool.query(`
    SELECT COUNT(*) FROM users WHERE subscription_status='expired'
  `);

  const totalRevenue = await pool.query(`
    SELECT COALESCE(SUM(amount),0) total FROM payments
  `);

  const mrr = await pool.query(`
    SELECT COALESCE(SUM(amount),0) total
    FROM payments
    WHERE date_trunc('month',paid_at)=date_trunc('month',CURRENT_DATE)
  `);

  const avg = await pool.query(`
    SELECT COALESCE(AVG(amount),0) avg FROM payments
  `);

  return `
📊 BUSINESS ANALYTICS

Active Users: ${active.rows[0].count}
Pending Users: ${pending.rows[0].count}
Expired Users: ${expired.rows[0].count}

Total Revenue: $${totalRevenue.rows[0].total}
MRR: $${mrr.rows[0].total}
Average Ticket: $${Number(avg.rows[0].avg).toFixed(2)}
`;
}

/* ======================
   DAILY CHECK
====================== */

cron.schedule("0 9 * * *", async () => {

  console.log("⏳ Daily subscription check");

  const expiring = await pool.query(`
    SELECT telegram_id, username
    FROM users
    WHERE subscription_status='active'
    AND subscription_end=CURRENT_DATE
  `);

  for (const u of expiring.rows) {
    await sendMessage(
      ADMIN_ID,
      `⚠️ Vence hoy: ${u.username || u.telegram_id}`
    );
  }

  const expired = await pool.query(`
    SELECT telegram_id, id, username
    FROM users
    WHERE subscription_status='active'
    AND subscription_end <= CURRENT_DATE - INTERVAL '3 day'
  `);

  for (const u of expired.rows) {

    await removeFromGroup(u.telegram_id);

    await pool.query(`
      UPDATE users
      SET subscription_status='removed'
      WHERE id=$1
    `, [u.id]);

    await sendMessage(
      ADMIN_ID,
      `❌ Usuario removido: ${u.username || u.telegram_id}`
    );
  }

});

/* ======================
   WEBHOOK
====================== */

app.post("/webhook", async (req, res) => {

  const incomingSecret =
    req.headers["x-telegram-bot-api-secret-token"];

  if (incomingSecret !== SECRET_TOKEN)
    return res.sendStatus(403);

  const update = req.body;

  console.log("Webhook received");

  if (update.message?.new_chat_members) {

    for (const member of update.message.new_chat_members) {

      if (member.is_bot) continue;

      await registerUser(member);
    }

    return res.sendStatus(200);
  }

  if (!update.message) return res.sendStatus(200);

  const msg = update.message;

  if (msg.from.id !== ADMIN_ID)
    return res.sendStatus(200);

  const text = msg.text || "";

  if (text.startsWith("/renew")) {

    const parts = text.split(" ");
    const telegramId = parts[1];
    const days = Number(parts[2]);
    const amount = Number(parts[3] || 0);

    const response =
      await renewUser(telegramId, days, amount);

    await sendMessage(msg.chat.id, response);
  }

  if (text === "/stats") {
    const s = await stats();
    await sendMessage(msg.chat.id, s);
  }

  res.sendStatus(200);
});

/* ======================
   ROOT
====================== */

app.get("/", (_, res) => {
  res.send("Subscription Bot Running 🚀");
});

/* ======================
   START SERVER
====================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});