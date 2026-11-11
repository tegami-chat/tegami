// Crash reports, sent only when the person has turned them on in settings.
//
// A report holds the error message and stack with quoted text removed, the app
// version and the platform. It never holds a key, a name or message text. The relay
// writes it to Cloudflare's logs (kept a few days) and stores nothing.

import { Platform } from 'react-native';

import { FILE_SERVER } from './files';

let enabled = false;
let installed = false;
const sent = new Set<string>();

/** Removes anything in quotes and long hex or base64 runs, which could be someone's data. */
export function scrub(text: string, max: number) {
  return text
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '$1…$1')
    .replace(/\b[0-9a-f]{32,}\b/gi, '…')
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '…')
    .slice(0, max);
}

function version() {
  if (typeof document === 'undefined') return 'native';
  const src = [...document.scripts].map((s) => s.src).find((s) => /entry-[0-9a-f]+\.js/.test(s));
  return src?.match(/entry-([0-9a-f]{8})/)?.[1] ?? 'dev';
}

export function report(error: unknown) {
  if (!enabled) return;
  const e = error instanceof Error ? error : new Error(String(error));
  const body = {
    message: scrub(`${e.name}: ${e.message}`, 500),
    stack: scrub(e.stack ?? '', 4000),
    version: version(),
    platform: Platform.OS,
  };
  const key = body.message + body.stack.slice(0, 200);
  if (sent.has(key) || sent.size > 20) return; // the same crash once, and not too many
  sent.add(key);
  // text/plain keeps this a simple request (no preflight).
  fetch(`${FILE_SERVER}/crash`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain' }, keepalive: true }).catch(
    () => {},
  );
}

export function setCrashReports(on: boolean) {
  enabled = on;
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (ev) => report(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', (ev) => report(ev.reason));
}
