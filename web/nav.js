/* NEARL top bar on phones: a ≡ button that opens a full-screen menu, and a Connect wallet button on
 * every page. Desktop is unchanged. Loaded on every page after footer.js. */
(function () {
  "use strict";
  const nav = document.querySelector(".topnav .in");
  if (!nav || document.getElementById("nav-burger")) return;
  const links = nav.querySelector(".links");

  const css = document.createElement("style");
  css.textContent = `
    #nav-burger{display:none;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;border:1px solid var(--rule);background:transparent;color:var(--ink);cursor:pointer;padding:0;flex:none}
    #nav-burger svg{width:20px;height:20px}
    #nav-menu{position:fixed;inset:0;z-index:60;background:var(--paper);display:flex;flex-direction:column;padding:max(14px,env(safe-area-inset-top,0px)) max(16px,env(safe-area-inset-right,0px)) max(24px,env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));overflow-y:auto}
    #nav-menu[hidden]{display:none}
    #nav-menu .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
    #nav-menu .top .brand{display:flex;align-items:center;gap:10px;font:800 18px var(--f-display);letter-spacing:.06em;color:var(--ink);text-decoration:none}
    #nav-menu nav{display:flex;flex-direction:column}
    #nav-menu nav a{display:flex;justify-content:space-between;align-items:center;padding:18px 4px;border-bottom:1px solid var(--rule);color:var(--ink-2);text-decoration:none;font:500 22px var(--f-body)}
    #nav-menu nav a[aria-current]{color:var(--ink)}
    #nav-menu nav a[aria-current]::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--accent)}
    #nav-menu .cta{display:flex;flex-direction:column;gap:10px;margin-top:24px}
    #nav-menu .cta .btn{width:100%;justify-content:center;padding:14px 18px;font-size:16px}
    #nav-menu .social{display:flex;gap:18px;margin-top:22px;font:500 14px var(--f-mono)}
    #nav-menu .social a{color:var(--ink-2);text-decoration:none}
    body.nav-open{overflow:hidden}
    @media (max-width:760px){
      .topnav .in{flex-wrap:nowrap}
      .topnav .links{display:none}
      #nav-burger{display:inline-flex}
      .topnav .in > a.btn.primary[href="check.html"]{display:none}
      .topnav .in .seg{order:9}
      .topnav .in:has(.seg){flex-wrap:wrap}
      #wallet-btn,#connect{white-space:nowrap}
    }`;
  document.head.appendChild(css);

  // A Connect wallet button on pages that do not have one yet.
  if (!document.getElementById("wallet-btn") && !document.getElementById("connect")) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn sm"; b.id = "wallet-btn"; b.textContent = "Connect wallet";
    nav.appendChild(b);
    const wire = () => {
      const W = window.NearlWallet;
      if (!W) return;
      const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
      const render = () => {
        if (W.account) { b.innerHTML = '<span class="dot"></span>' + short(W.account); b.classList.add("on"); b.title = "Connected: " + W.account + ". Click to disconnect."; }
        else { b.textContent = "Connect wallet"; b.classList.remove("on"); b.title = ""; }
      };
      b.addEventListener("click", async () => { if (W.account) await W.disconnect(); else await W.open(); render(); });
      W.onChange(render); W.restore().then(render);
    };
    if (window.NearlWallet) wire();
    else { const s = document.createElement("script"); s.src = "wallet.js"; s.onload = wire; document.head.appendChild(s); }
  }

  // ≡ button and the full-screen menu built from the page's own links.
  const burger = document.createElement("button");
  burger.type = "button"; burger.id = "nav-burger";
  burger.setAttribute("aria-label", "Open menu"); burger.setAttribute("aria-expanded", "false"); burger.setAttribute("aria-controls", "nav-menu");
  burger.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
  nav.appendChild(burger);

  const items = links ? [...links.querySelectorAll("a")] : [];
  const menu = document.createElement("div");
  menu.id = "nav-menu"; menu.hidden = true;
  menu.setAttribute("role", "dialog"); menu.setAttribute("aria-modal", "true"); menu.setAttribute("aria-label", "Menu");
  menu.innerHTML = `
    <div class="top">
      <a class="brand" href="index.html"><span class="logo" aria-hidden="true"></span>NEARL</a>
      <button type="button" id="nav-close" aria-label="Close menu" style="display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:10px;border:1px solid var(--rule);background:transparent;color:var(--ink);cursor:pointer;padding:0"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <nav aria-label="Main">${items.map((a) => `<a href="${a.getAttribute("href")}"${a.hasAttribute("aria-current") ? ' aria-current="page"' : ""}>${a.textContent}</a>`).join("")}<a href="stocks.html">Official stock tokens</a></nav>
    <div class="cta"><a class="btn primary" href="check.html">Check a token</a><button class="btn" type="button" id="nav-wallet">Connect wallet</button></div>
    <div class="social"><a href="https://x.com/nearlagent" target="_blank" rel="noopener">X ↗</a><a href="https://t.me/nearlagent" target="_blank" rel="noopener">Telegram ↗</a><a href="https://github.com/nearl-agent/nearl-agent" target="_blank" rel="noopener">GitHub ↗</a></div>`;
  document.body.appendChild(menu);

  const open = () => { menu.hidden = false; document.body.classList.add("nav-open"); burger.setAttribute("aria-expanded", "true"); syncWallet(); document.getElementById("nav-close").focus(); };
  const close = () => { menu.hidden = true; document.body.classList.remove("nav-open"); burger.setAttribute("aria-expanded", "false"); };
  burger.addEventListener("click", open);
  document.getElementById("nav-close").addEventListener("click", () => { close(); burger.focus(); });
  menu.addEventListener("click", (e) => { if (e.target.closest("nav a, .cta a")) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { close(); burger.focus(); } });
  addEventListener("resize", () => { if (innerWidth > 760 && !menu.hidden) close(); });

  // The menu's wallet button mirrors the page's own wallet button.
  const pageWallet = () => document.getElementById("wallet-btn") || document.getElementById("connect");
  function syncWallet() {
    const w = pageWallet(), mine = document.getElementById("nav-wallet");
    if (!w) { mine.hidden = true; return; }
    const connected = w.classList.contains("on") || (w.id === "connect" && w.hidden);
    mine.textContent = connected ? "Wallet connected" : "Connect wallet";
  }
  document.getElementById("nav-wallet").addEventListener("click", () => { const w = pageWallet(); close(); if (w && !w.hidden) w.click(); });
})();
