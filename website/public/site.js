// The light/dark switch and the language menu. No tracking of any kind.
document.querySelectorAll('[data-theme-set]').forEach((b) => {
  b.onclick = () => {
    const dark = b.dataset.themeSet === 'dark';
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('tegami.theme', b.dataset.themeSet); } catch {}
  };
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  let t;
  try { t = localStorage.getItem('tegami.theme'); } catch {}
  if (!t) document.documentElement.classList.toggle('dark', e.matches);
});
document.addEventListener('click', (e) => {
  document.querySelectorAll('[data-lang-menu][open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
});
