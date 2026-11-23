// NEARL Check on Telegram (@NearlCheckBot).
//   POST /.netlify/functions/telegram           Telegram webhook: replies to a contract address with a NEARL Check
//   GET  /.netlify/functions/telegram?setup=1   registers the webhook, the commands and the bot description
//   POST /.netlify/functions/telegram?register=1  {token}: saves a new bot token (used by /bot-setup.html)
// The token lives in Netlify Blobs (store "nearl-config"), so changing it needs no deploy; TELEGRAM_BOT_TOKEN is the
// fallback. A token is only accepted when Telegram says it belongs to @NearlCheckBot, so nobody else can swap the bot.
// The token is never logged or returned.
// The webhook secret is derived from the token, so Telegram's calls can be told apart from anyone else's.
const crypto = require("crypto");
const { runCheck } = require("./lib/engine");
const { cached, bump } = require("./lib/limits");

const SITE = "https://nearlagent.com";
const HOOK = SITE + "/.netlify/functions/telegram";
const ADDR = /0x[a-fA-F0-9]{40}/;
const TIME_BUDGET_MS = Number(process.env.NEARL_TG_BUDGET_MS || 8000); // Netlify ends a function after 10 s; answer before that

const BOT_USERNAME = "nearlcheckbot";
let current = "";
const token = () => current;
function configStore(event) {
  try {
    const { connectLambda, getStore } = require("@netlify/blobs");
    if (event && event.blobs) connectLambda(event);
    return getStore("nearl-config");
  } catch (_) { return null; }
}
async function loadToken(event) {
  try { const st = configStore(event); const t = st && (await st.get("telegram-token")); if (t) return String(t).trim(); } catch (_) {}
  return process.env.TELEGRAM_BOT_TOKEN || "";
}
const secret = () => crypto.createHash("sha256").update("nearl-telegram:" + token()).digest("hex").slice(0, 48);

