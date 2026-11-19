// The NEARL mark is a vector file (logo.svg), used as a CSS mask so every .logo element is drawn in
// the current text colour on any background, sharp at every size.
(function () {
  const r = document.documentElement.style;
  r.setProperty("--logo-mask", "url(logo.svg?v=2)");
  r.setProperty("--logo-ar", "1.308"); // 573 x 438
})();
