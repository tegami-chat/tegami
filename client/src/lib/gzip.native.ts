// gzip for the history files on the phone apps (Hermes has no CompressionStream). fflate
// makes and reads standard gzip, the same bytes the browser's CompressionStream makes.

import { gunzipSync, gzipSync } from 'fflate';

export function canGzip(): boolean {
  return true;
}

export async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return gzipSync(bytes) as Uint8Array<ArrayBuffer>;
}

export async function gunzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return gunzipSync(bytes) as Uint8Array<ArrayBuffer>;
}
