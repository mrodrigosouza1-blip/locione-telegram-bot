import { Telegraf, Markup } from "telegraf";
import "dotenv/config";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import * as appleMonitor from "./lib/apple-monitor.js";

// =========================
// ENV / CONFIG
// =========================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN não definido. Configure no Railway → Variables.");
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;
const CHANNEL_USERNAME = "@locione_app";
const TZ = "Europe/Rome";
const PIN_AUTO = String(process.env.PIN_AUTO || "0") === "1";

// Persistência (Railway Volume montado em /data)
const DATA_DIR = process.env.RAILWAY_ENVIRONMENT ? "/data" : path.join(process.cwd(), ".data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "bot.sqlite");

// Links
const LINKS = {
  finance_ios: "https://apps.apple.com/it/app/locione-finance/id6758838032",
  office_ios: "https://apps.apple.com/br/app/locione-office/id6759913632",
  tools_ios: "https://apps.apple.com/br/app/locitools/id6760295235",
  desk_download:
    "https://locione.com/download?utm_source=telegram&utm_medium=bot&utm_campaign=locione_desk",
  site: "https://locione.com?utm_source=telegram&utm_medium=bot&utm_campaign=locione_site",
  canal: "https://t.me/locione_app",
};

// =========================
// SQLITE
// =========================
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

  CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at_rome TEXT NOT NULL,
    kind TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_posts_pending
    ON scheduled_posts(status, run_at_rome);

  CREATE TABLE IF NOT EXISTS channel_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_username TEXT NOT NULL,
    channel_chat_id INTEGER,
    message_id INTEGER NOT NULL,
    kind TEXT,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_channel_posts_created
    ON channel_posts(created_at DESC);

  CREATE TABLE IF NOT EXISTS tracked_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_id TEXT NOT NULL,
    country TEXT NOT NULL DEFAULT 'br',
    store_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_version TEXT,
    last_release_date TEXT,
    last_name TEXT,
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tracked_apps_active_platform
    ON tracked_apps(is_active, platform);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_apps_slug ON tracked_apps(slug);

  CREATE TABLE IF NOT EXISTS app_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracked_app_id INTEGER NOT NULL,
    slug TEXT NOT NULL,
    app_id TEXT NOT NULL,
    old_version TEXT,
    new_version TEXT,
    old_release_date TEXT,
    new_release_date TEXT,
    old_name TEXT,
    new_name TEXT,
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    posted_to_channel INTEGER NOT NULL DEFAULT 0,
    broadcast_sent INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT,
    FOREIGN KEY(tracked_app_id) REFERENCES tracked_apps(id)
  );
  CREATE INDEX IF NOT EXISTS idx_app_updates_tracked_app_id
    ON app_updates(tracked_app_id);
  CREATE INDEX IF NOT EXISTS idx_app_updates_detected_at
    ON app_updates(detected_at DESC);
`);

appleMonitor.seedTrackedApps(db);

const stmtInc = db.prepare(`
  INSERT INTO stats (key, value) VALUES (?, 1)
  ON CONFLICT(key) DO UPDATE SET value = value + 1
`);
const stmtGetAllStats = db.prepare(`SELECT key, value FROM stats ORDER BY value DESC`);

const stmtSubAdd = db.prepare(`INSERT OR IGNORE INTO subscribers(chat_id) VALUES (?)`);
const stmtSubCount = db.prepare(`SELECT COUNT(*) as c FROM subscribers`);
const stmtSubRemove = db.prepare(`DELETE FROM subscribers WHERE chat_id = ?`);
const stmtSubsAll = db.prepare(`SELECT chat_id FROM subscribers ORDER BY created_at ASC`);

const stmtSchedInsert = db.prepare(`
  INSERT INTO scheduled_posts (run_at_rome, kind, text)
  VALUES (?, ?, ?)
`);
const stmtSchedPendingDue = db.prepare(`
  SELECT id, run_at_rome, kind, text
  FROM scheduled_posts
  WHERE status='pending' AND run_at_rome <= ?
  ORDER BY run_at_rome ASC, id ASC
  LIMIT 5
`);
const stmtSchedMarkSent = db.prepare(`
  UPDATE scheduled_posts
  SET status='sent', sent_at=datetime('now'), error=NULL
  WHERE id=?
`);
const stmtSchedMarkFailed = db.prepare(`
  UPDATE scheduled_posts
  SET status='failed', sent_at=datetime('now'), error=?
  WHERE id=?