// Every Telegram call gives up after 7 s, so a slow call can never hold the function past Netlify's limit.
async function tg(method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(7000),
    });
    return await r.json().catch(() => ({ ok: false, description: "bad reply from Telegram" }));
  } catch (e) {
    return { ok: false, description: e.name === "TimeoutError" ? "Telegram did not answer in 7 s" : e.message };
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

function card(r) {
  const dot = r.score >= 80 ? "🟢" : r.score >= 55 ? "🟡" : "🔴";
  const order = { bad: 0, warn: 1, info: 2, ok: 3 };
  const pick = r.findings
    .filter((f) => f.level !== "info" || /NEARL's own token|launch curve|stock token/i.test(f.title))
    .sort((a, b) => order[a.level] - order[b.level])
    .slice(0, 6);
  const mark = { bad: "✕", warn: "!", info: "·", ok: "✓" };
  const tax = (v) => (v == null ? "not tested" : v + "%");
  const lines = [
    `${dot} <b>${esc(r.symbol)}</b> · ${esc(r.name)}`,
    `Score <b>${r.score}/100</b> · ${esc(r.verdict)}`,
    "",
    ...pick.map((f) => `${mark[f.level] || "·"} ${esc(f.title)}`),
    "",
    `Tax: buy ${tax(r.buyTaxPct)} · sell ${tax(r.sellTaxPct)}` + (r.liquidityUsd ? ` · liquidity ~$${Math.round(r.liquidityUsd).toLocaleString("en-US")}` : ""),
    `<code>${esc(r.token)}</code>`,
    "",
    "<i>Automated checks can miss risks. Not investment advice.</i>",
  ];
  return lines.join("\n");
}

const HELP = [
  "<b>NEARL Check</b> · token safety on Robinhood Chain",
  "",
  "Send a token contract address (0x…) and I reply with a 0–100 safety score: a simulated buy, sell and transfer, taxes, owner powers, liquidity, bundles and snipers.",
  "",
  "In a group: paste a contract address, or use <code>/check 0x…</code>.",
  "",
  `Full scans: ${SITE}/check`,
  "Official $NEARL address: " + SITE + "/token",
].join("\n");

// In groups, the same address in the same chat is answered once every 10 minutes, so the bot never floods a chat.
async function seenRecently(event, chat, addr) {
  try {
    const { connectLambda, getStore } = require("@netlify/blobs");
    if (event && event.blobs) connectLambda(event);
    const st = getStore("nearl-tg"), key = `seen/${chat}/${addr.toLowerCase()}`;
    const at = Number((await st.get(key)) || 0);
    if (Date.now() - at < 10 * 60 * 1000) return true;
    await st.set(key, String(Date.now()));
  } catch (_) {}
  return false;
}

async function answer(msg, event) {
  const chat = msg.chat && msg.chat.id;
  if (!chat || (msg.from && msg.from.is_bot)) return;
  const text = String(msg.text || msg.caption || "");
  const isPrivate = msg.chat.type === "private";
  const cmd = (text.match(/^\/(\w+)(@\w+)?/) || [])[1];

  if (cmd === "start" || cmd === "help") {
    await tg("sendMessage", { chat_id: chat, text: HELP, parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }
  const m = text.match(ADDR);
  if (!m) {
    if (isPrivate || cmd === "check") await tg("sendMessage", { chat_id: chat, text: "Send a token contract address, for example <code>/check 0x…</code>", parse_mode: "HTML", reply_to_message_id: msg.message_id });
    return;
  }
  const addr = m[0];
  if (!isPrivate && cmd !== "check" && (await seenRecently(event, chat, addr))) return;
  tg("sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});

  let r = null, err = null;
  try {
    const work = cached(event, `mainnet/${addr}`, () => runCheck(addr, "mainnet", { holderMs: 3500 }));
    r = await Promise.race([work, new Promise((res) => setTimeout(() => res(null), TIME_BUDGET_MS))]);
  } catch (e) { err = e; }

  const link = `${SITE}/check?token=${addr}`;
  const keyboard = { inline_keyboard: [[{ text: "Full scan ↗", url: link }]] };
  let text2;
  if (r) { text2 = card(r); await bump(event, "tg"); }
  else if (err) text2 = `Could not check ${esc(short(addr))}: ${esc(err.message || "unknown error")}`;
  else text2 = `Scanning ${esc(short(addr))} is taking longer than usual. Open the full scan:`;
  await tg("sendMessage", { chat_id: chat, text: text2, parse_mode: "HTML", disable_web_page_preview: true, reply_to_message_id: msg.message_id, allow_sending_without_reply: true, reply_markup: keyboard });
}

async function setupBot() {
    // The four calls run side by side; the reply says which ones worked (never the token).
    const [hook, cmds, desc, short] = await Promise.all([
      tg("setWebhook", { url: HOOK, secret_token: secret(), allowed_updates: ["message"] }),
      tg("setMyCommands", { commands: [{ command: "check", description: "Check a token: /check 0x…" }, { command: "help", description: "How to use NEARL Check" }] }),
      tg("setMyDescription", { description: "NEARL Check on Telegram. Send a Robinhood Chain token address and get a 0–100 safety score: simulated buy and sell, taxes, owner powers, bundles and snipers. nearlagent.com" }),
      tg("setMyShortDescription", { short_description: "Token safety checks for Robinhood Chain · nearlagent.com" }),
    ]);
    const info = await tg("getWebhookInfo", {});
    const w = info.result || {};
    return {
      webhook: !!hook.ok, commands: !!cmds.ok, description: !!desc.ok, shortDescription: !!short.ok, error: hook.ok ? "" : hook.description || "",
      telegram: { url: w.url || "", pending: w.pending_update_count || 0, lastError: w.last_error_message || "" },
    };
}

const JSONH = { "Content-Type": "application/json", "Cache-Control": "no-store" };

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};

  // Save a new token from /bot-setup.html. Only a token for @NearlCheckBot is accepted.
  if (event.httpMethod === "POST" && q.register) {
    let body = {};
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}"); } catch (_) {}
    const t = String(body.token || "").trim().replace(/^bot/i, "");
    if (!/^[0-9]{6,}:[A-Za-z0-9_-]{30,}$/.test(t)) return { statusCode: 400, headers: JSONH, body: JSON.stringify({ ok: false, error: "That is not a bot token. It looks like 1234567890:AAH… (digits, a colon, then a long code)." }) };
    current = t;
    const me = await tg("getMe", {});
    if (!me.ok) return { statusCode: 400, headers: JSONH, body: JSON.stringify({ ok: false, error: "Telegram does not accept this token: " + (me.description || "unknown error") + ". If you used /revoke, copy the newest token." }) };
    if (String(me.result.username || "").toLowerCase() !== BOT_USERNAME) return { statusCode: 403, headers: JSONH, body: JSON.stringify({ ok: false, error: "This token belongs to @" + me.result.username + ", not @NearlCheckBot." }) };
    const st = configStore(event);
    try { await st.set("telegram-token", t); } catch (e) { return { statusCode: 500, headers: JSONH, body: JSON.stringify({ ok: false, error: "Could not save the token on the server." }) }; }
    const res = await setupBot();
    return { statusCode: 200, headers: JSONH, body: JSON.stringify({ ok: res.webhook, bot: "@" + me.result.username, ...res }) };
  }

  current = await loadToken(event);
  if (!token()) return { statusCode: 503, body: "No bot token yet: open nearlagent.com/bot-setup.html" };

  if (event.httpMethod === "GET" && q.setup) {
    return { statusCode: 200, headers: JSONH, body: JSON.stringify(await setupBot()) };
  }

  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };
  const h = event.headers || {};
  if ((h["x-telegram-bot-api-secret-token"] || "") !== secret()) return { statusCode: 401, body: "" };
  let update;
  try { update = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "{}"); } catch (_) { return { statusCode: 200, body: "" }; }
  const msg = update.message;
  if (msg) { try { await answer(msg, event); } catch (_) {} }
  return { statusCode: 200, body: "" }; // always 200, so Telegram does not resend the same message
};
