// Scheduled (every 10 minutes): posts Pons launch alerts to NEARL's Telegram channel.
//   · Close to bonding: a launch crosses 80% of its curve (with a quick NEARL Check score)
//   · Bonded: a launch graduates into its Uniswap v4 pool
//   · Serial launcher: a token from a wallet with 10+ other launches and none bonded passes 30% of its curve
// Each token gets each kind of alert once. On the very first run nothing is posted: what is already on the list
// is only remembered, so the channel is not flooded with old news. At most 3 posts per run.
// Uses the same scan as /bonding (lib/bonding.js). The bot must be an admin of the channel.
// The channel is "telegram-alert-chat" in the nearl-config store, else TELEGRAM_ALERT_CHAT, else @nearlagent.
// Set "telegram-alerts" to "off" in the nearl-config store to pause posting without a deploy.
const { getBonding, bondingStore, readKey, writeKey } = require("./lib/bonding");
const { quickScore } = require("./lib/engine");

const SITE = "https://nearlagent.com";
const NEAR_PCT = 80, SERIAL_PCT = 30, MAX_POSTS = 3;
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const usd = (v) => v == null ? "n/a" : v >= 1e6 ? "$" + (v / 1e6).toFixed(2) + "M" : v >= 1e3 ? "$" + (v / 1e3).toFixed(1) + "K" : "$" + Math.round(v);
const verdict = (s) => s >= 80 ? "Looks safe" : s >= 55 ? "Be careful" : s >= 25 ? "High risk" : "Do not buy";

function configStore(event) {
  try {
    const { connectLambda, getStore } = require("@netlify/blobs");
    if (event && event.blobs) connectLambda(event);
    return getStore("nearl-config");
  } catch (_) { return null; }
}
async function cfg(st, key, env, fallback) {
  try { const v = st && (await st.get(key)); if (v) return String(v).trim(); } catch (_) {}
  return process.env[env] || fallback;
}

function creatorLine(t) {
  if (t.serialLauncher) return `⚠️ Serial launcher: ${t.creatorOtherLaunches} other launches in 3 days, none bonded`;
  if (t.creatorOtherLaunches > 0) return `Creator launched ${t.creatorOtherLaunches} other token${t.creatorOtherLaunches === 1 ? "" : "s"} in 3 days, ${t.creatorOtherGraduated} bonded`;
  return "Creator: no other launches in 3 days";
}

function message(kind, t, score) {
  const head = {
    near: `🟡 <b>Close to bonding</b> · ${esc(t.symbol)}`,
    bonded: `🔔 <b>Bonded</b> · ${esc(t.symbol)}`,
    serial: `⚠️ <b>Serial launcher on the move</b> · ${esc(t.symbol)}`,
  }[kind];
  const lines = [head, esc(t.name || "")];
  if (kind === "bonded") lines.push("Graduated from its Pons curve into a Uniswap v4 pool.");
  else lines.push(`Curve ${t.progressPct.toFixed(1)}% · ${t.ethOnCurve.toFixed(2)} / ${t.graduatesAtEth} ETH · mkt cap ${usd(t.marketCapUsd)}`);
  if (score) lines.push(`NEARL quick check: <b>${score.score}/100</b> · ${verdict(score.score)} (no holder analysis)`);
  lines.push(creatorLine(t));
  if (t.creatorTaxPct) lines.push(`Creator tax ${t.creatorTaxPct}% per trade`);
  lines.push(`<code>${t.token}</code>`, "", "<i>Not a recommendation. Run the full scan before you buy.</i>");
  return lines.filter((l, i) => l !== "" || i > 0).join("\n");
}

async function send(tokenStr, chat, text, t) {
  const r = await fetch(`https://api.telegram.org/bot${tokenStr}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(7000),
    body: JSON.stringify({
      chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "Full scan ↗", url: `${SITE}/check?token=${t.token}` }, { text: "All launches ↗", url: `${SITE}/bonding` }]] },
    }),
  });
  return r.json().catch(() => ({ ok: false }));
}

// Works out which alerts are new. state.seen: { token: ["near", "bonded", "serial"] }
function pending(data, state) {
  const out = [];
  const has = (t, k) => (state.seen[t] || []).includes(k);
  for (const t of data.graduated || []) if (!has(t.token, "bonded")) out.push(["bonded", t]);
  for (const t of data.tokens || []) {
    if (t.progressPct >= NEAR_PCT && !has(t.token, "near")) out.push(["near", t]);
    else if (t.serialLauncher && t.progressPct >= SERIAL_PCT && !has(t.token, "serial")) out.push(["serial", t]);
  }
  return out;
}

async function run(event, { dry = false } = {}) {
  const st = configStore(event), bs = bondingStore(event);
  // Without shared storage the bot could not remember what it posted, so it would repeat itself: stop instead.
  if (!dry && (!st || !bs)) return { posted: 0, note: "no Blobs store" };
  if (!dry && (await cfg(st, "telegram-alerts", "TELEGRAM_ALERTS", "on")) === "off") return { posted: 0, note: "paused" };
  const { data } = await getBonding(bs, { maxAgeMs: 5 * 60 * 1000 });
  const state = (await readKey(bs, "alerts-state")) || { seen: {}, started: false };
  const todo = pending(data, state);
  const mark = (t, k) => { state.seen[t] = [...new Set([...(state.seen[t] || []), k])]; };

  if (!state.started) {
    todo.forEach(([k, t]) => mark(t.token, k));
    state.started = true;
    if (!dry) await writeKey(bs, "alerts-state", state);
    return { posted: 0, note: `first run: remembered ${todo.length} existing alerts` };
  }

  const tokenStr = dry ? "" : await cfg(st, "telegram-token", "TELEGRAM_BOT_TOKEN", "");
  const chat = await cfg(st, "telegram-alert-chat", "TELEGRAM_ALERT_CHAT", "@nearlagent");
  const out = [];
  for (const [kind, t] of todo.slice(0, MAX_POSTS)) {
    let score = null;
    if (kind === "near") {
      score = await Promise.race([quickScore(t.token).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
    }
    const text = message(kind, t, score);
    if (dry) { out.push(text); mark(t.token, kind); continue; }
    const r = await send(tokenStr, chat, text, t);
    if (r.ok) mark(t.token, kind);
    out.push(r.ok ? "sent" : "failed: " + (r.description || "unknown"));
    if (!r.ok && /chat not found|not enough rights|bot is not a member|forbidden/i.test(r.description || "")) break;
  }
  // Forget tokens that have left the 3-day window, so the state stays small.
  const live = new Set([...(data.tokens || []), ...(data.graduated || [])].map((t) => t.token));
  for (const k of Object.keys(state.seen)) if (!live.has(k)) delete state.seen[k];
  if (!dry) await writeKey(bs, "alerts-state", state);
  return { posted: out.filter((x) => x === "sent").length, results: out, waiting: Math.max(0, todo.length - MAX_POSTS) };
}

exports.handler = async (event) => {
  try {
    const r = await run(event);
    console.log("tg-alerts", JSON.stringify(r));
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (e) {
    console.log("tg-alerts error", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
exports.run = run;
exports.message = message;