`);
const stmtSchedListPending = db.prepare(`
  SELECT id, run_at_rome, kind, substr(text, 1, 120) AS preview
  FROM scheduled_posts
  WHERE status='pending'
  ORDER BY run_at_rome ASC, id ASC
  LIMIT 50
`);
const stmtSchedCancel = db.prepare(`
  UPDATE scheduled_posts
  SET status='canceled'
  WHERE id=? AND status='pending'
`);

const stmtChanPostInsert = db.prepare(`
  INSERT INTO channel_posts (channel_username, channel_chat_id, message_id, kind, source)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtChanLast = db.prepare(`
  SELECT channel_username, channel_chat_id, message_id, kind, source, created_at
  FROM channel_posts
  ORDER BY id DESC
  LIMIT 1
`);

function incStat(key) {
  try {
    stmtInc.run(key);
  } catch (e) {
    console.error("incStat error:", e);
  }
}

/** Envia uma mensagem a todos os inscritos (para broadcast de app update). */
async function sendBroadcastToSubscribers(text) {
  const subs = stmtSubsAll.all();
  for (let i = 0; i < subs.length; i++) {
    try {
      await bot.telegram.sendMessage(subs[i].chat_id, text, { disable_web_page_preview: true });
    } catch (_) {}
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 1100));
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
function isAdmin(ctx) {
  return !!ADMIN_CHAT_ID && ctx.chat?.id === ADMIN_CHAT_ID;
}
function getStatsPlainText() {
  const rows = stmtGetAllStats.all();
  const subs = stmtSubCount.get().c;
  const lines = rows.map((r) => `- ${r.key}: ${r.value}`);
  return `STATS\n\n${lines.length ? lines.join("\n") : "(sem dados)"}\n\ninscritos: ${subs}`;
}

// =========================
// TIME (Rome)
// =========================
function nowRomeParts() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { yyyy: get("year"), mm: get("month"), dd: get("day"), hh: get("hour"), min: get("minute") };
}
function nowRomeStr() {
  const p = nowRomeParts();
  return `${p.yyyy}-${p.mm}-${p.dd} ${p.hh}:${p.min}`;
}
function isValidRunAtRome(s) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s);
}

// =========================
// BOT
// =========================
const bot = new Telegraf(BOT_TOKEN);

// Teclado fixo
function persistentKeyboard() {
  return Markup.keyboard([
    ["📱 Finance", "🏢 Office"],
    ["🛠️ Tools", "💻 Desk"],
    ["🔔 Novidades", "🌐 Site"],
    ["📣 Canal"],
  ])
    .resize()
    .persistent();
}

// Menu inline
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📱 LociOne Finance", "app_finance")],
    [Markup.button.callback("🏢 LociOne Office", "app_office")],
    [Markup.button.callback("🛠️ LociTools", "app_tools")],
    [Markup.button.callback("💻 LociOne Desk", "app_desk")],
    [Markup.button.url("🌐 Site oficial", LINKS.site)],
    [Markup.button.url("📣 Canal", LINKS.canal)],
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

// =========================
// SCREENS
// =========================
async function showFinance(ctx) {
  incStat("open_finance");
  const text =
    "*LociOne Finance 📱*\n\n" +
    "• Controle financeiro rápido\n" +
    "• Offline-first (dados no aparelho)\n" +
    "• Relatórios e organização\n\n" +
    "🍎 *Baixar no iOS:*\n" +
    `${LINKS.finance_ios}`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("🍎 Abrir App Store (iOS)", LINKS.finance_ios)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...kb,
    ...persistentKeyboard(),
  });
}

async function showOffice(ctx) {
  incStat("open_office");
  const text =
    "*LociOne Office 🏢*\n\n" +
    "• Gestão para MEI/pequenos negócios\n" +
    "• Offline-first (dados no aparelho)\n" +
    "• Lançamentos, clientes, produtos e mais\n\n" +
    "🍎 *Baixar no iOS:*\n" +
    `${LINKS.office_ios}`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("🍎 Abrir App Store (iOS)", LINKS.office_ios)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...kb,
    ...persistentKeyboard(),
  });
}

