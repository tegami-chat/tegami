// The table of contents of the document pages (/how /status /compare /faq): marks the section being read
// (aria-current="true" on its link) and folds the phone version of the list after a link is used. No tracking, no requests.
(() => {
  const links = [...document.querySelectorAll('[data-doc-toc] a[href^="#"]')];
  if (!links.length) return;
  const ids = [...new Set(links.map((a) => a.getAttribute('href').slice(1)))];
  const sections = ids.map((id) => document.getElementById(id)).filter(Boolean);
  if (!sections.length) return;
  let current = '';
  const mark = (id) => {
    if (id === current) return;
    current = id;
    links.forEach((a) => {
      if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'true');
      else a.removeAttribute('aria-current');
    });
  };
  const update = () => {
    // The last section whose top has passed a line in the upper third of the window; at the very bottom of the page, the last one.
    let id = sections[0].id;
    for (const s of sections) if (s.getBoundingClientRect().top <= Math.max(140, innerHeight * 0.3)) id = s.id;
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) id = sections[sections.length - 1].id;
    mark(id);
  };
  let queued = false;
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; update(); }); } };
  addEventListener('scroll', queue, { passive: true });
  addEventListener('resize', queue);
  addEventListener('hashchange', queue);
  update();
  document.querySelectorAll('details[data-doc-toc] a').forEach((a) => a.addEventListener('click', () => a.closest('details').removeAttribute('open')));
})();
