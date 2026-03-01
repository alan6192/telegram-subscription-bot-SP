require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

    // 🔥 Limpia duplicadas activas dejando solo la más reciente
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

    // 🔒 Índice único parcial
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
   CREATE OR RENEW SUBSCRIPTION
============================== */
async function createOrRenewSubscription({ user_id, username, days, amount, method }) {

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1️⃣ Expira cualquier activa anterior
    await client.query(`
      UPDATE subscriptions
      SET status='expired'
      WHERE user_id=$1 AND status='active'
    `, [user_id]);

    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + days);

    // 2️⃣ Insert nueva activa
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

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/* ==============================
   ROUTES
============================== */

// 🔹 Crear nuevo usuario o renovar
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

// 🔹 Verificar estado
app.get("/status/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    const result = await pool.query(`
      SELECT * FROM subscriptions
      WHERE user_id=$1 AND status='active'
      LIMIT 1
    `, [user_id]);

    if (result.rows.length === 0) {
      return res.json({ active: false });
    }

    res.json({
      active: true,
      subscription: result.rows[0]
    });

  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

// 🔹 Cron automático para expirar vencidas
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

setInterval(expireSubscriptions, 60 * 60 * 1000); // cada hora

/* ==============================
   START SERVER
============================== */
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log("🚀 Server started");
  await initDB();
  console.log("✅ DB connected");
});