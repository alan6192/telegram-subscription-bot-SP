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
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(iso);
  const [y, m, d] = iso.split("-");
  const months = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
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
    console.error("SendMessage error:", e.response?.data || e.message);
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

// Sesiones
let adminSession = null;      // altas / renovaciones
let cleanupSession = null;    // proceso de expulsión manual

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

  // Cerrar suscripciones activas previas
  await pool.query(`
    UPDATE subscriptions SET status='expired'
    WHERE user_id=$1 AND status='active'
  `, [userId]);

  // ¿Es renovación?
  const prevSubs = await pool.query(
    `SELECT 1 FROM subscriptions WHERE user_id=$1 LIMIT 1`,
    [userId]
  );
  const isRenewal = prevSubs.rowCount > 0;

  // Insertar nueva suscripción
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
  `, [subId, amount, paymentMethod || "manual"]);

  await pool.query(`
    UPDATE users
    SET subscription_status='active', subscription_end=$1::date
    WHERE id=$2
  `, [endDateIso, userId]);

  return `✅ Suscripción registrada!\nVence: ${isoToDisplay(endDateIso)} (${endDateIso})\nTipo: ${
    isRenewal ? "🔄 Renovación" : "➕ Alta nueva"
  }\nMonto: $${amount} (${paymentMethod})`;
}

async function stats() {
  try {
    const active = await pool.query(
      `SELECT COUNT(*) FROM users WHERE subscription_status='active'`
    );

    const monthStart = new Date();
    monthStart.setDate(1);

    const mrr = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) total FROM payments WHERE paid_at >= $1::timestamp`,
      [monthStart]
    );
    const totalRevenue = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) total FROM payments`
    );
    const avgTicket = await pool.query(
      `SELECT COALESCE(AVG(amount), 0) avg FROM payments`
    );

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
      : "0.00";

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
    console.error("Stats error:", e);
    return "❌ Error calculando stats";
  }
}

async function monthReport(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!y || !m || m < 1 || m > 12) return "❌ Uso: /month YYYY MM (ej: /month 2026 3)";

  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0));

  const revenue = await pool.query(
    `SELECT COALESCE(SUM(amount),0) total
     FROM payments
     WHERE paid_at >= $1::timestamptz AND paid_at < $2::timestamptz`,
    [start.toISOString(), end.toISOString()]
  );

  const newSubs = await pool.query(
    `SELECT COUNT(*)
     FROM subscriptions s
     JOIN payments p ON p.subscription_id = s.id
     WHERE s.is_renewal = FALSE
       AND p.paid_at >= $1::timestamptz AND p.paid_at < $2::timestamptz`,
    [start.toISOString(), end.toISOString()]
  );

  const renewals = await pool.query(
    `SELECT COUNT(*)
     FROM subscriptions s
     JOIN payments p ON p.subscription_id = s.id
     WHERE s.is_renewal = TRUE
       AND p.paid_at >= $1::timestamptz AND p.paid_at < $2::timestamptz`,
    [start.toISOString(), end.toISOString()]
  );

  return `📅 REPORTE ${y}-${String(m).padStart(2,"0")}
