/* Hero: a stack of three NEARL scan-report sheets in 3D (CSS only, no WebGL).
   Drag to turn the stack, it tilts toward the pointer, and a click or tap sends the front sheet to the
   back so the next report comes forward. The numbers come from a real Pons launch (COFR) checked with
   NEARL on 19 Nov 2026; the sheets say so. */
(function () {
  "use strict";
  const stage = document.getElementById("report3d");
  if (!stage) return;
  const stack = stage.querySelector(".stack");
  const sheets = Array.from(stack.querySelectorAll(".sheet"));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;

  // positions in the stack: 0 is the front sheet
  let order = sheets.map((_, i) => i);
  function layout() {
    order.forEach((sheetIndex, pos) => {
      const s = sheets[sheetIndex];
      s.style.setProperty("--pos", pos);
      s.classList.toggle("front", pos === 0);
      s.setAttribute("aria-hidden", pos === 0 ? "false" : "true");
    });
    const dots = stage.querySelectorAll(".dots i");
    dots.forEach((d, i) => d.classList.toggle("on", i === order[0]));
  }
  layout();

  function next() {
    const front = sheets[order[0]];
    front.classList.add("leaving");
    setTimeout(() => {
      front.classList.remove("leaving");
      order = order.slice(1).concat(order[0]);
      layout();
    }, reduce ? 0 : 320);
  }

  // rotation: drag (with inertia) plus a small tilt toward the pointer
  let rx = -8, ry = -18, vx = 0, vy = 0, tx = 0, ty = 0, hx = 0, hy = 0, dragging = false, moved = 0, lx = 0, ly = 0;
  stage.addEventListener("pointerdown", (e) => {
    dragging = true; moved = 0; lx = e.clientX; ly = e.clientY;
    stage.setPointerCapture(e.pointerId); stage.classList.add("grabbing");
  });
  stage.addEventListener("pointermove", (e) => {
    const r = stage.getBoundingClientRect();
    hx = ((e.clientX - r.left) / r.width - 0.5) * 2; hy = ((e.clientY - r.top) / r.height - 0.5) * 2;
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);
    vy = dx * 0.35; vx = -dy * 0.25;
    ry = Math.max(-55, Math.min(55, ry + vy)); rx = Math.max(-30, Math.min(30, rx + vx));
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false; stage.classList.remove("grabbing");
    if (moved < 6 && e.type === "pointerup") next(); // a tap or click flips to the next sheet
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("pointerleave", () => { hx = 0; hy = 0; });
  stage.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); next(); } });

  let visible = true, raf = 0;
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; loop(); }).observe(stage);
  function frame() {
    raf = 0;
    if (!dragging) {
      vy *= 0.9; vx *= 0.9;
      ry += vy; rx += vx;
      ry += (-18 - ry) * 0.03; rx += (-8 - rx) * 0.03; // ease back to the resting angle
    }
    tx += ((fine ? hx : 0) - tx) * 0.08; ty += ((fine ? hy : 0) - ty) * 0.08;
    stack.style.transform = `rotateX(${(rx - ty * 6).toFixed(2)}deg) rotateY(${(ry + tx * 9).toFixed(2)}deg)`;
    loop();
  }
  function loop() {
    if (raf || !visible || reduce) return;
    raf = requestAnimationFrame(frame);
  }
  if (reduce) stack.style.transform = "rotateX(-6deg) rotateY(-14deg)";
  loop();
})();
