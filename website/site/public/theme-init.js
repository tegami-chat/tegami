// Light or dark before the page paints: the saved choice, otherwise the device setting.
(function () {
  var t;
  try { t = localStorage.theme; } catch (e) {}
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
})();