Ingresos: $${Number(revenue.rows[0].total).toFixed(2)}
Altas nuevas: ${newSubs.rows[0].count}
Renovaciones: ${renewals.rows[0].count}`;
}

// Próximos en vencer
async function nextExpiring(limit = 10, daysAhead = null) {
  const lim = Math.min(Math.max(parseInt(limit) || 10, 1), 100);

  let query = `
    SELECT
      telegram_id,
      username,
      first_name,
      subscription_end,
      (subscription_end - CURRENT_DATE) AS days_left
    FROM users
    WHERE subscription_status = 'active'
      AND subscription_end IS NOT NULL
      AND subscription_end >= CURRENT_DATE
  `;
  const params = [];

  if (daysAhead !== null) {
    query += ` AND subscription_end <= (CURRENT_DATE + $1::interval)`;
    params.push(`${daysAhead} days`);
  }

  query += `
    ORDER BY subscription_end ASC
    LIMIT ${lim}
  `;

  const res = await pool.query(query, params);

  if (!res.rowCount) {
    return "📅 No hay usuarios activos con fecha de vencimiento próxima.";
  }

  let header = "📅 Próximos usuarios en vencer\n\n";
  if (daysAhead !== null) {
    header = `📅 Próximos usuarios que vencen en los próximos ${daysAhead} días\n\n`;
  }

  const lines = res.rows.map((u, i) => {
    const idx = i + 1;
    const displayName = u.first_name || "Sin nombre";
    const endDateIso =
      typeof u.subscription_end === "string"
        ? u.subscription_end
        : u.subscription_end.toISOString().slice(0, 10);
    const endDate = isoToDisplay(endDateIso);
    const daysLeft = Number(u.days_left);
    const diasTexto =
      daysLeft === 0
        ? "hoy"
        : daysLeft === 1
        ? "en 1 día"
        : `en ${daysLeft} días`;

    return `${idx}) ${endDate} (${diasTexto})
   Nombre: ${displayName} — Telegram ID: ${u.telegram_id}`;
  });

  return header + lines.join("\n\n");
}

// Obtener lista de usuarios con más de 1 días vencidos
async function getExpiredCandidates() {
  const res = await pool.query(`
    SELECT id, telegram_id, username, first_name, subscription_end
    FROM users
    WHERE subscription_status='active'
      AND subscription_end IS NOT NULL
      AND subscription_end <= (CURRENT_DATE - INTERVAL '1 days')
    ORDER BY subscription_end ASC
  `);
  return res.rows;
}

// Cron diario
cron.schedule("0 9 * * *", async () => {
  console.log("Daily check");

  // Notify expiring today
  const expiring = await pool.query(`
    SELECT telegram_id, username, first_name
    FROM users
    WHERE subscription_status='active'
      AND subscription_end IS NOT NULL
      AND subscription_end = CURRENT_DATE
  `);

  for (const u of expiring.rows) {
    await sendMessage(
      ADMIN_ID,
      `⚠️ Vence hoy:
Nombre: ${u.first_name || "Sin nombre"}
Telegram ID: ${u.telegram_id}`
    );
  }

  // Resumen de próximos a vencer (próximos 3 días)
  try {
    const resumen = await nextExpiring(10, 3);
    if (!resumen.startsWith("📅 No hay usuarios")) {
      await sendMessage(
        ADMIN_ID,
        `⏰ Recordatorio diario:\n${resumen}`
      );
    }
  } catch (e) {
    console.error("Error en nextExpiring dentro del cron:", e);
  }

  // Solo informar quiénes llevan más de 1 días vencidos (sin expulsar)
  const expired = await getExpiredCandidates();

  if (expired.length > 0) {
    let resumen = `⚠️ Usuarios con más de 1 día vencido (${expired.length}):\n\n`;

    const lines = expired.slice(0, 20).map((u, i) => {
      const idx = i + 1;
      const displayName = u.first_name || "Sin nombre";
      return `${idx}) Nombre: ${displayName} — Telegram ID: ${u.telegram_id}
   Venció: ${u.subscription_end}`;
    });

    resumen += lines.join("\n\n");

    if (expired.length > 20) {
      resumen += `\n\n... y ${expired.length - 20} más.`;
    }

    resumen += `\n\nNo se ha expulsado a nadie automáticamente.\nPuedes usar /cleanup para revisar y expulsar uno por uno.`;

    await sendMessage(ADMIN_ID, resumen);
  }
});

// WEBHOOK
app.post("/webhook", async (req, res) => {
  const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (incomingSecret !== SECRET_TOKEN) return res.sendStatus(403);

  const update = req.body;
  console.log("Webhook received:", JSON.stringify(update));

  // Nuevos miembros del grupo
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
        `👤 Usuario entró:
Nombre: ${member.first_name || "Sin nombre"}
Telegram ID: ${member.id}`
      );

      if (!adminSession) {
        adminSession = {
          step: "days",
          telegramId: String(member.id),
          chatId: ADMIN_ID
        };

        await sendMessage(
          ADMIN_ID,
          `🚀 Nuevo miembro detectado: ${member.first_name || "Sin nombre"} (${member.id})

