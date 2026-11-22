// Making a photo, stamp or avatar smaller on the phone (expo-image-manipulator).
// Same sizes and quality as shrink.ts (the browser version): photos 1600 px JPEG, stamps
// 320 px (PNG when the picture has transparency), avatars a centered square of at most 256 px.

import * as ImageManipulator from 'expo-image-manipulator';
import { Directory, File, Paths } from 'expo-file-system';

import type { Shrunk } from './shrink';

export type { Shrunk };

const MAX_SIDE = 1600;
const AVATAR_SIDE = 256;
const STAMP_SIDE = 320;
const QUALITY = 0.82;

/** Gives the picture a file to be read from (the manipulator takes a file address, not a Blob). */
async function toTempFile(blob: Blob): Promise<File> {
  const dir = new Directory(Paths.cache, 'tegami-shrink');
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  file.create({ overwrite: true });
  file.write(new Uint8Array(await blob.arrayBuffer()));
  return file;
}

/** PNG signature followed by IHDR: byte 25 is the color type (4 = gray+alpha, 6 = RGBA). */
export function pngHasAlpha(head: Uint8Array): boolean {
  return head.length >= 26 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 && (head[25] === 4 || head[25] === 6);
}

async function run(
  blob: Blob,
  plan: (w: number, h: number) => { crop?: { originX: number; originY: number; width: number; height: number }; width: number; height: number; png?: (head: Uint8Array) => boolean },
): Promise<Shrunk> {
  const temp = await toTempFile(blob);
  let out: File | null = null;
  try {
    const base = await ImageManipulator.ImageManipulator.manipulate(temp.uri).renderAsync();
    const p = plan(base.width, base.height);
    const ctx = ImageManipulator.ImageManipulator.manipulate(base);
    if (p.crop) ctx.crop(p.crop);
    ctx.resize({ width: p.width, height: p.height });
    const rendered = await ctx.renderAsync();
    const png = p.png ? p.png(temp.bytesSync().subarray(0, 26)) : false;
    const saved = await rendered.saveAsync({
      format: png ? ImageManipulator.SaveFormat.PNG : ImageManipulator.SaveFormat.JPEG,
      compress: png ? 1 : QUALITY,
    });
    out = new File(saved.uri);
    const bytes = new Uint8Array(await out.bytes()) as Uint8Array<ArrayBuffer>;
    return { bytes, type: png ? 'image/png' : 'image/jpeg', width: saved.width, height: saved.height };
  } finally {
    temp.delete();
    try {
      out?.delete();
    } catch {
      // Already gone.
    }
  }
}

/** Makes a photo smaller (longest side 1600 px, JPEG). */
export function shrinkImage(file: Blob): Promise<Shrunk> {
  return run(file, (w, h) => {
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
  });
}

/** Shrinks a stamp to fit 320x320; PNG when the picture is a PNG with an alpha channel, else JPEG. */
export function shrinkStamp(file: Blob): Promise<Shrunk> {
  return run(file, (w, h) => {
    const scale = Math.min(1, STAMP_SIDE / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), png: pngHasAlpha };
  });
}

/** Crops to a centered square and shrinks to at most 256x256 JPEG. */
export function shrinkAvatar(file: Blob): Promise<Shrunk> {
  return run(file, (w, h) => {
    const short = Math.min(w, h);
    const side = Math.max(1, Math.min(AVATAR_SIDE, short));
    return {
      crop: { originX: Math.floor((w - short) / 2), originY: Math.floor((h - short) / 2), width: short, height: short },
      width: side,
      height: side,
    };
  });
}
