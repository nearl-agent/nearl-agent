// Loads the browser NEARL Check engine (web/check.js) inside a Netlify Function.
const { ethers } = require("ethers");
globalThis.window = globalThis.window || globalThis;
globalThis.window.ethers = ethers;
require("../../../web/rpc.js");
require("../../../web/check-holders.js");
require("../../../web/probe-code.js");
require("../../../web/v4-pools.js");
require("../../../web/stock-tokens.js");
require("../../../web/nearl-token.js");
require("../../../web/check.js");

const NearlCheck = globalThis.window.NearlCheck;

// Compact, agent-friendly result.
async function runCheck(token, network = "mainnet", opts = {}) {
  const net = network === "testnet" ? "testnet" : "mainnet";
  // Serverless functions have a short time limit, so the holder analysis gets a small budget here.
  const r = await NearlCheck.check(net, String(token || ""), () => {}, { holderDeadline: Date.now() + (opts.holderMs || 8500) });
  return {
    token: r.info.address,
    name: r.info.name,
    symbol: r.info.symbol,
    network: r.info.network,
    score: r.score,
    verdict: r.verdict.text,
    safeToBuy: r.score >= 55,
    buyTaxPct: r.info.buyTax,
    sellTaxPct: r.info.sellTax,
    transferTaxPct: r.info.transferTax,
    liquidityUsd: r.info.liquidityUsd ?? null,
    // Spot price from the token's pool or Pons curve at check time; market cap = price x (supply - burned).
    priceUsd: r.info.priceUsd ?? null,
    marketCapUsd: r.info.marketCapUsd ?? null,
    // Logo link the token creator stored on-chain (ipfs:// or https://), or null.
    logoUrl: r.info.logo || null,
    upgradeable: r.info.proxy,
    owner: r.info.owner,
    ownerSupplyPct: r.info.ownerPct ?? null,
    burnedSupplyPct: r.info.burnedPct,
    // Robinhood stock tokens: official (created by Robinhood's StockFactory) or a token copying one.
    stockToken: r.info.stock || null,
    // Holders and launch facts, when they could be rebuilt within the time limit (null otherwise).
    holders: r.info.holders ? { count: r.info.holders.count, top10Pct: r.info.holders.top10Pct, top: r.info.holders.top.slice(0, 5) } : null,
    launch: r.info.launch || null,
    creator: r.info.creator || null,
    findings: r.findings.map((f) => ({ level: f.level, title: f.title, detail: f.detail })),
    explorer: r.info.explorer,
    checkedAt: new Date().toISOString(),
    disclaimer: "Automated checks can miss risks. Not investment advice.",
  };
}

// Score without the holder analysis: fast enough to verify a shared result inside a request.
// Holder findings can only lower a score, so a genuine shared score is never above this one.
async function quickScore(token, network = "mainnet") {
  const net = network === "testnet" ? "testnet" : "mainnet";
  const r = await NearlCheck.check(net, String(token || ""), () => {}, { holders: false });
  return { score: r.score, symbol: r.info.symbol, name: r.info.name, titles: r.findings.map((f) => f.title) };
}

module.exports = { runCheck, quickScore };
