// GET /api/check?token=0x...&net=mainnet|testnet  → NEARL Check result as JSON
const { runCheck } = require("./lib/engine");
const { rateLimit, cached, LIMIT_PER_MIN, bump } = require("./lib/limits");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Use GET" }) };
  const q = event.queryStringParameters || {};
  if (!q.token) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ error: "Add ?token=0x... (and optionally &net=testnet)" }) };
  }

  const rl = await rateLimit(event);
  const limitHeaders = { "X-RateLimit-Limit": String(LIMIT_PER_MIN), "X-RateLimit-Remaining": String(rl.remaining) };
  if (!rl.ok) {
    return {
      statusCode: 429,
      headers: { ...HEADERS, ...limitHeaders, "Retry-After": String(rl.retryAfter) },
      body: JSON.stringify({ error: `Too many checks. The limit is ${LIMIT_PER_MIN} per minute. Try again in ${rl.retryAfter} seconds.` }),
    };
  }

  try {
    const net = q.net === "testnet" ? "testnet" : "mainnet";
    const result = await cached(event, `${net}/${String(q.token).slice(0, 64)}`, () => runCheck(q.token, net));
    await bump(event, "api");
    return { statusCode: 200, headers: { ...HEADERS, ...limitHeaders, "Cache-Control": "public, max-age=60" }, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 422, headers: { ...HEADERS, ...limitHeaders }, body: JSON.stringify({ error: e.message || "Check failed" }) };
  }
};