async function showTools(ctx) {
  incStat("open_tools");
  const text =
    "*LociTools 🛠️*\n\n" +
    "• Ferramentas úteis para o dia a dia\n" +
    "• Interface simples e prática\n" +
    "• Acesso rápido a utilidades no iPhone\n\n" +
    "🍎 *Baixar no iOS:*\n" +
    `${LINKS.tools_ios}`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("🍎 Abrir App Store (iOS)", LINKS.tools_ios)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...kb,
    ...persistentKeyboard(),
  });
}

async function showDesk(ctx) {
  incStat("open_desk");
  const text =
    "*LociOne Desk 💻*\n\n" +
    "• App desktop offline-first\n" +
    "• Produtividade com privacidade\n" +
    "• Downloads oficiais no site\n\n" +
    "💻 *Download:*\n" +
    `${LINKS.desk_download}`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("💻 Abrir Download", LINKS.desk_download)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
    [Markup.button.callback("⬅️ Voltar", "back")],
  ]);

  return safeEditOrReply(ctx, text, {
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    ...kb,
    ...persistentKeyboard(),
  });
}

// =========================
// HELPERS: canal
// =========================
async function postToChannel({ text, kind = null, source = "post" }) {
  const res = await bot.telegram.sendMessage(CHANNEL_USERNAME, text, {
    disable_web_page_preview: true,
  });

  try {
    stmtChanPostInsert.run(CHANNEL_USERNAME, res.chat?.id || null, res.message_id, kind, source);
  } catch (e) {
    console.error("save channel post failed:", e);
  }

  if (PIN_AUTO) {
    try {
      await bot.telegram.pinChatMessage(res.chat.id, res.message_id, { disable_notification: true });
      incStat("pin_auto_ok");
    } catch (e) {
      incStat("pin_auto_fail");
      console.error("pin auto failed:", e?.message || e);
    }
  }

  return res;
}

function templateFor(kind) {
  if (kind === "finance") {
    return (
      "🚀 Lançamento LociOne\n\n" +
      "📱 LociOne Finance (iOS)\n" +
      "Controle financeiro offline-first.\n\n" +
      "Baixar no iOS:\n" +
      LINKS.finance_ios +
      "\n\nCanal:\n" +
      LINKS.canal
    );
  }
  if (kind === "office") {
    return (
      "🚀 Lançamento LociOne\n\n" +
      "🏢 LociOne Office (iOS)\n" +
      "Gestão simples para MEI/pequenos negócios.\n\n" +
      "Baixar no iOS:\n" +
      LINKS.office_ios +
      "\n\nCanal:\n" +
      LINKS.canal
    );
  }
  if (kind === "tools") {
    return (
      "🚀 Lançamento LociOne\n\n" +
      "🛠️ LociTools (iOS)\n" +
      "Ferramentas úteis para o dia a dia.\n\n" +
      "Baixar no iOS:\n" +
      LINKS.tools_ios +
      "\n\nCanal:\n" +
      LINKS.canal
    );
  }
  if (kind === "desk") {
    return (
      "🚀 Lançamento LociOne\n\n" +
      "💻 LociOne Desk\n" +
      "Produtividade com foco em privacidade.\n\n" +
      "Download:\n" +
      LINKS.desk_download +
      "\n\nCanal:\n" +
      LINKS.canal
    );
  }
  return null;
}

// =========================
// START
// =========================
bot.start(async (ctx) => {
  incStat("start");
  const payload = (ctx.startPayload || "").trim();
  if (payload === "finance") return showFinance(ctx);
  if (payload === "office") return showOffice(ctx);
  if (payload === "tools") return showTools(ctx);
  if (payload === "desk") return showDesk(ctx);

  return ctx.reply("👋 *Bem-vindo à LociOne!*\n\nEscolha o app:", {
    parse_mode: "Markdown",
    ...mainMenu(),
    ...persistentKeyboard(),
  });
});

// =========================
// USER COMMANDS
// =========================
bot.command("finance", (ctx) => showFinance(ctx));
bot.command("office", (ctx) => showOffice(ctx));
bot.command("tools", (ctx) => showTools(ctx));
bot.command("desk", (ctx) => showDesk(ctx));
bot.command("site", (ctx) =>
  ctx.reply(`Site oficial:\n${LINKS.site}`, { disable_web_page_preview: true, ...persistentKeyboard() })
);
bot.command("canal", (ctx) => ctx.reply(`Canal:\n${LINKS.canal}`, { ...persistentKeyboard() }));

bot.command("stats", (ctx) => {
  incStat("stats_view");
  return ctx.reply(getStatsPlainText(), { disable_web_page_preview: true, ...persistentKeyboard() });
});

