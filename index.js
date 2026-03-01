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

let GROUP_ID = process.env.CHANNEL_ID || null;

/* ======================
DATABASE
====================== */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

pool.connect()
  .then(() => console.log("DB connected"))
  .catch(console.error);

/* ======================
CREATE TABLES - MEJORADO PARA BI
====================== */

async function createTables() {
  // Tabla users: estado operativo actual
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

  // Tabla subscriptions: HISTÓRICO COMPLETO para analítica
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

  // Tabla payments: DETALLE FINANCIERO
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments(
      id SERIAL PRIMARY KEY,
      subscription_id INTEGER REFERENCES subscriptions(id),
      amount NUMERIC(10,2) NOT NULL,
      currency TEXT DEFAULT 'USD',
      payment_method TEXT,  -- Nuevo: transferencia, nequi, etc
      paid_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  console.log("Tables ready - BI ready");
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
    console.error(e.response?.data || e.message);
  }
}

async function removeFromGroup(userId) {
  if (!GROUP_ID) {
    console.log("GROUP_ID missing");
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`,
      {
        chat_id: GROUP_ID,
        user_id: userId
      }
    );
  } catch (e) {
    console.error("Remove error", e.response?.data || e.message);
  }
}

/* ======================
ADMIN SESSION (estado del flujo guiado)
====================== */
// Memoria simple para el flujo del admin (en prod usar Redis o tabla)
let adminSession = null;

/* ======================
REGISTER USER
====================== */

async function registerUser(user) {
  await pool.query(`
    INSERT INTO users(telegram_id, username, first_name)
    VALUES($1, $2, $3)
    ON CONFLICT(telegram_id) DO NOTHING
  `, [user.id, user.username || null, user.first_name || null]);
}

/* ======================
RENEW SUBSCRIPTION - MEJORADO
====================== */

async function renewUser(telegramId, days, amount, paymentMethod, isRenewal) {
  const userRes = await pool.query(
    `SELECT id FROM users WHERE telegram_id=$1`,
    [telegramId]
  );

  if (!userRes.rowCount) return "❌ Usuario no encontrado";

  const userId = userRes.rows[0].id;

  // Cerrar suscripciones activas previas
  await pool.query(`
    UPDATE subscriptions
    SET status='expired'
    WHERE user_id=$1 AND status='active'
  `, [userId]);

  // Crear nueva suscripción
  const sub = await pool.query(`
    INSERT INTO subscriptions(user_id, start_date, end_date, status, is_renewal)
    VALUES($1, CURRENT_DATE, CURRENT_DATE + $2 * INTERVAL '1 day', 'active', $3)
    RETURNING id, end_date
  `, [userId, days, isRenewal]);

  const subId = sub.rows[0].id;
  const endDate = sub.rows[0].end_date;

  // Registrar pago con método
  await pool.query(`
    INSERT INTO payments(subscription_id, amount, payment_method)
    VALUES($1, $2, $3)
  `, [subId, amount, paymentMethod]);

  // Actualizar estado usuario
  await pool.query(`
    UPDATE users
    SET subscription_status='active', subscription_end=$1
    WHERE id=$2
  `, [endDate, userId]);

  return `✅ Suscripción registrada.\nVence: ${endDate}\nTipo: ${isRenewal ? 'Renovación' : 'Alta nueva'}`;
}

/* ======================
BUSINESS STATS - AVANZADO
====================== */

async function stats() {
  const active = await pool.query(`
    SELECT COUNT(*) FROM users
    WHERE subscription_status='active'
  `);

  const monthStart = new Date();
  monthStart.setDate(1);

  const mrr = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) total
    FROM payments
    WHERE paid_at >= $1::timestamp
  `, [monthStart]);

  const totalRevenue = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) total FROM payments
  `);

  const avgTicket = await pool.query(`
    SELECT COALESCE(AVG(amount), 0) avg FROM payments
  `);

  const newSubs = await pool.query(`
    SELECT COUNT(*) 
    FROM subscriptions s
    JOIN payments p ON s.id = p.subscription_id
    WHERE s.is_renewal = FALSE AND p.paid_at >= $1::timestamp
  `, [monthStart]);

  const renewals = await pool.query(`
    SELECT COUNT(*) 
    FROM subscriptions s
    JOIN payments p ON s.id = p.subscription_id
    WHERE s.is_renewal = TRUE AND p.paid_at >= $1::timestamp
  `, [monthStart]);

  const arpu = newSubs.rowCount > 0 
    ? Number(mrr.rows[0].total / newSubs.rows[0].count).toFixed(2)
    : 0;

  return `
