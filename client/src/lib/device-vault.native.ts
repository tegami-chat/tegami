// iPhone and Android: keeps the Nostr secret key on this device when no passkey protects it.
// Same job as device-vault.ts in the browser, where a non-extractable AES key sits in
// IndexedDB. Here a random AES-256 key sits in the Keychain (iPhone) or is protected by the
// Keystore (Android) through expo-secure-store, readable only while the phone is unlocked
// and never copied to another device or a backup (…THIS_DEVICE_ONLY). The encrypted Nostr
// key itself stays in the app's storage under the same name as in the browser.

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import * as SecureStore from 'expo-secure-store';

import { fromB64u, toB64u } from './vault';

export type DeviceVault = { v: 2; kind: 'device'; iv: string; ciphertext: string };

const KEY_ID = 'tegami.device-key';
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

async function deviceKey(create: boolean): Promise<Uint8Array | null> {
  const found = await SecureStore.getItemAsync(KEY_ID, OPTIONS);
  if (found) return hexToBytes(found);
  if (!create) return null;
  const key = crypto.getRandomValues(new Uint8Array(32));
  await SecureStore.setItemAsync(KEY_ID, bytesToHex(key), OPTIONS);
  return key;
}

export function deviceVaultAvailable() {
  return true;
}

export async function createDeviceVault(secret: Uint8Array<ArrayBuffer>): Promise<DeviceVault> {
  const key = (await deviceKey(true))!;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = gcm(key, iv).encrypt(secret);
  return { v: 2, kind: 'device', iv: toB64u(iv), ciphertext: toB64u(ct) };
}

export async function openDeviceVault(vault: DeviceVault): Promise<Uint8Array> {
  const key = await deviceKey(false);
  if (!key) throw new Error('device key missing');
  return gcm(key, fromB64u(vault.iv)).decrypt(fromB64u(vault.ciphertext));
}
