import { useEffect, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/constants/theme';
import { openFile, type FileRef } from '@/lib/files';

const WIDTH = 240;
const STAMP_SIDE = 160;

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

/** A stamp (at most `max` x `max`, without a bubble background). */
export function Stamp({
  file,
  max = STAMP_SIDE,
  testID = 'stamp-message',
  onPress,
  onLongPress,
}: {
  file: FileRef;
  max?: number;
  testID?: string;
  onPress?: () => void;
  onLongPress?: () => void;
}) {
  const c = usePalette();
  const [loaded, setLoaded] = useState<{ sha: string; uri: string } | null>(null);
  const [error, setError] = useState<'gone' | 'failed' | null>(null);
  const [w, h] = (file.dim ?? '').split('x').map(Number);
  const scale = w && h ? Math.min(1, max / Math.max(w, h)) : 1;
  const width = w && h ? Math.max(1, Math.round(w * scale)) : max;
  const height = w && h ? Math.max(1, Math.round(h * scale)) : max;

  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    setError(null);
    openFile(`stamp:${file.sha256}`, file)
      .then((blob) => {
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setLoaded({ sha: file.sha256, uri: url });
      })
      .catch((e: Error) => alive && setError(e.message === 'gone' ? 'gone' : 'failed'));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file.url, file.sha256, file.key, file.nonce]);

  const uri = loaded?.sha === file.sha256 ? loaded.uri : null;
  if (error) {
    return (
      <Text style={[styles.note, { color: c.muted }]}>
        {error === 'gone' ? 'スタンプの保存期間（30日）が過ぎました' : 'スタンプを開けませんでした'}
      </Text>
    );
  }
  const webMenu =
    Platform.OS === 'web' && onLongPress
      ? {
          onContextMenu: (e: { preventDefault: () => void }) => {
            e.preventDefault();
            onLongPress();
          },
        }
      : {};
  const image = uri ? (
    Platform.OS === 'web' ? (
      <img
        src={uri}
        alt="スタンプ"
        data-testid={testID}
        {...webMenu}
        style={{ width, height, maxWidth: max, maxHeight: max, objectFit: 'contain', display: 'block' }}
      />
    ) : (
      <Image
        source={{ uri }}
        testID={testID}
        accessibilityLabel="スタンプ"
        style={{ width, height, maxWidth: max, maxHeight: max }}
        resizeMode="contain"
      />
    )
  ) : null;
  if (!onPress && !onLongPress) {
    return <View style={{ width, height }}>{image}</View>;
  }
  return (
    <Pressable
      style={{ width, height }}
      disabled={!uri}
      onPress={() => uri && onPress?.()}
      onLongPress={onLongPress ? () => uri && onLongPress() : undefined}
      {...webMenu}>
      {image}
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

/** A video in a chat bubble: decrypted on this device and played in place. */
export function Video({ id, file }: { id: string; file: FileRef }) {
  const c = usePalette();
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<'gone' | 'failed' | null>(null);

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
        {error === 'gone' ? '動画の保存期間（30日）が過ぎました' : '動画を開けませんでした'}
      </Text>
    );
  }
  if (!uri || Platform.OS !== 'web') {
    return <View style={[styles.videoFrame, { backgroundColor: c.line }]} testID={uri ? 'video-message' : undefined} />;
  }
  return (
    <video
      src={uri}
      controls
      playsInline
      data-testid="video-message"
      style={{ maxWidth: 280, width: '100%', borderRadius: 12, display: 'block' }}
    />
  );
}

function formatBytes(size?: number): string {
  if (!size || size <= 0) return '';
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')}MB`;
}

/** A general file in a chat bubble: shows name and size, and saves the decrypted file. */
export function FileAttachment({ id, file }: { id: string; file: FileRef }) {
  const c = usePalette();
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<'gone' | 'failed' | null>(null);
  const name = file.name || 'ファイル';
  const sizeText = formatBytes(file.size);

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

  async function saveFile() {
    if (Platform.OS !== 'web') return;
    try {
      const href = uri ?? URL.createObjectURL(await openFile(id, file));
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      a.click();
      if (!uri) setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      setError((e as Error).message === 'gone' ? 'gone' : 'failed');
    }
  }

  if (error) {
    return (
      <Text style={[styles.note, { color: c.muted }]}>
        {error === 'gone' ? 'ファイルの保存期間（30日）が過ぎました' : 'ファイルを開けませんでした'}
      </Text>
    );
  }
  return (
    <View style={styles.fileRow} testID="file-message">
      <Text style={[styles.fileName, { color: c.text }]} numberOfLines={1}>
        {sizeText ? `${name}・${sizeText}` : name}
      </Text>
      <Pressable onPress={saveFile} role="button" style={styles.fileSave}>
        <Text style={[styles.fileSaveText, { color: c.accent }]}>保存</Text>
      </Pressable>
    </View>
  );
}

function formatClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

/** A recorded voice message in a chat bubble: decrypted audio player and duration. */
export function Voice({ id, file }: { id: string; file: FileRef }) {
  const c = usePalette();
  const [uri, setUri] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(file.duration ?? 0);
  const [error, setError] = useState<'gone' | 'failed' | null>(null);

  useEffect(() => {
    if (file.duration !== undefined) setDuration(file.duration);
  }, [file.duration]);

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
        {error === 'gone' ? '音声の保存期間（30日）が過ぎました' : '音声を開けませんでした'}
      </Text>
    );
  }
  return (
    <View style={styles.voiceRow} testID={Platform.OS === 'web' ? undefined : 'voice-message'}>
      {uri && Platform.OS === 'web' && (
        <audio
          src={uri}
          controls
          data-testid="voice-message"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (file.duration === undefined && Number.isFinite(d) && d > 0) setDuration(Math.round(d));
          }}
          style={{ maxWidth: 220, height: 36 }}
        />
      )}
      <Text style={[styles.voiceDuration, { color: c.muted }]}>{formatClock(duration)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 12, overflow: 'hidden', maxWidth: '100%' },
  videoFrame: { width: 240, height: 150, borderRadius: 12, overflow: 'hidden', maxWidth: '100%' },
  image: { width: '100%', height: '100%' },
  note: { fontSize: 14, paddingVertical: 4 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 },
  fileName: { fontSize: 15, flexShrink: 1 },
  fileSave: { paddingHorizontal: 6, paddingVertical: 2 },
  fileSaveText: { fontSize: 14, fontWeight: '600' },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  voiceDuration: { fontSize: 13 },
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
