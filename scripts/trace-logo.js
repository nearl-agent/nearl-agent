// Turns a black-on-light logo image into a crisp SVG (web/logo.svg).
// Input: a raw 8-bit grayscale dump of the image (width and height given on the command line).
// Steps: marching squares at mid-grey with sub-pixel edges, Ramer-Douglas-Peucker simplification,
// then smooth cubic curves (Catmull-Rom) that keep sharp corners sharp. Holes and separate pieces are
// handled by the even-odd fill rule.
// Usage: node scripts/trace-logo.js <gray.raw> <width> <height> <out.svg>
const fs = require("fs");
const [file, W0, H0, out] = process.argv.slice(2);
const W = Number(W0), H = Number(H0);
const px = fs.readFileSync(file);
const ink = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : 1 - px[y * W + x] / 255);

// crop to the mark
let x0 = W, y0 = H, x1 = 0, y1 = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink(x, y) > 0.5) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
const pad = 3;
x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;

// marching squares
const segs = [];
const lerp = (a, b) => (0.5 - a) / (b - a);
for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
  const tl = ink(x, y), tr = ink(x + 1, y), br = ink(x + 1, y + 1), bl = ink(x, y + 1);
  const code = (tl > 0.5 ? 8 : 0) | (tr > 0.5 ? 4 : 0) | (br > 0.5 ? 2 : 0) | (bl > 0.5 ? 1 : 0);
  if (code === 0 || code === 15) continue;
  const T = [x + lerp(tl, tr), y], R = [x + 1, y + lerp(tr, br)], B = [x + lerp(bl, br), y + 1], L = [x, y + lerp(tl, bl)];
  const add = (a, b) => segs.push([a, b]);
  switch (code) {
    case 1: case 14: add(L, B); break;
    case 2: case 13: add(B, R); break;
    case 3: case 12: add(L, R); break;
    case 4: case 11: add(T, R); break;
    case 5: add(L, T); add(B, R); break;
    case 6: case 9: add(T, B); break;
    case 7: case 8: add(L, T); break;
    case 10: add(T, R); add(L, B); break;
  }
}
const key = (p) => p[0].toFixed(4) + "," + p[1].toFixed(4);
const adj = new Map();
segs.forEach((s, i) => s.forEach((p) => { const k = key(p); if (!adj.has(k)) adj.set(k, []); adj.get(k).push(i); }));
const used = new Uint8Array(segs.length), loops = [];
for (let i = 0; i < segs.length; i++) {
  if (used[i]) continue;
  used[i] = 1;
  const loop = [segs[i][0], segs[i][1]];
  let end = segs[i][1];
  for (;;) {
    const next = (adj.get(key(end)) || []).find((j) => !used[j]);
    if (next === undefined) break;
    used[next] = 1;
    const s = segs[next];
    end = key(s[0]) === key(end) ? s[1] : s[0];
    if (key(end) === key(loop[0])) break;
    loop.push(end);
  }
  if (loop.length > 12) loops.push(loop);
}

// simplify (closed loop)
function rdp(pts, eps) {
  const go = (a, b) => {
    let dmax = 0, idx = -1;
    const [xa, ya] = pts[a], [xb, yb] = pts[b], dx = xb - xa, dy = yb - ya, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + xb * ya - yb * xa) / len; if (d > dmax) { dmax = d; idx = i; } }
    return dmax > eps ? [...go(a, idx).slice(0, -1), ...go(idx, b)] : [pts[a], pts[b]];
  };
  const m = Math.floor(pts.length / 2);
  return [...go(0, m).slice(0, -1), ...go(m, pts.length - 1).slice(0, -1)];
}

// smooth closed path: Catmull-Rom -> cubic Bezier, but keep corners sharper than CORNER degrees
const CORNER = 50;
const f = (n) => (Math.round(n * 100) / 100).toString();
function pathOf(p) {
  const n = p.length, P = (i) => p[(i + n) % n];
  const angle = (i) => {
    const a = P(i - 1), b = P(i), c = P(i + 1);
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1);
    return 180 - (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI; // turning angle
  };
  const sharp = p.map((_, i) => angle(i) > CORNER);
  let d = `M${f(P(0)[0] - x0)} ${f(P(0)[1] - y0)}`;
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const t = 1 / 6;
    const c1 = sharp[i] ? p1 : [p1[0] + (p2[0] - p0[0]) * t, p1[1] + (p2[1] - p0[1]) * t];
    const c2 = sharp[(i + 1) % n] ? p2 : [p2[0] - (p3[0] - p1[0]) * t, p2[1] - (p3[1] - p1[1]) * t];
    d += `C${f(c1[0] - x0)} ${f(c1[1] - y0)} ${f(c2[0] - x0)} ${f(c2[1] - y0)} ${f(p2[0] - x0)} ${f(p2[1] - y0)}`;
  }
  return d + "Z";
}

const area = (p) => p.reduce((s, q, i) => { const r = p[(i + 1) % p.length]; return s + q[0] * r[1] - r[0] * q[1]; }, 0) / 2;
const polys = loops.map((l) => rdp(l, 0.55)).filter((l) => l.length >= 3 && Math.abs(area(l)) > 20);
const d = polys.map(pathOf).join("");
const vw = x1 - x0, vh = y1 - y0;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" width="${vw}" height="${vh}"><title>NEARL</title><path fill="currentColor" fill-rule="evenodd" d="${d}"/></svg>\n`;
fs.writeFileSync(out, svg);
console.log(`loops ${loops.length} -> pieces ${polys.length}, points ${polys.reduce((s, p) => s + p.length, 0)}, viewBox ${vw}x${vh}, ${svg.length} bytes`);
