/* Shared transaction helpers for the Guard page (window.NearlTx). Works on testnet and mainnet;
   call NearlTx.setNet("mainnet" | "testnet") to switch. */
(function () {
  "use strict";
  const { ethers } = window;
  const NETS = {
    testnet: { key: "testnet", chainId: 46630, name: "Robinhood Chain Testnet", rpc: "https://rpc.testnet.chain.robinhood.com", explorer: "https://explorer.testnet.chain.robinhood.com", symbol: "tUSD" },
    mainnet: { key: "mainnet", chainId: 4663, name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com", symbol: "USDG" },
  };
  let NET = NETS.testnet;
  let read = window.NearlRPC.provider(NET.chainId);
  const deps = {};
  function setNet(key) {
    NET = NETS[key] || NETS.testnet;
    read = window.NearlRPC.provider(NET.chainId);
    return NET;
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---- toast
  let el, timer;
  function toast(html, ms = 6000) {
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      el.style.cssText = "position:fixed;left:50%;bottom:max(16px,env(safe-area-inset-bottom,0px));transform:translateX(-50%);max-width:min(560px,calc(100% - 32px));background:var(--ink);color:var(--paper);padding:12px 16px;border-radius:12px;font-size:14px;z-index:50;box-shadow:0 8px 24px rgba(0,0,0,.35)";
      document.body.appendChild(el);
    }
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(timer);
    if (ms) timer = setTimeout(() => (el.hidden = true), ms);
  }

  async function ensureChain(p) {
    const hex = "0x" + NET.chainId.toString(16);
    const cur = await p.request({ method: "eth_chainId" });
    if (String(cur).toLowerCase() === hex) return;
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      const code = e?.code ?? e?.data?.originalError?.code;
      if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e?.message || "")) throw e;
      await p.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: NET.name, rpcUrls: window.NearlRPC.LISTS[NET.chainId], blockExplorerUrls: [NET.explorer], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }] });
    }
  }

  async function signer() {
    const W = window.NearlWallet;
    if (!W.provider) {
      const a = await W.open();
      if (!a) throw new Error("Connect a wallet first.");
    }
    await ensureChain(W.provider);
    return new ethers.BrowserProvider(W.provider).getSigner();
  }

  function errorText(e, iface, messages = {}) {
    const data = e?.data || e?.info?.error?.data || e?.error?.data;
    let name = e?.revert?.name;
    if (!name && iface && typeof data === "string") {
      try { name = iface.parseError(data)?.name; } catch (_) {}
    }
    if (name && messages[name]) return messages[name];
    if (name) return name.replace(/([A-Z])/g, " $1").trim() + ".";
    if (e?.code === "ACTION_REJECTED" || e?.code === 4001) return "You rejected the request in your wallet.";
    if (e?.code === "INSUFFICIENT_FUNDS") return NET.key === "mainnet" ? "Not enough ETH on Robinhood Chain for the network fee." : "Not enough test ETH for the network fee. Get some from a faucet.";
    return e?.shortMessage || e?.reason || e?.message || "The transaction failed.";
  }

  let busy = false;
  async function send(label, fn, opts = {}) {
    if (busy) return null;
    busy = true;
    try {
      toast(`${esc(label)}: confirm in your wallet…`, 0);
      const tx = await fn(await signer());
      const link = `${NET.explorer}/tx/${tx.hash}`;
      toast(`${esc(label)}: waiting for confirmation… <a href="${link}" target="_blank" rel="noopener" style="color:inherit">View</a>`, 0);
      const r = await tx.wait();
      toast(`${esc(label)}: done ✓ <a href="${link}" target="_blank" rel="noopener" style="color:inherit">View</a>`);
      return r;
    } catch (e) {
      console.error(e);
      toast(`${esc(label)} failed. ${esc(errorText(e, opts.iface, opts.messages))}`, 9000);
      return null;
    } finally {
      busy = false;
    }
  }

  // Approve exactly what is needed if the current allowance is too low.
  async function approveIfNeeded(tokenAddr, spender, amount) {
    const W = window.NearlWallet;
    const erc = new ethers.Contract(tokenAddr, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], read);
    const cur = await erc.allowance(W.account, spender);
    if (cur >= amount) return true;
    const r = await send(`Approve ${NET.symbol}`, (s) => erc.connect(s).approve(spender, amount));
    return !!r;
  }

  // Checks the connected wallet holds enough of a token before sending; shows a clear message if not.
  async function hasBalance(tokenAddr, amount, symbol, hint) {
    if (!symbol) symbol = NET.key === "mainnet" ? "USDG" : "test USD";
    if (hint === undefined) hint = NET.key === "mainnet" ? "Add USDG on Robinhood Chain to this wallet first." : 'Get free test USD on the <a href="app.html" style="color:inherit">Earn page</a>.';
    const W = window.NearlWallet;
    if (!W.account) return true;
    const erc = new ethers.Contract(tokenAddr, ["function balanceOf(address) view returns (uint256)"], read);
    const bal = await erc.balanceOf(W.account);
    if (bal >= amount) return true;
    const f = (v) => Number(ethers.formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
    toast(`You need ${f(amount)} ${symbol} but this wallet has ${f(bal)}. ${hint}`, 10000);
    return false;
  }

  // eth_getLogs over long ranges, split into chunks the public RPC accepts.
  async function getLogsChunked(filter, fromBlock) {
    const latest = await read.getBlockNumber();
    return window.NearlRPC.getLogsAdaptive(read, filter, fromBlock, latest, 300);
  }

  async function deployment() {
    if (deps[NET.key]) return deps[NET.key];
    const r = await fetch(`deployments/${NET.key}.json`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${NET.name} deployment not found.`);
    return (deps[NET.key] = await r.json());
  }

  // Wallet button in the shared top nav.
  function wireWalletButton(onChange) {
    const btn = document.getElementById("wallet-btn"), W = window.NearlWallet;
    const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
    const render = () => {
      if (W.account) { btn.innerHTML = '<span class="dot"></span>' + short(W.account); btn.classList.add("on"); btn.title = "Connected: " + W.account + ". Click to disconnect."; }
      else { btn.textContent = "Connect wallet"; btn.classList.remove("on"); btn.title = ""; }
    };
    btn.addEventListener("click", async () => { if (W.account) await W.disconnect(); else await W.open(); render(); });
    W.onChange(() => { render(); onChange && onChange(); });
    W.restore().then(() => { render(); onChange && onChange(); });
  }

  window.NearlTx = {
    get NET() { return NET; },
    get read() { return read; },
    setNet, getLogsChunked, toast, signer, send, approveIfNeeded, hasBalance, deployment, wireWalletButton, esc, errorText,
  };
})();
