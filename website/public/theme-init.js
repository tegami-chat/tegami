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
