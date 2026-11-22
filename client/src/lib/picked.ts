// The picture or video a person picked in the photo picker, as a Blob.
// The browser's picker hands over the file itself. The phone apps use picked.native.ts.

export async function pickedBlob(asset: { uri: string; file?: Blob }): Promise<Blob> {
  return asset.file ?? (await (await fetch(asset.uri)).blob());
}
