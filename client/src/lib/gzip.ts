// gzip for the history files. The browser version (CompressionStream). The phone apps use
// gzip.native.ts (fflate), which makes and reads the same gzip bytes.

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** Whether this device can make gzip (when not, history files go out uncompressed). */
export function canGzip(): boolean {
  return typeof CompressionStream !== 'undefined';
}

export async function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return (await pipe(bytes, new CompressionStream('gzip'))) as Uint8Array<ArrayBuffer>;
}

export async function gunzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return (await pipe(bytes, new DecompressionStream('gzip'))) as Uint8Array<ArrayBuffer>;
}
