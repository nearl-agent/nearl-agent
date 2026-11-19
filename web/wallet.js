/* NEARL wallet connector.
 * Finds every installed browser wallet (EIP-6963: MetaMask, Rabby, Coinbase Wallet, OKX, Robinhood Wallet
 * extension, ...), lets the visitor pick one, remembers the choice, and exposes the wallet as
 * window.NearlWallet. No external libraries and no keys: the wallet itself holds the keys.
 */
(function () {
  "use strict";

  const STORE_KEY = "nearl.wallet";
  const wallets = new Map(); // id -> { info, provider }
  const listeners = new Set();
  const state = { provider: null, info: null, account: null };
  let detach = null;

  // ------------------------------------------------------------ discovery
  window.addEventListener("eip6963:announceProvider", (e) => {
    const d = e.detail;
    if (!d || !d.info || !d.provider) return;
    wallets.set(d.info.rdns || d.info.uuid, d);
    if (dialog && dialog.open) renderList();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function available() {
    const list = [...wallets.values()];
    // Older wallets only expose window.ethereum.
    if (!list.length && window.ethereum) {
      list.push({
        info: { uuid: "injected", rdns: "injected", name: window.ethereum.isMetaMask ? "MetaMask" : "Browser wallet", icon: "" },
        provider: window.ethereum,
      });
    }
    return list;
  }

  const save = (id) => { try { id ? localStorage.setItem(STORE_KEY, id) : localStorage.removeItem(STORE_KEY); } catch (_) {} };
  const saved = () => { try { return localStorage.getItem(STORE_KEY); } catch (_) { return null; } };
  const checksum = (a) => (window.ethers ? window.ethers.getAddress(a) : a);
  const emit = () => listeners.forEach((fn) => { try { fn(api); } catch (e) { console.error(e); } });

  function setActive(w, accounts) {
    if (detach) detach();
    detach = null;
    state.provider = w ? w.provider : null;
    state.info = w ? w.info : null;
    state.account = accounts && accounts[0] ? checksum(accounts[0]) : null;
    if (w && w.provider.on) {
      const onAccounts = (accs) => {
        state.account = accs && accs[0] ? checksum(accs[0]) : null;
        if (!state.account) { state.provider = null; state.info = null; save(null); }
        emit();
      };
      const onChain = () => emit();
      w.provider.on("accountsChanged", onAccounts);
      w.provider.on("chainChanged", onChain);
      detach = () => {
        w.provider.removeListener?.("accountsChanged", onAccounts);
        w.provider.removeListener?.("chainChanged", onChain);
      };
    }
    emit();
  }

  async function connectWith(w) {
    const accounts = await w.provider.request({ method: "eth_requestAccounts" });
    save(w.info.rdns || w.info.uuid);
    setActive(w, accounts);
    return state.account;
  }

  // Reconnect silently to the wallet chosen last time, if it still authorizes this site.
  async function restore() {
    const id = saved();
    if (!id) return null;
    await new Promise((r) => setTimeout(r, 300)); // give wallets time to announce themselves
    const w = available().find((x) => (x.info.rdns || x.info.uuid) === id) || (id === "injected" ? available()[0] : null);
    if (!w) return null;
    try {
      const accounts = await w.provider.request({ method: "eth_accounts" });
      if (accounts && accounts[0]) {
        setActive(w, accounts);
        return state.account;
      }
    } catch (_) {}
    return null;
  }

  async function disconnect() {
    const p = state.provider;
    save(null);
    setActive(null, null);
    try { await p?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch (_) {}
  }

  // ------------------------------------------------------------ picker dialog
  let dialog = null;
  let pending = null;

  function injectStyles() {
    if (document.getElementById("nw-style")) return;
    const s = document.createElement("style");
    s.id = "nw-style";
    s.textContent = `
      .nw-dialog{border:1px solid var(--rule,#C3CBD4);border-radius:16px;padding:0;width:min(420px,calc(100% - 32px));
        background:var(--surface,#F4F6F8);color:var(--ink,#121A24);font-family:var(--f-body,system-ui,sans-serif)}
      .nw-dialog::backdrop{background:rgba(10,14,20,.55)}
      .nw-head{display:flex;justify-content:space-between;align-items:center;padding:18px 20px;border-bottom:1px solid var(--rule,#C3CBD4)}
      .nw-head h2{margin:0;font:800 20px var(--f-display,system-ui,sans-serif);letter-spacing:-.02em}
      .nw-x{border:0;background:transparent;color:inherit;font-size:22px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px}
      .nw-body{padding:12px;display:grid;gap:8px}
      .nw-w{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border:1px solid var(--rule,#C3CBD4);border-radius:12px;
        background:var(--paper,#E8ECEF);color:inherit;font:600 15px var(--f-body,system-ui,sans-serif);cursor:pointer;text-align:left}
      .nw-w:hover{border-color:var(--cobalt,#2C46E8)}
      .nw-w img,.nw-w .nw-ph{width:32px;height:32px;border-radius:8px;flex:none}
      .nw-w .nw-ph{background:var(--rule,#C3CBD4)}
      .nw-w small{display:block;font:400 12px var(--f-mono,monospace);color:var(--ink-2,#465363)}
      .nw-note{margin:0;padding:4px 8px 8px;font-size:13px;color:var(--ink-2,#465363);line-height:1.5}
      .nw-note a{color:var(--cobalt,#2C46E8)}
      .nw-err{margin:0 8px 8px;padding:10px 12px;border-radius:10px;background:var(--bad-bg,#F9E1DF);color:var(--bad,#B3261E);font-size:13px}
    `;
    document.head.appendChild(s);
  }

  const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function renderList(error) {
    const body = dialog.querySelector(".nw-body");
    body.innerHTML = "";
    const list = available();

    if (error) {
      const e = document.createElement("p");
      e.className = "nw-err";
      e.textContent = error;
      body.appendChild(e);
    }

    for (const w of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "nw-w";
      const icon = typeof w.info.icon === "string" && w.info.icon.startsWith("data:image/")
        ? `<img alt="" src="${esc(w.info.icon)}">`
        : `<span class="nw-ph" aria-hidden="true"></span>`;
      b.innerHTML = `${icon}<span>${esc(w.info.name || "Wallet")}<small>Installed</small></span>`;
      b.onclick = async () => {
        try {
          b.disabled = true;
          const acct = await connectWith(w);
          close(acct);
        } catch (err) {
          b.disabled = false;
          const msg = err && err.code === 4001 ? "You rejected the connection request in your wallet." : (err && err.message) || "Could not connect to this wallet.";
          renderList(msg);
        }
      };
      body.appendChild(b);
    }

    const note = document.createElement("p");
    note.className = "nw-note";
    if (!list.length) {
      const here = location.host + location.pathname;
      note.innerHTML = isMobile()
        ? `No wallet found in this browser. Open this page inside your wallet app's browser: <a href="https://metamask.app.link/dapp/${esc(here)}">Open in MetaMask</a> · <a href="https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(location.href)}">Open in Coinbase Wallet</a>.`
        : `No browser wallet found. Install <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> or <a href="https://rabby.io/" target="_blank" rel="noopener">Rabby</a>, then reload this page.`;
    } else {
      note.textContent = "Your wallet keeps your keys. NEARL never sees them and only asks your wallet to sign transactions you approve.";
    }
    body.appendChild(note);
  }

  function close(result) {
    if (dialog && dialog.open) dialog.close();
    if (pending) {
      pending(result || null);
      pending = null;
    }
  }

  function open() {
    injectStyles();
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "nw-dialog";
      dialog.setAttribute("aria-labelledby", "nw-title");
      dialog.innerHTML = `<div class="nw-head"><h2 id="nw-title">Connect a wallet</h2><button type="button" class="nw-x" aria-label="Close">×</button></div><div class="nw-body"></div>`;
      dialog.querySelector(".nw-x").onclick = () => close(null);
      dialog.addEventListener("cancel", (e) => { e.preventDefault(); close(null); });
      dialog.addEventListener("click", (e) => { if (e.target === dialog) close(null); });
      document.body.appendChild(dialog);
    }
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    renderList();
    dialog.showModal();
    return new Promise((resolve) => (pending = resolve));
  }

  const api = {
    open,
    restore,
    disconnect,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get provider() { return state.provider; },
    get info() { return state.info; },
    get account() { return state.account; },
  };
  window.NearlWallet = api;
})();
