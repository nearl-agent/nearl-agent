// Rate limiting and a short result cache for the NEARL Check API and MCP server.
// Uses Netlify Blobs when available (shared across function instances), and falls back to
// per-instance memory when running locally or if Blobs is unavailable. Fails open on errors.
const LIMIT_PER_MIN = Number(process.env.NEARL_RATE_LIMIT || 20); // checks per IP per minute
const CACHE_SECONDS = 120;

const memHits = new Map();
const memCache = new Map();

function store(event) {
  try {
    const { connectLambda, getStore } = require("@netlify/blobs");
    if (event && event.blobs) connectLambda(event);
    return getStore("nearl-api");
  } catch (_) {
    return null;
  }
}

function clientIp(event) {
  const h = event.headers || {};
  return (h["x-nf-client-connection-ip"] || h["x-forwarded-for"] || "unknown").split(",")[0].trim();
}

/** @returns {{ ok: boolean, remaining: number, retryAfter: number }} */
async function rateLimit(event) {
  const ip = clientIp(event);
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl/${minute}/${ip}`;
  const retryAfter = 60 - Math.floor((Date.now() / 1000) % 60);
  let count = 0;
  const s = store(event);
  try {
    if (s) {
      count = Number((await s.get(key)) || 0) + 1;
      await s.set(key, String(count));
    } else throw new Error("no store");
  } catch (_) {
    count = (memHits.get(key) || 0) + 1;
    memHits.set(key, count);
    if (memHits.size > 5000) memHits.clear();
  }
  return { ok: count <= LIMIT_PER_MIN, remaining: Math.max(0, LIMIT_PER_MIN - count), retryAfter };
}

async function cached(event, cacheKey, compute) {
  const key = `cache/${cacheKey.toLowerCase()}`;
  const now = Date.now();
  const s = store(event);
  try {
    const hit = s ? await s.get(key, { type: "json" }) : memCache.get(key);
    if (hit && now - hit.at < CACHE_SECONDS * 1000) return { ...hit.value, cached: true };
  } catch (_) {}
  const value = await compute();
  const entry = { at: now, value };
  try {
    if (s) await s.setJSON(key, entry);
    else {
      memCache.set(key, entry);
      if (memCache.size > 500) memCache.clear();
    }
  } catch (_) {}
  return value;
}

module.exports = { rateLimit, cached, LIMIT_PER_MIN };
