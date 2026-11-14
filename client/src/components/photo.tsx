import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect, useRef, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/constants/theme';
import { keptFile, openFile, type FileRef } from '@/lib/files';

const WIDTH = 240;
const STAMP_SIDE = 160;
const FILE_TTL_SEC = 30 * 24 * 60 * 60;
const WAVE_BARS = 30;
const FALLBACK_WAVE: number[] = Array.from({ length: WAVE_BARS }, (_, i) => 0.3 + 0.35 * Math.abs(Math.sin((i + 1) * 0.7)));
const waveCache = new Map<string, number[]>();

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

/** Shows a decrypted photo full screen over the chat; long press (or right click) offers save. */
export function PhotoViewer({ uri, onClose }: { uri: string; onClose: () => void }) {
  const c = usePalette();
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function savePhoto() {
    setMenu(false);
    if (Platform.OS !== 'web') return;
    const a = document.createElement('a');
    a.href = uri;
    a.download = `tegami-${new Date().toISOString().slice(0, 10)}.jpg`;
    a.click();
  }

  const webMenu =
    Platform.OS === 'web'
      ? {
          onContextMenu: (e: { preventDefault: () => void }) => {
            e.preventDefault();
            setMenu(true);
          },
        }
      : {};

  return (
    <View style={styles.viewer} testID="photo-viewer">
      <Pressable
        onPress={onClose}
        role="button"
        aria-label="閉じる"
        aria-hidden={menu || undefined}
        style={styles.viewerClose}>
        <MaterialIcons name="close" size={24} color="#ffffff" />
      </Pressable>
      <Pressable
        style={styles.fullImageWrap}
        testID="viewer-photo"
        delayLongPress={400}
        onLongPress={() => setMenu(true)}
        {...webMenu}>
        <Image source={{ uri }} style={styles.fullImage} resizeMode="contain" />
      </Pressable>
      {menu && (
        <View style={styles.viewerMenuBackdrop} role="dialog" aria-modal={true}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenu(false)} />
          <View style={[styles.viewerMenu, { backgroundColor: c.surface, borderColor: c.line }]}>
            <Pressable role="button" onPress={savePhoto} style={styles.viewerMenuItem}>
              <Text style={[styles.viewerMenuText, { color: c.text }]}>保存</Text>
            </Pressable>
            <Pressable
              role="button"
              onPress={() => setMenu(false)}
              style={[styles.viewerMenuItem, styles.viewerMenuLine, { borderTopColor: c.line }]}>
              <Text style={[styles.viewerMenuText, { color: c.text }]}>閉じる</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

/** Shows a decrypted video full screen with native controls and sound. */
export function VideoViewer({ uri, onClose }: { uri: string; onClose: () => void }) {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <View style={styles.viewer} testID="video-viewer">
      <Pressable onPress={onClose} role="button" aria-label="閉じる" style={styles.viewerClose}>
        <MaterialIcons name="close" size={24} color="#ffffff" />
      </Pressable>
      {Platform.OS === 'web' && (
        <video
          src={uri}
          controls
          autoPlay
          playsInline
          style={{ width: '100%', height: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      )}
    </View>
  );
}

/** A video in the chat: plays muted and looped while on screen; tapping opens the full-screen player. */
export function Video({ id, file, onOpen }: { id: string; file: FileRef; onOpen?: (uri: string) => void }) {
  const c = usePalette();
  const [uri, setUri] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(file.duration ?? 0);
  const [error, setError] = useState<'gone' | 'failed' | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inViewRef = useRef(true);

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

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !uri || Platform.OS !== 'web') return;
    el.defaultMuted = true;
    el.muted = true;
    el.loop = true;
    el.playsInline = true;
    const tryPlay = () => {
      el.muted = true;
      void el.play().catch(() => {});
    };
    if (typeof IntersectionObserver === 'undefined') {
      inViewRef.current = true;
      tryPlay();
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          inViewRef.current = entry.isIntersecting;
          if (entry.isIntersecting) tryPlay();
          else el.pause();
        }
      },
      { threshold: 0.1 },
    );
    obs.observe(el);
    tryPlay();
    return () => {
      obs.disconnect();
      el.pause();
    };
  }, [uri]);

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
    <Pressable
      style={[styles.videoWrap, { backgroundColor: c.line }]}
      disabled={!onOpen}
      onPress={() => onOpen?.(uri)}>
      <video
        ref={videoRef}
        src={uri}
        muted
        loop
        playsInline
        autoPlay
        data-testid="video-message"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.muted = true;
          if (Number.isFinite(el.duration) && el.duration > 0) setDuration(Math.round(el.duration));
          if (inViewRef.current && el.paused) void el.play().catch(() => {});
        }}
        onCanPlay={(e) => {
          const el = e.currentTarget;
          el.muted = true;
          if (inViewRef.current && el.paused) void el.play().catch(() => {});
        }}
        style={{ width: WIDTH, maxWidth: '100%', borderRadius: 12, display: 'block', objectFit: 'cover' }}
      />
      <View style={styles.videoCorner} pointerEvents="none">
        <MaterialIcons name="play-arrow" size={14} color="#ffffff" />
        <Text style={styles.videoCornerText}>{formatClock(duration)}</Text>
      </View>
      <View style={styles.videoSpeaker} pointerEvents="none">
        <MaterialIcons name="volume-off" size={14} color="#ffffff" />
      </View>
    </Pressable>
  );
}

