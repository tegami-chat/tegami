// Browser: proving it is the owner before the secret key is written out. Only a passkey can do
// that here (the device vault has no prompt), so without one the export is not offered.

import { unlockVault, type Vault } from './vault';

export function canVerifyOwner(vault: Vault | null) {
  return !!vault;
}

/** Asks for the passkey again and checks it opens the same key that is open now. */
export async function verifyOwner(vault: Vault | null, secret: Uint8Array): Promise<boolean> {
  if (!vault) return false;
  const again = await unlockVault(vault);
  return again.length === secret.length && again.every((v, i) => v === secret[i]);
}
