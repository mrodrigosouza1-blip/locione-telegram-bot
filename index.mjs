import { Telegraf, Markup } from "telegraf";
import "dotenv/config";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN não definido. Configure em Railway → Variables.");
  process.exit(1);
}

// ===== Persistência (Railway Volume montado em /data) =====
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? "/data" : path.join(process.cwd(), ".data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "bot.sqlite");

// ===== Admin (para /broadcast) =====
// Defina ADMIN_CHAT_ID nas Variables do Railway (seu chat id).
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

// ===== SQLite =====
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS stats (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    chat_id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const stmtInc = db.prepare(`
  INSERT INTO stats (key, value) VALUES (?, 1)
  ON CONFLICT(key) DO UPDATE SET value = value + 1
`);
const stmtGetAllStats = db.prepare(`SELECT key, value FROM stats ORDER BY value DESC`);
const stmtSubAdd = db.prepare(`INSERT OR IGNORE INTO subscribers(chat_id) VALUES (?)`);
const stmtSubCount = db.prepare(`SELECT COUNT(*) as c FROM subscribers`);
const stmtSubRemove = db.prepare(`DELETE FROM subscribers WHERE chat_id = ?`);
const stmtSubsAll = db.prepare(`SELECT chat_id FROM subscribers ORDER BY created_at ASC`);

function incStat(key) {
  try { stmtInc.run(key); } catch (e) { console.error("incStat error:", e); }
}
function addSubscriber(chatId) {
  const res = stmtSubAdd.run(chatId);
  return res.changes > 0;
}
function removeSubscriber(chatId) {
  const res = stmtSubRemove.run(chatId);
  return res.changes > 0;
}
function getStatsText() {
  const rows = stmtGetAllStats.all();
  const subs = stmtSubCount.get().c;
  const lines = rows.map((r) => `• ${r.key}: ${r.value}`);
  return `📊 *Stats*\n\n${lines.length ? lines.join("\n") : "Sem dados ainda."}\n\n👥 inscritos: ${subs}`;
}

// ===== Links (com UTM) =====
const LINKS = {
  office_ios: "https://apps.apple.com/br/app/locione-office/id6759913632",
  finance_ios: "https://apps.apple.com/it/app/locione-finance/id6758838032",
  desk_download: "https://locione.com/download?utm_source=telegram&utm_medium=bot&utm_campaign=locione_desk",
  site: "https://locione.com?utm_source=telegram&utm_medium=bot&utm_campaign=locione_site",
  canal: "https://t.me/locione_app",
};

// ===== Bot =====
const bot = new Telegraf(BOT_TOKEN);

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📱 LociOne Finance", "app_finance")],function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📱 LociOne Finance", "app_finance")],
    [Markup.button.callback("🏢 LociOne Office", "app_office")],
    [Markup.button.callback("💻 LociOne Desk", "app_desk")],
    [Markup.button.url("🌐 Site oficial", LINKS.site)],
    [Markup.button.url("📣 Canal de novidades", LINKS.canal)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
  ]);
}
    [Markup.button.callback("💻 LociOne Desk", "app_desk")],
    [Markup.button.url("🌐 Site oficial", LINKS.site)],
    [Markup.button.url("📣 Canal de novidades", LINKS.canal)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
  ]);
}

async function safeEditOrReply(ctx, text, extra) {
  try {
    if (ctx.update?.callback_query) {
      await ctx.editMessageText(text, extra);
      return;
    }
  } catch {}
  return ctx.reply(text, extra);
}

async function showOffice(ctx) {
  incStat("open_office");
  const text =
    "*LociOne Office 🏢*\n\n" +
    "• Gestão simples para MEI/pequenos negócios\n" +
    "• Offline-first (dados no aparelho)\n" +
    "• Lançamentos, clientes, produtos e mais\n\n" +
    "Baixe no iOS:";

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("🍎 App Store (iOS)", LINKS.office_ios)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, { parse_mode: "Markdown", ...kb });
}
async function showFinance(ctx) {const kb = Markup.inlineKeyboard([
  [Markup.button.url("🍎 iOS (Finance)", LINKS.finance_ios)],
  [Markup.button.url("🏢 iOS (Office)", LINKS.office_ios)],
  [Markup.button.url("💻 Desk (Download)", LINKS.desk_download)],
  [Markup.button.url("🌐 Site", LINKS.site)],
  [Markup.button.url("📣 Canal", LINKS.canal)],
]);
  incStat("open_finance");
  const text =
    "*LociOne Finance 📱*\n\n" +
    "• Controle financeiro rápido\n" +
    "• Offline-first (dados no aparelho)\n" +
    "• Relatórios e organização\n\n" +
    "Baixe no iOS:";

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("🍎 App Store (iOS)", LINKS.finance_ios)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, { parse_mode: "Markdown", ...kb });
}