📊 STATS MES ACTUAL
Active users: ${active.rows[0].count}
Ingresos mes: $${Number(mrr.rows[0].total).toFixed(2)}
Ingresos total: $${Number(totalRevenue.rows[0].total).toFixed(2)}
Altas nuevas: ${newSubs.rows[0].count}
Renovaciones: ${renewals.rows[0].count}
Ticket promedio: $${Number(avgTicket.rows[0].avg).toFixed(2)}
ARPU: $${arpu}
  `;
}

/* ======================
MONTHLY REPORT
====================== */

async function monthlyReport(year, month) {
  const dateStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const dateEnd = new Date(year, month, 0);

  const revenue = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) total
    FROM payments WHERE paid_at >= $1::date AND paid_at < $2::date
  `, [dateStart, dateEnd.toISOString().split('T')[0]]);

  const newSubs = await pool.query(`
    SELECT COUNT(*) FROM subscriptions s
    JOIN payments p ON s.id = p.subscription_id
    WHERE s.is_renewal = FALSE AND p.paid_at >= $1::date AND p.paid_at < $2::date
  `, [dateStart, dateEnd.toISOString().split('T')[0]]);

  const renewals = await pool.query(`
    SELECT COUNT(*) FROM subscriptions s
    JOIN payments p ON s.id = p.subscription_id
    WHERE s.is_renewal = TRUE AND p.paid_at >= $1::date AND p.paid_at < $2::date
  `, [dateStart, dateEnd.toISOString().split('T')[0]]);

  // Comparación con mes anterior
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevStart = `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`;
  const prevEnd = new Date(prevYear, prevMonth, 0);

  const prevRevenue = await pool.query(`
    SELECT COALESCE(SUM(amount), 0) total
    FROM payments WHERE paid_at >= $1::date AND paid_at < $2::date
  `, [prevStart, prevEnd.toISOString().split('T')[0]]);

  const growth = prevRevenue.rows[0].total > 0 
    ? ((revenue.rows[0].total - prevRevenue.rows[0].total) / prevRevenue.rows[0].total * 100).toFixed(1)
    : '∞';

  return `
📈 REPORTE MES ${year}-${String(month).padStart(2, '0')}
Ingresos: $${Number(revenue.rows[0].total).toFixed(2)}
Altas nuevas: ${newSubs.rows[0].count}
Renovaciones: ${renewals.rows[0].count}
Crecimiento vs mes anterior: ${growth}%
  `;
}

/* ======================
DAILY CHECK - MEJORADO
====================== */

cron.schedule("0 9 * * *", async () => {
  console.log("Daily subscription check");

  // Vencen hoy
  const expiring = await pool.query(`
    SELECT telegram_id, username
    FROM users
    WHERE subscription_status='active'
    AND subscription_end = CURRENT_DATE
  `);

  for (const u of expiring.rows) {
    await sendMessage(
      ADMIN_ID,
      `⚠️ Vence hoy: ${u.username || u.telegram_id}`
    );
  }

  // Remover tras 3 días
  const expired = await pool.query(`
    SELECT telegram_id, id, username
    FROM users
    WHERE subscription_status='active'
    AND subscription_end <= CURRENT_DATE - INTERVAL '3 days'
  `);

  for (const u of expired.rows) {
    await removeFromGroup(u.telegram_id);

    await pool.query(`
      UPDATE users
      SET subscription_status='inactive'
      WHERE id=$1
    `, [u.id]);

    await sendMessage(
      ADMIN_ID,
      `❌ Removido por no renovar: ${u.username || u.telegram_id}`
    );
  }
});

/* ======================
WEBHOOK - CON FLUJO GUIADO
====================== */

