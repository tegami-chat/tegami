// How an account's storage names are made (shared by storage.ts and at-rest.ts).
// The first account keeps the names it always had ("tegami.messages" …); an account added
// later uses "tegami@<id>.messages" and so on.

export const FIRST_ACCOUNT = 'main';

/** The storage name of `name` for an account. */
export function keyFor(id: string, name: string) {
  return id === FIRST_ACCOUNT ? `tegami.${name}` : `tegami@${id}.${name}`;
}
