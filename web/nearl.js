/* Shared read-only chain helpers for the landing, Stats and Earn pages (window.Nearl). */
(function () {
  "use strict";
  const { ethers } = window;

  const NETWORKS = {
    testnet: { chainId: 46630, name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com" },
    mainnet: { chainId: 4663, name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" },
  };

  const NOTES_ABI = [
    "function seriesCount() view returns (uint256)",
    "function owner() view returns (address)",
    "function getSeries(uint256) view returns (tuple(address feed,uint16 barrierBps,uint16 autocallBps,uint16 couponBps,uint32 maxPriceAge,uint64 subscriptionEnd,uint8 nextObservation,uint8 couponsPaid,uint8 status,bool issuerSettled,int256 initialPrice,uint256 perUserCap,uint256 totalCap,uint256 totalDeposits,uint256 couponReserve,uint256 payoutRatio,uint64[] observationTimes))",
    "event Deposited(uint256 indexed id, address indexed user, uint256 amount)",
    "event Claimed(uint256 indexed id, address indexed user, uint256 coupons, uint256 principal)",
    "event SeriesCreated(uint256 indexed id, address indexed feed, uint256 couponReserve)",
    "event Started(uint256 indexed id, int256 initialPrice)",
    "event Observed(uint256 indexed id, uint8 indexed index, int256 price, bool couponPaid, uint8 status)",
    "event EmergencyTriggered(uint256 indexed id)",
  ];
  const FEED_ABI = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];

  const STATUS = ["Open to join", "Running", "Early win", "Ended", "Emergency exit"];

  const providers = {};
  function provider(net) {
    if (!providers[net]) providers[net] = window.NearlRPC.provider(NETWORKS[net].chainId);
    return providers[net];
  }

  async function deployment(net) {
    try {
      const r = await fetch(`deployments/${net}.json`, { cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch (_) {
      return null;
    }
  }

  // All pools with their feed price, newest first.
  async function pools(net) {
    const dep = await deployment(net);
    if (!dep) return { dep: null, pools: [] };
    const p = provider(net);
    const notes = new ethers.Contract(dep.notes, NOTES_ABI, p);
    const n = Number(await notes.seriesCount());
    const list = await Promise.all(Array.from({ length: n }, (_, i) => notes.getSeries(i)));
    const feeds = {};
    await Promise.all(
      [...new Set(list.map((s) => s.feed))].map(async (f) => {
        try {
          const c = new ethers.Contract(f, FEED_ABI, p);
          const [r, d] = await Promise.all([c.latestRoundData(), c.decimals()]);
          feeds[f] = { price: r[1], dec: Number(d) };
        } catch (_) {
          feeds[f] = null;
        }
      }),
    );
    const out = list.map((s, id) => {
      const feed = feeds[s.feed];
      const dec = feed ? feed.dec : 8;
      const toNum = (v) => Number(ethers.formatUnits(v, dec));
      const start = s.initialPrice > 0n ? toNum(s.initialPrice) : null;
      const obs = s.observationTimes.map(Number);
      const st = Number(s.status);
      const next = st === 0 ? Number(s.subscriptionEnd) : st === 1 ? obs[Number(s.nextObservation)] : null;
      const intervalSec = obs.length > 1 ? obs[1] - obs[0] : obs[0] - Number(s.subscriptionEnd);
      const joinable = st === 0 && Date.now() / 1000 < Number(s.subscriptionEnd);
      return {
        id,
        label: (dep.feeds && dep.feeds[s.feed]) || "Pool",
        status: st,
        joinable,
        statusText: st === 0 && !joinable ? "Starting soon" : STATUS[st],
        rewardPct: Number(s.couponBps) / 100,
        safetyPct: Number(s.barrierBps) / 100,
        earlyWinPct: Number(s.autocallBps) / 100,
        startPrice: start,
        price: feed ? toNum(feed.price) : null,
        safetyPrice: start ? (start * Number(s.barrierBps)) / 10000 : null,
        earlyWinPrice: start ? (start * Number(s.autocallBps)) / 10000 : null,
        checks: obs.length,
        rewardsPaid: Number(s.couponsPaid),
        intervalSec,
        joinCloses: Number(s.subscriptionEnd),
        nextEvent: next,
        filled: Number(ethers.formatUnits(s.totalDeposits, dep.assetDecimals)),
        cap: Number(ethers.formatUnits(s.totalCap, dep.assetDecimals)),
        perUser: Number(ethers.formatUnits(s.perUserCap, dep.assetDecimals)),
        reserve: Number(ethers.formatUnits(s.couponReserve, dep.assetDecimals)),
        symbol: dep.assetSymbol,
      };
    });
    return { dep, pools: out.reverse() };
  }

  // Reads logs from startBlock to now in chunks (public RPCs limit the range per call).
  async function logs(net, filter, fromBlock) {
    const p = provider(net);
    const latest = await p.getBlockNumber();
    return window.NearlRPC.getLogsAdaptive(p, filter, fromBlock, latest, 400);
  }

  // Most recent NEARL contract events, newest first, with block times.
  async function ledger(net = "testnet", limit = 10) {
    const dep = await deployment(net);
    if (!dep || dep.startBlock == null) return [];
    const p = provider(net);
    const iface = new ethers.Interface(NOTES_ABI);
    const raw = await logs(net, { address: dep.notes }, dep.startBlock);
    const items = [];
    for (const l of raw) {
      let ev;
      try { ev = iface.parseLog(l); } catch (_) { continue; }
      if (!ev) continue;
      const amt = (v) => Number(ethers.formatUnits(v, dep.assetDecimals));
      const id = ev.args.id !== undefined ? Number(ev.args.id) : null;
      let text;
      switch (ev.name) {
        case "SeriesCreated": text = `Pool #${id} opened · ${money(amt(ev.args.couponReserve), 0)} ${dep.assetSymbol} rewards locked`; break;
        case "Deposited": text = `${short(ev.args.user)} joined pool #${id} · ${money(amt(ev.args.amount))} ${dep.assetSymbol}`; break;
        case "Claimed": text = `${short(ev.args.user)} claimed ${money(amt(ev.args.coupons + ev.args.principal))} ${dep.assetSymbol} from pool #${id}`; break;
        case "Started": text = `Pool #${id} started · price recorded`; break;
        case "Observed":
          text = ev.args.price === 0n
            ? `Pool #${id} closed · nobody joined, rewards returned`
            : `Pool #${id} check ${Number(ev.args.index) + 1} · ${ev.args.couponPaid ? "reward paid" : "no reward"}`;
          break;
        case "EmergencyTriggered": text = `Pool #${id} emergency exit`; break;
        default: continue;
      }
      items.push({ block: l.blockNumber, tx: l.transactionHash, kind: ev.name, text });
    }
    items.sort((a, b) => b.block - a.block);
    const top = items.slice(0, limit);
    const times = {};
    await Promise.all([...new Set(top.map((x) => x.block))].map(async (b) => {
      try { times[b] = (await p.getBlock(b)).timestamp; } catch (_) {}
    }));
    return top.map((x) => ({ ...x, time: times[x.block] || null, url: `${NETWORKS[net].explorer}/tx/${x.tx}` }));
  }
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

  // "in 2 d 4 h", "in 35 min", "3 h ago"
  function countdown(ts) {
    const s = ts - Date.now() / 1000;
    const a = Math.abs(s);
    const d = Math.floor(a / 86400), h = Math.floor((a % 86400) / 3600), m = Math.max(1, Math.floor((a % 3600) / 60));
    const t = d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
    return s >= 0 ? `in ${t}` : `${t} ago`;
  }
  function every(sec) {
    if (sec >= 6 * 86400 && sec <= 8 * 86400) return "week";
    if (sec >= 86400 * 0.9 && sec <= 86400 * 1.1) return "day";
    if (sec >= 28 * 86400 && sec <= 31 * 86400) return "month";
    return `${Math.round(sec / 86400)} days`;
  }
  const money = (n, dp = 2) => n.toLocaleString("en-US", { maximumFractionDigits: dp });

  window.Nearl = { NETWORKS, provider, deployment, pools, ledger, countdown, every, money };
})();
