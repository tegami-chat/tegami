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
// Close the language menu and the phone menu on a click outside them, or on a link inside them.
document.addEventListener('click', (e) => {
  document.querySelectorAll('[data-lang-menu][open], [data-menu][open]').forEach((d) => {
    if (!d.contains(e.target) || e.target.closest('a')) d.removeAttribute('open');
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('[data-lang-menu][open], [data-menu][open]').forEach((d) => d.removeAttribute('open'));
});