¿Cuántos días contrató?`
        );
      } else {
        await sendMessage(
          ADMIN_ID,
          `ℹ️ Entró ${member.first_name || "Sin nombre"} (${member.id}) pero ya hay una renovación en curso.
Cuando termines, puedes usar /renew ${member.id} para procesarlo.`
        );
      }
    }

    return res.sendStatus(200);
  }

  if (!update.message) return res.sendStatus(200);
  const msg = update.message;
  const text = (msg.text || "").trim();
  const chatId = msg.chat.id;

  // Solo el admin puede ejecutar comandos / respuestas
  if (msg.from.id !== ADMIN_ID) return res.sendStatus(200);

  // /help - resumen de funcionalidad
  if (text === "/help" || text === "/start") {
    const helpMsg = `
🤖 MemberFlow - Comandos disponibles

/renew TELEGRAM_ID
   Inicia alta/renovación manual para un usuario.

/stats
   Muestra estadísticas del mes actual (activos, ingresos, altas, renovaciones).

/month YYYY MM
   Reporte de ingresos y renovaciones de un mes específico.
   Ej: /month 2026 05

/next [cantidad] [dias]
   Lista los próximos usuarios en vencer.
   Ej: /next        → próximos 10
       /next 5      → próximos 5
       /next 10 7   → 10 usuarios que vencen en los próximos 7 días.

/cleanup
   Inicia un flujo para revisar usuarios con más de 1 día vencido y expulsarlos uno por uno (con confirmación).

Además:
- Cuando un usuario entra al grupo, el bot te abre automáticamente un flujo de alta/renovación (días, monto, método).
- Todos los días a las 9am recibes recordatorio de vencimientos y una lista de quienes llevan más de 1 día vencido (sin expulsarlos).`;
    await sendMessage(chatId, helpMsg);
    return res.sendStatus(200);
  }

  // /month YYYY MM
  if (text.startsWith("/month ")) {
    const parts = text.split(" ");
    const year = parts[1];
    const month = parts[2];
    const r = await monthReport(year, month);
    await sendMessage(chatId, r);
    return res.sendStatus(200);
  }

  // /stats
  if (text === "/stats") {
    const s = await stats();
    await sendMessage(chatId, s);
    return res.sendStatus(200);
  }

  // /next [limit] [daysAhead]
  if (text.startsWith("/next")) {
    const parts = text.split(" ").filter(Boolean);
    let limit = 10;
    let daysAhead = null;

    if (parts[1]) {
      limit = parseInt(parts[1]);
      if (isNaN(limit) || limit <= 0) {
        await sendMessage(chatId, "❌ Uso: /next [cantidad] [dias]\nEj: /next 10 7 (10 usuarios que vencen en los próximos 7 días)");
        return res.sendStatus(200);
      }
    }

    if (parts[2]) {
      daysAhead = parseInt(parts[2]);
      if (isNaN(daysAhead) || daysAhead < 0) {
        await sendMessage(chatId, "❌ Días inválidos. Usa un número >= 0.\nEj: /next 10 7");
        return res.sendStatus(200);
      }
    }

    const msgNext = await nextExpiring(limit, daysAhead);
    await sendMessage(chatId, msgNext);
    return res.sendStatus(200);
  }

  // /cleanup - iniciar flujo de expulsión uno a uno
  if (text === "/cleanup") {
    const candidates = await getExpiredCandidates();

    if (!candidates.length) {
      await sendMessage(chatId, "✅ No hay usuarios con más de 1 día vencido.");
      return res.sendStatus(200);
    }

    cleanupSession = {
      chatId,
      index: 0,
      users: candidates
    };

    const u = candidates[0];
    const displayName = u.first_name || "Sin nombre";
    await sendMessage(
      chatId,
      `🧹 Limpieza de usuarios vencidos (uno por uno)

Usuario 1 de ${candidates.length}:
Nombre: ${displayName}
Telegram ID: ${u.telegram_id}
Venció: ${u.subscription_end}

