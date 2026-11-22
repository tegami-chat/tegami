// The picture or video a person picked in the photo picker, as a Blob.
// fetch(uri).blob() answers "File not found" for the picker's copy on Android, so the
// file is read in place with expo-file-system: its File is a Blob that remembers its uri,
// which lets shrink.native.ts give the same uri to the image manipulator.

import { File } from 'expo-file-system';

export async function pickedBlob(asset: { uri: string; file?: Blob }): Promise<Blob> {
  return asset.file ?? new File(asset.uri);
}