bot.command("subscribe", (ctx) => {
  const ok = addSubscriber(ctx.chat.id);
  incStat(ok ? "sub_new_cmd" : "sub_existing_cmd");
  return ctx.reply(ok ? "✅ Inscrito nas novidades." : "✅ Você já está inscrito.", { ...persistentKeyboard() });
});

bot.command("unsubscribe", (ctx) => {
  const ok = removeSubscriber(ctx.chat.id);
  incStat(ok ? "sub_removed_cmd" : "sub_removed_noop_cmd");
  return ctx.reply(ok ? "🛑 Inscrição removida." : "Você não estava inscrito.", { ...persistentKeyboard() });
});

bot.command("myid", (ctx) => ctx.reply(`Seu chat_id: ${ctx.chat?.id}`));

// =========================
// ADMIN
// =========================
bot.command("admin", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const subs = stmtSubCount.get().c;
  const now = nowRomeStr();
  const text =
    `ADMIN\n\n` +
    `inscritos: ${subs}\n` +
    `agora(Roma): ${now}\n` +
    `pin_auto: ${PIN_AUTO ? "ON" : "OFF"}\n\n` +
    `comandos:\n` +
    `- /postcanal texto...\n` +
    `- /post finance|office|tools|desk\n` +
    `- /lancamento finance|office|tools|desk\n` +
    `- /agendar YYYY-MM-DD HH:MM finance|office|tools|desk\n` +
    `- /agendar YYYY-MM-DD HH:MM seu texto livre...\n` +
    `- /agendados\n` +
    `- /cancelar ID\n` +
    `- /pinlast\n` +
    `- /unpinall\n` +
    `- /broadcast texto...\n` +
    `- /stats\n\n` +
    `App Store monitor:\n` +
    `- /appslist\n` +
    `- /appcheck [slug]\n` +
    `- /appadd slug|nome|appid|url\n` +
    `- /apptoggle slug\n` +
    `- /appupdates\n` +
    `- /appcheckbroadcast slug`;
  return ctx.reply(text, { ...persistentKeyboard() });
});

bot.command("post", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const text = ctx.message?.text || "";
  const arg = text.replace(/^\/post\s*/i, "").trim().toLowerCase();
  if (!["finance", "office", "tools", "desk"].includes(arg)) {
    return ctx.reply("Uso: /post finance | office | tools | desk");
  }
  const msg = templateFor(arg);
  await postToChannel({ text: msg, kind: arg, source: "post" });
  incStat(`post_${arg}`);
  return ctx.reply(`✅ Postado no canal (${arg}).`);
});

bot.command("lancamento", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const text = ctx.message?.text || "";
  const arg = text.replace(/^\/lancamento\s*/i, "").trim().toLowerCase();
  if (!["finance", "office", "tools", "desk"].includes(arg)) {
    return ctx.reply("Uso: /lancamento finance | office | tools | desk");
  }
  const msg = templateFor(arg);
  await postToChannel({ text: msg, kind: arg, source: "lancamento" });
  incStat(`launch_${arg}`);
  return ctx.reply(`✅ Lançamento postado no canal (${arg}).`);
});

bot.command("postcanal", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const text = ctx.message?.text || "";
  const msg = text.replace(/^\/postcanal\s*/i, "").trim();
  if (!msg) return ctx.reply("Uso: /postcanal sua mensagem aqui");
  await postToChannel({ text: msg, kind: null, source: "postcanal" });
  incStat("post_canal");
  return ctx.reply(`✅ Postado no canal ${CHANNEL_USERNAME}.`);
});

bot.command("pinlast", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const last = stmtChanLast.get();
  if (!last) return ctx.reply("Ainda não existe post salvo para fixar.");
  try {
    const chatId = last.channel_chat_id;
    if (!chatId) return ctx.reply("Sem channel_chat_id salvo ainda. Poste novamente via bot.");
    await bot.telegram.pinChatMessage(chatId, last.message_id, { disable_notification: true });
    incStat("pin_last_ok");
    return ctx.reply(`📌 Fixado o último post (msg_id: ${last.message_id}).`);
  } catch (e) {
    incStat("pin_last_fail");
    return ctx.reply(`Falha ao fixar: ${String(e?.message || e)}`);
  }
});

