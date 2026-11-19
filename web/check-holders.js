/* NEARL Check, part 2: who holds the token and how it launched (window.NearlHolders).
 * Everything is rebuilt from the chain itself, with no indexer:
 *   1. Creation block: binary search on eth_getCode at past blocks (needs archive state).
 *   2. Holders: every Transfer since creation, summed into balances; the top wallets are then
 *      re-read with balanceOf so the numbers are exact. Skipped if the history could not be read
 *      completely, because a partial history gives wrong balances.
 *   3. Launch: wallets that bought in the first 10 seconds (snipers), and for Pons tokens the
 *      bundle wallets the creator declared at launch (they are exempted from the snipe tax).
 *   4. Creator history (Pons): other tokens the same wallet launched, and how they ended.
 * A deadline keeps it from slowing the whole check: parts that run out of time are reported as
 * not checked instead of guessed.
 */
(function (root) {
  "use strict";
  const { ethers } = root;
  const TRANSFER = ethers.id("Transfer(address,address,uint256)");
  const SNIPE_EXEMPT = ethers.id("SnipeTaxExempted(address)");
  const TOKEN_LAUNCHED = ethers.id("TokenLaunched(address,address,address,address,uint256,uint256)");
  const DEAD = "0x000000000000000000000000000000000000dead";
  const ZERO = ethers.ZeroAddress.toLowerCase();
  const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const EARLY_SECONDS = 10;
  const ERC20 = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
  const FACTORY = new ethers.Interface([
    "function getLaunchedToken(address token) view returns ((address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))",
  ]);
  const CURVE = new ethers.Interface(["function realQuoteReserve() view returns (uint256)"]);

  const lc = (a) => String(a).toLowerCase();
  const topicAddr = (t) => ethers.getAddress("0x" + t.slice(26));
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const pctOf = (v, total) => (total > 0n ? Number((v * 1000000n) / total) / 10000 : 0);
  const fmtPct = (x) => (x >= 10 ? x.toFixed(0) : x >= 1 ? x.toFixed(1) : x.toFixed(2)) + "%";

  async function tryCall(fn) { try { return await fn(); } catch (_) { return null; } }

  // First block at which `addr` has code. Four probes per round, so about 12 rounds for 100M blocks.
  async function creationBlock(p, addr, latest, lowHint = 0) {
    let lo = Math.max(0, lowHint), hi = latest;
    while (hi - lo > 1) {
      const pts = [1, 2, 3, 4].map((k) => lo + Math.floor(((hi - lo) * k) / 5)).filter((x, i, a) => x > lo && x < hi && a.indexOf(x) === i);
      if (!pts.length) break;
      const codes = await Promise.all(pts.map((b) => p.getCode(addr, b)));
      let newLo = lo, newHi = hi;
      for (let i = 0; i < pts.length; i++) {
        if (codes[i] === "0x") newLo = pts[i];
        else { newHi = pts[i]; break; }
      }
      lo = newLo; hi = newHi;
    }
    return hi;
  }

  /**
   * @param ctx { token, decimals, supply: bigint, owner, pons: { curve, deployer, creatorFeeRecipient, factory } | null,
   *              pools: [address], onStep, deadline: ms timestamp }
   * @returns { info, findings }
   */
  async function analyze(p, ctx) {
    const findings = [];
    const add = (level, title, detail, penalty = 0) => findings.push({ level, title, detail, penalty });
    const info = { holders: null, launch: null, creator: null };
    const timeLeft = () => ctx.deadline - Date.now();
    const step = ctx.onStep || (() => {});
    const supply = ctx.supply;
    const token = ethers.getAddress(ctx.token);

    // Contracts that hold tokens on behalf of everyone are not "holders".
    const labels = new Map();
    const infra = new Set([ZERO, DEAD, POOL_MANAGER]);
    labels.set(ZERO, "Burned"); labels.set(DEAD, "Burned"); labels.set(POOL_MANAGER, "Uniswap v4 pools");
    for (const a of ctx.pools || []) if (a) { infra.add(lc(a)); labels.set(lc(a), "Uniswap v3 pool"); }
    if (ctx.pons) { infra.add(lc(ctx.pons.curve)); labels.set(lc(ctx.pons.curve), "Pons curve (unsold)"); }
    const creator = ctx.pons ? lc(ctx.pons.deployer) : null;
    if (creator) labels.set(creator, "Creator");
    if (ctx.pons && ctx.pons.creatorFeeRecipient && lc(ctx.pons.creatorFeeRecipient) !== creator) labels.set(lc(ctx.pons.creatorFeeRecipient), "Creator fee wallet");
    if (ctx.owner && !labels.has(lc(ctx.owner))) labels.set(lc(ctx.owner), "Owner");

    step("Finding when the token was created…");
    const latest = await p.getBlockNumber();
    const created = await tryCall(() => creationBlock(p, token, latest, ctx.lowHint || 0));
    if (!created) {
      add("info", "Holders not checked", "NEARL could not read the token's history from the RPC.");
      return { info, findings };
    }
    const [bCreated, bLatest] = await Promise.all([tryCall(() => p.getBlock(created)), tryCall(() => p.getBlock(latest))]);
    const blocksPerSec = bCreated && bLatest && bLatest.timestamp > bCreated.timestamp ? (latest - created) / (bLatest.timestamp - bCreated.timestamp) : 4;
    const ageSec = bCreated && bLatest ? bLatest.timestamp - bCreated.timestamp : null;
    info.launch = { createdBlock: created, ageHours: ageSec !== null ? Math.round((ageSec / 3600) * 10) / 10 : null };

    // ---- holders
    step("Reading every transfer since launch…");
    const maxReq = 60;
    const span = root.NearlRPC.maxSpan(p); // 0 when the RPC has not refused a range yet
    const fits = !span || (latest - created) / span <= maxReq;
    const logs = fits && timeLeft() > 3000
      ? await root.NearlRPC.getLogsAdaptive(p, { address: token, topics: [TRANSFER] }, created, latest, maxReq, ctx.deadline)
      : Object.assign([], { complete: false });
    let holdersOk = false;
    const bal = new Map();
    if (logs.complete) {
      for (const l of logs) {
        const from = lc(topicAddr(l.topics[1])), to = lc(topicAddr(l.topics[2])), v = BigInt(l.data);
        bal.set(from, (bal.get(from) || 0n) - v);
        bal.set(to, (bal.get(to) || 0n) + v);
      }
      holdersOk = true;
    }

    if (holdersOk) {
      step("Checking the largest holders…");
      const ranked = Array.from(bal).filter(([a, v]) => v > 0n && a !== ZERO).sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
      // Re-read the biggest wallets directly, so the shown balances are exact.
      const top = ranked.slice(0, 20);
      const exact = await Promise.all(top.map(([a]) => tryCall(() => p.call({ to: token, data: ERC20.encodeFunctionData("balanceOf", [a]) }))));
      top.forEach((t, i) => { if (exact[i]) t[1] = BigInt(exact[i]); });
      top.sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
      const people = ranked.filter(([a]) => !infra.has(a));
      const topPeople = top.filter(([a, v]) => !infra.has(a) && v > 0n);
      const top10 = topPeople.slice(0, 10).reduce((s, [, v]) => s + v, 0n);
      const top10Pct = pctOf(top10, supply);
      info.holders = {
        count: people.length,
        top10Pct,
        top: top.filter(([, v]) => pctOf(v, supply) >= 0.001).slice(0, 10).map(([a, v]) => ({ address: ethers.getAddress(a), pct: pctOf(v, supply), label: labels.get(a) || null })),
      };
      const biggest = topPeople[0];
      if (biggest) {
        const p1 = pctOf(biggest[1], supply), who = labels.get(biggest[0]) || short(ethers.getAddress(biggest[0]));
        if (p1 > 20) add("bad", `One wallet holds ${fmtPct(p1)} of the supply`, `${who} could sell enough at once to crash the price.`, 15);
        else if (p1 > 10) add("warn", `Largest holder has ${fmtPct(p1)}`, `${who} holds a large share. Watch it before buying big.`, 5);
      }
      if (top10Pct > 70) add("bad", `Top 10 wallets hold ${fmtPct(top10Pct)}`, "Supply is concentrated in very few hands.", 12);
      else if (top10Pct > 50) add("warn", `Top 10 wallets hold ${fmtPct(top10Pct)}`, "A small group controls most of what is in circulation.", 6);
      else if (people.length >= 10) add("ok", `Holders look spread out`, `${people.length.toLocaleString("en-US")} wallets hold it; the top 10 have ${fmtPct(top10Pct)} of the supply.`);
      if (creator) {
        const cb = bal.get(creator) || 0n, cp = pctOf(cb > 0n ? cb : 0n, supply);
        if (cp > 5) add("warn", `Creator still holds ${fmtPct(cp)}`, "The wallet that launched the token can still sell this amount.", 5);
        else add("ok", cp > 0 ? `Creator holds ${fmtPct(cp)}` : "Creator holds none", "The wallet that launched the token holds little or nothing of it.");
      }
    } else {
      add("info", "Holders not checked", "This token has too much history to rebuild every balance in a few seconds, so the holder breakdown was skipped.");
    }

    // ---- launch: snipers and bundle wallets
    if (holdersOk && logs.length) {
      step("Looking at the first seconds of trading…");
      const sources = new Set([...(ctx.pons ? [lc(ctx.pons.curve)] : []), ...((ctx.pools || []).map(lc)), POOL_MANAGER]);
      const buys = logs.filter((l) => sources.has(lc(topicAddr(l.topics[1]))));
      if (buys.length) {
        const first = buys[0].blockNumber, windowEnd = first + Math.ceil(EARLY_SECONDS * blocksPerSec);
        // Follow the tokens bought in the window: through routers that forward them, between wallets,
        // and back into the pool. Tokens are conserved, so the total can never exceed what was bought.
        const early = new Map();
        for (const l of logs) {
          if (l.blockNumber < first) continue;
          if (l.blockNumber > windowEnd) break;
          const from = lc(topicAddr(l.topics[1])), to = lc(topicAddr(l.topics[2])), v = BigInt(l.data);
          if (sources.has(from)) { if (!infra.has(to)) early.set(to, (early.get(to) || 0n) + v); continue; }
          if (!early.has(from)) continue;
          early.set(from, early.get(from) - v);
          if (!infra.has(to) && !sources.has(to)) early.set(to, (early.get(to) || 0n) + v);
        }
        // The very first block of trading, where bundled buys land.
        const firstBlock = new Map();
        for (const l of buys) {
          if (l.blockNumber > first + 1) break;
          const to = lc(topicAddr(l.topics[2]));
          if (!infra.has(to) && to !== creator) firstBlock.set(to, (firstBlock.get(to) || 0n) + BigInt(l.data));
        }
        for (const [a, v] of early) if (v <= 0n) early.delete(a); // flipped within seconds: not holding
        const others = Array.from(early.keys()).filter((a) => a !== creator);
        const boughtPct = Math.min(100, pctOf(Array.from(early.values()).reduce((s, v) => s + v, 0n), supply));
        const stillPct = pctOf(Array.from(early.keys()).reduce((s, a) => s + ((bal.get(a) || 0n) > 0n ? bal.get(a) : 0n), 0n), supply);
        const fbPct = pctOf(Array.from(firstBlock.values()).reduce((s, v) => s + v, 0n), supply);
        if (firstBlock.size >= 3 && fbPct >= 10) {
          const fbStill = pctOf(Array.from(firstBlock.keys()).reduce((s, a) => s + ((bal.get(a) || 0n) > 0n ? bal.get(a) : 0n), 0n), supply);
          info.launch.firstBlockBuyers = firstBlock.size;
          info.launch.firstBlockPct = fbPct;
          add(fbStill >= 5 ? "warn" : "info", `Bundled start: ${firstBlock.size} wallets bought ${fmtPct(fbPct)} in the first block`, `Right as trading opened, ${firstBlock.size} wallets bought ${fmtPct(fbPct)} of the supply in the same moment, a pattern typical of one person using several wallets. They hold ${fmtPct(fbStill)} now.`, fbStill >= 5 ? (fbStill > 15 ? 10 : 6) : 0);
        }
        info.launch.earlyBuyers = early.size;
        info.launch.earlyBoughtPct = boughtPct;
        info.launch.earlyStillPct = stillPct;
        if (others.length >= 3 && boughtPct >= 10 && stillPct >= 5) {
          const bad = stillPct > 20;
          add(bad ? "bad" : "warn", `Sniped at launch: ${early.size} wallets took ${fmtPct(boughtPct)}`, `In the first ${EARLY_SECONDS} seconds of trading, ${early.size} wallets picked up ${fmtPct(boughtPct)} of the supply. Together they still hold ${fmtPct(stillPct)} and could sell it on later buyers.`, bad ? 12 : 6);
        } else if (others.length >= 3 && boughtPct >= 10) {
          add("info", "Launch snipers have sold", `${early.size} wallets picked up ${fmtPct(boughtPct)} in the first ${EARLY_SECONDS} seconds, but they now hold only ${fmtPct(stillPct)}.`);
        } else if (early.size) {
          add("ok", "No heavy sniping at launch", `${early.size} wallet${early.size === 1 ? "" : "s"} bought in the first ${EARLY_SECONDS} seconds, ${fmtPct(boughtPct)} of the supply in total.`);
        }
      }
      if (ctx.pons && timeLeft() > 1500) {
        // Wallets the creator exempted from the snipe tax at launch: the creator, the fee wallet, and bundle wallets.
        const ex = await tryCall(() => root.NearlRPC.getLogsAdaptive(p, { address: ctx.pons.curve, topics: [SNIPE_EXEMPT] }, created, Math.min(latest, created + 2000), 4));
        if (ex) {
          const own = new Set([creator, lc(ctx.pons.creatorFeeRecipient || ZERO)]);
          const bundle = Array.from(new Set(ex.map((l) => lc(topicAddr(l.topics[1]))))).filter((a) => !own.has(a));
          info.launch.bundleWallets = bundle.length;
          if (bundle.length) {
            const holdPct = pctOf(bundle.reduce((s, a) => s + ((bal.get(a) || 0n) > 0n ? bal.get(a) : 0n), 0n), supply);
            info.launch.bundleStillPct = holdPct;
            add(holdPct > 5 ? "warn" : "info", `Creator set up ${bundle.length} bundle wallet${bundle.length === 1 ? "" : "s"}`, `At launch the creator named ${bundle.length} extra wallet${bundle.length === 1 ? "" : "s"} that could buy without the snipe tax. They hold ${fmtPct(holdPct)} now.`, holdPct > 5 ? 8 : 0);
          }
        }
      }
    }

    // ---- creator history on Pons
    if (ctx.pons && ctx.pons.factory && timeLeft() > 3000) {
      step("Checking what else the creator launched…");
      const week = Math.ceil(7 * 86400 * blocksPerSec);
      const span2 = root.NearlRPC.maxSpan(p);
      const reach = span2 ? Math.min(week, span2 * 24) : week; // small-range backup RPCs only look back as far as 24 requests reach
      const from = Math.max(latest - reach, 0);
      const launches = await tryCall(() => root.NearlRPC.getLogsAdaptive(p, { address: ctx.pons.factory, topics: [TOKEN_LAUNCHED, null, null, ethers.zeroPadValue(ctx.pons.deployer, 32)] }, from, latest, 24, ctx.deadline));
      if (launches) {
        const other = launches.map((l) => topicAddr(l.topics[1])).filter((t) => lc(t) !== lc(token));
        const recent = other.slice(-15);
        const fac = new ethers.Contract(ctx.pons.factory, FACTORY, p);
        let graduated = 0, died = 0;
        await Promise.all(recent.map(async (t, i) => {
          const lt = await tryCall(() => fac.getLaunchedToken(t));
          if (!lt) return;
          if (Number(lt.phase) !== 0) { graduated++; return; }
          const rq = await tryCall(() => p.call({ to: lt.curve, data: CURVE.encodeFunctionData("realQuoteReserve") }));
          const launchedLog = launches.find((l) => lc(topicAddr(l.topics[1])) === lc(t));
          const oldEnough = launchedLog && latest - launchedLog.blockNumber > 6 * 3600 * blocksPerSec;
          if (rq && oldEnough && BigInt(rq) < 10n ** 16n) died++; // under 0.01 ETH after 6 hours
        }));
        const hours = launches.complete ? Math.max(1, Math.round(reach / blocksPerSec / 3600)) : null;
        info.creator = { address: ctx.pons.deployer, otherLaunches: other.length, checked: recent.length, graduated, died, windowHours: hours };
        const where = !hours ? "recently" : hours >= 160 ? "in the last week" : hours >= 48 ? `in the last ${Math.round(hours / 24)} days` : `in the last ${hours} hours`;
        if (other.length >= 10 && graduated === 0) {
          add("bad", `Serial launcher: ${other.length} other tokens ${where}`, `The creator ${short(ctx.pons.deployer)} launched ${other.length} other tokens ${where}${recent.length ? `; of the last ${recent.length}, none graduated and ${died} died with almost no money in them` : ""}. Tokens from wallets like this are often abandoned quickly.`, 15);
        } else if (other.length >= 3) {
          add("warn", `Creator launched ${other.length} other tokens ${where}`, `Of the last ${recent.length}: ${graduated} graduated to Uniswap, ${died} died with almost no money in them.`, 5);
        } else if (other.length > 0) {
          add("info", `Creator launched ${other.length} other token${other.length === 1 ? "" : "s"} ${where}`, `${graduated} graduated to Uniswap.`);
        } else if (launches.complete) {
          add("ok", "No other launches from this creator", `The wallet ${short(ctx.pons.deployer)} has not launched other tokens on Pons ${where}.`);
        }
      }
    }
    return { info, findings };
  }

  root.NearlHolders = { analyze, creationBlock };
})(typeof window !== "undefined" ? window : globalThis);
