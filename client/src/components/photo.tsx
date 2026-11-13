import { useEffect, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/constants/theme';
import { openFile, type FileRef } from '@/lib/files';

const WIDTH = 240;

/** A photo in a chat bubble: decrypted on this device, kept on this device. */
export function Photo({ id, file, onOpen }: { id: string; file: FileRef; onOpen?: (uri: string) => void }) {
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
    <Pressable
      style={[styles.frame, { width: WIDTH, height, backgroundColor: c.line }]}
      disabled={!uri || !onOpen}
      onPress={() => uri && onOpen?.(uri)}>
      {uri && <Image source={{ uri }} style={styles.image} accessibilityLabel="写真" resizeMode="cover" />}
    </Pressable>
  );
}

/** Shows a decrypted photo full screen over the chat, with save and close controls. */
export function PhotoViewer({ uri, onClose }: { uri: string; onClose: () => void }) {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function savePhoto() {
    if (Platform.OS !== 'web') return;
    const a = document.createElement('a');
    a.href = uri;
    a.download = `tegami-${new Date().toISOString().slice(0, 10)}.jpg`;
    a.click();
  }

  return (
    <View style={styles.viewer}>
      <View style={styles.viewerBar}>
        <Pressable onPress={savePhoto} role="button" style={styles.viewerButton}>
          <Text style={styles.viewerButtonText}>保存</Text>
        </Pressable>
        <Pressable onPress={onClose} role="button" style={styles.viewerButton}>
          <Text style={styles.viewerButtonText}>閉じる</Text>
        </Pressable>
      </View>
      <Image source={{ uri }} style={styles.fullImage} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 12, overflow: 'hidden', maxWidth: '100%' },
  image: { width: '100%', height: '100%' },
  note: { fontSize: 14, paddingVertical: 4 },
  viewer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
    justifyContent: 'center',
  },
  viewerBar: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 101,
    flexDirection: 'row',
    gap: 12,
  },
  viewerButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  viewerButtonText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  fullImage: { width: '100%', height: '100%' },
});
