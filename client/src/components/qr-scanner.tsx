// QR scanning on the phone apps lives in qr-scanner.native.tsx. The browser scans in
// app/add.tsx with the camera stream and jsQR, so these are empty here.

export function NativeQrScanner(_props: { onScan: (raw: string) => boolean }) {
  return null;
}

/** Phone apps only. Always "nothing picked" in the browser. */
export async function scanQrFromLibrary(): Promise<string | null | undefined> {
  return undefined;
}
