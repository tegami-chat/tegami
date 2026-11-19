// The status page (tegami.chat/status): does the relay answer, and the weekly usage numbers.
// Reads two public documents from the relay: its NIP-11 document (every 60 seconds, small
// and static) and /stats (once, already rounded by the relay). Sends nothing else anywhere.
(() => {
  const RELAY = 'https://relay.tegami.chat';
  const REPO = 'https://github.com/tegami-chat/tegami';
  const lang = document.documentElement.lang === 'ja' ? 'ja' : 'en';
  const locale = lang === 'ja' ? 'ja-JP' : 'en-US';
  const S = {
    en: {
      checking: 'Checking the relay', up: 'The relay is responding', down: 'The relay is not responding',
      none: 'Unavailable', under10: 'under 10', more: 'Show all weeks', less: 'Show the last 8 weeks only',
      empty: 'No week has finished yet. The first figures appear after {date}, 00:00 UTC.',
      period: 'Period: {from} to {to} (UTC)',
      tabs: { envelopes: 'Envelopes', logins: 'Logins', keys: 'Accounts' },
      cols: { envelopes: 'Envelopes', files: 'Files', logins: 'Logins', keys: 'Accounts per day (est.)' },
    },
    ja: {
      checking: 'リレーを確認しています', up: 'リレーは応答しています', down: 'リレーから応答がありません',
      none: '取得できませんでした', under10: '10未満', more: 'すべての週を表示', less: '直近8週だけを表示',
      empty: '集計が終わった週はまだありません。最初の数値は、{date}の日本時間9時（UTC 0時）以降に表示します。',
      period: '対象期間：{from}〜{to}（UTC）',
      tabs: { envelopes: '封筒', logins: 'ログイン', keys: 'アカウント' },
      cols: { envelopes: '封筒の数', files: 'ファイルの数', logins: 'ログインの回数', keys: '1日あたりのアカウント数（推定）' },
    },
  }[lang];
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat(locale);
  const show = (n) => (n === 0 ? S.under10 : nf.format(n));

  // Weeks are UTC, so their dates are shown in UTC. The last check is shown in the visitor's
  // own time, with the time zone named (日本時間 in Japan).
  const parts = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  };
  const plusDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // A range like 2026年11月16日〜22日, 2026年11月30日〜12月6日, 2026年12月28日〜2027年1月3日.
  function range(fromIso, toIso) {
    const a = parts(fromIso), b = parts(toIso);
    if (lang === 'ja') {
      const end = a.y !== b.y ? `${b.y}年${b.m}月${b.d}日` : a.m !== b.m ? `${b.m}月${b.d}日` : `${b.d}日`;
      return `${a.y}年${a.m}月${a.d}日〜${end}`;
    }
    if (a.y !== b.y) return `${MON[a.m - 1]} ${a.d}, ${a.y}–${MON[b.m - 1]} ${b.d}, ${b.y}`;
    return `${MON[a.m - 1]} ${a.d}–${a.m !== b.m ? MON[b.m - 1] + ' ' : ''}${b.d}, ${a.y}`;
  }
  const weekRange = (iso) => range(iso, plusDays(iso, 6));
  const short = (iso) => { const p = parts(iso); return lang === 'ja' ? `${p.m}/${p.d}` : `${MON[p.m - 1]} ${p.d}`; };
  const longDate = (iso) => { const p = parts(iso); return lang === 'ja' ? `${p.y}年${p.m}月${p.d}日` : `${MON[p.m - 1]} ${p.d}, ${p.y}`; };

  function checkedAt() {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const text = now.toLocaleString(locale, { year: 'numeric', month: lang === 'ja' ? 'long' : 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (tz === 'Asia/Tokyo') return text + (lang === 'ja' ? '（日本時間）' : ' (JST)');
    const name = new Intl.DateTimeFormat(locale, { timeZoneName: 'short' }).formatToParts(now).find((p) => p.type === 'timeZoneName')?.value;
    if (!name) return text;
    return lang === 'ja' ? `${text}（${name}）` : `${text} (${name})`;
  }

  function setCommit(c) {
    const el = $('commit');
    if (c && /^[0-9a-f]{7,40}$/.test(c)) el.innerHTML = `<a class="font-mono underline" href="${REPO}/commit/${c}" target="_blank" rel="noopener">${c.slice(0, 7)}<svg viewBox="0 0 24 24" class="ml-1 inline-block h-[0.85em] w-[0.85em] align-[-0.1em]" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg><span class="sr-only">${lang === 'ja' ? '（新しいタブで開きます）' : ' (opens in a new tab)'}</span></a>`;
    else el.textContent = S.none;
  }

  // Only says whether the relay answers its information request; it does not test sending.
  async function ping() {
    const t0 = performance.now();
    try {
      const res = await fetch(RELAY + '/', { headers: { Accept: 'application/nostr+json' }, cache: 'no-store' });
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      $('banner').className = 'mt-10 flex items-center gap-3 rounded-2xl border border-forest-600/30 bg-forest-50 px-5 py-4 dark:border-forest-300/30 dark:bg-forest-950';
      $('dot').className = 'h-3 w-3 shrink-0 rounded-full bg-forest-600 dark:bg-forest-300';
      $('state').textContent = S.up;
      $('rtt').textContent = ms + ' ms';
      $('nips').textContent = (j.supported_nips || []).map((n) => String(n).padStart(2, '0')).join(', ');
      setCommit(j.version);
    } catch {
      $('banner').className = 'mt-10 flex items-center gap-3 rounded-2xl border border-red-300 bg-red-50 px-5 py-4 dark:border-red-400/40 dark:bg-red-950/40';
      $('dot').className = 'h-3 w-3 shrink-0 rounded-full bg-red-500';
      $('state').textContent = S.down;
      $('rtt').textContent = '—';
    }
    $('checked').textContent = checkedAt();
  }

  let weeks = [];
  let all = false;
  // Sample numbers are for drafts only, never on the real site.
  const sample = location.hostname !== 'tegami.chat' && new URLSearchParams(location.search).get('sample');

  async function load() {
    if (sample) {
      $('sample-bar').hidden = false;
      weeks = [['2026-11-16', 120, 0, 90, 10], ['2026-11-23', 340, 20, 210, 20], ['2026-11-30', 0, 0, 40, 0], ['2026-12-07', 980, 60, 540, 50], ['2026-12-14', 1520, 90, 860, 80], ['2026-12-21', 1740, 110, 990, 90], ['2026-12-28', 1610, 100, 930, 90], ['2027-01-04', 2050, 130, 1180, 110], ['2027-01-11', 2210, 140, 1250, 120]]
        .map(([week, envelopes, files, logins, keys]) => ({ week, envelopes, files, logins, keys }));
    } else {
      try {
        const data = await (await fetch(RELAY + '/stats')).json();
        if (Array.isArray(data.weeks)) weeks = data.weeks.slice().reverse();
      } catch {}
    }
    render();
  }

  function nextMonday() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
    return d.toISOString().slice(0, 10);
  }

  function render() {
    const has = weeks.length > 0;
    $('empty').hidden = has;
    $('empty').textContent = S.empty.replace('{date}', longDate(nextMonday()));
    $('chart-box').hidden = !has;
    $('table-wide').classList.toggle('sm:block', has);
    $('period').textContent = has ? S.period.replace('{from}', longDate(weeks[0].week)).replace('{to}', longDate(plusDays(weeks[weeks.length - 1].week, 6))) : '';
    const list = weeks.slice().reverse();
    const shown = all ? list : list.slice(0, 8);
    const keys = ['envelopes', 'files', 'logins', 'keys'];
    $('rows').innerHTML = shown.map((w) => `<tr class="border-t border-neutral-200 dark:border-night-line">
      <td class="py-2.5 pr-3">${weekRange(w.week)}</td>${keys.map((k, i) => `<td class="${i === 3 ? 'py-2.5 pl-3' : 'px-3 py-2.5'} text-right">${show(w[k])}</td>`).join('')}</tr>`).join('');
    $('cards').innerHTML = shown.map((w) => `<li class="border-t border-neutral-200 py-3 text-sm dark:border-night-line">
      <div class="font-semibold">${weekRange(w.week)}</div>
      <dl class="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 tabular-nums">${keys.map((k) => `<div><dt class="text-xs text-neutral-600 dark:text-neutral-400">${S.cols[k]}</dt><dd class="font-semibold">${show(w[k])}</dd></div>`).join('')}</dl></li>`).join('');
    $('more').hidden = list.length <= 8;
    $('more').textContent = all ? S.less : S.more;
    if (has && !$('charts').children.length) {
      $('charts').innerHTML = Object.entries(S.tabs).map(([m, label]) => `<section class="rounded-xl border border-neutral-200 p-4 dark:border-night-line"><h3 class="text-base font-bold">${label}</h3><svg data-chart="${m}" class="mt-2 w-full" viewBox="0 0 600 200" role="img" aria-label="${S.cols[m]}"></svg></section>`).join('');
    }
    if (has) draw();
  }

  // Bars with the top value. A week under 10 is a short, faint bar that stays visible
  // (at least 6 px high) even when other weeks are much larger.
  function draw() {
    document.querySelectorAll('[data-chart]').forEach((svg) => drawOne(svg, svg.dataset.chart));
  }
  function drawOne(svg, metric) {
    // Drawn at the real width, so the labels keep their size on a phone.
    const W = Math.max(280, Math.round(svg.getBoundingClientRect().width) || 600), H = 200, top = 18, bottom = 24;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const vals = weeks.map((w) => w[metric]);
    const max = Math.max(20, ...vals);
    const plot = H - top - bottom;
    const y = (v) => top + plot - (v / max) * plot;
    const bw = W / weeks.length;
    const dark = document.documentElement.classList.contains('dark');
    const fill = dark ? '#7fd7a8' : '#106c4a', faint = dark ? '#2c3430' : '#d4d4d4', label = dark ? '#9aa39e' : '#525252';
    let out = `<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="${faint}"/>`;
    out += `<line x1="0" x2="${W}" y1="${y(max)}" y2="${y(max)}" stroke="${faint}" stroke-dasharray="4 4"/><text x="2" y="${y(max) - 4}" font-size="13" fill="${label}">${nf.format(max)}</text>`;
    const step = Math.ceil(weeks.length / Math.max(3, Math.floor(W / 70)));
    weeks.forEach((w, i) => {
      const v = w[metric];
      const small = v === 0;
      const h = small ? Math.max(6, (y(0) - y(10)) * 0.5) : Math.max(6, y(0) - y(v));
      const x = i * bw + bw * 0.18;
      out += `<rect x="${x}" y="${y(0) - h}" width="${bw * 0.64}" height="${h}" rx="3" fill="${fill}" opacity="${small ? 0.35 : 1}"><title>${weekRange(w.week)}: ${show(v)}</title></rect>`;
      // Keep the first and last dates inside the chart.
      if (i % step === 0) out += `<text x="${Math.min(W - 24, Math.max(24, x + bw * 0.32))}" y="${H - 6}" text-anchor="middle" font-size="13" fill="${label}">${short(w.week)}</text>`;
    });
    svg.innerHTML = out;
  }

  $('more').addEventListener('click', () => { all = !all; render(); });
  // Redraw the chart in the new colors when the light/dark switch is used.
  new MutationObserver(() => { if (weeks.length) draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  // Redraw when the width changes (turning the phone, resizing the window).
  let lastWidth = 0;
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width);
    if (w && w !== lastWidth && weeks.length) { lastWidth = w; draw(); }
  }).observe($('charts'));

  $('state').textContent = S.checking;
  ping();
  load();
  setInterval(ping, 60000);
})();
