/* Landing page as fenced "slides": every section becomes a framed, full-height panel with a slide
   number, a name and scanner-style corner brackets. As each slide scrolls into view its frame lights up,
   the heading rises word by word and the rest follows in a short cascade. Each slide animates once.
   With reduced motion (or no IntersectionObserver) everything is simply shown. */
(function () {
  "use strict";
  const slides = Array.from(document.querySelectorAll("main > .hero, main > section.sec"));
  if (!slides.length) return;
  const NAMES = ["Overview", "New launches", "The scanner", "Agent flow", "Products", "For builders", "Who it's for", "Onchain ledger"];
  const pad = (n) => String(n).padStart(2, "0");

  slides.forEach((el, i) => {
    el.classList.add("slide");
    const tag = document.createElement("div");
    tag.className = "slide-tag";
    tag.setAttribute("aria-hidden", "true");
    tag.innerHTML = `<span>${pad(i + 1)} / ${pad(slides.length)}</span><span>${NAMES[i] || ""}</span>`;
    el.prepend(tag);
    for (const c of ["tl", "tr", "bl", "br"]) {
      const s = document.createElement("i");
      s.className = "corner " + c;
      s.setAttribute("aria-hidden", "true");
      el.appendChild(s);
    }
  });

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("slides-anim");

  // Wrap every word of a heading in a mask so it can rise from below its line. Child elements
  // (like the accent span) keep their styling; line breaks stay where they are.
  function split(el) {
    let n = 0;
    const walk = (node) => {
      for (const ch of Array.from(node.childNodes)) {
        if (ch.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const part of ch.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
            const w = document.createElement("span");
            w.className = "w";
            const inner = document.createElement("span");
            inner.textContent = part;
            inner.style.setProperty("--i", n++);
            w.appendChild(inner);
            frag.appendChild(w);
          }
          ch.replaceWith(frag);
        } else if (ch.nodeType === 1 && ch.tagName !== "BR") {
          walk(ch);
        }
      }
    };
    walk(el);
    return n;
  }

  const CASCADE = ".kicker, .pill, .scantag, .sub, .lead, .scanbar, .chips, .fresh .radar, .marq, .report3d, .cell, .step, .prod, .plug .tabs, .plug pre, .who > div, .ledger, .nearl-ca, .scrollcue";
  slides.forEach((s) => {
    let words = 0;
    s.querySelectorAll("h1, .h2").forEach((h) => { words = Math.max(words, split(h)); h.classList.add("split"); });
    const start = Math.min(words, 14) * 45 + 220; // the rest begins as the heading settles
    Array.from(s.querySelectorAll(CASCADE)).forEach((el, k) => {
      el.classList.add("rise");
      el.style.setProperty("--d", (el.matches(".kicker, .pill, .scantag") ? 0 : start + Math.min(k, 10) * 70) + "ms");
    });
  });

  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add("in");
    io.unobserve(e.target);
  }), { threshold: 0, rootMargin: "0px 0px -12% 0px" }); // any height: fire as soon as the top enters
  slides.forEach((s) => io.observe(s));

  // Safety net: a slide on screen is always shown, even if the observer never fires.
  const sweep = () => slides.forEach((s) => { const r = s.getBoundingClientRect(); if (r.top < innerHeight * 0.95 && r.bottom > 0) s.classList.add("in"); });
  setTimeout(sweep, 2000);
  addEventListener("scroll", () => { clearTimeout(sweep.t); sweep.t = setTimeout(sweep, 400); }, { passive: true });
})();
