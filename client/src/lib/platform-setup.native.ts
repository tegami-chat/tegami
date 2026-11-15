// Runs first in the iPhone and Android apps (imported at the top of app/_layout.tsx),
// so the app's code can keep using the browser's names:
//   localStorage            -> expo-sqlite's key-value store (a file in the app's storage)
//   crypto.getRandomValues  -> expo-crypto (the operating system's random numbers)
//   crypto.subtle           -> native-subtle.ts (the WebCrypto calls Tegami makes, with @noble)
//   TextDecoder, DOMException where the JavaScript engine lacks them.
// The browser build uses platform-setup.ts, which adds nothing.

import 'expo-sqlite/localStorage/install';
import { getRandomValues } from 'expo-crypto';

import { nativeSubtle } from './native-subtle';

const g = globalThis as unknown as {
  crypto?: { getRandomValues?: unknown; subtle?: unknown };
  TextDecoder?: unknown;
  DOMException?: unknown;
};

g.crypto ??= {};
if (typeof g.crypto.getRandomValues !== 'function') g.crypto.getRandomValues = getRandomValues;
if (!g.crypto.subtle) g.crypto.subtle = nativeSubtle;

if (typeof g.DOMException !== 'function') {
  // gate.tsx checks `e instanceof DOMException` for a cancelled passkey prompt.
  g.DOMException = class DOMException extends Error {
    constructor(message?: string, name?: string) {
      super(message);
      this.name = name ?? 'Error';
    }
  };
}

if (typeof g.TextDecoder !== 'function') {
  // UTF-8 only, which is all the app decodes.
  g.TextDecoder = class TextDecoder {
    decode(input?: ArrayBuffer | ArrayBufferView) {
      if (!input) return '';
      const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = '';
      for (let i = 0; i < b.length; ) {
        const c = b[i++];
        let cp = c;
        if (c >= 0xf0) cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 0xe0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 0xc0) cp = ((c & 31) << 6) | (b[i++] & 63);
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  };
}
