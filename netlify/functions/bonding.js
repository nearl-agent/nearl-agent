// GET /api/bonding → Pons launches on Robinhood Chain closest to graduating into Uniswap v4, as JSON.
// A scan reads the chain (about 5 s), so the result is kept for 60 s in Netlify Blobs and shared by
// every visitor (and by the Telegram alerts). See lib/bonding.js.
const { getBonding, bondingStore } = require("./lib/bonding");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "GET") return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Use GET" }) };
  try {
    const { data, ageMs } = await getBonding(bondingStore(event));
    return {
      statusCode: 200,
      headers: { ...HEADERS, "Cache-Control": "public, max-age=30", "X-Data-Age": String(Math.round(ageMs / 1000)) },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return { statusCode: 503, headers: HEADERS, body: JSON.stringify({ error: "Could not read Robinhood Chain right now. Try again in a minute." }) };
  }
};