async function showDesk(ctx) {
  incStat("open_desk");
  const text =
    "*LociOne Desk 💻*\n\n" +
    "• App desktop offline-first\n" +
    "• Produtividade com privacidade\n" +
    "• Downloads oficiais no site\n\n" +
    "Faça o download:";

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("💻 Download Desktop", LINKS.desk_download)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, { parse_mode: "Markdown", ...kb });
}

// ===== /start =====
bot.start(async (ctx) => {
  incStat("start");
  const payload = (ctx.startPayload || "").trim();

  if (payload === "finance") return showFinance(ctx);
  if (payload === "office") return showOffice(ctx);
  if (payload === "desk") return showDesk(ctx);

  return ctx.reply(
    "👋 *Bem-vindo à LociOne!*\n\nEscolha o app que você quer conhecer:",
    { parse_mode: "Markdown", ...mainMenu() }
  );
});

// ===== Comandos (agora vão funcionar) =====
bot.command("finance", (ctx) => showFinance(ctx));
bot.command("office", (ctx) => showOffice(ctx));
bot.command("desk", (ctx) => showDesk(ctx));
bot.command("site", (ctx) => ctx.reply(`🌐 Site oficial: ${LINKS.site}`));
bot.command("canal", (ctx) => ctx.reply(`📣 Canal de novidades: ${LINKS.canal}`));
bot.command("stats", (ctx) => ctx.reply(getStatsText(), { parse_mode: "Markdown" }));

bot.command("subscribe", (ctx) => {
  const ok = addSubscriber(ctx.chat.id);
  incStat(ok ? "sub_new_cmd" : "sub_existing_cmd");
  return ctx.reply(ok ? "✅ Inscrito nas novidades." : "✅ Você já está inscrito.");
});

bot.command("unsubscribe", (ctx) => {
  const ok = removeSubscriber(ctx.chat.id);
  incStat(ok ? "sub_removed_cmd" : "sub_removed_noop_cmd");
  return ctx.reply(ok ? "🛑 Inscrição removida." : "Você não estava inscrito.");
});

// ===== Descobrir seu chat_id =====
bot.command("myid", (ctx) => {
  const id = ctx.chat?.id;
  return ctx.reply(`🆔 Seu chat_id: ${id}`);
});

// ===== Broadcast (admin-only) =====
// Uso: /broadcast Texto...
bot.command("broadcast", async (ctx) => {
  if (!ADMIN_CHAT_ID || ctx.chat.id !== ADMIN_CHAT_ID) {
    return ctx.reply("⛔ Comando restrito ao admin.");
  }

  const text = ctx.message?.text || "";
  const msg = text.replace(/^\/broadcast\s*/i, "").trim();
  if (!msg) return ctx.reply("Uso: /broadcast sua mensagem aqui");

  incStat("broadcast_sent");

  const subs = stmtSubsAll.all();
  let ok = 0;
  let fail = 0;

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("🍎 iOS (App Store)", LINKS.finance_ios)],
    [Markup.button.url("💻 Desk (Download)", LINKS.desk_download)],
    [Markup.button.url("🌐 Site", LINKS.site)],
    [Markup.button.url("📣 Canal", LINKS.canal)],
  ]);

  // Rate limit conservador
  for (let i = 0; i < subs.length; i++) {
    const chatId = subs[i].chat_id;
    try {
      await bot.telegram.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...kb,
      });
      ok++;
    } catch (e) {
      fail++;
    }
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 1100));
  }

  return ctx.reply(`✅ Broadcast concluído.\n\nEnviados: ${ok}\nFalhas: ${fail}\nTotal: ${subs.length}`);
});    

// ===== Botões =====
bot.action("app_finance", (ctx) => showFinance(ctx));
bot.action("app_office", (ctx) => showOffice(ctx));
bot.action("app_desk", (ctx) => showDesk(ctx));

bot.action("sub_on", async (ctx) => {
  const ok = addSubscriber(ctx.chat.id);
  incStat(ok ? "sub_new" : "sub_existing");
  try { await ctx.answerCbQuery(ok ? "Inscrito ✅" : "Você já está inscrito ✅"); } catch {}
  return safeEditOrReply(
    ctx,
    ok ? "✅ Pronto! Você vai receber novidades da LociOne." : "ℹ️ Você já estava inscrito.",
    { ...mainMenu() }
  );
});

bot.action("back", async (ctx) => {
  try {
    await ctx.editMessageText("Escolha o app que você quer conhecer:", mainMenu());
  } catch {
    await ctx.reply("Escolha o app que você quer conhecer:", mainMenu());
  }
});

// Robustez
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
bot.catch((err) => console.error("Bot error:", err));

(async () => {
  console.log("🤖 LociOne Bot iniciando...");
  console.log("DB_PATH:", DB_PATH);
  await bot.launch();
  console.log("🤖 LociOne Bot rodando...");
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
