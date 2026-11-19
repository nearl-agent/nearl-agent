// GET /og?d=<shared result>  ->  a 1200x630 PNG card for X, Telegram and other link previews.
// The card shows the exact score that was shared, after checking it against a fresh server-side check:
// holder findings can only lower a score, so a genuine shared score is never above the server's own
// score (small drift allowed). A link that claims a higher score gets a "could not verify" card instead,
// so nobody can make a token look safer than NEARL found it.
const fs = require("fs");
const path = require("path");
const satori = require("satori").default || require("satori");
const { Resvg, initWasm } = require("@resvg/resvg-wasm");
const { quickScore } = require("./lib/engine");
const { cached } = require("./lib/limits");
const { decode, verdictOf } = require("./lib/share-data");

const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p));
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await initWasm(read("node_modules/@resvg/resvg-wasm/index_bg.wasm"));
      return [
        { name: "Inter", data: read("node_modules/@fontsource/inter/files/inter-latin-400-normal.woff"), weight: 400, style: "normal" },
        { name: "Inter", data: read("node_modules/@fontsource/inter/files/inter-latin-600-normal.woff"), weight: 600, style: "normal" },
        { name: "Inter", data: read("node_modules/@fontsource/inter/files/inter-latin-700-normal.woff"), weight: 700, style: "normal" },
        { name: "Mono", data: read("node_modules/@fontsource/source-code-pro/files/source-code-pro-latin-500-normal.woff"), weight: 500, style: "normal" },
      ];
    })();
  }
  return ready;
}

const C = { paper: "#000F06", surface: "#0B1712", ink: "#F6F6F6", ink2: "#9aa29d", rule: "#1d2a24", accent: "#FDFAC3", good: "#7FC8A0", ok: "#7FC8A0", warn: "#E8C468", bad: "#FF8A7E", info: "#9AA8FF" };
const h = (type, style, ...children) => ({ type, props: { style: { display: "flex", ...style }, children: children.flat().filter((c) => c !== null && c !== false) } });
const uri = (svg) => "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");

let logoUri = null;
function logo() {
  if (!logoUri) logoUri = uri(read("web/logo.svg").toString("utf8").replace(/currentColor/g, C.accent));
  return logoUri;
}

