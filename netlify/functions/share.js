// GET /s?d=<shared result>  ->  a tiny page whose link preview (X, Telegram, Discord, WhatsApp) shows the
// result card from /og. People who open it are sent on to the live check of the same token.
const { decode, verdictOf, esc } = require("./lib/share-data");

exports.handler = async (event) => {
  const host = (event.headers && (event.headers["x-forwarded-host"] || event.headers.host)) || "";
  const origin = host ? `https://${host}` : "";
  const d = String((event.queryStringParameters || {}).d || "");
  const snap = decode(d);
  if (!snap) {
    return { statusCode: 302, headers: { Location: `${origin}/check.html` }, body: "" };
  }
  const [verdict] = verdictOf(snap.score);
  const live = `${origin}/check.html?net=${snap.net}&token=${snap.token}`;
  const title = `${snap.symbol}: ${snap.score}/100 on NEARL Check (${verdict})`;
  const desc = snap.findings.length ? snap.findings.map((f) => f.title).join(" · ") : "Token safety check on Robinhood Chain: bundles, snipers, top holders, taxes and a simulated buy and sell.";
  const img = `${origin}/og?d=${encodeURIComponent(d)}`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="NEARL">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(`${origin}/s?d=${d}`)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta http-equiv="refresh" content="0; url=${esc(live)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{background:#000F06;color:#F6F6F6;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}a{color:#FDFAC3}</style>
</head><body><p>Opening the live NEARL check of ${esc(snap.symbol)}… <a href="${esc(live)}">Continue</a></p>
<script>location.replace(${JSON.stringify(live)})</script>
</body></html>`;
  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
    body: html,
  };
};