function formatBytes(size?: number): string {
  if (!size || !Number.isInteger(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(2).replace(/\.?0+$/, '')} MB`;
}

function formatExpiry(at: number): string {
  const d = new Date((at + FILE_TTL_SEC) * 1000);
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `有効期間：${m}/${day} ${hh}:${mm}`;
}

/** A general file in a chat bubble: icon, name, expiry/kept status and size; tapping saves it. */
export function FileAttachment({ id, file, at }: { id: string; file: FileRef; at?: number }) {
  const c = usePalette();
  const [kept, setKept] = useState(false);
  const [error, setError] = useState<'gone' | 'failed' | null>(null);
  const name = file.name || 'ファイル';
  const sizeText = formatBytes(file.size);
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(name);
  const uploadedAt = at ?? Math.floor(Date.now() / 1000);
  const pastPeriod = Date.now() >= (uploadedAt + FILE_TTL_SEC) * 1000;
  const expired = !kept && (pastPeriod || error === 'gone');

  useEffect(() => {
    let alive = true;
    keptFile(id).then((blob) => {
      if (alive) setKept(!!blob);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  async function saveFile() {
    if (Platform.OS !== 'web' || expired) return;
    try {
      const blob = await openFile(id, file);
      setKept(true);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) {
      setError((e as Error).message === 'gone' ? 'gone' : 'failed');
    }
  }

  if (error === 'failed') {
    return <Text style={[styles.note, { color: c.muted }]}>ファイルを開けませんでした</Text>;
  }

  const periodLine = kept
    ? 'この端末に保存済み'
    : expired
      ? '有効期間が過ぎました'
      : formatExpiry(uploadedAt);

  return (
    <Pressable
      style={styles.fileRow}
      testID="file-message"
      role="button"
      disabled={expired}
      onPress={saveFile}>
      <View
        style={[
          styles.fileIconBox,
          isPdf ? { backgroundColor: c.danger } : { backgroundColor: c.background, borderColor: c.line, borderWidth: 1 },
        ]}>
        <MaterialIcons name={isPdf ? 'picture-as-pdf' : 'description'} size={24} color={isPdf ? '#ffffff' : c.text} />
      </View>
      <View style={styles.fileMeta}>
        <Text style={[styles.fileName, { color: c.text }]} numberOfLines={1} ellipsizeMode="middle">
          {name}
        </Text>
        <Text style={[styles.fileSub, { color: c.muted }]} numberOfLines={1}>
          {periodLine}
        </Text>
        {sizeText ? (
          <Text style={[styles.fileSub, { color: c.muted }]} numberOfLines={1}>
            {`サイズ：${sizeText}`}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function formatClock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

async function decodeWaveform(id: string, blob: Blob): Promise<number[]> {
  const hit = waveCache.get(id);
  if (hit) return hit;
  const AC =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) {
    waveCache.set(id, FALLBACK_WAVE);
    return FALLBACK_WAVE;
  }
  let ctx: AudioContext | null = null;
  try {
    ctx = new AC();
    const buf = await blob.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const data = audio.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / WAVE_BARS));
    const raw: number[] = [];
    for (let i = 0; i < WAVE_BARS; i++) {
      const start = i * step;
      const end = Math.min(data.length, start + step);
      let sum = 0;
      for (let j = start; j < end; j++) sum += data[j] * data[j];
      raw.push(end > start ? Math.sqrt(sum / (end - start)) : 0);
    }
    const peak = Math.max(...raw, 0.01);
    const bars = raw.map((v) => Math.max(0.18, Math.min(1, v / peak)));
    waveCache.set(id, bars);
    return bars;
  } catch {
    waveCache.set(id, FALLBACK_WAVE);
    return FALLBACK_WAVE;
  } finally {
    void ctx?.close().catch(() => {});
  }
}

/** A recorded voice message in a chat bubble: play/pause button, 30-bar waveform and duration. */
export function Voice({ id, file }: { id: string; file: FileRef }) {
  const c = usePalette();
  const [uri, setUri] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(file.duration ?? 0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [bars, setBars] = useState<number[]>(() => waveCache.get(id) ?? FALLBACK_WAVE);
  const [error, setError] = useState<'gone' | 'failed' | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

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
        return decodeWaveform(id, blob);
      })
      .then((w) => {
        if (alive && w) setBars(w);
      })
      .catch((e: Error) => alive && setError(e.message === 'gone' ? 'gone' : 'failed'));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, file]);

  function togglePlay() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  if (error) {
    return (
      <Text style={[styles.note, { color: c.muted }]}>
        {error === 'gone' ? '音声の保存期間（30日）が過ぎました' : '音声を開けませんでした'}
      </Text>
    );
  }
  return (
    <View style={styles.voiceRow} testID="voice-message">
      {uri && Platform.OS === 'web' && (
        <audio
          ref={audioRef}
          src={uri}
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (file.duration === undefined && Number.isFinite(d) && d > 0) setDuration(Math.round(d));
          }}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            const d = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration || 1;
            setProgress(Math.min(1, Math.max(0, el.currentTime / d)));
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          style={{ display: 'none' }}
        />
      )}
      <Pressable
        role="button"
        aria-label={playing ? '一時停止' : '再生'}
        disabled={!uri}
        onPress={togglePlay}
        style={[styles.voicePlayBtn, { backgroundColor: c.text }]}>
        <MaterialIcons name={playing ? 'pause' : 'play-arrow'} size={18} color={c.surface} />
      </Pressable>
      <View style={styles.waveform} testID="voice-waveform">
        {bars.map((amp, i) => {
          const played = playing && i / bars.length <= progress;
          return (
            <View
              key={i}
              style={[
                styles.waveBar,
                {
                  height: Math.round(4 + amp * 18),
                  backgroundColor: played ? c.text : c.muted,
                  opacity: played ? 1 : 0.4,
                },
              ]}
            />
          );
        })}
      </View>
      <Text style={[styles.voiceDuration, { color: c.muted }]}>{formatClock(duration)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { borderRadius: 12, overflow: 'hidden', maxWidth: '100%' },
  videoWrap: { width: WIDTH, maxWidth: '100%', borderRadius: 12, overflow: 'hidden', position: 'relative' },
  videoFrame: { width: WIDTH, height: 150, borderRadius: 12, overflow: 'hidden', maxWidth: '100%' },
  videoCorner: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: 'rgba(0, 0, 0, 0.56)',
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  videoCornerText: { color: '#ffffff', fontSize: 11, fontWeight: '600' },
  videoSpeaker: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0, 0, 0, 0.56)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: { width: '100%', height: '100%' },
  note: { fontSize: 14, paddingVertical: 4 },
  // A fixed width: inside a bubble that shrinks to its content, flex: 1 alone collapses the text.
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2, width: 230 },
  fileIconBox: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  fileMeta: { flex: 1, minWidth: 0, gap: 1 },
  fileName: { fontSize: 14, fontWeight: '600' },
  fileSub: { fontSize: 12 },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 },
  voicePlayBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  waveform: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 24 },
  waveBar: { width: 2, borderRadius: 1 },
  voiceDuration: { fontSize: 12, flexShrink: 0 },
  viewer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 100,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewerClose: {
    position: 'absolute',
    top: 12,
    left: 12,
    zIndex: 101,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImageWrap: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImage: { width: '100%', height: '100%' },
  viewerMenuBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 102,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  viewerMenu: {
    width: '100%',
    maxWidth: 280,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  viewerMenuItem: {
    minHeight: 48,
    paddingHorizontal: 20,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerMenuLine: { borderTopWidth: StyleSheet.hairlineWidth },
  viewerMenuText: { fontSize: 16, fontWeight: '600' },
});