¿Quieres expulsarlo del grupo y marcarlo como inactivo?
Responde: sí / no / stop`
    );

    return res.sendStatus(200);
  }

  // /renew TELEGRAM_ID
  if (text.startsWith("/renew ")) {
    const telegramId = text.split(" ")[1];
    if (!telegramId || isNaN(telegramId)) {
      await sendMessage(chatId, "❌ Uso: /renew TELEGRAM_ID\nEj: /renew 5863380360");
      return res.sendStatus(200);
    }

    adminSession = { step: "days", telegramId, chatId };
    await sendMessage(
      chatId,
      `👤 Renovar/Alta: ${telegramId}\n\n¿Cuántos días contrató?`
    );
    return res.sendStatus(200);
  }

  // Flujo de cleanup (sí / no / stop)
  if (cleanupSession && cleanupSession.chatId === chatId) {
    const answer = text.toLowerCase();

    const users = cleanupSession.users;
    let idx = cleanupSession.index;

    if (answer === "stop") {
      await sendMessage(chatId, "🧹 Limpieza detenida. No se expulsará a más usuarios.");
      cleanupSession = null;
      return res.sendStatus(200);
    }

    const current = users[idx];
    const currentName = current.first_name || "Sin nombre";

    if (answer === "sí" || answer === "si") {
      // expulsar
      await removeFromGroup(current.telegram_id);
      await pool.query(
        `UPDATE users SET subscription_status='inactive' WHERE id=$1`,
        [current.id]
      );
      await sendMessage(
        chatId,
        `❌ Usuario expulsado:
Nombre: ${currentName}
Telegram ID: ${current.telegram_id}`
      );
    } else if (answer === "no") {
      await sendMessage(
        chatId,
        `✔️ Usuario conservado:
Nombre: ${currentName}
Telegram ID: ${current.telegram_id}`
      );
    } else {
      await sendMessage(chatId, "Responde: sí / no / stop");
      return res.sendStatus(200);
    }

    // pasar al siguiente
    idx += 1;
    if (idx >= users.length) {
      await sendMessage(chatId, "🧹 Limpieza completada. No hay más usuarios vencidos en esta lista.");
      cleanupSession = null;
    } else {
      cleanupSession.index = idx;
      const nextUser = users[idx];
      const nextName = nextUser.first_name || "Sin nombre";
      await sendMessage(
        chatId,
        `Usuario ${idx + 1} de ${users.length}:
Nombre: ${nextName}
Telegram ID: ${nextUser.telegram_id}
Venció: ${nextUser.subscription_end}

¿Quieres expulsarlo del grupo y marcarlo como inactivo?
Responde: sí / no / stop`
      );
    }

    return res.sendStatus(200);
  }

  // Flujo interactivo de adminSession (alta / renovación)
  if (adminSession && adminSession.chatId === chatId) {
    const response = text;

    if (adminSession.step === "days") {
      const days = parseInt(response);
      if (isNaN(days) || days <= 0) {
        await sendMessage(chatId, "❌ Días inválido (número > 0)");
        return res.sendStatus(200);
      }
      adminSession.days = days;
      adminSession.step = "amount";
      await sendMessage(chatId, "¿Cuánto pagó?");
      return res.sendStatus(200);

    } else if (adminSession.step === "amount") {
      const amount = parseFloat(response);
      if (isNaN(amount) || amount <= 0) {
        await sendMessage(chatId, "❌ Monto inválido (número > 0)");
        return res.sendStatus(200);
      }
      adminSession.amount = amount;
      adminSession.step = "method";
      await sendMessage(chatId, "¿Método? (transferencia, nequi, etc)");
      return res.sendStatus(200);

    } else if (adminSession.step === "method") {
      const result = await renewUser(
        adminSession.telegramId,
        adminSession.days,
        adminSession.amount,
        response
      );
      await sendMessage(chatId, result);
      adminSession = null;
      return res.sendStatus(200);
    }
  }

  res.sendStatus(200);
});

app.get("/", (_, res) =>
  res.send("Subscription Bot - FIXED DATE STORAGE + GUARD ✅")
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));