bot.command("unpinall", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  try {
    const last = stmtChanLast.get();
    const chatId = last?.channel_chat_id;
    if (!chatId) return ctx.reply("Sem channel_chat_id salvo. Poste algo no canal via bot primeiro.");
    await bot.telegram.unpinAllChatMessages(chatId);
    incStat("unpin_all_ok");
    return ctx.reply("🧷 Removi todos os pins do canal.");
  } catch (e) {
    incStat("unpin_all_fail");
    return ctx.reply(`Falha ao remover pins: ${String(e?.message || e)}`);
  }
});

// =========================
// ADMIN - App Store monitor
// =========================
bot.command("appslist", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const apps = appleMonitor.listTrackedApps(db);
  if (!apps.length) return ctx.reply("Nenhum app monitorado.");
  const lines = apps.map(
    (a) =>
      `${a.slug} | ${a.name} | ${a.app_id} | v${a.last_version || "?"} | ${a.is_active ? "ativo" : "inativo"}`
  );
  return ctx.reply("APPS MONITORADOS:\n\n" + lines.join("\n"), { ...persistentKeyboard() });
});

bot.command("appcheck", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const text = ctx.message?.text || "";
  const arg = text.replace(/^\/appcheck\s*/i, "").trim().toLowerCase();
  const postToChannelFn = (msg, kind, source) => postToChannel({ text: msg, kind, source: source || "app_update" });
  if (!arg) {
    const result = await appleMonitor.runAllChecks(db, {
      postToChannelFn,
      sendBroadcastFn: null,
      incStatFn: incStat,
      delayMs: 1500,
    });
    return ctx.reply(`Check concluído. Apps checados: ${result.checked}`, { ...persistentKeyboard() });
  }
  const row = appleMonitor.getTrackedAppBySlug(db, arg);
  if (!row) return ctx.reply(`App não encontrado: ${arg}`);
  await appleMonitor.checkTrackedApp(db, row, {
    postToChannel: true,
    sendBroadcast: false,
    postToChannelFn,
    sendBroadcastFn: null,
    incStatFn: incStat,
  });
  return ctx.reply(`Check concluído: ${arg}`, { ...persistentKeyboard() });
});

bot.command("appadd", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const text = ctx.message?.text || "";
  const rest = text.replace(/^\/appadd\s*/i, "").trim();
  const parts = rest.split(/\|/).map((p) => p.trim());
  if (parts.length < 3) {
    return ctx.reply("Uso: /appadd slug|nome|appid|url\nEx: /appadd tools2|Meu App|1234567890|https://apps.apple.com/br/app/...");
  }
  const slug = parts[0];
  const name = parts[1];
  const appId = parts[2];
  const storeUrl = parts.length > 3 ? parts.slice(3).join("|").trim() : null;
  if (!slug || !name || !appId) {
    return ctx.reply("slug, nome e appid são obrigatórios.");
  }
  try {
    appleMonitor.addTrackedApp(db, { slug, name, appId, country: "br", storeUrl: storeUrl || null });
    return ctx.reply(`App adicionado: ${slug} (${name})`);
  } catch (e) {
    return ctx.reply(`Erro: ${String(e?.message || e)}`);
  }
});

bot.command("apptoggle", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const text = ctx.message?.text || "";
  const slug = text.replace(/^\/apptoggle\s*/i, "").trim().toLowerCase();
  if (!slug) return ctx.reply("Uso: /apptoggle slug");
  const newState = appleMonitor.toggleTrackedApp(db, slug);
  if (newState === null) return ctx.reply(`App não encontrado: ${slug}`);
  return ctx.reply(`${slug}: ${newState ? "ativado" : "desativado"}`);
});

bot.command("appupdates", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const updates = appleMonitor.getLastAppUpdates(db, 10);
  if (!updates.length) return ctx.reply("Nenhum update registrado.");
  const lines = updates.map(
    (u) =>
      `${u.slug} ${u.old_version || "?"} -> ${u.new_version || "?"} (${u.detected_at}) post=${u.posted_to_channel} bc=${u.broadcast_sent}`
  );
  return ctx.reply("ÚLTIMOS UPDATES:\n\n" + lines.join("\n"), { ...persistentKeyboard() });
});

