import { Telegraf, Markup } from "telegraf";
import "dotenv/config";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// ========================
// Config
// ========================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN não definido. Configure no Railway → Variables.");
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;
const CHANNEL_USERNAME = "@locione_app"; // seu canal
const TZ = "Europe/Rome"; // horário Roma (importante para autopost)

// Persistência (Railway Volume montado em /data)
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? "/data" : path.join(process.cwd(), ".data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "bot.sqlite");

// Links
const LINKS = {
  finance_ios: "https://apps.apple.com/it/app/locione-finance/id6758838032",
  office_ios: "https://apps.apple.com/br/app/locione-office/id6759913632",
  desk_download:
    "https://locione.com/download?utm_source=telegram&utm_medium=bot&utm_campaign=locione_desk",
  site: "https://locione.com?utm_source=telegram&utm_medium=bot&utm_campaign=locione_site",
  canal: "https://t.me/locione_app",
};

// ========================
// SQLite
// ========================
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

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

const stmtInc = db.prepare(`
  INSERT INTO stats (key, value) VALUES (?, 1)
  ON CONFLICT(key) DO UPDATE SET value = value + 1
`);
const stmtAdd = db.prepare(`
  INSERT INTO stats (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = value + excluded.value
`);
const stmtGetAllStats = db.prepare(`SELECT key, value FROM stats ORDER BY value DESC`);

const stmtSubAdd = db.prepare(`INSERT OR IGNORE INTO subscribers(chat_id) VALUES (?)`);
const stmtSubCount = db.prepare(`SELECT COUNT(*) as c FROM subscribers`);
const stmtSubRemove = db.prepare(`DELETE FROM subscribers WHERE chat_id = ?`);
const stmtSubsAll = db.prepare(`SELECT chat_id FROM subscribers ORDER BY created_at ASC`);

const stmtMetaGet = db.prepare(`SELECT value FROM meta WHERE key = ?`);
const stmtMetaSet = db.prepare(`
  INSERT INTO meta(key,value) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);

function incStat(key) {
  try {
    stmtInc.run(key);
  } catch (e) {
    console.error("incStat error:", e);
  }
}
function setStat(key, val) {
  try {
    stmtAdd.run(key, val);
  } catch (e) {
    console.error("setStat error:", e);
  }
}
function metaGet(key) {
  try {
    return stmtMetaGet.get(key)?.value ?? null;
  } catch {
    return null;
  }
}
function metaSet(key, value) {
  try {
    stmtMetaSet.run(key, value);
  } catch (e) {
    console.error("metaSet error:", e);
  }
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

// ========================
// Time helpers (Rome TZ)
// ========================
function nowRomeParts() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  // weekday: Mon Tue Wed Thu Fri Sat Sun
  return {
    weekday: get("weekday"),
    yyyy: get("year"),
    mm: get("month"),
    dd: get("day"),
    hh: get("hour"),
    min: get("minute"),
  };
}
function romeKeyToday() {
  const p = nowRomeParts();
  return `${p.yyyy}-${p.mm}-${p.dd}`;
}
function isRomeTime({ weekday, hour, minute }) {
  const p = nowRomeParts();
  return p.weekday === weekday && p.hh === String(hour).padStart(2, "0") && p.min === String(minute).padStart(2, "0");
}

// ========================
// Bot
// ========================
const bot = new Telegraf(BOT_TOKEN);

// Evita 400 "message can't be edited"
async function safeEditOrReply(ctx, text, extra) {
  try {
    if (ctx.update?.callback_query) {
      await ctx.editMessageText(text, extra);
      return;
    }
  } catch {}
  return ctx.reply(text, extra);
}

// ========================
// Menus (com tracking real)
// A diferença: botões de "Abrir link" são callback -> bot envia o link.
// Assim a gente consegue contar clique.
// ========================
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📱 LociOne Finance", "app_finance")],
    [Markup.button.callback("🏢 LociOne Office", "app_office")],
    [Markup.button.callback("💻 LociOne Desk", "app_desk")],
    [Markup.button.url("🌐 Site oficial", LINKS.site)],
    [Markup.button.url("📣 Canal", LINKS.canal)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
  ]);
}

function ctaMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🍎 Abrir iOS (Finance)", "go_finance_ios")],
    [Markup.button.callback("🏢 Abrir iOS (Office)", "go_office_ios")],
    [Markup.button.callback("💻 Abrir Desk (Download)", "go_desk")],
    [Markup.button.callback("🌐 Abrir Site", "go_site")],
    [Markup.button.url("📣 Canal", LINKS.canal)],
  ]);
}

// ========================
// Screens
// ========================
async function showFinance(ctx) {
  incStat("open_finance");
  const text =
    "*LociOne Finance 📱*\n\n" +
    "• Controle financeiro rápido\n" +
    "• Offline-first (dados no aparelho)\n" +
    "• Relatórios e organização\n\n" +
    "Quer o link do iOS?";

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🍎 Abrir App Store (iOS)", "go_finance_ios")],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, { parse_mode: "Markdown", ...kb });
}

async function showOffice(ctx) {
  incStat("open_office");
  const text =
    "*LociOne Office 🏢*\n\n" +
    "• Gestão para MEI/pequenos negócios\n" +
    "• Offline-first (dados no aparelho)\n" +
    "• Lançamentos, clientes, produtos e mais\n\n" +
    "Quer o link do iOS?";

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🍎 Abrir App Store (iOS)", "go_office_ios")],
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
    "Quer o link de download?";

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("💻 Abrir Download", "go_desk")],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, { parse_mode: "Markdown", ...kb });
}

// ========================
// /start
// ========================
bot.start(async (ctx) => {
  incStat("start");
  const payload = (ctx.startPayload || "").trim();

  if (payload === "finance") return showFinance(ctx);
  if (payload === "office") return showOffice(ctx);
  if (payload === "desk") return showDesk(ctx);

  return ctx.reply("👋 *Bem-vindo à LociOne!*\n\nEscolha o app:", {
    parse_mode: "Markdown",
    ...mainMenu(),
  });
});

// ========================
// Commands (user)
// ========================
bot.command("finance", (ctx) => showFinance(ctx));
bot.command("office", (ctx) => showOffice(ctx));
bot.command("desk", (ctx) => showDesk(ctx));
bot.command("site", (ctx) => ctx.reply(`🌐 Site oficial: ${LINKS.site}`));
bot.command("canal", (ctx) => ctx.reply(`📣 Canal: ${LINKS.canal}`));
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

bot.command("myid", (ctx) => ctx.reply(`🆔 Seu chat_id: ${ctx.chat?.id}`));

// ========================
// Admin Dashboard
// ========================
function isAdmin(ctx) {
  return !!ADMIN_CHAT_ID && ctx.chat?.id === ADMIN_CHAT_ID;
}

bot.command("admin", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");

  const subs = stmtSubCount.get().c;
  const lastWeekly = metaGet("weekly_last") || "n/a";
  const lastLaunch = metaGet("launch_last") || "n/a";

  const text =
    `🛠️ *Admin Dashboard*\n\n` +
    `👥 inscritos: *${subs}*\n` +
    `📅 weekly_last: \`${lastWeekly}\`\n` +
    `🚀 launch_last: \`${lastLaunch}\`\n\n` +
    `Comandos:\n` +
    `• /broadcast texto...\n` +
    `• /postcanal texto...\n` +
    `• /lancamento finance|office|desk\n` +
    `• /exportsubs\n` +
    `• /stats`;

  return ctx.reply(text, { parse_mode: "Markdown" });
});

