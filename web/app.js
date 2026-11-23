/* NEARL web app: reads note series from the chain and sends wallet transactions. */
(function () {
  "use strict";
  const { ethers } = window;

  const NETWORKS = {
    testnet: {
      key: "testnet",
      chainId: 46630,
      chainName: "Robinhood Chain Testnet",
      rpc: "https://rpc.testnet.chain.robinhood.com",
      explorer: "https://explorer.testnet.chain.robinhood.com",
    },
    mainnet: {
      key: "mainnet",
      chainId: 4663,
      chainName: "Robinhood Chain",
      rpc: "https://rpc.mainnet.chain.robinhood.com",
      explorer: "https://robinhoodchain.blockscout.com",
    },
  };

  const NOTES_ABI = [
    "function seriesCount() view returns (uint256)",
    "function owner() view returns (address)",
    "function paused() view returns (bool)",
    "function EMERGENCY_DELAY() view returns (uint256)",
    "function getSeries(uint256) view returns (tuple(address feed,uint16 barrierBps,uint16 autocallBps,uint16 couponBps,uint32 maxPriceAge,uint64 subscriptionEnd,uint8 nextObservation,uint8 couponsPaid,uint8 status,bool issuerSettled,int256 initialPrice,uint256 perUserCap,uint256 totalCap,uint256 totalDeposits,uint256 couponReserve,uint256 payoutRatio,uint64[] observationTimes))",
    "function getPosition(uint256,address) view returns (tuple(uint256 deposit,uint8 couponsClaimed,bool principalClaimed))",
    "function claimable(uint256,address) view returns (uint256 coupons,uint256 principal)",
    "function deposit(uint256 id,uint256 amount)",
    "function claim(uint256 id)",
    "function start(uint256 id)",
    "function observe(uint256 id)",
    "function triggerEmergency(uint256 id)",
    "function settleIssuer(uint256 id)",
    "function pause()",
    "function unpause()",
    "error InvalidParams()", "error WrongStatus()", "error TooEarly()", "error TooLate()", "error CapExceeded()",
    "error ZeroAmount()", "error BadPrice()", "error StalePrice()", "error NothingToClaim()", "error UnknownSeries()",
    "error EnforcedPause()",
  ];
  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function faucet()",
    "function lastFaucet(address) view returns (uint256)",
    "error FaucetCooldown()",
    "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  ];
  const FEED_ABI = [
    "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    "function decimals() view returns (uint8)",
    "function owner() view returns (address)",
    "function setPrice(int256)",
  ];

  const STATUS = ["Open to join", "Running", "Early win", "Ended", "Emergency exit"];
  const ERRORS = {
    CapExceeded: "This deposit would go over the per-wallet or total limit of the pool.",
    TooLate: "Joining has closed for this pool.",
    TooEarly: "This action is not due yet.",
    WrongStatus: "The pool is not in the right state for this action. Refresh and try again.",
    ZeroAmount: "Enter an amount greater than zero.",
    StalePrice: "The price feed has not updated since the due date. Try again after the next price update.",
    BadPrice: "The price feed returned an invalid price.",
    NothingToClaim: "There is nothing to claim yet.",
    EnforcedPause: "Joining is paused by the pool creator.",
    FaucetCooldown: "The faucet can be used once per hour per wallet.",
    ERC20InsufficientBalance: "Not enough test USD in this wallet. Use the Get 10,000 test USD button first.",
  };

  const $ = (id) => document.getElementById(id);
  const state = {
    net: "testnet",
    dep: null,
    read: null,
    browser: null,
    signer: null,
    account: null,
    owner: null,
    busy: false,
  };
  try { state.net = localStorage.getItem("nearl.net") === "mainnet" ? "mainnet" : "testnet"; } catch (_) {}

  // ---------------------------------------------------------------- helpers
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const pct = (bps) => (Number(bps) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";
  const fmtAmt = (v, dec = state.dep.assetDecimals) =>
    Number(ethers.formatUnits(v, dec)).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtPrice = (v, dec) => Number(ethers.formatUnits(v, dec)).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtDate = (ts) =>
    new Date(Number(ts) * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  function rel(ts) {
    const s = Number(ts) - Date.now() / 1000;
    const a = Math.abs(s);
    const t = a < 3600 ? Math.round(a / 60) + " min" : a < 172800 ? Math.round(a / 3600) + " h" : Math.round(a / 86400) + " days";
    return s >= 0 ? "in " + t : t + " ago";
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let toastTimer;
  function toast(html, ms = 6000) {
    const t = $("toast");
    t.innerHTML = html;
    t.hidden = false;
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  function errorText(e) {
    const iface = new ethers.Interface([...NOTES_ABI, ...ERC20_ABI]);
    const data = e?.data || e?.info?.error?.data || e?.error?.data;
    if (e?.revert?.name && ERRORS[e.revert.name]) return ERRORS[e.revert.name];
    if (typeof data === "string") {
      try {
        const parsed = iface.parseError(data);
        if (parsed && ERRORS[parsed.name]) return ERRORS[parsed.name];
      } catch (_) {}
    }
    if (e?.code === "ACTION_REJECTED") return "You rejected the request in your wallet.";
    if (e?.code === "INSUFFICIENT_FUNDS") return "Your wallet does not have enough ETH to pay the network fee.";
    return e?.shortMessage || e?.reason || e?.message || "The transaction failed.";
  }

  async function send(label, fn) {
    if (state.busy) return;
    state.busy = true;
    try {
      await ensureChain();
      toast(`${esc(label)}: confirm in your wallet…`, 0);
      const tx = await fn();
      const link = `${NETWORKS[state.net].explorer}/tx/${tx.hash}`;
      toast(`${esc(label)}: waiting for confirmation… <a href="${link}" target="_blank" rel="noopener">View</a>`, 0);
      await tx.wait();
      toast(`${esc(label)}: done. <a href="${link}" target="_blank" rel="noopener">View transaction</a>`);
      state.busy = false;
      await refresh();
      return true;
    } catch (e) {
      console.error(e);
      toast(`${esc(label)} failed. ${esc(errorText(e))}`, 9000);
      return false;
    } finally {
      state.busy = false;
    }
  }

  // ---------------------------------------------------------------- wallet
  // Wallet selection lives in wallet.js (window.NearlWallet). This keeps app state in sync with it.
  async function syncWallet() {
    const W = window.NearlWallet;
    if (W.provider && W.account) {
      state.browser = new ethers.BrowserProvider(W.provider);
      state.account = W.account;
      try { state.signer = await state.browser.getSigner(); } catch (_) { state.signer = null; }
    } else {
      state.browser = null;
      state.signer = null;
      state.account = null;
    }
    renderAccount();
  }

  async function connect() {
    try {
      const acct = await window.NearlWallet.open();
      if (!acct) return;
      await syncWallet();
      await ensureChain();
      await refresh();
    } catch (e) {
      toast(esc(errorText(e)), 8000);
    }
  }

  async function ensureChain() {
    const p = window.NearlWallet.provider;
    if (!p) throw new Error("Connect a wallet first.");
    const n = NETWORKS[state.net];
    const hex = "0x" + n.chainId.toString(16);
    const current = await p.request({ method: "eth_chainId" });
    if (String(current).toLowerCase() !== hex) {
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      } catch (e) {
        const code = e?.code ?? e?.data?.originalError?.code;
        if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e?.message || "")) throw e;
        await p.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hex, chainName: n.chainName, rpcUrls: window.NearlRPC.LISTS[n.chainId], blockExplorerUrls: [n.explorer], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
        });
      }
    }
    state.browser = new ethers.BrowserProvider(p);
    state.signer = await state.browser.getSigner();
  }

  function renderAccount() {
    const a = $("acct");
    if (state.account) {
      const name = window.NearlWallet.info?.name;
      a.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="lbl">Connected</span><span>${esc(short(state.account))}</span>`;
      a.title = name ? `Connected with ${name}: ${state.account}` : `Connected: ${state.account}`;
      a.hidden = false;
      $("disconnect").hidden = false;
      $("connect").hidden = true;
    } else {
      a.hidden = true;
      $("disconnect").hidden = true;
      $("connect").hidden = false;
    }
  }

  const writeNotes = () => new ethers.Contract(state.dep.notes, NOTES_ABI, state.signer);
  const writeToken = () => new ethers.Contract(state.dep.asset, ERC20_ABI, state.signer);

  // ---------------------------------------------------------------- data
  async function loadDeployment() {
    try {
      const r = await fetch(`deployments/${state.net}.json`, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    }
  }

  async function refresh() {
    const n = NETWORKS[state.net];
    if (!state.read || state.read._nearlNet !== state.net) {
      state.read = window.NearlRPC.provider(n.chainId);
      state.read._nearlNet = state.net;
    }
    state.dep = await loadDeployment();
    renderBanner();
    if (!state.dep) return renderNotDeployed();

    const notes = new ethers.Contract(state.dep.notes, NOTES_ABI, state.read);
    const token = new ethers.Contract(state.dep.asset, ERC20_ABI, state.read);
    let count, owner, paused, emergencyDelay;
    try {
      [count, owner, paused, emergencyDelay] = await Promise.all([notes.seriesCount(), notes.owner(), notes.paused(), notes.EMERGENCY_DELAY()]);
    } catch (e) {
      $("series").innerHTML = `<div class="empty">Could not reach the ${esc(n.chainName)} network. Check your connection and reload.</div>`;
      return;
    }
    state.owner = owner;

    const ids = Array.from({ length: Number(count) }, (_, i) => i);
    const series = await Promise.all(ids.map((i) => notes.getSeries(i)));

    const feeds = {};
    await Promise.all(
      [...new Set(series.map((s) => s.feed))].map(async (f) => {
        const c = new ethers.Contract(f, FEED_ABI, state.read);
        try {
          const [round, dec] = await Promise.all([c.latestRoundData(), c.decimals()]);
          feeds[f] = { price: round[1], updatedAt: round[3], dec: Number(dec) };
        } catch (_) {
          feeds[f] = null;
        }
      }),
    );

    let positions = [], claims = [], balance = 0n, allowance = 0n;
    if (state.account) {
      [positions, claims, balance, allowance] = await Promise.all([
        Promise.all(ids.map((i) => notes.getPosition(i, state.account))),
        Promise.all(ids.map((i) => notes.claimable(i, state.account))),
        token.balanceOf(state.account),
        token.allowance(state.account, state.dep.notes),
      ]);
    }

    renderStats(series, balance, paused);
    renderSeries(ids, series, feeds, positions, claims, allowance, paused, Number(emergencyDelay));
    renderAdmin(ids, series, paused);
  }

  // ---------------------------------------------------------------- render
  function renderBanner() {
    const b = $("banner");
    if (state.net === "testnet") {
      b.innerHTML = `<div class="banner testnet"><p><strong>Testnet.</strong> Everything here uses worthless test tokens on Robinhood Chain Testnet. Get free test ETH for network fees from a faucet listed in the <a href="https://docs.robinhood.com/chain" target="_blank" rel="noopener">Robinhood Chain docs</a>, then use the button to receive test USD.</p>${state.dep && state.dep.faucet ? '<button class="btn" type="button" id="faucet">Get 10,000 test USD</button>' : ""}</div>`;
      const f = $("faucet");
      if (f) f.onclick = () => (state.account ? send("Faucet", () => writeToken().faucet()) : connect());
    } else {
      b.innerHTML = ""; // mainnet: no banner (risks are on the Terms and Contracts pages)
    }
  }

  function renderNotDeployed() {
    $("stats").innerHTML = "";
    $("admin").hidden = true;
    const cmd = state.net === "testnet" ? "npm run deploy:testnet" : "npm run deploy:mainnet";
    $("series").innerHTML = `<div class="empty">NEARL is not deployed on ${state.net} yet.<br>Run <code>${cmd}</code> and publish the website again.</div>`;
  }

  function renderStats(series, balance, paused) {
    const tvl = series.reduce((a, s) => a + s.totalDeposits, 0n);
    const open = series.filter((s) => Number(s.status) <= 1).length;
    const sym = esc(state.dep.assetSymbol);
    $("stats").innerHTML =
      // Hidden while nothing is deposited yet: a new pool is waiting for its first member, not empty for good.
      (tvl > 0n ? `<div><span class="label">Total deposits</span><b>${fmtAmt(tvl)} ${sym}</b></div>` : "") +
      `<div><span class="label">Open pools</span><b>${open}</b></div>` +
      (state.account ? `<div><span class="label">Your balance</span><b>${fmtAmt(balance)} ${sym}</b></div>` : "") +
      (paused ? `<div><span class="label">Deposits</span><b style="color:var(--bad)">Paused</b></div>` : "");
  }

  function renderSeries(ids, series, feeds, positions, claims, allowance, paused, emergencyDelay) {
    const box = $("series");
    if (!ids.length) {
      box.innerHTML = state.net === "mainnet"
        ? `<div class="empty">No mainnet pools are open yet. Mainnet pools open after the contracts are audited.<br><button class="btn" type="button" id="go-testnet" style="margin-top:12px">Try pools on testnet →</button></div>`
        : `<div class="empty">No pools yet. Check back soon.</div>`;
      const gt = document.getElementById("go-testnet");
      if (gt) gt.onclick = () => document.getElementById("net-testnet").click();
      return;
    }
    const now = Date.now() / 1000;
    const sym = esc(state.dep.assetSymbol);
    box.innerHTML = "";

    // Newest first
    for (const i of [...ids].reverse()) {
      const s = series[i];
      const st = Number(s.status);
      const feed = feeds[s.feed];
      const label = esc((state.dep.feeds && state.dep.feeds[s.feed]) || "Price feed " + short(s.feed));
      const obs = s.observationTimes.map(Number);
      const next = Number(s.nextObservation);
      const dueTs = st === 0 ? Number(s.subscriptionEnd) : st === 1 ? obs[next] : 0;

      // Safety line and early-win line in dollars once the start price is known.
      let startHtml = "Set at start", safetyHtml = pct(s.barrierBps) + " of start", winHtml = pct(s.autocallBps) + " of start", zone = null;
      if (feed && s.initialPrice > 0n) {
        startHtml = "$" + fmtPrice(s.initialPrice, feed.dec);
        safetyHtml = "$" + fmtPrice((s.initialPrice * BigInt(s.barrierBps)) / 10000n, feed.dec);
        winHtml = "$" + fmtPrice((s.initialPrice * BigInt(s.autocallBps)) / 10000n, feed.dec);
        const lvl = (feed.price * 10000n) / s.initialPrice;
        zone = lvl >= BigInt(s.autocallBps) ? "win" : lvl >= BigInt(s.barrierBps) ? "safe" : "below";
      }
      const fill = s.totalCap > 0n ? Number((s.totalDeposits * 10000n) / s.totalCap) / 100 : 0;
      const interval = obs.length > 1 ? obs[1] - obs[0] : obs[0] - Number(s.subscriptionEnd);
      const per = interval >= 6 * 86400 && interval <= 8 * 86400 ? "week" : interval >= 0.9 * 86400 && interval <= 1.1 * 86400 ? "day" : Math.round(interval / 86400) + " days";
      const paid = Number(s.couponsPaid);
      const zoneHtml = !zone || st > 1 ? "" :
        zone === "win" ? `<div class="zone win">🎉 Price is at or above the early win line. The next check ends the pool early with a reward.</div>` :
        zone === "safe" ? `<div class="zone safe">🟢 Price is above the safety line. The next check pays a reward.</div>` :
        `<div class="zone below">🔴 Price is below the safety line. The next check pays no reward unless it recovers.</div>`;
      const dueText = !dueTs ? "" : now >= dueTs ? (st === 0 ? "Ready to start" : "Check is due now") : (st === 0 ? "Joining closes " : "Next check ") + rel(dueTs);

      const card = document.createElement("article");
      card.className = "card";
      card.innerHTML = `
        <div class="t">
          <div><span class="label">Pool #${i}</span><h2>${label}</h2></div>
          <span class="pill s${st}">${st === 0 && now >= Number(s.subscriptionEnd) ? "Starting soon" : STATUS[st]}</span>
        </div>
        <div class="reward"><b>+${pct(s.couponBps)}</b> <span>per check, every ${per}</span>${paid ? `<span class="streak">🔥 ${paid} paid</span>` : ""}</div>
        ${zoneHtml}
        <div class="kv">
          <div><span class="label">Safety line</span><b>${safetyHtml}</b></div>
          <div><span class="label">Price now</span><b>${feed ? "$" + fmtPrice(feed.price, feed.dec) : "—"}</b></div>
          <div><span class="label">Start price</span><b>${startHtml}</b></div>
          <div><span class="label">Early win</span><b>${winHtml}</b></div>
        </div>
        <div>
          ${s.totalDeposits === 0n && Number(s.status) <= 1
            ? `<div class="row"><span><b style="color:var(--accent)">New pool</b> · be the first to join · room for ${fmtAmt(s.totalCap)} ${sym}</span><span>Max ${fmtAmt(s.perUserCap)} per wallet</span></div>`
            : `<div class="row"><span>Filled ${fmtAmt(s.totalDeposits)} of ${fmtAmt(s.totalCap)} ${sym}</span><span>Max ${fmtAmt(s.perUserCap)} per wallet</span></div>
          <div class="bar" style="margin-top:6px"><i style="width:${Math.min(100, fill)}%"></i></div>`}
        </div>
        ${dueText ? `<p class="due">⏱ ${dueText}</p>` : ""}
        <details class="schedwrap"><summary>Schedule (${paid} of ${obs.length} rewards paid)</summary>
        <ul class="sched">
          <li class="${st === 0 ? "next" : "done"}"><span>Joining closes</span><span>${fmtDate(s.subscriptionEnd)}</span></li>
          ${obs.map((t, k) => `<li class="${st >= 2 ? (k < next || (st === 2 && k === next) ? "done" : "") : k < next ? "done" : k === next && st === 1 ? "next" : ""}"><span>Check ${k + 1}</span><span>${fmtDate(t)}</span></li>`).join("")}
        </ul></details>
        <div class="pos"></div>`;

      const pos = card.querySelector(".pos");
      const p = positions[i];
      const c = claims[i];
      const parts = [];

      if (state.account && p && p.deposit > 0n) {
        parts.push(`<div class="kv three">
          <div><span class="label">Your deposit</span><b>${fmtAmt(p.deposit)}</b></div>
          <div><span class="label">Rewards ready</span><b>${fmtAmt(c.coupons)}</b></div>
          <div><span class="label">Deposit back</span><b>${fmtAmt(c.principal)}</b></div>
        </div>`);
      }
      pos.innerHTML = parts.join("");

      const act = document.createElement("div");
      act.className = "act";
      const addBtn = (text, cls, onClick, disabled) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn " + (cls || "");
        b.textContent = text;
        b.disabled = !!disabled;
        b.onclick = onClick;
        act.appendChild(b);
        return b;
      };

      // Deposit
      if (st === 0 && now < Number(s.subscriptionEnd)) {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "0";
        inp.step = "any";
        inp.placeholder = `Amount in ${state.dep.assetSymbol}`;
        inp.id = `amt-${state.net}-${i}`;
        inp.setAttribute("aria-label", `Deposit amount for pool ${i}`);
        act.appendChild(inp);
        addBtn(paused ? "Joining paused" : "Join pool", "primary", async () => {
          if (!state.account) return connect();
          let amount;
          try {
            amount = ethers.parseUnits(inp.value || "0", state.dep.assetDecimals);
          } catch (_) {
            return toast("Enter a valid amount, for example 100 or 25.5.");
          }
          if (amount <= 0n) return toast("Enter an amount greater than zero.");
          if (amount > allowance) {
            const ok = await send("Approve " + state.dep.assetSymbol, () => writeToken().approve(state.dep.notes, amount));
            if (!ok) return;
          }
          await send("Join pool", () => writeNotes().deposit(i, amount));
        }, paused);
      }

      // Anyone can move the pool forward when a step is due.
      if (st === 0 && now >= Number(s.subscriptionEnd)) {
        addBtn("Start pool", "", () => (state.account ? send("Start pool", () => writeNotes().start(i)) : connect()));
      }
      if (st === 1 && now >= obs[next]) {
        addBtn(`Run check ${next + 1}`, "", () => (state.account ? send(`Check ${next + 1}`, () => writeNotes().observe(i)) : connect()));
      }
      if ((st === 0 || st === 1) && dueTs && now >= dueTs + emergencyDelay) {
        addBtn("Emergency exit", "", () => (state.account ? send("Emergency exit", () => writeNotes().triggerEmergency(i)) : connect()));
      }

      // Claim
      if (state.account && c && c.coupons + c.principal > 0n) {
        addBtn(`Claim ${fmtAmt(c.coupons + c.principal)} ${state.dep.assetSymbol}`, "primary", () => send("Claim", () => writeNotes().claim(i)));
      }
      if (act.children.length) pos.appendChild(act);
      if (!pos.children.length) pos.remove();

      box.appendChild(card);
    }
  }

  async function renderAdmin(ids, series, paused) {
    const box = $("admin");
    const isOwner = state.account && state.owner && state.account.toLowerCase() === state.owner.toLowerCase();
    let feedOwner = false;
    if (state.account && state.dep.mockFeed) {
      try {
        const f = new ethers.Contract(state.dep.mockFeed, FEED_ABI, state.read);
        feedOwner = (await f.owner()).toLowerCase() === state.account.toLowerCase();
      } catch (_) {}
    }
    if (!isOwner && !feedOwner) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const settle = ids.filter((i) => Number(series[i].status) >= 2 && !series[i].issuerSettled);
    box.innerHTML = `<h3>Pool creator tools</h3>
      <p class="note" style="margin:0">Only the contract owner sees this panel. New pools are created with <code>npm run series:${state.net}</code>.</p>`;

    if (isOwner) {
      const row = document.createElement("div");
      row.className = "act";
      const pb = document.createElement("button");
      pb.className = "btn";
      pb.type = "button";
      pb.textContent = paused ? "Resume joining" : "Pause joining";
      pb.onclick = () => send(pb.textContent, () => (paused ? writeNotes().unpause() : writeNotes().pause()));
      row.appendChild(pb);
      for (const i of settle) {
        const b = document.createElement("button");
        b.className = "btn";
        b.type = "button";
        b.textContent = `Withdraw creator share from pool #${i}`;
        b.onclick = () => send(`Withdraw creator share #${i}`, () => writeNotes().settleIssuer(i));
        row.appendChild(b);
      }
      box.appendChild(row);
    }

    if (feedOwner) {
      const row = document.createElement("div");
      row.className = "act";
      row.innerHTML = `<label class="label" for="mockprice" style="flex-basis:100%">Test price feed (testnet only)</label>
        <input id="mockprice" type="number" step="any" min="0" placeholder="New ETH / USD price, e.g. 2500">`;
      const b = document.createElement("button");
      b.className = "btn";
      b.type = "button";
      b.textContent = "Set test price";
      b.onclick = () => {
        const v = $("mockprice").value;
        let price;
        try {
          price = ethers.parseUnits(v || "0", 8);
        } catch (_) {
          return toast("Enter a valid price.");
        }
        if (price <= 0n) return toast("Enter a price greater than zero.");
        send("Set test price", () => new ethers.Contract(state.dep.mockFeed, FEED_ABI, state.signer).setPrice(price));
      };
      row.appendChild(b);
      box.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- boot
  function setNet(key) {
    state.net = key;
    try { localStorage.setItem("nearl.net", key); } catch (_) {}
    $("net-testnet").setAttribute("aria-pressed", key === "testnet");
    $("net-mainnet").setAttribute("aria-pressed", key === "mainnet");
    $("series").innerHTML = `<div class="empty">Loading ${esc(NETWORKS[key].chainName)}…</div>`;
    refresh();
  }

  $("net-testnet").onclick = () => setNet("testnet");
  $("net-mainnet").onclick = () => setNet("mainnet");
  $("connect").onclick = connect;

  $("disconnect").onclick = async () => {
    await window.NearlWallet.disconnect();
    toast("Wallet disconnected.");
  };

  // Account switched, wallet locked, or network changed inside the wallet.
  window.NearlWallet.onChange(async () => {
    await syncWallet();
    refresh();
  });
  // Reconnect silently to the wallet used last time, if it still authorizes this site.
  window.NearlWallet.restore();

  setNet(state.net);
  setInterval(() => { if (!state.busy && document.visibilityState === "visible") refresh(); }, 30000);
})();
