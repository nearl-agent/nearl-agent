// Check counter for the Stats page.
//   POST /api/count  → the website's Check page reports that one check finished (no body; nothing about it is stored)
//   GET  /api/count  → { web, api, mcp, total } checks run so far
const { rateLimit, bump, counts } = require("./lib/limits");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "https://nearlagent.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod === "GET") {
    return { statusCode: 200, headers: { ...HEADERS, "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=30" }, body: JSON.stringify(await counts(event)) };
  }
  if (event.httpMethod === "POST") {
    // Same per-IP limit as the API, so the number cannot be pumped up by a script.
    const rl = await rateLimit(event);
    if (rl.ok) await bump(event, "web");
    return { statusCode: 204, headers: HEADERS, body: "" };
  }
  return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: "Use GET or POST" }) };
};
