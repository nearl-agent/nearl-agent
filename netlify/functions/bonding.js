// GET /api/bonding → Pons launches on Robinhood Chain closest to graduating into Uniswap v4, as JSON.
// A scan reads the chain (about 5 s), so the result is kept for 60 s in Netlify Blobs and shared by
// every visitor. Snapshots from earlier scans give the ETH that came into each curve in about the last hour.
const { scanBonding } = require("./lib/bonding");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const FRESH_MS = 60 * 1000;
const SNAP_EVERY_MS = 10 * 60 * 1000; // keep a snapshot every 10 minutes
const SNAP_KEEP = 8;
const mem = {};

function store(event) {
  try {
    const { connectLambda, getStore } = require("@netlify/blobs");
    if (event && event.blobs) connectLambda(event);
    return getStore("nearl-bonding");
  } catch (_) {
    return null;
  }
}
async function get(s, key) {
  try { return s ? await s.get(key, { type: "json" }) : mem[key] || null; } catch (_) { return mem[key] || null; }
}
async function put(s, key, value) {
  mem[key] = value;
  try { if (s) await s.setJSON(key, value); } catch (_) {}
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Use GET" }) };
  const s = store(event);
  const now = Date.now();
  const last = await get(s, "latest");
  if (last && now - last.at < FRESH_MS) return reply(last.data, now - last.at);

  try {
    // The snapshot to compare against: the newest one that is at least 45 minutes old, else the oldest one kept.
    const hist = (await get(s, "hist")) || [];
    const old = hist.filter((h) => now - Date.parse(h.at) >= 45 * 60 * 1000);
    const prev = old.length ? old[old.length - 1] : hist[0] || null;
    const data = await scanBonding(prev);
    const snap = data.snapshot;
    delete data.snapshot;
    await put(s, "latest", { at: now, data });
    if (!hist.length || now - Date.parse(hist[hist.length - 1].at) >= SNAP_EVERY_MS) {
      await put(s, "hist", [...hist, snap].slice(-SNAP_KEEP));
    }
    return reply(data, 0);
  } catch (e) {
    if (last) return reply({ ...last.data, stale: true }, now - last.at);
    return { statusCode: 503, headers: HEADERS, body: JSON.stringify({ error: "Could not read Robinhood Chain right now. Try again in a minute." }) };
  }
};

function reply(data, ageMs) {
  return {
    statusCode: 200,
    headers: { ...HEADERS, "Cache-Control": "public, max-age=30", "X-Data-Age": String(Math.round(ageMs / 1000)) },
    body: JSON.stringify(data),
  };
}
