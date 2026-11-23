// Light or dark before the page paints. The site saves its choice as "theme", the developer docs (Starlight)
// as "starlight-theme". Both are written on a switch, so the choice carries over between the two.
// The docs' key wins when it exists, because a switch on the docs side only changes that key.
// Starlight writes "" for "follow the device".
(function () {
  var t;
  try {
    var s = localStorage.getItem('starlight-theme');
    t = s !== null ? s : localStorage.getItem('theme');
  } catch (e) {}
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
})();

// Japanese visitors who land on an English page from outside the site go to the Japanese page.
// "Japanese" means the browser's first language is ja. A choice in the language menu is saved as "lang"
// (site.js) and wins over the browser. Moves inside the site (same-origin referrer) are never redirected,
// so a link to an English page keeps working. No cookie: the privacy policy promises none on tegami.chat.
(function () {
  if (document.documentElement.lang !== 'en') return;
  var ja = document.querySelector('link[rel="alternate"][hreflang="ja"]');
  if (!ja) return;
  var saved;
  try { saved = localStorage.getItem('lang'); } catch (e) {}
  if (saved === 'en') return;
  if (saved !== 'ja' && document.referrer.indexOf(location.origin + '/') === 0) return;
  var first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  if (saved === 'ja' || /^ja(-|$)/i.test(first)) location.replace(new URL(ja.href).pathname + location.search + location.hash);
})();
