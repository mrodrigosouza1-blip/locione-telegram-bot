import { Telegraf, Markup } from "telegraf";
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== Persistência simples =====
const DATA_DIR = process.cwd();
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const SUBS_FILE = path.join(DATA_DIR, "subscribers.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function incStat(key) {
  const stats = readJson(STATS_FILE, {});
  stats[key] = (stats[key] || 0) + 1;
  writeJson(STATS_FILE, stats);
}

function addSubscriber(chatId) {
  const subs = readJson(SUBS_FILE, { chat_ids: [] });
  if (!subs.chat_ids.includes(chatId)) {
    subs.chat_ids.push(chatId);
    writeJson(SUBS_FILE, subs);
    return true;
  }
  return false;
}

// ===== Links =====
const LINKS = {
  finance_ios: "https://apps.apple.com/it/app/locione-finance/id6758838032",
  desk_download: "https://locione.com/download?utm_source=telegram&utm_medium=bot&utm_campaign=locione_desk",
  site: "https://locione.com?utm_source=telegram&utm_medium=bot&utm_campaign=locione_site",
  canal: "https://t.me/locione_app",
};

// ===== Menu =====
function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📱 LociOne Finance", "app_finance")],
    [Markup.button.callback("💻 LociOne Desk", "app_desk")],
    [Markup.button.url("🌐 Site oficial", LINKS.site)],
    [Markup.button.url("📣 Canal de novidades", LINKS.canal)],
    [Markup.button.callback("🔔 Receber novidades", "sub_on")],
  ]);
}

// ===== Helper seguro =====
async function safeEditOrReply(ctx, text, extra) {
  try {
    if (ctx.update?.callback_query) {
      await ctx.editMessageText(text, extra);
      return;
    }
  } catch {}
  return ctx.reply(text, extra);
}

// ===== Telas =====
async function showFinance(ctx) {
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

// ===== Start =====
bot.start(async (ctx) => {
  incStat("start");
  const payload = (ctx.startPayload || "").trim();

  if (payload === "finance") return showFinance(ctx);
  if (payload === "desk") return showDesk(ctx);

  return ctx.reply(
    "👋 *Bem-vindo à LociOne!*\n\nEscolha o app que você quer conhecer:",
    { parse_mode: "Markdown", ...mainMenu() }
  );
});

// ===== Ações =====
bot.action("app_finance", (ctx) => showFinance(ctx));
bot.action("app_desk", (ctx) => showDesk(ctx));

bot.action("sub_on", async (ctx) => {
  const ok = addSubscriber(ctx.chat.id);
  incStat(ok ? "sub_new" : "sub_existing");
  try {
    await ctx.answerCbQuery(ok ? "Inscrito ✅" : "Você já está inscrito ✅");
  } catch {}
  return safeEditOrReply(
    ctx,
    ok
      ? "✅ Pronto! Você vai receber novidades da LociOne."
      : "ℹ️ Você já estava inscrito nas novidades.",
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

// ===== Start =====
bot.launch();
console.log("🤖 LociOne Bot rodando...");
