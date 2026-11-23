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

// ---- check counter for the Stats page ----
// One number per source (web, api, mcp). Nothing about the check is stored: no token, no IP, no wallet.
// Read-modify-write on the same kind of store the rate limiter uses (the "strong" mode is not available to
// Lambda-style functions). Under heavy concurrency a count can be missed, never invented.
const SOURCES = ["web", "api", "mcp"];
function countStore(event) {
  try {
    const { connectLambda, getStore } = require("@netlify/blobs");
    if (event && event.blobs) connectLambda(event);
    return getStore("nearl-counts");
  } catch (_) {
    return null;
  }
}
async function bump(event, source) {
  if (!SOURCES.includes(source)) return;
  const s = countStore(event);
  if (!s) return;
  try {
    const key = `checks/${source}`;
    const n = Number((await s.get(key)) || 0) + 1;
    await s.set(key, String(n));
  } catch (_) {}
}
async function counts(event) {
  const s = countStore(event);
  const out = { web: 0, api: 0, mcp: 0 };
  if (s) {
    await Promise.all(SOURCES.map(async (k) => {
      try { out[k] = Number((await s.get(`checks/${k}`)) || 0); } catch (_) {}
    }));
  }
  out.total = out.web + out.api + out.mcp;
  return out;
}

module.exports = { rateLimit, cached, LIMIT_PER_MIN, bump, counts };
