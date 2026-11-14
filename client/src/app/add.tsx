import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { router } from 'expo-router';
import jsQR from 'jsqr';
import makeQr from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Palette, usePalette } from '@/constants/theme';
import { keepInviteCode } from '@/lib/register';
import {
  inviteCodeOf,
  inviteFromQr,
  inviteLink,
  inviteModel,
  inviteName,
  parsePubkey,
  takePendingInvite,
  useTegami,
} from '@/lib/tegami';

export { inviteFromQr };

/** Decodes a QR code from an ImageData buffer using jsQR. */
export function decodeQrImage(image: { data: Uint8ClampedArray; width: number; height: number }): string | null {
  const hit = jsQR(image.data, image.width, image.height);
  return hit?.data ?? null;
}

if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w.inviteFromQr = inviteFromQr;
  w.decodeQrImage = decodeQrImage;
  w.makeQr = makeQr;
}

function makeQrPng(text: string): string {
  const qr = makeQr(0, 'M');
  qr.addData(text);
  qr.make();
  if (typeof document !== 'undefined') {
    const count = qr.getModuleCount();
    const cell = 6;
    const margin = 2 * cell;
    const size = count * cell + margin * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000000';
      for (let r = 0; r < count; r++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(r, col)) ctx.fillRect(margin + col * cell, margin + r * cell, cell, cell);
        }
      }
      return canvas.toDataURL('image/png');
    }
  }
  return qr.createDataURL(6, 2);
}

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<{ rawValue?: string }[]>;
};

function pickImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = 'image/*';
    el.style.display = 'none';
    document.body.appendChild(el);
    const done = (file: File | null) => {
      el.remove();
      resolve(file);
    };
    el.addEventListener('change', () => done(el.files?.[0] ?? null), { once: true });
    el.addEventListener('cancel', () => done(null), { once: true });
    el.click();
  });
}

