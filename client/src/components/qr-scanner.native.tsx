import { Camera, CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

/** The camera view for the scan tab. `onScan` returns true when the code was taken (it then closes the tab). */
export function NativeQrScanner({ onScan }: { onScan: (raw: string) => boolean }) {
  const [permission, requestPermission] = useCameraPermissions();
  const busy = useRef(false);

  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain) void requestPermission();
    // Ask once when the tab opens; later changes come from the system settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permission?.status]);

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={styles.denied}>
        <Text style={styles.deniedText}>カメラの使用が許可されていません</Text>
        <Pressable role="button" aria-label="設定を開く" style={styles.button} onPress={() => void Linking.openSettings()}>
          <Text style={styles.buttonText}>設定を開く</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <CameraView
      style={StyleSheet.absoluteFill}
      facing="back"
      barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
      onBarcodeScanned={({ data }) => {
        if (busy.current || !data) return;
        busy.current = true;
        const taken = onScan(data);
        // A code that is not a Tegami link: keep scanning, but not on every frame.
        if (!taken) setTimeout(() => (busy.current = false), 1500);
      }}
    />
  );
}

/** Picks a picture and reads a QR code from it. A string when found, null when the picture has none, undefined when cancelled. */
export async function scanQrFromLibrary(): Promise<string | null | undefined> {
  const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
  if (picked.canceled || !picked.assets[0]) return undefined;
  const hits = await Camera.scanFromURLAsync(picked.assets[0].uri, ['qr']);
  return hits[0]?.data ?? null;
}

const styles = StyleSheet.create({
  denied: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  deniedText: { color: '#ffffff', fontSize: 14, textAlign: 'center' },
  button: { minHeight: 44, paddingHorizontal: 18, justifyContent: 'center', borderRadius: 22, backgroundColor: '#ffffff' },
  buttonText: { color: '#000000', fontSize: 15, fontWeight: '600' },
});
