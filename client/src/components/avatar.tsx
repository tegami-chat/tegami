import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/constants/theme';
import { openFile, type FileRef } from '@/lib/files';

/** A round avatar, or a round placeholder with the first character of the name. */
export function Avatar({ name, file, size = 36 }: { name: string; file?: FileRef | null; size?: number }) {
  const c = usePalette();
  const [loaded, setLoaded] = useState<{ sha: string; uri: string } | null>(null);

  useEffect(() => {
    if (!file) {
      setLoaded(null);
      return;
    }
    let url: string | null = null;
    let alive = true;
    openFile(`avatar:${file.sha256}`, file)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setLoaded({ sha: file.sha256, uri: url });
      })
      .catch(() => alive && setLoaded(null));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file?.url, file?.sha256, file?.key, file?.nonce]);

  const uri = file && loaded?.sha === file.sha256 ? loaded.uri : null;
  if (uri) {
    if (Platform.OS === 'web') {
      return (
        <img
          src={uri}
          alt=""
          data-testid="avatar-img"
          style={{ width: size, height: size, borderRadius: size / 2, objectFit: 'cover', display: 'block', flexShrink: 0 }}
        />
      );
    }
    return (
      <Image
        source={{ uri }}
        testID="avatar-img"
        style={{ width: size, height: size, borderRadius: size / 2 }}
        resizeMode="cover"
      />
    );
  }

  const initial = (name || '?').slice(0, 1);
  return (
    <View
      testID="avatar-initial"
      style={[styles.placeholder, { width: size, height: size, borderRadius: size / 2, backgroundColor: c.accent }]}>
      {initial === '◎' ? (
        <MaterialIcons name="group" size={Math.round(size * 0.5)} color="#ffffff" />
      ) : (
        <Text style={[styles.initial, { fontSize: Math.round(size * 0.44) }]}>{initial}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  initial: { color: '#ffffff', fontWeight: '600' },
});
