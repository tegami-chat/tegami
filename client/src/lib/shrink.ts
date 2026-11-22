// Making a photo, stamp or avatar smaller on this device before it is encrypted and sent.
// The browser version (canvas). The phone apps use shrink.native.ts (expo-image-manipulator).

export type Shrunk = { bytes: Uint8Array<ArrayBuffer>; type: string; width: number; height: number };

const MAX_SIDE = 1600;
const AVATAR_SIDE = 256;
const STAMP_SIDE = 320;
const QUALITY = 0.82;

/** Makes a photo smaller (longest side 1600 px, JPEG). Philosophy #97: small by default. */
export async function shrinkImage(file: Blob): Promise<Shrunk> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not encode the photo'))), 'image/jpeg', QUALITY),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', width, height };
}

/** Whether the image has an alpha channel (transparent pixels, or a PNG with alpha). */
async function hasAlpha(file: Blob, ctx: CanvasRenderingContext2D, width: number, height: number): Promise<boolean> {
  const rgba = ctx.getImageData(0, 0, width, height).data;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) return true;
  }
  const head = new Uint8Array(await file.slice(0, 26).arrayBuffer());
  // PNG signature followed by IHDR: byte 25 is the color type (4 = gray+alpha, 6 = RGBA).
  if (head.length >= 26 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return head[25] === 4 || head[25] === 6;
  }
  return false;
}

/** Shrinks a stamp to fit 320x320; outputs PNG when the input has an alpha channel, else JPEG. */
export async function shrinkStamp(file: Blob): Promise<Shrunk> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, STAMP_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const alpha = await hasAlpha(file, ctx, width, height);
  const type = alpha ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not encode the stamp'))), type, alpha ? undefined : QUALITY),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type, width, height };
}

/** Crops to a centered square and shrinks to at most 256x256 JPEG. */
export async function shrinkAvatar(file: Blob): Promise<Shrunk> {
  const bitmap = await createImageBitmap(file);
  const short = Math.min(bitmap.width, bitmap.height);
  const side = Math.max(1, Math.min(AVATAR_SIDE, short));
  const sx = Math.floor((bitmap.width - short) / 2);
  const sy = Math.floor((bitmap.height - short) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, short, short, 0, 0, side, side);
  bitmap.close();
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error('could not encode the avatar'))), 'image/jpeg', QUALITY),
  );
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: 'image/jpeg', width: side, height: side };
}
