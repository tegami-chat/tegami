// QR codes for `tegami-agent pair`: in the terminal, and as a small local web page.

import makeQr from 'qrcode-generator';

function matrix(text) {
  const qr = makeQr(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return { n, dark: (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c) };
}

/**
 * The QR code drawn with half blocks, two rows of modules per line, with a quiet zone.
 * Light modules are drawn as blocks, so on a dark terminal the code reads dark on light.
 */
export function qrTerminal(text, quiet = 2) {
  const { n, dark } = matrix(text);
  const lines = [];
  for (let r = -quiet; r < n + quiet; r += 2) {
    let line = '';
    for (let c = -quiet; c < n + quiet; c++) {
      const top = !dark(r, c);
      const bottom = r + 1 < n + quiet ? !dark(r + 1, c) : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** The QR code as SVG (black on white). */
export function qrSvg(text, cell = 8, quiet = 4) {
  const { n, dark } = matrix(text);
  const size = (n + quiet * 2) * cell;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (dark(r, c)) path += `M${(c + quiet) * cell} ${(r + quiet) * cell}h${cell}v${cell}h-${cell}z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A page with the QR code, opened in the browser by `pair --browser`. Deleted when pairing ends. */
export function qrHtml(text, name, until) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tegami: ${esc(name)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f1e8;color:#111;display:flex;flex-direction:column;align-items:center;gap:16px;padding:32px}svg{max-width:90vw;height:auto}p{margin:0}</style>
</head><body>
<h1>${esc(name)}</h1>
${qrSvg(text)}
<p>Tegami: 友だち追加 &gt; QRコードスキャン</p>
<p>Works once, until ${esc(until)}.</p>
</body></html>
`;
}