bot.command("appcheckbroadcast", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const text = ctx.message?.text || "";
  const slug = text.replace(/^\/appcheckbroadcast\s*/i, "").trim().toLowerCase();
  if (!slug) return ctx.reply("Uso: /appcheckbroadcast slug");
  const row = appleMonitor.getTrackedAppBySlug(db, slug);
  if (!row) return ctx.reply(`App não encontrado: ${slug}`);
  const postToChannelFn = (msg, kind, source) => postToChannel({ text: msg, kind, source: source || "app_update" });
  const result = await appleMonitor.checkTrackedApp(db, row, {
    postToChannel: true,
    sendBroadcast: true,
    postToChannelFn,
    sendBroadcastFn: sendBroadcastToSubscribers,
    incStatFn: incStat,
  });
  return ctx.reply(
    `Check com broadcast concluído: ${slug}${result.updated ? " (update detectado)" : ""}`,
    { ...persistentKeyboard() }
  );
});

// =========================
// SCHEDULER
// =========================
bot.command("agendar", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const full = ctx.message?.text || "";
  const rest = full.replace(/^\/agendar\s*/i, "").trim();
  const parts = rest.split(/\s+/);

  if (parts.length < 3) {
    return ctx.reply("Uso:\n/agendar YYYY-MM-DD HH:MM finance|office|tools|desk\nou\n/agendar YYYY-MM-DD HH:MM seu texto...");
  }

  const date = parts[0];
  const time = parts[1];
  const runAt = `${date} ${time}`;

  if (!isValidRunAtRome(runAt)) {
    return ctx.reply("Formato inválido. Use: YYYY-MM-DD HH:MM (ex: 2026-03-05 09:30)");
  }

  const tail = parts.slice(2).join(" ");
  let kind = null;
  let msg = null;

  const lowerTail = tail.toLowerCase().trim();
  if (["finance", "office", "tools", "desk"].includes(lowerTail)) {
    kind = lowerTail;
    msg = templateFor(kind);
  } else {
    msg = tail;
  }

  stmtSchedInsert.run(runAt, kind, msg);
  incStat("schedule_create");

  return ctx.reply(`✅ Agendado para (Roma): ${runAt}\n${kind ? `tipo: ${kind}` : "tipo: texto livre"}`);
});

bot.command("agendados", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const rows = stmtSchedListPending.all();
  if (!rows.length) return ctx.reply("Sem posts pendentes.");
  const lines = rows.map((r) => `#${r.id} | ${r.run_at_rome} | ${r.kind || "texto"} | ${r.preview}`);
  return ctx.reply(`PENDENTES:\n\n${lines.join("\n")}`);
});

bot.command("cancelar", (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");
  const full = ctx.message?.text || "";
  const idStr = full.replace(/^\/cancelar\s*/i, "").trim();
  const id = Number(idStr);
  if (!Number.isFinite(id) || id <= 0) return ctx.reply("Uso: /cancelar ID");
  const res = stmtSchedCancel.run(id);
  if (res.changes > 0) {
    incStat("schedule_cancel");
    return ctx.reply(`✅ Agendamento #${id} cancelado.`);
  }
  return ctx.reply(`Não encontrei #${id} pendente.`);
});

async function schedulerTick() {
  const now = nowRomeStr();
  const due = stmtSchedPendingDue.all(now);
  if (!due.length) return;

  for (const row of due) {
    try {
      await postToChannel({ text: row.text, kind: row.kind, source: "schedule" });
      stmtSchedMarkSent.run(row.id);
      incStat("schedule_sent");
      if (row.kind) incStat(`schedule_sent_${row.kind}`);
    } catch (e) {
      const msg = String(e?.message || e);
      stmtSchedMarkFailed.run(msg.slice(0, 500), row.id);
      incStat("schedule_failed");
      console.error("scheduler send failed:", row.id, msg);
    }
  }
}

setInterval(() => {
  schedulerTick().catch(() => {});
}, 20_000);

// Monitoramento App Store: flag e função segura (não bloqueia o bot)
const APPLE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const postToChannelForAppUpdate = (text, kind, source) =>
  postToChannel({ text, kind, source: source || "app_update" });
let appleCheckRunning = false;
async function runAppleMonitorJobSafe() {
  if (appleCheckRunning) {
    console.log("[apple-check] skip (job already running)");
    return;
  }
  appleCheckRunning = true;
  try {
    await appleMonitor.runAllChecks(db, {
      postToChannelFn: postToChannelForAppUpdate,
      sendBroadcastFn: sendBroadcastToSubscribers,
      incStatFn: incStat,
      delayMs: 2000,
    });
  } catch (e) {
    console.error("[apple-check] job error", e?.message || e);
  } finally {
    appleCheckRunning = false;
  }
}

