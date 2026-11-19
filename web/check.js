/* NEARL Check engine: read-only safety checks for an ERC-20 token on Robinhood Chain.
 * Everything runs in the visitor's browser against the public RPC. Nothing is signed or sent.
 *
 *   1. Token basics (name, symbol, decimals, supply)
 *   2. Upgradeable proxy (EIP-1967 slots)
 *   3. Owner and whether ownership is renounced
 *   4. Risky owner functions found in the bytecode (mint, blacklist, fees, trading switch, limits)
 *   5. Supply held by the owner, burned, and in the liquidity pool
 *   6. Liquidity: Uniswap v3 and v4 pools, or the token's Pons V2 launch curve
 *   7. Simulated buy, sell and wallet transfer (eth_call + state override) to measure taxes
 *      and catch honeypots. Tokens still on a Pons curve are bought and sold on the curve itself.
 */
(function () {
  "use strict";
  const { ethers } = window;

  const NET = {
    mainnet: {
      name: "Robinhood Chain",
      chainId: 4663,
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      explorer: "https://robinhoodchain.blockscout.com",
      factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", // Uniswap v3
      v4: {
        poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
        stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
        fromBlock: 9070, // PoolManager deployment
      },
      // Pons V2 launchpad: every launch gets its own bonding curve, then graduates to Uniswap v4.
      pons: { factory: "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" },
      quotes: {
        WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
        USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      },
      examples: [
        ["USDG", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"],
        ["WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"],
      ],
    },
    testnet: {
      name: "Robinhood Chain Testnet",
      chainId: 46630,
      rpc: "https://rpc.testnet.chain.robinhood.com",
      explorer: "https://explorer.testnet.chain.robinhood.com",
      factory: null,
      quotes: {},
      examples: [["tUSD", "0xBC4433dcf2C04c6a5f2ebF435519682636261996"]],
    },
  };

  const ERC20 = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
  ];
  const OWNABLE = ["function owner() view returns (address)", "function getOwner() view returns (address)"];
  const FACTORY = ["function getPool(address,address,uint24) view returns (address)"];
  const POOL = ["function slot0() view returns (uint160 sqrtPriceX96,int24,uint16,uint16,uint16,uint8,bool)", "function token0() view returns (address)"];
  const PROBE = ["function probe(address token,address to,uint256 amount) returns (bool ok,uint256 received,bytes err)"];
  const PROBE_PONS = ["function roundTrip(address curve,address token,address pairToken,uint256 quoteIn) returns (bool buyOk,uint256 tokensOut,bool sellOk,uint256 quoteBack,bytes err)"];
  const PONS_FACTORY = ["function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))"];
  const PONS_CURVE = [
    "function graduated() view returns (bool)", "function readyToGraduate() view returns (bool)",
    "function feeBps() view returns (uint256)", "function creatorTaxBps() view returns (uint256)",
    "function realQuoteReserve() view returns (uint256)", "function graduationThreshold() view returns (uint256)",
    "function currentSnipeTaxBps(address) view returns (uint256)",
  ];

  // Major assets whose admin powers are expected (issuers must be able to mint, upgrade, freeze).
  const KNOWN = {
    mainnet: {
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { name: "Global Dollar (USDG) by Paxos", note: "A regulated stablecoin. Minting, upgrades and freezing are normal for its issuer." },
      "0x0bd7d308f8e1639fab988df18a8011f41eacad73": { name: "Wrapped Ether (WETH)", note: "The standard wrapped version of ETH on this chain." },
    },
    testnet: {
      "0xbc4433dcf2c04c6a5f2ebf435519682636261996": { name: "NEARL Test USD (tUSD)", note: "Worthless test token used by NEARL testnet pools." },
    },
  };

  const DEAD = "0x000000000000000000000000000000000000dEaD";
  const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
  const OZ7201_ERC20 = "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00";
  const FEES = [100, 500, 3000, 10000];

  // Owner-only powers that matter to buyers, grouped by what they let the owner do.
  const RISKY = {
    mint: { label: "can create new tokens (mint)", penalty: 25, sigs: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)"] },
    blacklist: { label: "can block wallets from selling (blacklist)", penalty: 20, sigs: ["blacklist(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "blacklistAddress(address,bool)", "addBot(address)", "setBots(address[],bool)", "addBots(address[])", "setBot(address,bool)"] },
    fees: { label: "can change buy/sell taxes", penalty: 15, sigs: ["setFee(uint256)", "setFees(uint256,uint256)", "setTaxFee(uint256)", "setBuyFee(uint256)", "setSellFee(uint256)", "setTax(uint256)", "setBuyTax(uint256)", "setSellTax(uint256)", "setTaxes(uint256,uint256)", "updateFees(uint256,uint256)", "updateBuyFees(uint256,uint256,uint256)", "updateSellFees(uint256,uint256,uint256)"] },
    trading: { label: "can pause or switch off trading", penalty: 15, sigs: ["pause()", "enableTrading()", "openTrading()", "setTradingEnabled(bool)", "setTrading(bool)", "tradingStatus(bool)"] },
    limits: { label: "can limit how much a wallet buys or holds", penalty: 5, sigs: ["setMaxTxAmount(uint256)", "setMaxWallet(uint256)", "setMaxWalletSize(uint256)", "updateMaxTxnAmount(uint256)", "updateMaxWalletAmount(uint256)", "setMaxTx(uint256)"] },
  };
  for (const g of Object.values(RISKY)) g.selectors = g.sigs.map((s) => ethers.id(s).slice(2, 10));

  // Every PUSH4 operand in the bytecode (function selectors live there).
  function pushedSelectors(code) {
    const hex = code.startsWith("0x") ? code.slice(2) : code;
    const out = new Set();
    for (let i = 0; i < hex.length; ) {
      const op = parseInt(hex.substr(i, 2), 16);
      i += 2;
      if (op >= 0x60 && op <= 0x7f) {
        const n = op - 0x5f;
        if (n === 4) out.add(hex.substr(i, 8).toLowerCase());
        i += n * 2;
      }
    }
    return out;
  }

  const addrFromSlot = (v) => (v && v !== "0x" && BigInt(v) !== 0n ? ethers.getAddress("0x" + v.slice(-40)) : null);
  const isBurn = (a) => !a || a === ethers.ZeroAddress || a.toLowerCase() === DEAD.toLowerCase();

  async function tryCall(fn) {
    try {
      return await fn();
    } catch (_) {
      return null;
    }
  }

  const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // Robinhood stock tokens. The official list (stock-tokens.js) is read from the StockFactory's own
  // creation events. A token on the stock-token beacon that is newer than the list is confirmed by
  // finding the factory's creation event in the block where the token's code appeared.
  async function stockStatus(p, token, info, beaconAddr) {
    const S = window.NearlStockTokens;
    if (!S) return null;
    const lc = token.toLowerCase();
    const hit = S.tokens.find((t) => t.address.toLowerCase() === lc);
    if (hit) return { official: true, symbol: hit.symbol, name: hit.name };
    if (beaconAddr && beaconAddr.toLowerCase() === S.beacon) {
      const ok = await tryCall(() => createdByFactory(p, token, S.factory));
      return ok ? { official: true, symbol: info.symbol, name: info.name } : { unconfirmed: true };
    }
    const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9.]/g, "");
    const sym = norm(info.symbol), nm = String(info.name || "").trim().toLowerCase();
    const company = (t) => t.name.split(" • ")[0].toLowerCase();
    const byName = nm && S.tokens.find((t) => company(t) === nm || t.name.toLowerCase() === nm);
    if (byName) return { impersonates: byName, by: "name" };
    const bySym = sym && S.tokens.find((t) => norm(t.symbol) === sym);
    if (bySym) {
      // Short tickers like F, ON or RUN are also ordinary memecoin names. A token only copies the stock
      // when its name points at it too: the company's name, the ticker itself, "stock" or "Robinhood".
      const word = company(bySym).split(/[\s,.]+/)[0];
      const poses = (sym.length >= 3 && norm(info.name) === sym) || /robinhood|stock|shares?\b|equity|\binc\b|\bcorp/.test(nm);
      if (poses) return { impersonates: bySym, by: "ticker" };
      if (word.length >= 3 && nm.includes(word)) return { lookalike: bySym };
      return { sameTicker: bySym };
    }
    if (/robinhood\s*token/.test(nm)) return { claimsRobinhood: true };
    return null;
  }

  async function createdByFactory(p, token, factory) {
    let lo = 0, hi = await p.getBlockNumber();
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await p.getCode(token, mid)) !== "0x") hi = mid; else lo = mid + 1;
    }
    const logs = await p.getLogs({ address: factory, fromBlock: lo, toBlock: lo });
    const needle = token.toLowerCase().slice(2);
    return logs.some((l) => l.data.toLowerCase().includes(needle));
  }

  // Finds the storage slot of the balances mapping so the simulation can give a test wallet tokens.
  async function findBalanceSlot(p, token, holder) {
    const want = 123456789n;
    const value = ethers.toBeHex(want, 32);
    const data = new ethers.Interface(ERC20).encodeFunctionData("balanceOf", [holder]);
    const candidates = [];
    for (let s = 0; s < 12; s++) {
      candidates.push(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [holder, s])));
      candidates.push(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address"], [s, holder]))); // Vyper order
    }
    candidates.push(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [holder, OZ7201_ERC20])));
    for (const key of candidates) {
      const r = await tryCall(() => p.send("eth_call", [{ to: token, data }, "latest", { [token]: { stateDiff: { [key]: value } } }]));
      if (r && BigInt(r) === want) return key;
    }
    return null;
  }

  // ---- Uniswap v4
  const V4_INIT = new ethers.Interface(["event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"]);
  const STATE_VIEW = ["function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)", "function getLiquidity(bytes32) view returns (uint128)"];
  const PROBE_V4 = [
    "function buy(address pm,(address,address,uint24,int24,address) key,address token,uint256 quoteIn) returns (bool ok,uint256 out,uint256 received,bytes err)",
    "function sell(address pm,(address,address,uint24,int24,address) key,address token,uint256 tokenIn) returns (bool ok,uint256 out,uint256 received,bytes err)",
  ];

  // Finds the deepest v4 pool pairing the token with ETH, WETH or USDG, from PoolManager Initialize events.
  async function findV4Pool(p, net, token, toUsd) {
    // Fast path (v4-pools.js): compute pool ids for the common v4 settings and read them directly,
    // without scanning logs. A pool with real depth is good enough; otherwise fall back to the log scan.
    let fast = null;
    if (window.NearlV4Known) {
      fast = await tryCall(() => window.NearlV4Known.find(p, net.v4.stateView, token, net.quotes, toUsd));
      // A pool on a known setting was found (even an empty one): trust it and skip the slow log scan.
      if (fast) return fast;
    }
    const slow = await tryCall(() => findV4PoolByLogs(p, net, token, toUsd));
    if (fast && slow) return slow.quoteUsd > fast.quoteUsd ? slow : fast;
    return slow || fast;
  }

  async function findV4PoolByLogs(p, net, token, toUsd) {
    const topic = V4_INIT.getEvent("Initialize").topicHash;
    const t = ethers.zeroPadValue(token, 32);
    const latest = await p.getBlockNumber();
    const STEP = 10_000_000;
    const ranges = [];
    for (let to = latest; to >= net.v4.fromBlock; to -= STEP) ranges.push([Math.max(net.v4.fromBlock, to - STEP + 1), to]);
    // The public RPC rate-limits eth_getLogs, so scan newest ranges first, retry with a pause,
    // and stop once we have passed the token's pools (they all come after the token launched).
    // If a backup RPC only accepts small ranges, NearlRPC splits them and searches the newest blocks first.
    const getLogs = (from, to, topics) => window.NearlRPC.getLogsAdaptive(p, { address: net.v4.poolManager, topics }, from, to, 30);
    const logs = [];
    let seen = false;
    for (const [from, to] of ranges) {
      const pair = await Promise.all([getLogs(from, to, [topic, null, t]), getLogs(from, to, [topic, null, null, t])]);
      const n = pair[0].length + pair[1].length;
      logs.push(...pair[0], ...pair[1]);
      if (n) seen = true;
      else if (seen) break;
      const span = window.NearlRPC.maxSpan(p); if (span && span < 1_000_000) break; // backup RPC with small ranges: newest blocks only, to stay fast
    }
    const quotes = { [ethers.ZeroAddress.toLowerCase()]: "ETH" };
    for (const [s, a] of Object.entries(net.quotes)) quotes[a.toLowerCase()] = s;
    const cands = [];
    for (const l of logs) {
      const a = V4_INIT.parseLog(l).args;
      const tokenIs0 = a.currency0.toLowerCase() === token.toLowerCase();
      const q = (tokenIs0 ? a.currency1 : a.currency0).toLowerCase();
      if (!quotes[q]) continue;
      cands.push({ id: a.id, c0: a.currency0, c1: a.currency1, fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks: a.hooks, quote: quotes[q] === "ETH" ? "ETH" : quotes[q], quoteAddr: tokenIs0 ? a.currency1 : a.currency0, tokenIs0 });
    }
    if (!cands.length) return null;
    const sv = new ethers.Contract(net.v4.stateView, STATE_VIEW, p);
    // Newest pools first; read at most 80, ten at a time, to stay within public RPC limits.
    cands.reverse();
    const look = cands.slice(0, 80);
    for (let i = 0; i < look.length; i += 10) await Promise.all(look.slice(i, i + 10).map(async (c) => {
      const [s0, L] = await Promise.all([tryCall(() => sv.getSlot0(c.id)), tryCall(() => sv.getLiquidity(c.id))]);
      c.quoteUsd = 0;
      if (!s0 || !L || L === 0n || s0[0] === 0n) return;
      const sq = Number(s0[0]) / 2 ** 96, liq = Number(L);
      const amt0 = liq / sq, amt1 = liq * sq; // virtual reserves near the current price
      const qRaw = c.tokenIs0 ? amt1 : amt0, tRaw = c.tokenIs0 ? amt0 : amt1;
      c.quoteVirtual = BigInt(Math.floor(qRaw));
      c.tokenVirtual = BigInt(Math.floor(tRaw));
      c.quoteUsd = toUsd(c.quote === "USDG" ? "USDG" : "ETH", c.quoteVirtual);
    }));
    look.sort((a, b) => (b.quoteUsd || 0) - (a.quoteUsd || 0));
    return look[0] && look[0].quoteUsd > 0 ? look[0] : null;
  }

  async function runV4(p, net, mode, pool, token, amountIn, tester, override) {
    const iface = new ethers.Interface(PROBE_V4);
    const key = [pool.c0, pool.c1, pool.fee, pool.tickSpacing, pool.hooks];
    const data = iface.encodeFunctionData(mode, [net.v4.poolManager, key, token, amountIn]);
    const r = await p.send("eth_call", [{ to: tester, data, gas: "0x2FAF080" }, "latest", override]);
    const [ok, out, received] = iface.decodeFunctionResult(mode, r);
    return { ok, expected: out, received };
  }

  async function runProbe(p, at, token, to, amount, override) {
    const iface = new ethers.Interface(PROBE);
    const data = iface.encodeFunctionData("probe", [token, to, amount]);
    const r = await p.send("eth_call", [{ to: at, data, gas: "0x1C9C380" }, "latest", override]);
    const [ok, received] = iface.decodeFunctionResult("probe", r);
    return { ok, received };
  }

  // ------------------------------------------------------------------ main
  async function check(netKey, address, onStep = () => {}, opts = {}) {
    const net = NET[netKey];
    const p = window.NearlRPC.provider(net.chainId); // official RPC first, public backups if it is blocked or busy
    const findings = [];
    const add = (level, title, detail, penalty = 0) => findings.push({ level, title, detail, penalty });
    let token;
    try {
      token = ethers.getAddress(address.trim());
    } catch (_) {
      throw new Error("That is not a valid address. It should start with 0x and have 42 characters.");
    }

    onStep("Reading the contract…");
    const code = await p.getCode(token);
    if (code === "0x") throw new Error(`No contract at this address on ${net.name}. Check the address and the network.`);

    const erc = new ethers.Contract(token, ERC20, p);
    const [name, symbol, decimals, supply] = await Promise.all([
      tryCall(() => erc.name()), tryCall(() => erc.symbol()), tryCall(() => erc.decimals()), tryCall(() => erc.totalSupply()),
    ]);
    if (supply === null || decimals === null) throw new Error("This contract does not look like a token (ERC-20).");
    const dec = Number(decimals);
    const fmt = (v) => Number(ethers.formatUnits(v, dec));
    const info = { address: token, name: name || "Unknown", symbol: symbol || "?", decimals: dec, supply: fmt(supply), network: net.name, explorer: `${net.explorer}/token/${token}` };

    // --- proxy
    onStep("Checking if the code can be changed…");
    const [impl, admin, beacon] = await Promise.all([SLOT_IMPL, SLOT_ADMIN, SLOT_BEACON].map((s) => tryCall(() => p.getStorage(token, s))));
    const implAddr = addrFromSlot(impl), beaconAddr = addrFromSlot(beacon);
    let scanCode = code;
    if (implAddr || beaconAddr) {
      add("warn", "Upgradeable contract", "The team can replace the token's code later. That is common for big projects, but it means the rules can change after you buy.", 15);
      if (implAddr) scanCode += (await tryCall(() => p.getCode(implAddr))) || "";
    } else {
      add("ok", "Code cannot be swapped", "This is not an upgradeable proxy, so the token's rules are fixed.");
    }
    info.proxy = !!(implAddr || beaconAddr);

    // --- owner
    onStep("Looking for an owner…");
    const own = new ethers.Contract(token, OWNABLE, p);
    let owner = (await tryCall(() => own.owner())) || (await tryCall(() => own.getOwner()));
    if (!owner && admin) owner = addrFromSlot(admin);
    const renounced = !owner || isBurn(owner);
    info.owner = owner && !isBurn(owner) ? owner : null;

    // --- risky functions
    const sels = pushedSelectors(scanCode);
    const powers = Object.values(RISKY).filter((g) => g.selectors.some((s) => sels.has(s)));
    if (renounced) {
      add("ok", owner ? "Ownership renounced" : "No owner found", "Nobody holds special admin rights over this token.");
      if (powers.length) add("info", "Admin functions exist but are locked", "The code has admin functions, but with no owner nobody can call them.");
    } else {
      add("info", "Has an owner", `Owner wallet ${short(owner)} can call admin functions.`, 5);
      for (const g of powers) add(g.penalty >= 20 ? "bad" : "warn", `Owner ${g.label}`, "Found in the contract code. Check that the team is trustworthy before buying.", g.penalty);
      if (!powers.length) add("ok", "No risky admin functions found", "No mint, blacklist, tax or trading switch functions were found in the code.");
    }

    // --- holdings
    onStep("Checking who holds the supply…");
    const burned = ((await tryCall(() => erc.balanceOf(DEAD))) || 0n) + ((await tryCall(() => erc.balanceOf(ethers.ZeroAddress))) || 0n);
    info.burnedPct = supply > 0n ? Number((burned * 10000n) / supply) / 100 : 0;
    if (info.owner) {
      const ob = (await tryCall(() => erc.balanceOf(info.owner))) || 0n;
      const pct = supply > 0n ? Number((ob * 10000n) / supply) / 100 : 0;
      info.ownerPct = pct;
      if (pct > 20) add("bad", `Owner holds ${pct}% of the supply`, "One wallet could sell a large amount at once and crash the price.", 15);
      else if (pct > 5) add("warn", `Owner holds ${pct}% of the supply`, "A noticeable share sits with the owner.", 5);
    }
    if (info.burnedPct > 0) add("ok", `${info.burnedPct}% of supply burned`, "These tokens were sent to a dead address and can never be sold.");

    // --- liquidity: a Pons launch curve, Uniswap v3 and Uniswap v4
    let v3 = null, v4 = null, pons = null;
    const ethUsd = net.factory ? await ethPriceUsd(p, net) : null;
    const toUsd = (sym, raw) => {
      const q = Number(ethers.formatUnits(raw, sym === "USDG" ? 6 : 18));
      return sym === "USDG" ? q : ethUsd ? q * ethUsd : 0;
    };
    if (net.pons) {
      onStep("Checking the Pons launchpad…");
      pons = await tryCall(() => ponsLaunch(p, net, token));
    }
    const onCurve = !!(pons && pons.onCurve);
    if (onCurve) {
      // Still on its launch curve: there is no Uniswap pool yet, so the curve itself is the market.
      info.pons = { curve: pons.curve, progressPct: pons.progressPct, creatorTaxPct: pons.creatorTaxPct, feePct: pons.feePct };
      const raised = pons.native ? `${fmtAmt(pons.realQuote, 18)} ETH` : `${fmtAmt(pons.realQuote, pons.pairDecimals)} ${pons.pairSymbol}`;
      add("info", "On the Pons launch curve", `This token was launched on Pons and still trades on its own bonding curve (${pons.curve.slice(0, 6)}…${pons.curve.slice(-4)}). Buyers have put in ${raised} so far, ${pons.progressPct.toFixed(0)}% of the way to graduating into a Uniswap v4 pool.`);
      const usd = pons.native ? toUsd("ETH", pons.realQuote) : null;
      info.liquidityUsd = usd;
      info.pool = { venue: "Pons curve", address: pons.curve, pair: `${info.symbol}/${pons.native ? "ETH" : pons.pairSymbol}` };
      if (usd !== null) {
        const dollars = "$" + Math.round(usd).toLocaleString("en-US");
        if (usd < 1) add("warn", "Very early: almost nothing on the curve yet", "Hardly anyone has bought yet, so the price moves a lot with each trade and can fall fast if early buyers sell.", 10);
        else if (usd < 1000) add("warn", `Very early: about ${dollars} on the curve`, "Little money has gone in yet, so the price moves a lot with each trade and can fall fast if early buyers sell.", 10);
        else add("ok", `About ${dollars} on the curve`, "Money buyers have put into the launch curve so far.");
      }
      if (pons.creatorTaxPct > 0) add(pons.creatorTaxPct > 2 ? "warn" : "info", `Creator tax: ${pons.creatorTaxPct}% per trade`, `The creator set a ${pons.creatorTaxPct}% tax on every buy and sell on the curve, on top of the ${pons.feePct}% Pons fee. It cannot be raised later.`, pons.creatorTaxPct > 2 ? 5 : 0);
      if (pons.snipeTaxPct > 0) add("warn", `Launch snipe tax active: ${pons.snipeTaxPct}%`, "This token launched seconds ago. Pons charges a high tax on buys in the first seconds; it drops to zero almost immediately.", 5);
    } else if (pons && pons.exists) {
      add("info", "Graduated from Pons", "This token was launched on Pons, finished its launch curve and now trades in a locked Uniswap v4 pool.");
    }
    if (net.factory && !onCurve) {
      onStep("Finding Uniswap v3 liquidity…");
      const f = new ethers.Contract(net.factory, FACTORY, p);
      const quoteEntries = Object.entries(net.quotes).filter(([, a]) => a.toLowerCase() !== token.toLowerCase());
      const pools = [];
      await Promise.all(
        quoteEntries.flatMap(([qs, qa]) =>
          FEES.map(async (fee) => {
            const pool = await tryCall(() => f.getPool(token, qa, fee));
            if (!pool || pool === ethers.ZeroAddress) return;
            const [tb, qb] = await Promise.all([tryCall(() => erc.balanceOf(pool)), tryCall(() => new ethers.Contract(qa, ERC20, p).balanceOf(pool))]);
            pools.push({ pool, fee, quote: qs, quoteAddr: qa, tokenBal: tb || 0n, quoteBal: qb || 0n, quoteUsd: toUsd(qs, qb || 0n) });
          }),
        ),
      );
      pools.sort((a, b) => b.quoteUsd - a.quoteUsd);
      v3 = pools[0] || null;
    }
    // Skip the slower v4 search when the token already has deep v3 liquidity.
    if (net.v4 && !onCurve && !(v3 && v3.quoteUsd > 500000)) {
      onStep("Finding Uniswap v4 liquidity…");
      v4 = await tryCall(() => findV4Pool(p, net, token, toUsd));
    }
    const venue = !v3 && !v4 ? null : !v4 || (v3 && v3.quoteUsd >= v4.quoteUsd) ? "v3" : "v4";

    if (onCurve) {
      // reported above
    } else if (!venue) {
      if (net.factory) add("warn", "No Uniswap pool found", "No Uniswap v3 or v4 pool against ETH, WETH or USDG. It may be on a launchpad other than Pons, which NEARL cannot simulate yet. Make sure you can sell it before buying.", 20);
      else add("info", "Liquidity not checked", "DEX liquidity is only checked on Robinhood Chain mainnet.");
    } else {
      const usd = (venue === "v3" ? v3.quoteUsd : v4.quoteUsd) * 2;
      const where = venue === "v3"
        ? `${info.symbol}/${v3.quote} on Uniswap v3 (${v3.fee / 10000}% fee)`
        : `${info.symbol}/${v4.quote} on Uniswap v4${v4.hooks !== ethers.ZeroAddress ? " (with a hook)" : ""}`;
      info.liquidityUsd = usd;
      info.pool = venue === "v3"
        ? { venue: "Uniswap v3", address: v3.pool, pair: `${info.symbol}/${v3.quote}` }
        : { venue: "Uniswap v4", id: v4.id, hooks: v4.hooks, pair: `${info.symbol}/${v4.quote}` };
      if (venue === "v4" && v4.empty) add("bad", "Pool has no active liquidity", `The ${where.replace(/^.*? on /, "")} pool exists, but no liquidity is active at the current price (it was removed, or the price moved outside every position). Buying or selling may not be possible right now.`, 30);
      else if (usd < 1000) add("bad", `Very low liquidity (~$${Math.round(usd).toLocaleString("en-US")})`, `Largest pool: ${where}. Small trades will move the price a lot.`, 15);
      else if (usd < 25000) add("warn", `Low liquidity (~$${Math.round(usd).toLocaleString("en-US")})`, `Largest pool: ${where}. Larger trades will move the price noticeably.`, 5);
      else add("ok", `Liquidity ~$${Math.round(usd).toLocaleString("en-US")}`, `Largest pool: ${where}.${venue === "v4" ? " Measured near the current price." : ""}`);
      if (venue === "v4" && v4.hooks !== ethers.ZeroAddress) {
        add("info", "Pool runs a hook", `This Uniswap v4 pool runs extra code (${v4.hooks.slice(0, 6)}…${v4.hooks.slice(-4)}) on every trade. Launchpads such as Pons use hooks. NEARL simulated trades through it.`);
      }
    }

    // --- simulations
    onStep("Simulating a buy, a sell and a transfer…");
    const probe = window.NEARL_PROBE;
    const probeV4 = window.NEARL_PROBE_V4;
    const tester = ethers.getAddress("0x" + "4e45" + "41524c".padEnd(36, "0")); // "NEARL" test wallet, never real
    const other = ethers.getAddress("0x" + "4e45" + "41524d".padEnd(36, "0"));
    let amount = supply / 100000n || 1n; // 0.001% of supply
    if (venue === "v3" && v3.tokenBal > 0n) amount = v3.tokenBal / 1000n || 1n; // 0.1% of the pool
    if (venue === "v4" && v4.tokenVirtual > 0n) amount = v4.tokenVirtual / 1000n || 1n;
    const sim = { buy: null, sell: null, transfer: null, toPool: null };
    const lots = ethers.toBeHex(10n ** 24n);

    if (onCurve) {
      // A real buy on the curve and an immediate sell of everything bought, in one simulated call.
      const quoteIn = pons.native ? 10n ** 15n : 10n ** BigInt(Math.max(0, pons.pairDecimals - 3)); // 0.001 ETH or 0.001 of the pair token
      const fund = { [tester]: { code: window.NEARL_PROBE_PONS, balance: lots } };
      let canFund = pons.native;
      if (!canFund) {
        const qs = await findBalanceSlot(p, pons.pairToken, tester);
        if (qs) { fund[pons.pairToken] = { stateDiff: { [qs]: ethers.toBeHex(quoteIn * 10n, 32) } }; canFund = true; }
      }
      const r = canFund ? await tryCall(() => runPons(p, pons, token, quoteIn, tester, fund)) : null;
      if (r) {
        // The Pons token itself takes nothing; the Pons fee and creator tax come off the quote side.
        sim.buy = { ok: r.buyOk, received: r.tokensOut, expected: r.tokensOut };
        sim.sell = { ok: r.buyOk && r.sellOk, received: r.quoteBack, expected: r.quoteBack };
        if (r.buyOk && r.sellOk) info.roundTripLossPct = Math.max(0, 100 - Number((r.quoteBack * 10000n) / quoteIn) / 100);
        if (r.buyOk && r.tokensOut > 0n) amount = r.tokensOut; // use a realistic amount for the transfer test
      }
    }
    if (venue === "v3") {
      // Buy: tokens leave the pool. The pool's own code is swapped for the probe so it can send.
      const r = await tryCall(() => runProbe(p, v3.pool, token, tester, amount, { [v3.pool]: { code: probe } }));
      sim.buy = r && { ok: r.ok, received: r.received, expected: amount };
    }
    if (venue === "v4") {
      // Buy: a real v4 swap through the PoolManager, paid with simulated ETH or USDG.
      const quoteIn = v4.quoteVirtual / 1000n || 1n;
      const fund = { [tester]: { code: probeV4, balance: lots } };
      let canFund = v4.quoteAddr === ethers.ZeroAddress;
      if (!canFund) {
        const qs = await findBalanceSlot(p, v4.quoteAddr, tester);
        if (qs) { fund[v4.quoteAddr] = { stateDiff: { [qs]: ethers.toBeHex(quoteIn * 10n, 32) } }; canFund = true; }
      }
      if (canFund) sim.buy = await tryCall(() => runV4(p, net, "buy", v4, token, quoteIn, tester, fund));
    }

    const slot = await findBalanceSlot(p, token, tester);
    if (slot) {
      const tokenBal = { [token]: { stateDiff: { [slot]: ethers.toBeHex(amount * 10n, 32) } } };
      const give = { ...tokenBal, [tester]: { code: probe } };
      if (venue === "v3") {
        const r = await tryCall(() => runProbe(p, tester, token, v3.pool, amount, give));
        sim.sell = r && { ok: r.ok, received: r.received, expected: amount };
      }
      if (venue === "v4") {
        // Tax on tokens sent to the PoolManager, then a real v4 sell through the pool and its hook.
        const r = await tryCall(() => runProbe(p, tester, token, net.v4.poolManager, amount, give));
        sim.toPool = r && { ok: r.ok, received: r.received, expected: amount };
        sim.sell = await tryCall(() => runV4(p, net, "sell", v4, token, amount, tester, { ...tokenBal, [tester]: { code: probeV4, balance: lots } }));
      }
      const r = await tryCall(() => runProbe(p, tester, token, other, amount, give));
      sim.transfer = r && { ok: r.ok, received: r.received, expected: amount };
    }

    const tax = (r) => (r && r.ok && r.expected > 0n ? Math.max(0, Math.min(100, 100 - Number((r.received * 10000n) / r.expected) / 100)) : null);
    info.buyTax = tax(sim.buy);
    if (onCurve) info.buyTax = pons.creatorTaxPct; // on a curve the creator tax is the only tax beyond the Pons fee
    // For v4, the sell output is the quote coin, so the token tax is measured on the transfer into the pool.
    info.sellTax = venue === "v4" ? (sim.sell && sim.sell.ok ? tax(sim.toPool) : null) : tax(sim.sell);
    if (onCurve) info.sellTax = sim.sell && sim.sell.ok ? pons.creatorTaxPct : null;
    info.transferTax = tax(sim.transfer);
    const v4SellTax = venue === "v4" ? tax(sim.toPool) : null;

    const traded = venue || onCurve;
    if (onCurve && sim.sell && sim.sell.ok) add("ok", "Buy and sell on the curve work", `A simulated buy on the Pons curve and an immediate sell of everything bought went through. The round trip cost ${(info.roundTripLossPct || 0).toFixed(1)}% (the ${pons.feePct}% Pons fee and ${pons.creatorTaxPct}% creator tax each way).`);
    if (traded && sim.buy && !sim.buy.ok) add("bad", "Buying looks blocked", "A simulated buy from the pool failed.", 40);
    if (traded && sim.sell && !sim.sell.ok) {
      if (v4SellTax && v4SellTax > 0) {
        info.sellTax = v4SellTax;
        add("warn", "Sell could not be fully simulated", `The token takes about ${v4SellTax.toFixed(1)}% on transfers into the pool, which stopped the simulated v4 sell. Selling may still work through a router.`, 10);
      } else {
        add("bad", "Selling looks blocked (possible honeypot)", "A simulated sell into the pool failed. You may be able to buy but never sell.", 100);
      }
    }
    if (sim.transfer && !sim.transfer.ok) add("bad", "Transfers between wallets fail", "A simulated wallet-to-wallet transfer failed.", 40);
    // A curve's creator tax has its own finding above, so only taxes inside the token count here.
    const worstTax = onCurve ? info.transferTax || 0 : Math.max(info.buyTax || 0, info.sellTax || 0, info.transferTax || 0);
    if (worstTax > 10) add("bad", `High tax: ${worstTax.toFixed(1)}%`, "You lose this share of tokens on each trade.", 30);
    else if (worstTax > 2) add("warn", `Tax: ${worstTax.toFixed(1)}%`, "Part of each trade is taken as a fee.", 10);
    const worked = [["buy", sim.buy], ["sell", sim.sell], ["transfer", sim.transfer]].filter(([, r]) => r && r.ok).map(([k]) => k);
    if (worked.length && worstTax <= 2 && !onCurve) {
      const list = worked.length === 1 ? worked[0] : worked.slice(0, -1).join(", ") + " and " + worked[worked.length - 1];
      add("ok", `Simulated ${list} ${worked.length === 1 ? "works" : "work"}`, `The test went through${worstTax > 0 ? ` with a ${worstTax.toFixed(1)}% tax` : " with no tax"}.`);
    }
    let known = KNOWN[netKey] && KNOWN[netKey][token.toLowerCase()];
    if (known) add("info", `Well-known token: ${known.name}`, known.note);
    // NEARL's own token is disclosed, never favoured: no penalty change, same rules as every token.
    const nearlOwn = window.NearlToken && String(window.NearlToken.address || "").toLowerCase();
    if (netKey === "mainnet" && nearlOwn && nearlOwn === token.toLowerCase()) {
      info.nearlOwn = true;
      add("info", "This is NEARL's own token ($NEARL)", "NEARL made this token. It is scored by exactly the same rules as every other token, with no adjustment.");
    }

    // --- Robinhood stock tokens: the official ones are created only by Robinhood's StockFactory
    const stock = netKey === "mainnet" ? await tryCall(() => stockStatus(p, token, info, beaconAddr)) : null;
    if (stock && stock.official) {
      const company = stock.name.split(" • ")[0];
      info.stock = { official: true, symbol: stock.symbol, company, factory: window.NearlStockTokens.factory };
      add("ok", `Official Robinhood stock token: ${company} (${stock.symbol})`, `Created by Robinhood's StockFactory (${short(window.NearlStockTokens.factory)}). It follows the ${stock.symbol} share price; Robinhood describes stock tokens as not giving ownership of the share itself. Upgrades, minting and freezing are normal for the issuer.`);
      known = known || { name: stock.name };
    } else if (stock && stock.unconfirmed) {
      info.stock = { official: false, unconfirmed: true };
      add("warn", "Robinhood stock-token code, not confirmed official", "This token runs on the same code as Robinhood's stock tokens, but NEARL could not confirm that Robinhood's StockFactory created it.", 10);
    } else if (stock && stock.impersonates) {
      const t = stock.impersonates;
      info.stock = { official: false, impersonates: t.symbol, officialAddress: t.address };
      add("bad", `Not the official ${t.symbol} stock token`, `It uses the ${stock.by} of Robinhood's ${t.name.split(" • ")[0]} stock token, but it was not created by Robinhood. The official ${t.symbol} token is ${t.address}.`, 40);
    } else if (stock && stock.lookalike) {
      const t = stock.lookalike;
      info.stock = { official: false, lookalikeOf: t.symbol, officialAddress: t.address };
      add("warn", `Looks like the ${t.symbol} stock token, but is not`, `It has the same ticker as Robinhood's ${t.name.split(" • ")[0]} stock token and a similar name, but Robinhood did not create it. The official ${t.symbol} token is ${t.address}.`, 10);
    } else if (stock && stock.sameTicker) {
      const t = stock.sameTicker;
      info.stock = { official: false, sameTickerAs: t.symbol, officialAddress: t.address };
      add("info", `Same ticker as Robinhood's ${t.symbol} stock token`, `This is not the ${t.name.split(" • ")[0]} stock token. If that is what you wanted, the official one is ${t.address}.`);
    } else if (stock && stock.claimsRobinhood) {
      info.stock = { official: false, claimsRobinhood: true };
      add("bad", "Claims to be a Robinhood token, but is not", "Its name says Robinhood Token, but it was not created by Robinhood's StockFactory.", 40);
    }

    // --- holders, launch and creator history (check-holders.js), rebuilt from the chain
    if (window.NearlHolders && net.factory && !known && opts.holders !== false) {
      const h = await tryCall(() => window.NearlHolders.analyze(p, {
        token, decimals: dec, supply, owner: info.owner, onStep,
        pons: pons && pons.exists ? { curve: pons.curve, deployer: pons.deployer, creatorFeeRecipient: pons.creatorFeeRecipient, factory: net.pons.factory } : null,
        pools: [v3 && v3.pool].filter(Boolean),
        deadline: opts.holderDeadline || Date.now() + (opts.holderBudgetMs || 20000),
      }));
      if (h) { Object.assign(info, h.info); findings.push(...h.findings); }
    }
    if (!slot) add("info", "Sell test not possible", "This token stores balances in an unusual way, so the sell simulation was skipped.");

    // --- score
    let score = Math.max(0, 100 - findings.reduce((a, x) => a + x.penalty, 0));
    // Without a sell test we cannot rule out a honeypot, so never call it "Looks safe".
    if (!(sim.sell && sim.sell.ok) && !known) score = Math.min(score, 70);
    // A token posing as a Robinhood stock token is never "safe to buy", however clean its code is.
    if (info.stock && (info.stock.impersonates || info.stock.claimsRobinhood)) score = Math.min(score, 40);
    const verdict = score >= 80 ? { key: "safe", text: "Looks safe" } : score >= 55 ? { key: "careful", text: "Be careful" } : score >= 25 ? { key: "risky", text: "High risk" } : { key: "danger", text: "Do not buy" };
    const order = { bad: 0, warn: 1, info: 2, ok: 3 };
    findings.sort((a, b) => order[a.level] - order[b.level] || b.penalty - a.penalty);
    return { info, findings, score, verdict };
  }

  const fmtAmt = (v, dec) => Number(ethers.formatUnits(v, dec)).toLocaleString("en-US", { maximumFractionDigits: 4 });

  // Reads the token's Pons V2 launch record and, if it is still on its curve, the curve's state.
  async function ponsLaunch(p, net, token) {
    const f = new ethers.Contract(net.pons.factory, PONS_FACTORY, p);
    const lt = await f.getLaunchedToken(token);
    if (!lt.exists || lt.token.toLowerCase() !== token.toLowerCase()) return null;
    const c = new ethers.Contract(lt.curve, PONS_CURVE, p);
    const [graduated, ready] = await Promise.all([tryCall(() => c.graduated()), tryCall(() => c.readyToGraduate())]);
    const onCurve = Number(lt.phase) === 0 && graduated === false && ready === false;
    const out = { exists: true, onCurve, curve: lt.curve, pairToken: lt.pairToken, native: lt.pairToken === ethers.ZeroAddress, deployer: lt.deployer, creatorFeeRecipient: lt.creatorFeeRecipient };
    if (!onCurve) return out;
    const tester = ethers.getAddress("0x" + "4e45" + "41524c".padEnd(36, "0"));
    const [feeBps, taxBps, realQuote, threshold, snipe] = await Promise.all([
      c.feeBps(), c.creatorTaxBps(), c.realQuoteReserve(), c.graduationThreshold(), tryCall(() => c.currentSnipeTaxBps(tester)),
    ]);
    out.feePct = Number(feeBps) / 100;
    out.creatorTaxPct = Number(taxBps) / 100;
    out.snipeTaxPct = snipe ? Number(snipe) / 100 : 0;
    out.realQuote = realQuote;
    out.progressPct = threshold > 0n ? Math.min(100, Number((realQuote * 10000n) / threshold) / 100) : 0;
    out.pairDecimals = 18;
    out.pairSymbol = "ETH";
    if (!out.native) {
      const q = new ethers.Contract(lt.pairToken, ERC20, p);
      out.pairDecimals = Number((await tryCall(() => q.decimals())) ?? 18);
      out.pairSymbol = (await tryCall(() => q.symbol())) || "pair token";
    }
    return out;
  }

  async function runPons(p, pons, token, quoteIn, tester, override) {
    const iface = new ethers.Interface(PROBE_PONS);
    const data = iface.encodeFunctionData("roundTrip", [pons.curve, token, pons.pairToken, quoteIn]);
    const r = await p.send("eth_call", [{ to: tester, data, gas: "0x1C9C380" }, "latest", override]);
    const [buyOk, tokensOut, sellOk, quoteBack] = iface.decodeFunctionResult("roundTrip", r);
    return { buyOk, tokensOut, sellOk, quoteBack };
  }

  async function ethPriceUsd(p, net) {
    if (!net.factory || !net.quotes.WETH || !net.quotes.USDG) return null;
    const f = new ethers.Contract(net.factory, FACTORY, p);
    for (const fee of [500, 3000, 100, 10000]) {
      const pool = await tryCall(() => f.getPool(net.quotes.WETH, net.quotes.USDG, fee));
      if (!pool || pool === ethers.ZeroAddress) continue;
      const c = new ethers.Contract(pool, POOL, p);
      const [s0, t0] = await Promise.all([tryCall(() => c.slot0()), tryCall(() => c.token0())]);
      if (!s0 || !t0) continue;
      const sq = Number(s0[0]) / 2 ** 96;
      let price = sq * sq; // token1 per token0 in raw units
      const wethIs0 = t0.toLowerCase() === net.quotes.WETH.toLowerCase();
      // adjust decimals: WETH 18, USDG 6
      price = wethIs0 ? price * 1e12 : (1 / price) * 1e12;
      if (price > 10 && price < 1e6) return price;
    }
    return null;
  }

  window.NearlCheck = { NET, check, stockStatus };
})();
