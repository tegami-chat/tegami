// The light/dark switch and the menus. No tracking of any kind.
// The site saves its choice as "theme" and the developer docs (Starlight) as "starlight-theme".
// Both are written, so the choice carries over between the two.
document.querySelectorAll('[data-theme-set]').forEach((b) => {
  b.addEventListener('click', () => {
    const v = b.dataset.themeSet;
    document.documentElement.classList.toggle('dark', v === 'dark');
    try { localStorage.setItem('theme', v); localStorage.setItem('starlight-theme', v); } catch {}
  });
});
// Without a saved choice, follow the device setting as it changes.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  let saved;
  try { saved = localStorage.getItem('starlight-theme') || localStorage.getItem('theme'); } catch {}
  if (!saved) document.documentElement.classList.toggle('dark', e.matches);
});
// Remember a choice in the language menu, so theme-init.js stops sending this browser to the Japanese pages.
document.querySelectorAll('[data-lang-menu] a[hreflang]').forEach((a) => {
  a.addEventListener('click', () => { try { localStorage.setItem('lang', a.hreflang); } catch {} });
});
// Close the language menu and the phone menu on a click outside them, or on a link inside them.
document.addEventListener('click', (e) => {
  document.querySelectorAll('[data-lang-menu][open], [data-menu][open]').forEach((d) => {
    if (!d.contains(e.target) || e.target.closest('a')) d.removeAttribute('open');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('[data-lang-menu][open], [data-menu][open]').forEach((d) => d.removeAttribute('open'));
});
// The copy buttons: copy the text in data-copy, then show data-done in the label for a moment.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const label = b.querySelector('[data-copy-label]');
  const done = () => {
    if (!label) return;
    if (!label.dataset.orig) label.dataset.orig = label.textContent;
    label.textContent = b.dataset.done;
    clearTimeout(b._t);
    b._t = setTimeout(() => { label.textContent = label.dataset.orig; }, 1800);
  };
  const fallback = () => {
    const a = document.createElement('textarea');
    a.value = b.dataset.copy;
    a.setAttribute('readonly', '');
    a.style.position = 'fixed';
    a.style.opacity = '0';
    document.body.appendChild(a);
    a.select();
    try { if (document.execCommand('copy')) done(); } catch {}
    a.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(b.dataset.copy).then(done, fallback);
  else fallback();
});
