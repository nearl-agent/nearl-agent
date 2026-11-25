/* Shared NEARL site footer. Any page with <footer id="site-footer"></footer> gets it. */
(function () {
  "use strict";
  const el = document.getElementById("site-footer");
  if (!el) return;
  const cols = [
    ["Product", [["$NEARL token", "token.html"], ["Check", "check.html"], ["Bonding tracker", "bonding.html"], ["Swap", "swap.html"], ["Guard", "guard.html"], ["Earn", "app.html"], ["API & MCP", "docs.html#api"]]],
    ["Resources", [["Docs", "docs.html"], ["Dev log", "devlog.html"], ["Stats", "stats.html"], ["Contracts", "contracts.html"], ["Official stock tokens", "stocks.html"], ["Agent skill file", "skill.md"]]],
    ["Legal", [["Terms", "terms.html"], ["Privacy", "privacy.html"], ["Risk disclosure", "terms.html#risk"], ["Verify contracts", "contracts.html#verify"]]],
  ];
  // NEARL's own accounts. Paste each link when the account exists; until then the icon shows as "soon".
  const SOCIAL = [
    ["X", "https://x.com/nearlagent", '<path d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.3L5.3 21H2.2l7.3-8.3L1.8 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z"/>'],
    ["Telegram", "https://t.me/nearlagent", '<path d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.6-.6-.2L6.2 13.1l-4.8-1.5c-1-.3-1.1-1 .2-1.5L20.4 2.9c.9-.3 1.7.2 1.5 1.4z"/>'],
    ["GitHub", "https://github.com/nearl-agent/nearl-agent", '<path d="M12 1.5a10.5 10.5 0 0 0-3.3 20.5c.5.1.7-.2.7-.5v-1.8c-2.9.6-3.5-1.4-3.5-1.4-.5-1.2-1.2-1.5-1.2-1.5-1-.7.1-.7.1-.7 1 .1 1.6 1.1 1.6 1.1.9 1.6 2.5 1.2 3.1.9.1-.7.4-1.2.7-1.4-2.3-.3-4.8-1.2-4.8-5.2 0-1.1.4-2.1 1.1-2.8-.1-.3-.5-1.4.1-2.8 0 0 .9-.3 2.9 1.1a10 10 0 0 1 5.2 0c2-1.4 2.9-1.1 2.9-1.1.6 1.4.2 2.5.1 2.8.7.8 1.1 1.7 1.1 2.8 0 4-2.5 4.9-4.8 5.2.4.3.7 1 .7 1.9v2.9c0 .3.2.6.7.5A10.5 10.5 0 0 0 12 1.5z"/>'],
  ];
  if (!document.getElementById("sf-social-css")) {
    const st = document.createElement("style");
    st.id = "sf-social-css";
    st.textContent = ".sf-social{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}.sf-social a,.sf-social span{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid var(--rule);border-radius:999px;font:500 12.5px var(--f-mono);color:var(--ink);text-decoration:none}.sf-social a:hover{border-color:var(--ink-2)}.sf-social svg{width:15px;height:15px;fill:currentColor}.sf-social span{color:var(--ink-2);cursor:default}.sf-social small{font-size:11px;opacity:.75}";
    document.head.appendChild(st);
  }
  const social = SOCIAL.map(([name, url, path]) => {
    const icon = `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
    return url.startsWith("https://")
      ? `<a href="${url}" target="_blank" rel="noopener" aria-label="NEARL on ${name}">${icon}${name}</a>`
      : `<span title="NEARL on ${name}: coming soon">${icon}${name} <small>soon</small></span>`;
  }).join("");
  const here = location.pathname.split("/").pop() || "index.html";
  const link = ([t, h]) => {
    const ext = /^https?:/.test(h);
    const cur = !ext && h.split("#")[0] === here.replace(/^$/, "index.html") ? ' aria-current="page"' : "";
    return `<li><a href="${h}"${ext ? ' target="_blank" rel="noopener"' : ""}${cur}>${t}${ext ? " ↗" : ""}</a></li>`;
  };
  el.className = "sitefoot";
  el.innerHTML = `
    <div class="sf-in">
      <div class="sf-brand">
        <a class="sf-logo" href="index.html"><span class="logo" aria-hidden="true"></span>NEARL</a>
        <p>The safety layer for onchain agents: token checks, guarded agent wallets and reward pools, on Robinhood Chain.</p>
        <a class="sf-badge" href="contracts.html#verify"><span class="dot"></span>Official contract addresses ↗</a>
        <div class="sf-social">${social}</div>
      </div>
      ${cols.map(([h, items]) => `<nav class="sf-col" aria-label="${h}"><h2>${h}</h2><ul>${items.map(link).join("")}</ul></nav>`).join("")}
    </div>
    <div class="sf-bottom">
      <span>© ${new Date().getFullYear()} NEARL</span>
      <span>Experimental software. Contracts are not audited. Not investment advice.</span>
    </div>`;
})();
