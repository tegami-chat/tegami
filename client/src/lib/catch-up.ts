// Reading a whole mailbox from the relay.
//
// One answer from the relay holds at most 1,000 envelopes (and 4 MB), newest first, then EOSE. A mailbox can
// hold 10,000. So after the first answer the app asks again with `until` set to the oldest time it has seen,
// and goes on until an answer brings nothing it has not seen. The oldest envelope comes back each time
// (`until` includes its own second), which is how the app knows the end was reached without being told.
// When the relay says it is rate-limited (it gives each key a budget of rows), the app waits and asks again.

export type Page = { events: { id: string; created_at: number }[]; closed: string | null };

export type CatchUp = {
  /** Ids already handed to the app (the first answer); new ones are added as pages arrive. */
  seen: Set<string>;
  /** The oldest created_at among them. */
  oldest: number;
  /** Asks the relay for one page: the same filter with `until`. Resolves at EOSE or CLOSED. */
  page: (until: number) => Promise<Page>;
  wait?: (ms: number) => Promise<void>;
  /** True when the app is shutting down. */
  stopped?: () => boolean;
  /** Pages at most (a safety stop). 1,000 envelopes each: 60 pages is 60,000. */
  maxPages?: number;
  /** How long to wait after "rate-limited", and how many times in a row before giving up. */
  retryMs?: number;
  maxRetries?: number;
};

/** Returns how many envelopes were added after the first answer. */
export async function catchUp(c: CatchUp): Promise<number> {
  const wait = c.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxPages = c.maxPages ?? 60;
  const retryMs = c.retryMs ?? 6000;
  const maxRetries = c.maxRetries ?? 40;
  let added = 0;
  let oldest = c.oldest;
  let retries = 0;
  for (let pages = 0; pages < maxPages; ) {
    if (c.stopped?.()) return added;
    const res = await c.page(oldest);
    if (res.closed !== null) {
      // The relay refused this page. A budget that has run out fills up again; anything else is final.
      if (!res.closed.startsWith('rate-limited') || ++retries > maxRetries) return added;
      await wait(retryMs);
      continue;
    }
    retries = 0;
    pages++;
    let fresh = 0;
    for (const e of res.events) {
      if (c.seen.has(e.id)) continue;
      c.seen.add(e.id);
      fresh++;
      if (e.created_at < oldest) oldest = e.created_at;
    }
    added += fresh;
    if (!fresh) return added;
  }
  return added;
}
