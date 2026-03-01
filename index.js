require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const TelegramBot = require("node-telegram-bot-api");

const app = express();
app.use(express.json());

/* ==============================
   ENV
============================== */
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

/* ==============================
   DATABASE
============================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ==============================
   TELEGRAM BOT
============================== */
const bot = new TelegramBot(TOKEN);

/* ==============================
   INIT DATABASE
============================== */
async function initDB() {
  try {
    console.log("🔄 Initializing DB...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        username TEXT,
        start_date TIMESTAMP NOT NULL,
        end_date TIMESTAMP NOT NULL,
        status TEXT NOT NULL,
        days INTEGER NOT NULL,
        amount NUMERIC(10,2) NOT NULL,
        method TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      UPDATE subscriptions s
      SET status = 'expired'
      WHERE status = 'active'
      AND id NOT IN (
        SELECT MAX(id)
        FROM subscriptions
        WHERE status = 'active'
        GROUP BY user_id
      );
    `);

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE indexname = 'one_active_subscription'
        ) THEN
          CREATE UNIQUE INDEX one_active_subscription
          ON subscriptions(user_id)
          WHERE status='active';
        END IF;
      END$$;
    `);

    console.log("✅ DB ready");

  } catch (err) {
    console.error("Migration error:", err);
  }
}

/* ==============================
   CREATE OR RENEW
============================== */
async function createOrRenewSubscription({ user_id, username, days, amount, method }) {

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      UPDATE subscriptions
      SET status='expired'
      WHERE user_id=$1 AND status='active'
    `, [user_id]);

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + days);

    await client.query(`
      INSERT INTO subscriptions 
      (user_id, username, start_date, end_date, status, days, amount, method)
      VALUES ($1,$2,$3,$4,'active',$5,$6,$7)
    `, [
      user_id,
      username,
      startDate,
      endDate,
      days,
      amount,
      method
    ]);

    await client.query("COMMIT");

    // 🔥 Notificar al usuario por Telegram
    try {
      await bot.sendMessage(user_id, `✅ Subscription activated for ${days} days.`);
    } catch (e) {
      console.log("No se pudo notificar al usuario");
    }

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ==============================
   WEBHOOK
============================== */
app.post("/webhook", async (req, res) => {

  const telegramSecret = req.headers["x-telegram-bot-api-secret-token"];

  if (telegramSecret !== SECRET_TOKEN) {
    return res.sendStatus(403);
  }

  try {
    await bot.processUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

/* ==============================
   TELEGRAM COMMANDS
============================== */
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "Bot active ✅");
});

/* ==============================
   ROUTES (SE MANTIENEN IGUAL)
============================== */
app.post("/renew", async (req, res) => {
  try {
    const { user_id, username, days, amount, method } = req.body;

    if (!user_id || !days || !amount || !method) {
      return res.status(400).json({
        error: "user_id, days, amount y method son obligatorios"
      });
    }

    await createOrRenewSubscription({
      user_id,
      username,
      days: Number(days),
      amount: Number(amount),
      method
    });

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  }
});

/* ==============================
   EXPIRE CRON
============================== */
async function expireSubscriptions() {
  try {
    await pool.query(`
      UPDATE subscriptions
      SET status='expired'
      WHERE status='active'
      AND end_date < NOW()
    `);
  } catch (err) {
    console.error("Expire error:", err);
  }
}

setInterval(expireSubscriptions, 60 * 60 * 1000);

/* ==============================
   START SERVER
============================== */
app.listen(PORT, async () => {
  console.log("🚀 Server started");
  await initDB();

  const webhookUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook`;

  await bot.setWebHook(webhookUrl, {
    secret_token: SECRET_TOKEN
  });

  console.log("✅ Webhook configured");
});