app.post("/webhook", async (req, res) => {
  const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];

  if (incomingSecret !== SECRET_TOKEN)
    return res.sendStatus(403);

  const update = req.body;

  console.log("Webhook received:", JSON.stringify(update));

  // USER JOIN GROUP
  if (update.message?.new_chat_members) {
    const chatId = update.message.chat.id;

    if (!GROUP_ID) {
      GROUP_ID = chatId;
      console.log("GROUP DETECTED:", GROUP_ID);
      await sendMessage(
        ADMIN_ID,
        `✅ Grupo detectado automáticamente: ${GROUP_ID}`
      );
    }

    for (const member of update.message.new_chat_members) {
      if (member.is_bot) continue;

      await registerUser(member);
      await sendMessage(
        ADMIN_ID,
        `👤 Usuario entró: ${member.username || member.id}`
      );
    }

    return res.sendStatus(200);
  }

  // Solo comandos del admin
  if (!update.message) return res.sendStatus(200);
  const msg = update.message;

  if (msg.from.id !== ADMIN_ID)
    return res.sendStatus(200);

  const text = msg.text || "";
  const chatId = msg.chat.id;

  // COMANDOS ESPECIALES
  if (text === "/stats") {
    const s = await stats();
    await sendMessage(chatId, s);
    return res.sendStatus(200);
  }

  if (text.startsWith("/month ")) {
    const parts = text.split(" ");
    const year = parseInt(parts[1]);
    const month = parseInt(parts[2]);
    if (year && month) {
      const report = await monthlyReport(year, month);
      await sendMessage(chatId, report);
    }
    return res.sendStatus(200);
  }

  if (text.startsWith("/renew ")) {
    const parts = text.split(" ");
    const telegramId = parts[1];
    if (!telegramId) {
      await sendMessage(chatId, "❌ Uso: /renew TELEGRAM_ID");
      return res.sendStatus(200);
    }

    // INICIAR FLUJO GUIADO
    adminSession = {
      step: 'ask_days',
      telegramId: telegramId,
      chatId: chatId
    };

    await sendMessage(chatId, `👤 Nuevo ingreso detectado:\nUsuario ID: ${telegramId}\n\n¿Cuántos días contrató?`);
    return res.sendStatus(200);
  }

  // RESPUESTAS AL FLUJO GUIADO
  if (adminSession && adminSession.chatId === chatId) {
    const response = text.trim();

    if (adminSession.step === 'ask_days') {
      const days = parseInt(response);
      if (isNaN(days) || days <= 0) {
        await sendMessage(chatId, "❌ Días inválidos. ¿Cuántos días contrató?");
        return res.sendStatus(200);
      }

      adminSession.days = days;
      adminSession.step = 'ask_amount';
      await sendMessage(chatId, "¿Cuánto pagó?");
      return res.sendStatus(200);

    } else if (adminSession.step === 'ask_amount') {
      const amount = parseFloat(response);
      if (isNaN(amount) || amount <= 0) {
        await sendMessage(chatId, "❌ Monto inválido. ¿Cuánto pagó?");
        return res.sendStatus(200);
      }

      adminSession.amount = amount;
      adminSession.step = 'ask_method';
      await sendMessage(chatId, "¿Método de pago? (transferencia, nequi, etc)");
      return res.sendStatus(200);

    } else if (adminSession.step === 'ask_method') {
      const paymentMethod = response;

      // DETECTAR SI ES RENOVACIÓN
      const userRes = await pool.query(
        `SELECT id FROM users WHERE telegram_id=$1`,
        [adminSession.telegramId]
      );
      const userId = userRes.rows[0]?.id;
      const prevSubs = await pool.query(
        `SELECT 1 FROM subscriptions WHERE user_id=$1 LIMIT 1`,
        [userId]
      );
      const isRenewal = prevSubs.rowCount > 0;

      // EJECUTAR RENOVACIÓN
      const result = await renewUser(
        adminSession.telegramId,
        adminSession.days,
        adminSession.amount,
        paymentMethod,
        isRenewal
      );

      await sendMessage(chatId, result);
      adminSession = null;  // CERRAR FLUJO
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

/* ======================
ROOT
====================== */

app.get("/", (_, res) => {
  res.send("Subscription Bot Running 🚀 - BI Ready");
});

/* ======================
START SERVER
====================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});