// NEARL landing: a hexagonal scanner tunnel in 3D (Three.js).
// Scrolling flies the camera forward. Each page section has a scanner gate in the tunnel.
// Token particles drift slowly toward the viewer; a few "bad" (red) tokens fade out quietly at the
// first gate they reach. Motion is kept calm on purpose: no camera roll, no flashing, a steady drift.
// Purely decorative: all content stays in normal HTML on top of the canvas.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";

const canvas = document.getElementById("tunnel");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const small = innerWidth < 760;

function webglOK() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch (_) {
    return false;
  }
}

if (canvas && webglOK()) start();

function start() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !small, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, small ? 1.25 : 1.6));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const BG = new THREE.Color("#0B0E13");
  scene.fog = new THREE.FogExp2(BG, small ? 0.055 : 0.042);

  const camera = new THREE.PerspectiveCamera(small ? 78 : 64, 1, 0.1, 220);
  camera.position.set(0, 0, 6);

  const ACCENT = new THREE.Color("#9AA8FF");
  const SCAN = new THREE.Color("#8FC2A9");
  const BAD = new THREE.Color("#FF7E72");
  const DIM = new THREE.Color("#2A3445");

  const LENGTH = 200;       // tunnel length in world units
  const R = 5;              // tunnel radius (hexagon)
  const STEP = 4;           // spacing between structural rings
  const hex = (r, z) => Array.from({ length: 7 }, (_, i) => {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, z);
  });

  // ---- structure: thin hexagon frames + 6 rails along the tunnel
  const frameMat = new THREE.LineBasicMaterial({ color: DIM, transparent: true, opacity: 0.6 });
  const framePts = [];
  for (let z = 8; z > -LENGTH; z -= STEP) {
    const h = hex(R, z);
    for (let i = 0; i < 6; i++) framePts.push(h[i], h[i + 1]);
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(framePts), frameMat));

  const railPts = [];
  const near = hex(R, 10), far = hex(R, -LENGTH);
  for (let i = 0; i < 6; i++) railPts.push(near[i], far[i]);
  const railMat = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.18 });
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(railPts), railMat));

  // Floor glow strips (two rails at the bottom, brighter)
  const floorPts = [];
  for (let z = 8; z > -LENGTH; z -= STEP * 0.5) {
    floorPts.push(new THREE.Vector3(-1.2, -R * 0.866, z), new THREE.Vector3(-1.2, -R * 0.866, z - STEP * 0.25));
    floorPts.push(new THREE.Vector3(1.2, -R * 0.866, z), new THREE.Vector3(1.2, -R * 0.866, z - STEP * 0.25));
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(floorPts),
    new THREE.LineBasicMaterial({ color: SCAN, transparent: true, opacity: 0.22 })));

  // ---- scanner gates: hexagonal tori with a scan sheet; positions follow the page sections
  const gates = [];
  const gateGeo = new THREE.TorusGeometry(R * 0.92, 0.05, 6, 6);
  const sheetGeo = new THREE.CircleGeometry(R * 0.9, 6);
  function makeGate(label) {
    const g = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85 });
    const ring = new THREE.Mesh(gateGeo, ringMat);
    ring.rotation.z = Math.PI / 6;
    const sheetMat = new THREE.MeshBasicMaterial({ color: SCAN, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false });
    const sheet = new THREE.Mesh(sheetGeo, sheetMat);
    sheet.rotation.z = Math.PI / 6;
    // a scanning bar that sweeps up and down the gate
    const barMat = new THREE.MeshBasicMaterial({ color: SCAN, transparent: true, opacity: 0.55, depthWrite: false });
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(R * 1.6, 0.04), barMat);
    g.add(ring, sheet, bar);
    g.userData = { ring, sheet, bar, label, flash: 0 };
    scene.add(g);
    gates.push(g);
    return g;
  }

  // ---- token particles
  const COUNT = reduce ? 0 : small ? 110 : 260;
  const pos = new Float32Array(COUNT * 3);
  const col = new Float32Array(COUNT * 3);
  const speed = new Float32Array(COUNT);
  const bad = new Uint8Array(COUNT);
  const alive = new Float32Array(COUNT);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  pGeo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const pMat = new THREE.PointsMaterial({ size: small ? 0.08 : 0.065, vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(pGeo, pMat);
  scene.add(points);

  function spawn(i, zStart) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * R * 0.78;
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = Math.sin(a) * r;
    pos[i * 3 + 2] = zStart;
    speed[i] = 0.025 + Math.random() * 0.035;
    bad[i] = Math.random() < 0.07 ? 1 : 0;
    alive[i] = 1;
    const c = bad[i] ? BAD : Math.random() < 0.55 ? SCAN : ACCENT;
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  for (let i = 0; i < COUNT; i++) spawn(i, -Math.random() * LENGTH);

  // ---- map page sections to gate positions along the tunnel
  const sections = [...document.querySelectorAll("[data-gate]")];
  const hudLinks = [...document.querySelectorAll(".gates a")];
  let gateZ = [];
  let maxScroll = 1;

  function layout() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    maxScroll = Math.max(1, document.documentElement.scrollHeight - h);
    gateZ = sections.map((el) => {
      const top = el.getBoundingClientRect().top + scrollY;
      const p = Math.min(1, Math.max(0, (top - h * 0.25) / maxScroll));
      return camZ(p) - 7; // gate sits just ahead of the camera when its section arrives
    });
    if (!gates.length) sections.forEach((el) => makeGate(el.dataset.gate));
    gates.forEach((g, i) => (g.position.z = gateZ[i]));
  }
  const camZ = (p) => 6 - p * (LENGTH - 30);

  // ---- input
  let target = 0, current = 0, mx = 0, my = 0;
  addEventListener("scroll", () => (target = scrollY / maxScroll), { passive: true });
  addEventListener("pointermove", (e) => {
    mx = (e.clientX / innerWidth - 0.5) * 2;
    my = (e.clientY / innerHeight - 0.5) * 2;
  }, { passive: true });
  addEventListener("resize", () => { layout(); target = scrollY / maxScroll; });
  // Content can grow after load (live data); refresh gate positions a few times.
  [800, 2500, 6000].forEach((t) => setTimeout(() => { layout(); target = scrollY / maxScroll; }, t));

  layout();
  target = current = scrollY / maxScroll;

  let visible = true;
  document.addEventListener("visibilitychange", () => { visible = document.visibilityState === "visible"; if (visible) requestAnimationFrame(frame); });

  let t0 = performance.now();
  function frame(now) {
    if (!visible) return;
    const dt = Math.min(0.05, (now - t0) / 1000);
    t0 = now;

    current += (target - current) * (reduce ? 1 : 0.06);
    const cz = camZ(current);
    camera.position.z = cz;
    if (!reduce) {
      camera.position.x += (mx * 0.25 - camera.position.x) * 0.02;
      camera.position.y += (-my * 0.18 - camera.position.y) * 0.02;
    }
    camera.lookAt(camera.position.x * 0.3, camera.position.y * 0.3, cz - 20);

    // gates: brighter when the camera is close, scan bar sweeps
    let nearest = -1, best = Infinity;
    gates.forEach((g, i) => {
      const d = g.position.z - cz;
      const closeness = Math.max(0, 1 - Math.abs(d + 7) / 22);
      const u = g.userData;
      u.ring.material.opacity = 0.22 + 0.4 * closeness;
      u.sheet.material.opacity = 0.02 + 0.04 * closeness;
      u.bar.position.y = reduce ? 0 : Math.sin(now / 3200 + i) * R * 0.6;
      u.bar.material.opacity = 0.08 + 0.25 * closeness;
      const ad = Math.abs(d + 7);
      if (ad < best && d < 4) { best = ad; nearest = i; }
    });
    hudLinks.forEach((a, i) => a.classList.toggle("on", i === nearest));

    // particles flow toward the viewer; bad tokens are stopped at the first gate they reach
    if (COUNT) {
      for (let i = 0; i < COUNT; i++) {
        const iz = i * 3 + 2;
        const prevZ = pos[iz];
        if (alive[i] < 1) {
          alive[i] -= dt * 0.8; // fading out after being stopped
          if (alive[i] <= 0) spawn(i, cz - 40 - Math.random() * 80);
          continue;
        }
        pos[iz] += speed[i] * 60 * dt; // steady drift, independent of scrolling
        if (bad[i]) {
          for (const g of gates) {
            if (prevZ < g.position.z && pos[iz] >= g.position.z) {
              pos[iz] = g.position.z;
              alive[i] = 0.999; // fade out quietly at the gate
              break;
            }
          }
        }
        if (pos[iz] > cz + 4) spawn(i, cz - 60 - Math.random() * 100);
      }
      pGeo.attributes.position.needsUpdate = true;
      pGeo.attributes.color.needsUpdate = true;
    }

    renderer.render(scene, camera);
    if (!reduce || Math.abs(target - current) > 0.0005) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  if (reduce) addEventListener("scroll", () => requestAnimationFrame(frame), { passive: true });

  document.documentElement.classList.add("has-tunnel");
}
