import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/constants/theme';
import { openFile, type FileRef } from '@/lib/files';

const WIDTH = 240;

/** A photo in a chat bubble: decrypted on this device, kept on this device. */
export function Photo({ id, file }: { id: string; file: FileRef }) {
  const c = usePalette();
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<'gone' | 'failed' | null>(null);
  const [w, h] = (file.dim ?? '').split('x').map(Number);
  const height = w && h ? Math.round((WIDTH * h) / w) : WIDTH;

  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    openFile(id, file)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setUri(url);
      })
      .catch((e: Error) => alive && setError(e.message === 'gone' ? 'gone' : 'failed'));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, file]);

  if (error) {
    return (
      <Text style={[styles.note, { color: c.muted }]}>
        {error === 'gone' ? '写真の保存期間（30日）が過ぎました' : '写真を開けませんでした'}
      </Text>
    );
  }
  return (
    <View style={[styles.frame, { width: WIDTH, height, backgroundColor: c.line }]}>
      {uri && <Image source={{ uri }} style={styles.image} accessibilityLabel="写真" resizeMode="cover" />}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 12, overflow: 'hidden', maxWidth: '100%' },
  image: { width: '100%', height: '100%' },
  note: { fontSize: 14, paddingVertical: 4 },
});
