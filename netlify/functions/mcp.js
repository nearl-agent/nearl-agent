// NEARL MCP server (Streamable HTTP, stateless, JSON responses) at POST /mcp
// Tool: nearl_check_token: safety score for a Robinhood Chain token before buying it.
const { runCheck } = require("./lib/engine");
const { rateLimit, cached, LIMIT_PER_MIN } = require("./lib/limits");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Authorization",
};

const TOOLS = [
  {
    name: "nearl_check_token",
    title: "NEARL Check: token safety score",
    description:
      "Check an ERC-20 token on Robinhood Chain before buying it. Simulates a buy, a sell and a transfer to detect honeypots and taxes, reads owner powers (mint, blacklist, tax, trading switch), upgradeability, supply held by the owner, and Uniswap v3 liquidity. Returns a 0-100 score and plain-language findings. Do not buy when safeToBuy is false.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Token contract address (0x...)" },
        network: { type: "string", enum: ["mainnet", "testnet"], default: "mainnet", description: "Robinhood Chain network" },
      },
      required: ["token"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

function reply(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function fail(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handle(msg, event) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // notification: no response
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nearl", title: "NEARL", version: "0.1.0" },
        instructions: "Call nearl_check_token before buying any token on Robinhood Chain. Skip tokens where safeToBuy is false.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      if (params?.name !== "nearl_check_token") return fail(id, -32602, `Unknown tool: ${params?.name}`);
      const rl = await rateLimit(event);
      if (!rl.ok) {
        return reply(id, { content: [{ type: "text", text: `Rate limit reached (${LIMIT_PER_MIN} checks per minute). Try again in ${rl.retryAfter} seconds.` }], isError: true });
      }
      try {
        const net = params?.arguments?.network === "testnet" ? "testnet" : "mainnet";
        const r = await cached(event, `${net}/${String(params?.arguments?.token || "").slice(0, 64)}`, () => runCheck(params?.arguments?.token, net));
        const top = r.findings.filter((f) => f.level === "bad" || f.level === "warn").slice(0, 4).map((f) => `- ${f.title}`).join("\n");
        const text = `${r.name} (${r.symbol}) on ${r.network}: score ${r.score}/100, ${r.verdict}. ` +
          `Buy tax ${r.buyTaxPct == null ? "not tested" : r.buyTaxPct + "%"}, sell tax ${r.sellTaxPct == null ? "not tested" : r.sellTaxPct + "%"}, liquidity ${r.liquidityUsd ? "$" + Math.round(r.liquidityUsd) : "n/a"}.` +
          (r.stockToken && r.stockToken.official ? `\nOfficial Robinhood stock token (${r.stockToken.symbol}).` : "") +
          (r.stockToken && r.stockToken.impersonates ? `\nNOT the official ${r.stockToken.impersonates} stock token. Official address: ${r.stockToken.officialAddress}` : "") +
          (top ? `\nRisks:\n${top}` : "\nNo major risks found.") + `\nsafeToBuy: ${r.safeToBuy}`;
        return reply(id, { content: [{ type: "text", text }], structuredContent: r, isError: false });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `Check failed: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: { ...HEADERS, Allow: "POST" }, body: JSON.stringify(fail(null, -32000, "Use POST with JSON-RPC")) };
  }
  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body || "");
  } catch (_) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify(fail(null, -32700, "Parse error")) };
  }
  const batch = Array.isArray(body);
  const out = (await Promise.all((batch ? body : [body]).map((m) => handle(m, event)))).filter(Boolean);
  if (!out.length) return { statusCode: 202, headers: HEADERS, body: "" };
  return { statusCode: 200, headers: HEADERS, body: JSON.stringify(batch ? out : out[0]) };
};
