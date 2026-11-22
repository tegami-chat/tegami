// iPhone and Android: proving it is the owner before the secret key is written out. A Keychain /
// Keystore item made with requireAuthentication asks for Face ID, fingerprint or the device
// passcode each time it is read; reading it successfully is the proof.

import * as SecureStore from 'expo-secure-store';

import type { Vault } from './vault';

const GATE_ID = 'tegami.export-gate';
const PROMPT = '秘密鍵を書き出す前に、本人か確かめます';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: true,
  authenticationPrompt: PROMPT,
};

export function canVerifyOwner(_vault: Vault | null) {
  try {
    return SecureStore.canUseBiometricAuthentication();
  } catch {
    return false;
  }
}

export async function verifyOwner(_vault: Vault | null, _secret: Uint8Array): Promise<boolean> {
  if (!canVerifyOwner(null)) return false;
  let found = await SecureStore.getItemAsync(GATE_ID, OPTIONS);
  if (found === null) {
    // First time, or the item was dropped when the enrolled fingerprints or face changed.
    await SecureStore.setItemAsync(GATE_ID, 'gate', OPTIONS);
    found = await SecureStore.getItemAsync(GATE_ID, OPTIONS);
  }
  return found === 'gate';
}