// ========================
// Tracking buttons (go_*)
// ========================
async function sendLink(ctx, label, url, statKey) {
  incStat(statKey);
  try {
    await ctx.answerCbQuery("Abrindo link ✅");
  } catch {}
  return ctx.reply(`🔗 *${label}*\n${url}`, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...ctaMenu(),
  });
}

bot.action("go_finance_ios", (ctx) => sendLink(ctx, "App Store — LociOne Finance", LINKS.finance_ios, "click_finance_ios"));
bot.action("go_office_ios", (ctx) => sendLink(ctx, "App Store — LociOne Office", LINKS.office_ios, "click_office_ios"));
bot.action("go_desk", (ctx) => sendLink(ctx, "Download — LociOne Desk", LINKS.desk_download, "click_desk_download"));
bot.action("go_site", (ctx) => sendLink(ctx, "Site — LociOne", LINKS.site, "click_site"));

// ========================
// Subscribe button
// ========================
bot.action("sub_on", async (ctx) => {
  const ok = addSubscriber(ctx.chat.id);
  incStat(ok ? "sub_new" : "sub_existing");
  try {
    await ctx.answerCbQuery(ok ? "Inscrito ✅" : "Você já está inscrito ✅");
  } catch {}
  return safeEditOrReply(
    ctx,
    ok ? "✅ Pronto! Você vai receber novidades da LociOne." : "ℹ️ Você já estava inscrito.",
    { ...mainMenu() }
  );
});

bot.action("app_finance", (ctx) => showFinance(ctx));
bot.action("app_office", (ctx) => showOffice(ctx));
bot.action("app_desk", (ctx) => showDesk(ctx));

bot.action("back", async (ctx) => {
  try {
    await ctx.editMessageText("Escolha o app:", mainMenu());
  } catch {
    await ctx.reply("Escolha o app:", mainMenu());
  }
});

// ========================
// Admin: post in channel
// ========================
bot.command("postcanal", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Comando restrito ao admin.");

  const text = ctx.message?.text || "";
  const msg = text.replace(/^\/postcanal\s*/i, "").trim();
  if (!msg) return ctx.reply("Uso: /postcanal sua mensagem aqui");

  await bot.telegram.sendMessage(CHANNEL_USERNAME, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...ctaMenu(), // botões rastreáveis no canal também
  });

  incStat("post_canal");
  return ctx.reply(`✅ Postado no canal ${CHANNEL_USERNAME}.`);
});