export default function Add() {
  const c = usePalette();
  const s = styles(c);
  const { npub, me, contacts, addContact, myName, setMyName, myAvatar, inviteCode, trusted, registration, registerWith } = useTegami();
  const [opened] = useState(takePendingInvite);
  const [tab, setTab] = useState<'qr' | 'scan'>('qr');
  const [invite, setInvite] = useState(opened);
  const [name, setName] = useState(inviteName(opened));
  const [cameraError, setCameraError] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const peer = parsePubkey(invite);
  const model = inviteModel(invite);
  const known = contacts.find((x) => x.pubkey === peer);
  const canAdd = !!peer && peer !== me && name.trim().length > 0;
  const myInvite = npub ? inviteLink(npub, myName, inviteCode) : '';
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const qrUri = useMemo(() => (myInvite ? makeQrPng(myInvite) : ''), [myInvite]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(myInvite);
    } catch {}
  }

  async function share() {
    try {
      await navigator.share({ title: 'Tegami', text: 'Tegami で話そう', url: myInvite });
    } catch {
      // Cancelled by the user.
    }
  }

  function saveQr() {
    if (!qrUri || typeof document === 'undefined') return;
    const a = document.createElement('a');
    a.href = qrUri;
    a.download = 'tegami-qr.png';
    a.click();
  }

  function changeInvite(text: string) {
    setInvite(text);
    const n = inviteName(text);
    if (n && !name.trim()) setName(n);
  }

  function add() {
    if (!peer || !canAdd) return;
    addContact(peer, name.trim(), model || undefined);
    // Registered without an invite: a friend's code makes my messages reach strangers too.
    const code = inviteCodeOf(invite);
    if (code && registration === 'ok' && !trusted) void registerWith({ invite: code });
    router.replace({ pathname: '/chat/[peer]', params: { peer } });
  }

  function applyScannedQr(raw: string): boolean {
    const link = inviteFromQr(raw);
    if (!link) {
      setScanError('Tegami の招待リンクではありません');
      return false;
    }
    keepInviteCode(inviteCodeOf(link));
    setInvite(link);
    const n = inviteName(link);
    if (n) setName(n);
    setScanError(null);
    setTab('qr');
    return true;
  }

  async function pickQrImage() {
    if (Platform.OS !== 'web') return;
    const file = await pickImageFile();
    if (!file) return;
    setScanError(null);
    try {
      let raw: string | null = null;
      const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike })
        .BarcodeDetector;
      const bitmap = await createImageBitmap(file);
      try {
        if (Detector) {
          try {
            const detector = new Detector({ formats: ['qr_code'] });
            const hits = await detector.detect(bitmap);
            raw = hits[0]?.rawValue ?? null;
          } catch {
            // Fall back to jsQR on the canvas below.
          }
        }
        if (!raw) {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            raw = decodeQrImage(ctx.getImageData(0, 0, canvas.width, canvas.height));
          }
        }
      } finally {
        bitmap.close();
      }
      if (!raw) {
        setScanError('招待リンクを読み取れません');
        return;
      }
      applyScannedQr(raw);
    } catch {
      setScanError('招待リンクを読み取れません');
    }
  }

  useEffect(() => {
    if (tab !== 'scan' || Platform.OS !== 'web') return;
    setCameraError(false);
    setScanError(null);
    if (!navigator?.mediaDevices?.getUserMedia) {
      setCameraError(true);
      return;
    }
    let alive = true;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      } catch {
        if (alive) setCameraError(true);
        return;
      }
      if (!alive) {
        stop();
        return;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => {});
      }
      const Detector = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike }).BarcodeDetector;
      let detector: BarcodeDetectorLike | null = null;
      if (Detector) {
        try {
          detector = new Detector({ formats: ['qr_code'] });
        } catch {
          detector = null;
        }
      }
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let busy = false;

      timer = setInterval(async () => {
        if (!alive || busy) return;
        const video = videoRef.current;
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        busy = true;
        try {
          let raw: string | null = null;
          if (detector) {
            try {
              const hits = await detector.detect(video);
              raw = hits[0]?.rawValue ?? null;
            } catch {
              detector = null;
            }
          }
          if (!raw && ctx) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            raw = decodeQrImage(ctx.getImageData(0, 0, canvas.width, canvas.height));
          }
          if (!alive || !raw) return;
          if (applyScannedQr(raw)) stop();
        } finally {
          busy = false;
        }
      }, 200);
    })();

    return () => {
      alive = false;
      stop();
    };
  }, [tab]);

  return (
    <ScrollView style={s.fill} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
      <View style={s.tabs}>
        <Pressable
          role="button"
          aria-label="マイQRコード"
          style={[s.tab, tab === 'qr' && s.tabActive]}
          onPress={() => setTab('qr')}>
          <MaterialIcons name="qr-code" size={24} color={tab === 'qr' ? c.onAccent : c.muted} />
          <Text style={[s.tabText, tab === 'qr' && s.tabTextActive]}>マイQRコード</Text>
        </Pressable>
        <Pressable
          role="button"
          aria-label="QRコードスキャン"
          style={[s.tab, tab === 'scan' && s.tabActive]}
          onPress={() => setTab('scan')}>
          <MaterialIcons name="qr-code-scanner" size={24} color={tab === 'scan' ? c.onAccent : c.muted} />
          <Text style={[s.tabText, tab === 'scan' && s.tabTextActive]}>QRコードスキャン</Text>
        </Pressable>
      </View>

      {tab === 'qr' ? (
        <>
          <View style={s.card}>
            <View style={s.profileRow}>
              <Avatar name={myName || '自分'} file={myAvatar} size={44} />
              <TextInput
                style={[s.input, s.nameInput]}
                value={myName}
                onChangeText={setMyName}
                placeholder="自分の名前"
                aria-label="自分の名前"
                placeholderTextColor={c.muted}
              />
            </View>
            {qrUri ? (
              <View style={s.qrBox}>
                <Image source={{ uri: qrUri }} style={s.qr} testID="invite-qr" />
              </View>
            ) : null}
            <Text style={s.srOnly} numberOfLines={1}>
              {myInvite}
            </Text>
            <View style={s.qrActions}>
              <Pressable onPress={copy} role="button" aria-label="リンクをコピー" style={s.qrAction}>
                <MaterialIcons name="link" size={24} color={c.text} />
                <Text style={s.qrActionText}>リンクをコピー</Text>
              </Pressable>
              {canShare && (
                <Pressable onPress={share} role="button" aria-label="シェア" style={s.qrAction}>
                  <MaterialIcons name="share" size={24} color={c.text} />
                  <Text style={s.qrActionText}>シェア</Text>
                </Pressable>
              )}
              <Pressable onPress={saveQr} role="button" aria-label="保存" style={s.qrAction}>
                <MaterialIcons name="download" size={24} color={c.text} />
                <Text style={s.qrActionText}>保存</Text>
              </Pressable>
            </View>
          </View>

          <TextInput
            style={s.input}
            value={invite}
            onChangeText={changeInvite}
            placeholder="https://app.tegami.chat/i#npub…"
            placeholderTextColor={c.muted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {invite.length > 0 && !peer && <Text style={s.error}>招待リンクを読み取れません</Text>}
          {peer && peer === me && <Text style={s.error}>自分の招待リンクです</Text>}
          {known && <Text style={s.error}>{known.name} さんは、もう友だちです</Text>}
          <TextInput
            style={s.input}
            value={name}
            onChangeText={setName}
            placeholder="表示する名前"
            placeholderTextColor={c.muted}
            onSubmitEditing={add}
          />
          {peer && model ? <Text style={s.model}>AI：{model}</Text> : null}
          <Pressable style={[s.primary, !canAdd && s.disabled]} onPress={add} disabled={!canAdd} role="button">
            <Text style={s.primaryText}>{known ? '名前を変える' : '追加'}</Text>
          </Pressable>
        </>
      ) : (
        <View style={s.scanWrap}>
          {cameraError ? (
            <Text style={s.error}>カメラを使えません</Text>
          ) : (
            <View style={s.cameraFrame}>
              {Platform.OS === 'web' && (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                />
              )}
              <View style={s.squareOverlay} pointerEvents="none" />
            </View>
          )}
          <Pressable role="button" aria-label="画像から読み取る" style={s.pickImageBtn} onPress={pickQrImage}>
            <MaterialIcons name="image" size={20} color={c.text} />
            <Text style={s.pickImageText}>画像から読み取る</Text>
          </Pressable>
          <Text style={s.scanNote}>QRコードを読み取ると、友だち追加の画面が開きます。</Text>
          {scanError && <Text style={s.error}>{scanError}</Text>}
        </View>
      )}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    body: { padding: 16, gap: 12, maxWidth: 560, width: '100%', alignSelf: 'center' },
    tabs: {
      flexDirection: 'row',
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      padding: 4,
      gap: 4,
    },
    tab: {
      flex: 1,
      minHeight: 44,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 8,
      gap: 2,
    },
    tabActive: { backgroundColor: c.accent },
    tabText: { fontSize: 15, fontWeight: '600', color: c.muted },
    tabTextActive: { color: c.onAccent },
    card: {
      backgroundColor: c.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.line,
      padding: 16,
      gap: 16,
      alignItems: 'center',
    },
    profileRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      width: '100%',
    },
    nameInput: { flex: 1 },
    qrBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 4 },
    qr: { width: 240, height: 240, borderRadius: 8, backgroundColor: '#ffffff' },
    srOnly: { position: 'absolute', opacity: 0, pointerEvents: 'none' },
    qrActions: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 24,
      width: '100%',
    },
    qrAction: {
      minHeight: 44,
      minWidth: 72,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 6,
      paddingHorizontal: 8,
      gap: 4,
    },
    qrActionText: { fontSize: 13, color: c.text, fontWeight: '600' },
    input: {
      minHeight: 44,
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 16,
      color: c.text,
    },
    error: { fontSize: 13, color: c.danger, textAlign: 'center' },
    model: { fontSize: 14, color: c.muted },
    primary: {
      minHeight: 44,
      backgroundColor: c.accent,
      borderRadius: 999,
      paddingVertical: 12,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    disabled: { opacity: 0.4 },
    primaryText: { color: c.onAccent, fontSize: 16, fontWeight: '600' },
    scanWrap: { alignItems: 'center', gap: 16, paddingVertical: 16 },
    cameraFrame: {
      width: 260,
      height: 260,
      borderRadius: 16,
      overflow: 'hidden',
      backgroundColor: '#000000',
      borderWidth: 2,
      borderColor: c.line,
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
    },
    squareOverlay: {
      position: 'absolute',
      width: 200,
      height: 200,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: '#ffffff',
    },
    pickImageBtn: {
      minHeight: 44,
      minWidth: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.surface,
    },
    pickImageText: { fontSize: 15, fontWeight: '600', color: c.text },
    scanNote: { fontSize: 14, color: c.muted, textAlign: 'center' },
  });
