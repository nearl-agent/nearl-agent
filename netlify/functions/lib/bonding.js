// Pons launches on Robinhood Chain, sorted by how close they are to graduating ("bonding") into Uniswap v4.
// Everything is read from the chain: TokenLaunched events from the Pons factory, each launch record,
// and each curve's reserves. Reads are batched through Multicall3 so a full scan is a handful of calls.
const { ethers } = require("ethers");
globalThis.window = globalThis.window || globalThis;
globalThis.window.ethers = ethers;
require("../../../web/rpc.js");

const PONS_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TOKEN_LAUNCHED = ethers.id("TokenLaunched(address,address,address,address,uint256,uint256)");
const WINDOW_HOURS = 72; // launches older than this are not listed
const SERIAL_MIN = 10; // same rule as Check: 10+ other launches and none graduated

const MC = new ethers.Interface(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])"]);
const FAC = new ethers.Interface(["function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))"]);
const CURVE = new ethers.Interface([
  "function realQuoteReserve() view returns (uint256)", "function quoteReserve() view returns (uint256)", "function tokenReserve() view returns (uint256)",
  "function graduated() view returns (bool)", "function readyToGraduate() view returns (bool)",
]);
const ERC20 = new ethers.Interface(["function name() view returns (string)", "function symbol() view returns (string)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"]);
const V3F = new ethers.Interface(["function getPool(address,address,uint24) view returns (address)"]);
const POOL = new ethers.Interface(["function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)", "function token0() view returns (address)"]);

// Runs many view calls in batches of `size`; each result is decoded, or null if that call failed.
// Batches run side by side.
async function multi(p, calls, size = 300) {
  const chunks = [];
  for (let i = 0; i < calls.length; i += size) chunks.push(calls.slice(i, i + size));
  const parts = await Promise.all(chunks.map(async (chunk) => {
    const data = MC.encodeFunctionData("aggregate3", [chunk.map((c) => ({ target: c.to, allowFailure: true, callData: c.iface.encodeFunctionData(c.fn, c.args || []) }))]);
    const res = MC.decodeFunctionResult("aggregate3", await p.call({ to: MULTICALL3, data }))[0];
    return res.map((r, k) => {
      const c = chunk[k];
      if (!r.success || r.returnData === "0x") return null;
      try { return c.iface.decodeFunctionResult(c.fn, r.returnData)[0]; } catch (_) { return null; }
    });
  }));
  return parts.flat();
}

async function ethUsd(p) {
  for (const fee of [500, 3000, 100, 10000]) {
    try {
      const pool = V3F.decodeFunctionResult("getPool", await p.call({ to: V3_FACTORY, data: V3F.encodeFunctionData("getPool", [WETH, USDG, fee]) }))[0];
      if (!pool || pool === ethers.ZeroAddress) continue;
      const [s0, t0] = await multi(p, [{ to: pool, iface: POOL, fn: "slot0" }, { to: pool, iface: POOL, fn: "token0" }]);
      if (!s0 || !t0) continue;
      const raw = (Number(s0) / 2 ** 96) ** 2;
      const px = t0.toLowerCase() === WETH.toLowerCase() ? raw * 1e12 : (1 / raw) * 1e12; // WETH 18, USDG 6 decimals
      if (px > 10 && px < 1e6) return px;
    } catch (_) {}
  }
  return null;
}

/**
 * @param {object} [prev] an earlier snapshot ({ at, eth: { token: ethOnCurve } }) to work out recent inflow
 * @returns list of tokens still on their curve (highest progress first), recently graduated ones, and totals
 */