// ========================
// Admin: broadcast to subscribers
// ========================
bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Comando restrito ao admin.");

  const text = ctx.message?.text || "";
  const msg = text.replace(/^\/broadcast\s*/i, "").trim();
  if (!msg) return ctx.reply("Uso: /broadcast sua mensagem aqui");

  incStat("broadcast_sent");
  metaSet("broadcast_last", new Date().toISOString());

  const subs = stmtSubsAll.all();
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < subs.length; i++) {
    const chatId = subs[i].chat_id;
    try {
      await bot.telegram.sendMessage(chatId, msg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...ctaMenu(),
      });
      ok++;
    } catch {
      fail++;
    }
    // rate limit conservador
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 1100));
  }

  return ctx.reply(`✅ Broadcast concluído.\n\nEnviados: ${ok}\nFalhas: ${fail}\nTotal: ${subs.length}`);
});

// ========================
// Admin: launch campaigns
// /lancamento finance|office|desk
// - posta no canal + (opcional) broadcast (aqui: posta no canal + pergunta/avisa como broadcast)
// ========================
function launchMessage(kind) {
  if (kind === "finance") {
    return (
      "🚀 *Lançamento LociOne*\n\n" +
      "📱 *LociOne Finance (iOS)*\n" +
      "Controle seus gastos em segundos.\n" +
      "Offline-first. Rápido. Privado.\n\n" +
      "Clique nos botões abaixo 👇"
    );
  }
  if (kind === "office") {
    return (
      "🚀 *Lançamento LociOne*\n\n" +
      "🏢 *LociOne Office (iOS)*\n" +
      "Gestão simples para MEI/pequenos negócios.\n" +
      "Offline-first. Direto ao ponto.\n\n" +
      "Clique nos botões abaixo 👇"
    );
  }
  if (kind === "desk") {
    return (
      "🚀 *Lançamento LociOne*\n\n" +
      "💻 *LociOne Desk*\n" +
      "Versão desktop com foco em produtividade e privacidade.\n\n" +
      "Clique nos botões abaixo 👇"
    );
  }
  return null;
}

bot.command("lancamento", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");

  const text = ctx.message?.text || "";
  const arg = text.replace(/^\/lancamento\s*/i, "").trim().toLowerCase();
  if (!["finance", "office", "desk"].includes(arg)) {
    return ctx.reply("Uso: /lancamento finance | office | desk");
  }

  const msg = launchMessage(arg);
  metaSet("launch_last", `${arg}:${new Date().toISOString()}`);
  incStat(`launch_${arg}`);

  await bot.telegram.sendMessage(CHANNEL_USERNAME, msg, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...ctaMenu(),
  });

  return ctx.reply(`✅ Lançamento postado no canal (${arg}). Se quiser mandar pra inscritos: use /broadcast e cole o mesmo texto.`);
});

// ========================
// Admin: export subscribers CSV
// ========================
bot.command("exportsubs", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");

  const rows = stmtSubsAll.all();
  const csv = ["chat_id"].concat(rows.map((r) => String(r.chat_id))).join("\n");
  const filePath = path.join(DATA_DIR, `subscribers_${romeKeyToday()}.csv`);
  fs.writeFileSync(filePath, csv, "utf8");

  incStat("export_subs");
  return ctx.replyWithDocument({ source: filePath, filename: path.basename(filePath) });
});

// ========================
// Auto-campaign (weekly) — Rome time
// Exemplo: toda segunda 09:30 (Roma) posta no canal.
// Anti-duplicação via meta weekly_last = YYYY-MM-DD
// ========================
async function weeklyAutoPostTick() {
  // Segunda 09:30 (Roma)
  const should = isRomeTime({ weekday: "Mon", hour: 9, minute: 30 });
  if (!should) return;

  const today = romeKeyToday();
  const last = metaGet("weekly_last");
  if (last === today) return; // já postou hoje

  const msg =
    "💡 *Dica LociOne da semana*\n\n" +
    "Quer organizar sua vida financeira e o seu negócio sem depender de nuvem?\n" +
    "A LociOne é *offline-first* (dados no seu aparelho) — simples e rápida.\n\n" +
    "Clique nos botões abaixo 👇";

  try {
    await bot.telegram.sendMessage(CHANNEL_USERNAME, msg, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      ...ctaMenu(),
    });
    metaSet("weekly_last", today);
    incStat("weekly_post");
  } catch (e) {
    console.error("weeklyAutoPostTick error:", e);
  }
}

// Tick a cada 30s
setInterval(() => {
  weeklyAutoPostTick().catch(() => {});
}, 30_000);

// Heartbeat (te ajuda a ver “vivo” no log)
setInterval(() => {
  console.log("💓 heartbeat", new Date().toISOString());
}, 60_000);

// ========================
// Robustez
// ========================
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