function ring(score, color) {
  const r = 104, c = 2 * Math.PI * r, dash = (score / 100) * c;
  return uri(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="260" viewBox="0 0 260 260">
    <circle cx="130" cy="130" r="${r}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="20"/>
    <circle cx="130" cy="130" r="${r}" fill="none" stroke="${color}" stroke-width="20" stroke-linecap="round" stroke-dasharray="${dash} ${c}" transform="rotate(-90 130 130)"/></svg>`);
}

function card(snap, host) {
  const [verdict, tone] = verdictOf(snap.score);
  const color = C[tone];
  const when = snap.at ? new Date(snap.at * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  const short = snap.token.slice(0, 6) + "…" + snap.token.slice(-4);
  return h("div", { width: 1200, height: 630, background: C.paper, color: C.ink, fontFamily: "Inter", position: "relative" },
    h("div", { position: "absolute", left: 64, right: 64, top: 48, height: 48, alignItems: "center", justifyContent: "space-between" },
      h("div", { alignItems: "center", gap: 16 },
        { type: "img", props: { src: logo(), width: 58, height: 44 } },
        h("div", { fontSize: 30, fontWeight: 700, letterSpacing: 2 }, "NEARL"),
        h("div", { fontSize: 24, color: C.ink2, marginLeft: 4 }, "Check")),
      h("div", { fontSize: 22, color: C.ink2 }, snap.net === "testnet" ? "Robinhood Chain Testnet" : "Robinhood Chain")),
    h("div", { position: "absolute", left: 64, right: 64, top: 128, height: 380, alignItems: "center", gap: 56 },
      h("div", { width: 260, height: 260, position: "relative", alignItems: "center", justifyContent: "center", flexShrink: 0 },
        { type: "img", props: { src: ring(snap.score, color), width: 260, height: 260, style: { position: "absolute", left: 0, top: 0 } } },
        h("div", { flexDirection: "column", alignItems: "center" },
          h("div", { fontSize: 96, fontWeight: 700, lineHeight: 1, color: C.ink }, String(snap.score)),
          h("div", { fontSize: 24, color: C.ink2, marginTop: 6 }, "/ 100"))),
      h("div", { flexDirection: "column", flex: 1, minWidth: 0 },
        h("div", { fontSize: 58, fontWeight: 700, color, lineHeight: 1.05 }, verdict),
        h("div", { fontSize: 40, fontWeight: 600, marginTop: 14, lineHeight: 1.1 }, snap.name ? `${snap.symbol} · ${snap.name}`.slice(0, 40) : snap.symbol),
        h("div", { fontFamily: "Mono", fontSize: 22, color: C.ink2, marginTop: 10 }, short),
        h("div", { flexDirection: "column", gap: 12, marginTop: 26 },
          snap.findings.map((f) => h("div", { alignItems: "center", gap: 14, fontSize: 25 },
            h("div", { width: 16, height: 16, borderRadius: 8, background: C[f.level], flexShrink: 0 }),
            h("div", { color: C.ink }, f.title)))))),
    h("div", { position: "absolute", left: 64, right: 64, bottom: 40, height: 56, justifyContent: "space-between", alignItems: "flex-end", fontSize: 21, color: C.ink2, borderTop: "1px solid #1d2a24" },
      h("div", {}, when ? `Checked ${when}` : "NEARL Check"),
      h("div", { fontFamily: "Mono", whiteSpace: "nowrap" }, host)));
}

function unverified(host) {
  return h("div", { width: 1200, height: 630, background: C.paper, color: C.ink, fontFamily: "Inter", padding: 64, flexDirection: "column", justifyContent: "center", gap: 18 },
    h("div", { alignItems: "center", gap: 16 }, { type: "img", props: { src: logo(), width: 58, height: 44 } }, h("div", { fontSize: 30, fontWeight: 700, letterSpacing: 2 }, "NEARL Check")),
    h("div", { fontSize: 54, fontWeight: 700, marginTop: 20 }, "This result could not be verified."),
    h("div", { fontSize: 28, color: C.ink2 }, "Open the link to see NEARL's live check of this token."),
    h("div", { fontFamily: "Mono", fontSize: 22, color: C.ink2, marginTop: 8 }, host));
}

exports.handler = async (event) => {
  const host = (event.headers && (event.headers["x-forwarded-host"] || event.headers.host)) || "nearl";
  const snap = decode((event.queryStringParameters || {}).d);
  let tree, ok = false;
  try {
    const fonts = await init();
    if (snap) {
      const q = await cached(event, `quick/${snap.net}/${snap.token.toLowerCase()}`, () => quickScore(snap.token, snap.net));
      ok = snap.score <= q.score + 5;
      if (ok) {
        // Keep only findings this check really produces; holder findings come from the deeper browser check.
        const known = new Set(q.titles);
        snap.findings = snap.findings.filter((f) => known.has(f.title) || /holder|snip|bundl|creator|launch|serial|top 10|wallet/i.test(f.title));
        if (!snap.symbol || snap.symbol === "?") snap.symbol = q.symbol;
      }
    }
    tree = ok ? card(snap, host) : unverified(host);
    const svg = await satori(tree, { width: 1200, height: 630, fonts });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "image/png",
        // The link fixes the content, so a verified card can be cached for a long time.
        "Cache-Control": ok ? "public, max-age=604800, immutable" : "public, max-age=300",
      },
      body: Buffer.from(png).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (e) {
    return { statusCode: 500, headers: { "Content-Type": "text/plain" }, body: "Card could not be drawn." };
  }
};
