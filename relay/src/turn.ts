// TURN credentials for calls (POST /turn).
//
// Calls go straight between two browsers (WebRTC). When both sit behind strict NATs they cannot
// reach each other, and a TURN server has to relay the media. Tegami uses Cloudflare Realtime
// TURN. Its long-term key (TURN_KEY_ID and TURN_KEY_API_TOKEN, Worker secrets) stays here; the
// relay hands a registered, unstopped key short-lived credentials made from it:
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers
//   Authorization: Bearer <token>, body {"ttl": seconds} → 201 {iceServers: [...]}
// (https://developers.cloudflare.com/realtime/turn/generate-credentials/).
//
// The media stays encrypted end to end (DTLS-SRTP between the two browsers); TURN only forwards
// the encrypted packets. The relay keeps nothing about a request: not who asked, not the
// credentials. Without the secrets the route answers 503 and the app calls with STUN only.

/** How long the credentials work. Cloudflare allows up to 48 hours; a call longer than this needs new ones. */
export const TURN_TTL_SECONDS = 6 * 60 * 60;
/** Per key: 10 at once, then one every 10 minutes. The app keeps credentials for hours, so this is plenty. */
export const TURN_RATE = { burst: 10, perSecond: 1 / 600 };

export type TurnEnv = { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string; TURN_API?: string };

export type IceServer = { urls: string[]; username?: string; credential?: string };

/** Whether this relay can hand out TURN credentials. */
export function turnConfigured(env: TurnEnv) {
  return !!env.TURN_KEY_ID && !!env.TURN_KEY_API_TOKEN;
}

/**
 * Asks Cloudflare for credentials. api: the API's origin (tests use a local stand-in).
 * Returns null when Cloudflare does not answer as expected.
 */
export async function makeTurnCredentials(env: TurnEnv, api = 'https://rtc.live.cloudflare.com'): Promise<IceServer[] | null> {
  let res: Response;
  try {
    res = await fetch(`${api}/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID!)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let json: { iceServers?: unknown };
  try {
    json = await res.json();
  } catch {
    return null;
  }
  return cleanIceServers(json.iceServers);
}

/**
 * Keeps only well-formed entries with stun:, turn: and turns: addresses, and drops port 53:
 * browsers block it and a TURN address there only times out
 * (https://developers.cloudflare.com/realtime/turn/generate-credentials/).
 */
export function cleanIceServers(list: unknown): IceServer[] | null {
  if (!Array.isArray(list)) return null;
  const out: IceServer[] = [];
  for (const s of list.slice(0, 10)) {
    if (!s || typeof s !== 'object') continue;
    const e = s as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(e.urls) ? e.urls : [e.urls])
      .filter((u): u is string => typeof u === 'string' && /^(stun|turns?):/.test(u))
      .filter((u) => !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    const entry: IceServer = { urls };
    if (typeof e.username === 'string' && typeof e.credential === 'string') {
      entry.username = e.username;
      entry.credential = e.credential;
    }
    out.push(entry);
  }
  return out.some((e) => e.username && e.urls.some((u) => u.startsWith('turn'))) ? out : null;
}
