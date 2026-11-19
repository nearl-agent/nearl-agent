// A shared Check result travels inside the share link as compact base64url JSON:
//   { t: token, n: "mainnet"|"testnet", s: score, y: symbol, m: name, f: [[level, title], ...], at: unix seconds }
// Everything is length-limited and cleaned here, so nothing in a link can break the page or the image.
const LEVELS = new Set(["bad", "warn", "ok", "info"]);
const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f<>]/g, "").slice(0, max);

function decode(d) {
  try {
    const raw = JSON.parse(Buffer.from(String(d || ""), "base64url").toString("utf8"));
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw.t || "")) return null;
    const score = Math.round(Number(raw.s));
    if (!Number.isFinite(score) || score < 0 || score > 100) return null;
    return {
      token: raw.t,
      net: raw.n === "testnet" ? "testnet" : "mainnet",
      score,
      symbol: clean(raw.y, 16) || "?",
      name: clean(raw.m, 40),
      findings: (Array.isArray(raw.f) ? raw.f : []).slice(0, 3)
        .filter((x) => Array.isArray(x) && LEVELS.has(x[0]))
        .map(([level, title]) => ({ level, title: clean(title, 70) })),
      at: Number(raw.at) > 1.6e9 && Number(raw.at) < 4e9 ? Math.floor(Number(raw.at)) : null,
    };
  } catch (_) {
    return null;
  }
}

// The verdict always follows from the score (same thresholds as the Check page), never from the link.
const verdictOf = (s) => (s >= 80 ? ["Looks safe", "good"] : s >= 55 ? ["Be careful", "warn"] : s >= 25 ? ["High risk", "bad"] : ["Do not buy", "bad"]);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

module.exports = { decode, verdictOf, esc };