async function scanBonding(prev, { limit = 60 } = {}) {
  const p = globalThis.window.NearlRPC.provider(4663);
  const latest = await p.getBlockNumber();
  const [bL, bP] = await Promise.all([p.getBlock(latest), p.getBlock(latest - 50000)]);
  const bps = bL && bP && bL.timestamp > bP.timestamp ? 50000 / (bL.timestamp - bP.timestamp) : 9;
  const from = Math.max(0, latest - Math.round(WINDOW_HOURS * 3600 * bps));
  const logs = await globalThis.window.NearlRPC.getLogsAdaptive(p, { address: PONS_FACTORY, topics: [TOKEN_LAUNCHED] }, from, latest, 80);

  const seen = new Set(), launches = [];
  for (const l of logs) {
    const token = ethers.getAddress("0x" + l.topics[1].slice(26));
    if (seen.has(token)) continue;
    seen.add(token);
    launches.push({ token, deployer: ethers.getAddress("0x" + l.topics[3].slice(26)), block: l.blockNumber });
  }
  const recs = await multi(p, launches.map((x) => ({ to: PONS_FACTORY, iface: FAC, fn: "getLaunchedToken", args: [x.token] })));

  // Per creator: how many launches in the window, and how many of them graduated.
  const byCreator = {};
  launches.forEach((x, i) => {
    const r = recs[i];
    const c = (byCreator[x.deployer] ||= { launches: 0, graduated: 0 });
    c.launches++;
    if (r && Number(r.phase) !== 0) c.graduated++;
  });

  // ETH-paired launches only: their progress and dollar value can be read the same way for all of them.
  const live = [], grads = [];
  launches.forEach((x, i) => {
    const r = recs[i];
    if (!r || !r.exists || r.pairToken !== ethers.ZeroAddress) return;
    const item = { ...x, curve: r.curve, threshold: r.graduationThreshold, creatorTaxPct: Number(r.creatorTaxBps) / 100 };
    (Number(r.phase) === 0 ? live : grads).push(item);
  });
  const rq = await multi(p, live.map((x) => ({ to: x.curve, iface: CURVE, fn: "realQuoteReserve" })));
  live.forEach((x, i) => { x.realQuote = rq[i] ?? 0n; });
  live.sort((a, b) => (b.realQuote * 10000n / (b.threshold || 1n) > a.realQuote * 10000n / (a.threshold || 1n) ? 1 : -1));

  const top = live.slice(0, limit), gradTop = grads.slice(-12).reverse();
  const both = [...top, ...gradTop];
  const meta = await multi(p, both.flatMap((x) => [
    { to: x.token, iface: ERC20, fn: "name" }, { to: x.token, iface: ERC20, fn: "symbol" }, { to: x.token, iface: ERC20, fn: "totalSupply" },
  ]));
  const res = await multi(p, top.flatMap((x) => [{ to: x.curve, iface: CURVE, fn: "quoteReserve" }, { to: x.curve, iface: CURVE, fn: "tokenReserve" }, { to: x.curve, iface: CURVE, fn: "readyToGraduate" }]));
  const usd = await ethUsd(p);
  const nowS = bL.timestamp;
  const ageH = (block) => Math.max(0, (latest - block) / bps / 3600);

  const shape = (x, i, onCurve) => {
    const name = meta[i * 3], symbol = meta[i * 3 + 1], supply = meta[i * 3 + 2];
    const c = byCreator[x.deployer] || { launches: 1, graduated: 0 };
    const others = c.launches - 1, othersGrad = c.graduated - (onCurve ? 0 : 1);
    const out = {
      token: x.token, name: name ? String(name).slice(0, 40) : "", symbol: symbol ? String(symbol).slice(0, 16) : "?",
      creator: x.deployer, creatorOtherLaunches: others, creatorOtherGraduated: Math.max(0, othersGrad),
      serialLauncher: others >= SERIAL_MIN && othersGrad <= 0,
      creatorTaxPct: x.creatorTaxPct, launchedHoursAgo: Math.round(ageH(x.block) * 10) / 10,
    };
    if (!onCurve) return out;
    const k = i * 3, qr = res[k], tr = res[k + 1];
    const eth = Number(ethers.formatEther(x.realQuote)), thr = Number(ethers.formatEther(x.threshold));
    const priceEth = qr && tr && tr > 0n ? Number(ethers.formatEther(qr)) / Number(ethers.formatUnits(tr, 18)) : null;
    const supplyN = supply ? Number(ethers.formatUnits(supply, 18)) : null;
    const before = prev && prev.eth ? prev.eth[x.token] : undefined;
    return {
      ...out, ethOnCurve: Math.round(eth * 1e4) / 1e4, graduatesAtEth: thr, progressPct: Math.min(100, Math.round((eth / thr) * 1000) / 10),
      readyToGraduate: res[k + 2] === true,
      marketCapUsd: priceEth && supplyN && usd ? Math.round(priceEth * supplyN * usd) : null,
      ethInSincePrev: before === undefined ? null : Math.round((eth - before) * 1e4) / 1e4,
    };
  };

  const tokens = top.map((x, i) => shape(x, i, true));
  const graduated = gradTop.map((x, i) => shape(x, top.length + i, false));
  return {
    updatedAt: new Date(nowS * 1000).toISOString(), windowHours: WINDOW_HOURS, ethUsd: usd ? Math.round(usd * 100) / 100 : null,
    launches: launches.length, ethPaired: live.length + grads.length, graduatedInWindow: grads.length,
    prevAt: prev ? prev.at : null, complete: !!logs.complete,
    tokens, graduated,
    snapshot: { at: new Date().toISOString(), eth: Object.fromEntries(tokens.map((t) => [t.token, t.ethOnCurve])) },
  };
}

module.exports = { scanBonding };
