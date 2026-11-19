/* NEARL fast Uniswap v4 pool finder (window.NearlV4Known). Works in the browser and in Netlify Functions.
 *
 * Finding a token's v4 pool normally means scanning PoolManager Initialize events, which public RPCs
 * rate-limit and which can take 30+ seconds. A v4 pool id is just keccak256(PoolKey), so for the pool
 * settings that are actually used on Robinhood Chain we can compute the id directly and read its
 * liquidity from StateView: a few dozen quick eth_calls, no logs.
 *
 * CONFIGS lists [quote, fee, tickSpacing, hooks] for the 90 most common settings among v4 pools
 * paired with ETH, WETH or USDG (about 84% of recent pools; built by scanning Initialize events in
 * November 2026). Tokens on other settings still fall back to the log scan in check.js.
 */
(function (root) {
  "use strict";
  const { ethers } = root;

  const CONFIGS = [
    ["ETH", 10000, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 100, 1, "0x0000000000000000000000000000000000000000"],
    ["WETH", 8388608, 8, "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544"],
    ["ETH", 1, 1, "0x0000000000000000000000000000000000000000"],
    ["WETH", 0, 200, "0x2c668601193e4A081DD82604785e436AFf6a2aCC"],
    ["ETH", 0, 60, "0x0Af57F62982D03066ef917AcAd87F771c06528Ec"],
    ["USDG", 800000, 8000, "0x0000000000000000000000000000000000000000"],
    ["USDG", 8388608, 8, "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544"],
    ["USDG", 900000, 9000, "0x0000000000000000000000000000000000000000"],
    ["WETH", 8388608, 200, "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544"],
    ["ETH", 500, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 3000, 60, "0x0000000000000000000000000000000000000000"],
    ["WETH", 8388608, 200, "0x48B8F6AD3A1b4aA477314c9a23035b8F84dDe8cc"],
    ["USDG", 700000, 7000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 0, 60, "0x8e1Bf182a2a1FEdF9850379127D4535F18EA68cc"],
    ["WETH", 10000, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 8388608, 60, "0x9CeeF5e565755124958fDAd6e6337DF78E26e8c4"],
    ["ETH", 0, 200, "0x745d717620052a97a22dEEE2e5Eba59583f3e0CC"],
    ["ETH", 790000, 60, "0x0000000000000000000000000000000000000000"],
    ["USDG", 870000, 8700, "0x0000000000000000000000000000000000000000"],
    ["ETH", 2500, 25, "0x0000000000000000000000000000000000000000"],
    ["ETH", 0, 200, "0x565189a6780D1a50FC1792F64db8e4881119AaCC"],
    ["USDG", 500000, 5000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 813670, 200, "0x0000000000000000000000000000000000000000"],
    ["USDG", 600000, 6000, "0x0000000000000000000000000000000000000000"],
    ["USDG", 890000, 8900, "0x0000000000000000000000000000000000000000"],
    ["ETH", 75, 1, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1000, 200, "0x0000000000000000000000000000000000000000"],
    ["USDG", 860000, 8600, "0x0000000000000000000000000000000000000000"],
    ["ETH", 600000, 6000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1500, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 2500, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 2000, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 0, 60, "0x0000000000000000000000000000000000000000"],
    ["WETH", 3000, 60, "0x0000000000000000000000000000000000000000"],
    ["ETH", 836900, 200, "0x0000000000000000000000000000000000000000"],
    ["USDG", 0, 1, "0x0000000000000000000000000000000000000000"],
    ["USDG", 880000, 8800, "0x0000000000000000000000000000000000000000"],
    ["ETH", 827298, 9303, "0x0000000000000000000000000000000000000000"],
    ["ETH", 950000, 9500, "0x0000000000000000000000000000000000000000"],
    ["USDG", 200000, 2000, "0x0000000000000000000000000000000000000000"],
    ["USDG", 990000, 9900, "0x0000000000000000000000000000000000000000"],
    ["ETH", 10000, 200, "0x037BF303462Bb3CdE80038a1945CD10af1EBdaCc"],
    ["ETH", 772986, 9303, "0x0000000000000000000000000000000000000000"],
    ["USDG", 770000, 7700, "0x0000000000000000000000000000000000000000"],
    ["ETH", 899900, 8999, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1800, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1200, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 2700, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1400, 200, "0x0000000000000000000000000000000000000000"],
    ["USDG", 1, 1, "0x0000000000000000000000000000000000000000"],
    ["ETH", 3000, 200, "0x0000000000000000000000000000000000000000"],
    ["USDG", 40000, 400, "0x0000000000000000000000000000000000000000"],
    ["ETH", 0, 200, "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044"],
    ["USDG", 701000, 7010, "0x0000000000000000000000000000000000000000"],
    ["USDG", 989999, 9900, "0x0000000000000000000000000000000000000000"],
    ["USDG", 450000, 4500, "0x0000000000000000000000000000000000000000"],
    ["ETH", 795055, 9303, "0x0000000000000000000000000000000000000000"],
    ["ETH", 500000, 5000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 0, 60, "0x15e5E7206C661a1E881F5CD33A94eAF2328FA8cc"],
    ["ETH", 1300, 200, "0x0000000000000000000000000000000000000000"],
    ["USDG", 400000, 4000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1900, 200, "0x0000000000000000000000000000000000000000"],
    ["USDG", 850000, 8500, "0x0000000000000000000000000000000000000000"],
    ["ETH", 846900, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 30000, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 700000, 7000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1100, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 601000, 6010, "0x0000000000000000000000000000000000000000"],
    ["USDG", 501000, 5010, "0x0000000000000000000000000000000000000000"],
    ["USDG", 790000, 7900, "0x0000000000000000000000000000000000000000"],
    ["ETH", 800000, 8000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 2100, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 2800, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 20000, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 15000, 200, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1700, 200, "0x0000000000000000000000000000000000000000"],
    ["USDG", 150000, 1500, "0x0000000000000000000000000000000000000000"],
    ["USDG", 810000, 8100, "0x0000000000000000000000000000000000000000"],
    ["ETH", 500, 10, "0x0000000000000000000000000000000000000000"],
    ["USDG", 550000, 5500, "0x0000000000000000000000000000000000000000"],
    ["USDG", 100000, 1000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 860000, 8600, "0x0000000000000000000000000000000000000000"],
    ["USDG", 0, 1, "0x73036032C3e81b1262c8BfBB29fC1383a76de888"],
    ["USDG", 601000, 6010, "0x0000000000000000000000000000000000000000"],
    ["ETH", 200000, 2000, "0x0000000000000000000000000000000000000000"],
    ["ETH", 0, 60, "0x442460d3f1d40d13eED678d540427EfCe7b520cc"],
    ["USDG", 451000, 4510, "0x0000000000000000000000000000000000000000"],
    ["ETH", 836798, 9303, "0x0000000000000000000000000000000000000000"],
    ["ETH", 1600, 200, "0x0000000000000000000000000000000000000000"],
  ];

  const STATE_VIEW = [
    "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
    "function getLiquidity(bytes32) view returns (uint128)",
  ];
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const poolId = (c0, c1, fee, ts, hooks) =>
    ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, ts, hooks]));

  /**
   * Returns the deepest known-setting v4 pool for `token`, in the same shape as check.js findV4Pool,
   * or null. `quotes` maps symbol -> address (WETH, USDG); ETH is address(0).
   */
  async function find(p, stateView, token, quotes, toUsd) {
    const addr = { ETH: ethers.ZeroAddress, WETH: quotes.WETH, USDG: quotes.USDG };
    const t = token.toLowerCase();
    const cands = [];
    for (const [q, fee, ts, hooks] of CONFIGS) {
      const qa = addr[q];
      if (!qa || qa.toLowerCase() === t) continue;
      const tokenIs0 = BigInt(token) < BigInt(qa);
      const c0 = tokenIs0 ? token : qa, c1 = tokenIs0 ? qa : token;
      cands.push({ id: poolId(c0, c1, fee, ts, hooks), c0, c1, fee, tickSpacing: ts, hooks, quote: q, quoteAddr: qa, tokenIs0 });
    }
    const sv = new ethers.Contract(stateView, STATE_VIEW, p);
    // 1) Which of these pools exist? An initialized pool has a non-zero price in slot0.
    const found = [];
    for (let i = 0; i < cands.length; i += 15) {
      const batch = cands.slice(i, i + 15);
      const s0 = await Promise.all(batch.map((c) => sv.getSlot0(c.id).catch(() => null)));
      batch.forEach((c, k) => { if (s0[k] && s0[k][0] > 0n) { c.sqrt = s0[k][0]; found.push(c); } });
    }
    if (!found.length) return null;
    // 2) Active liquidity at the current price. 0 means the pool exists but nothing can be traded right now
    //    (liquidity removed, or price moved outside every position). That is reported as ~$0, not "no pool".
    await Promise.all(found.map(async (c) => {
      const L = await sv.getLiquidity(c.id).catch(() => 0n);
      const sq = Number(c.sqrt) / 2 ** 96, liq = Number(L);
      const amt0 = liq / sq, amt1 = liq * sq; // virtual reserves near the current price
      const qRaw = c.tokenIs0 ? amt1 : amt0, tRaw = c.tokenIs0 ? amt0 : amt1;
      c.quoteVirtual = BigInt(Math.floor(qRaw));
      c.tokenVirtual = BigInt(Math.floor(tRaw));
      c.quoteUsd = L > 0n ? toUsd(c.quote === "USDG" ? "USDG" : "ETH", c.quoteVirtual) : 0;
      c.empty = L === 0n;
    }));
    found.sort((a, b) => (b.quoteUsd || 0) - (a.quoteUsd || 0));
    return found[0];
  }

  root.NearlV4Known = { CONFIGS, find, poolId };
})(typeof window !== "undefined" ? window : globalThis);