// =========================
// BROADCAST
// =========================
bot.command("broadcast", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Admin only.");

  const text = ctx.message?.text || "";
  const msg = text.replace(/^\/broadcast\s*/i, "").trim();
  if (!msg) return ctx.reply("Uso: /broadcast sua mensagem aqui");

  incStat("broadcast_sent");

  const subs = stmtSubsAll.all();
  let ok = 0;
  let fail = 0;

  const kb = Markup.inlineKeyboard([
    [Markup.button.url("🍎 iOS (Finance)", LINKS.finance_ios)],
    [Markup.button.url("🏢 iOS (Office)", LINKS.office_ios)],
    [Markup.button.url("🛠️ iOS (LociTools)", LINKS.tools_ios)],
    [Markup.button.url("💻 Desk (Download)", LINKS.desk_download)],
    [Markup.button.url("🌐 Site", LINKS.site)],
    [Markup.button.url("📣 Canal", LINKS.canal)],
  ]);

  for (let i = 0; i < subs.length; i++) {
    const chatId = subs[i].chat_id;
    try {
      await bot.telegram.sendMessage(chatId, msg, { disable_web_page_preview: true, ...kb });
      ok++;
    } catch {
      fail++;
    }
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 1100));
  }

  return ctx.reply(`✅ Broadcast concluído.\nEnviados: ${ok}\nFalhas: ${fail}\nTotal: ${subs.length}`);
});

// =========================
// TAP-ONLY
// =========================
bot.hears("📱 Finance", (ctx) => showFinance(ctx));
bot.hears("🏢 Office", (ctx) => showOffice(ctx));
bot.hears("🛠️ Tools", (ctx) => showTools(ctx));
bot.hears("💻 Desk", (ctx) => showDesk(ctx));
bot.hears("🌐 Site", (ctx) =>
  ctx.reply(`Site oficial:\n${LINKS.site}`, { disable_web_page_preview: true, ...persistentKeyboard() })
);
bot.hears("📣 Canal", (ctx) => ctx.reply(`Canal:\n${LINKS.canal}`, { ...persistentKeyboard() }));
bot.hears("🔔 Novidades", (ctx) => {
  const ok = addSubscriber(ctx.chat.id);
  incStat(ok ? "sub_new_keyboard" : "sub_existing_keyboard");
  return ctx.reply(ok ? "✅ Inscrito nas novidades." : "✅ Você já está inscrito.", { ...persistentKeyboard() });
});

// =========================
// INLINE ACTIONS
// =========================
bot.action("app_finance", (ctx) => showFinance(ctx));
bot.action("app_office", (ctx) => showOffice(ctx));
bot.action("app_tools", (ctx) => showTools(ctx));
bot.action("app_desk", (ctx) => showDesk(ctx));

bot.action("sub_on", async (ctx) => {
  const ok = addSubscriber(ctx.chat.id);
  incStat(ok ? "sub_new" : "sub_existing");
  try {
    await ctx.answerCbQuery(ok ? "Inscrito ✅" : "Você já está inscrito ✅");
  } catch {}
  return safeEditOrReply(
    ctx,
    ok ? "✅ Pronto! Você vai receber novidades da LociOne." : "ℹ️ Você já estava inscrito.",
    { ...mainMenu(), ...persistentKeyboard() }
  );
});

bot.action("back", async (ctx) => {
  try {
    await ctx.editMessageText("Escolha o app:", mainMenu());
  } catch {
    await ctx.reply("Escolha o app:", { ...mainMenu(), ...persistentKeyboard() });
  }
});

// =========================
// ROBUSTEZ
// =========================
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));
bot.catch((err) => console.error("Bot error:", err));

(async () => {
  try {
    console.log("🤖 LociOne Bot iniciando...");
    console.log("DB_PATH:", DB_PATH);

    console.log("Launching bot...");
    await bot.launch();
    console.log("🤖 LociOne Bot rodando...");

    console.log("[apple-check] first delayed run scheduled for 60s");
    setTimeout(() => runAppleMonitorJobSafe().catch(console.error), 60_000);

    console.log("[apple-check] interval scheduled for 30min");
    setInterval(() => runAppleMonitorJobSafe().catch(console.error), 30 * 60 * 1000);

  } catch (err) {
    console.error("BOOT ERROR:", err);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));