import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as ImagePicker from 'expo-image-picker';
import { Stack, router, useIsFocused, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/avatar';
import { Dialog } from '@/components/dialog';
import { FileAttachment, Photo, PhotoViewer, Stamp, Video, VideoViewer, Voice } from '@/components/photo';
import { ReportSheet } from '@/components/report-sheet';
import { Palette, usePalette } from '@/constants/theme';
import { useCall } from '@/lib/calls';
import { cautionFor } from '@/lib/caution';
import { MAX_FILE_BYTES } from '@/lib/files';
import { chatName, clock, isGroup, personName, shortId, useTegami, type Message, type Stamp as StampItem } from '@/lib/tegami';

const SEND_ERROR = '送れませんでした。もう一度送ってください';
const VOICE_MAX_MS = 5 * 60 * 1000;
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
const SWIPE_REPLY_PX = 60;

function pickWebFile(accept?: string, capture?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const el = document.createElement('input');
    el.type = 'file';
    if (accept) el.accept = accept;
    if (capture) el.setAttribute('capture', capture);
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

/** How long a message stays marked after jumping to it. */
const HIGHLIGHT_MS = 2000;

export default function Chat() {
  const c = usePalette();
  const s = styles(c);
  // m: a message to jump to (from search).
  const { peer, m: focus } = useLocalSearchParams<{ peer: string; m?: string }>();
  const {
    me,
    myName,
    contacts,
    groups,
    blocked,
    block,
    messages,
    deleteMessage,
    send,
    sendPhoto,
    sendFile,
    sendVoice,
    forwardFile,
    stamps,
    makeStamp,
    addStamp,
    removeStamp,
    sendStamp,
    addContact,
    markRead,
    cancelSend,
    retrySend,
  } = useTegami();
  // A message waiting to be sent that was tapped: it offers to stop sending.
  const [offered, setOffered] = useState<string | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [stampsOpen, setStampsOpen] = useState(false);
  const [stampDeleting, setStampDeleting] = useState<string | null>(null);
  const [stampOffer, setStampOffer] = useState<string | null>(null);
  const [replying, setReplying] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The message whose actions are shown: by long press/right click or by hovering (mouse).
  const [pressed, setPressed] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const input = useRef<TextInput>(null);
  const [newName, setNewName] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordPanel, setRecordPanel] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const [recorded, setRecorded] = useState<{ blob: Blob; url: string; duration: number } | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const recorderRef = useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    chunks: BlobPart[];
    mimeType: string;
    startedAt: number;
    timer: ReturnType<typeof setInterval>;
    limitTimer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [viewingVideo, setViewingVideo] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [blockingPeer, setBlockingPeer] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<{ peer: string; messageId?: string } | null>(null);
  const [swiping, setSwiping] = useState<{ id: string; dx: number } | null>(null);
  // When the press that opened the panel by holding was released. The panel pushes the bubble
  // up (the list grows from the bottom), so that release lands on a cell: ignore its tap.
  const openedAt = useRef(0);
  const dragRef = useRef<{
    id: string;
    msg: Message;
    startX: number;
    startY: number;
    dx: number;
    moved: boolean;
    startedAt?: number;
    longTimer?: ReturnType<typeof setTimeout>;
    longFired?: boolean;
  } | null>(null);
  const list = useRef<FlatList>(null);
  const { supported, startCall } = useCall();

  const group = !!peer && isGroup(peer);
  const isBlocked = !!peer && !group && blocked.includes(peer);
  const contact = contacts.find((x) => x.pubkey === peer);
  // 1:1 with a person (an AI friend cannot pick up). Groups later.
  const canCall = supported && !group && !!contact && !contact.model && !isBlocked;
  const thread = useMemo(() => messages.filter((m) => m.peer === peer).reverse(), [messages, peer]);
  const byId = useMemo(() => new Map(thread.map((m, i) => [m.id, i])), [thread]);
  const friends = useMemo(() => new Set(contacts.map((x) => x.pubkey)), [contacts]);
  // Shown once per chat above the first money/link message from someone who is not a friend.
  const firstCautionId = useMemo(
    () =>
      messages.find(
        (m) => m.peer === peer && m.from !== me && !m.file && !m.call && !friends.has(m.from) && cautionFor(m.text),
      )?.id ?? null,
    [messages, peer, me, friends],
  );
  const forwardTargets = useMemo(
    () => [
      ...contacts.filter((x) => !blocked.includes(x.pubkey)).map((x) => ({ room: x.pubkey, name: personName(x.pubkey, contacts) })),
      ...groups.map((g) => ({ room: g.id, name: chatName(g.id, contacts, groups) })),
    ],
    [contacts, blocked, groups],
  );

  useEffect(() => {
    setReportTarget(null);
    setBlockingPeer(null);
    setDeletingId(null);
    setForwarding(null);
    setReplying(null);
    setPressed(null);
    setHovered(null);
    setCopied(null);
    setPlusOpen(false);
    setStampsOpen(false);
    setStampDeleting(null);
    setStampOffer(null);
    setError(null);
  }, [peer]);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const nameOf = (pubkey: string) => (pubkey === me ? myName || '自分' : personName(pubkey, contacts));
  const firstLine = (m: Message) =>
    m.stamp
      ? 'スタンプ'
      : m.file
        ? m.file.name || (m.file.type.startsWith('video/') ? '動画' : m.file.type.startsWith('audio/') ? '音声メッセージ' : '写真')
        : m.text.split('\n')[0];

  /** Scrolls to a message on this device and marks it for a moment. */
  const jumpTo = useCallback(
    (id: string) => {
      const index = byId.get(id);
      if (index === undefined) return;
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
      setHighlight(id);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    },
    [byId],
  );
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  // Opened from a search result: jump to that message once it is here.
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || jumped.current === focus || !byId.has(focus)) return;
    jumped.current = focus;
    // After the list has laid out its first rows.
    const t = setTimeout(() => jumpTo(focus), 50);
    return () => clearTimeout(t);
  }, [focus, byId, jumpTo]);

  // Leaving a message hides its actions a moment later, so the mouse can reach them.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverIn = (id: string) => {
    clearTimeout(hoverTimer.current);
    setHovered(id);
  };
  const hoverOut = (id: string) => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = setTimeout(() => setHovered((h) => (h === id ? null : h)), 300);
  };
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  // Tapping outside the message action panel closes it.
  useEffect(() => {
    if ((!pressed && !hovered) || Platform.OS !== 'web') return;
    const onDown = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-testid="message-panel"]')) return;
      clearTimeout(hoverTimer.current);
      setPressed(null);
      setHovered(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [pressed, hovered]);

  const startReply = useCallback((m: Message) => {
    setReplying(m);
    setForwarding(null);
    setReportTarget(null);
    setPressed(null);
    clearTimeout(hoverTimer.current);
    setHovered(null);
    setCopied(null);
    input.current?.focus();
  }, []);

  // Pointer/touch swipe right (> 60 px) on a message starts a reply.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const moveAt = (clientX: number, clientY: number) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = clientX - d.startX;
      const dy = clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) > 8) {
        d.moved = true;
        clearTimeout(d.longTimer);
      }
      if (dx > 8 && dx > Math.abs(dy)) {
        d.dx = dx;
        setSwiping({ id: d.id, dx: Math.min(dx, 96) });
      } else if (d.dx > 0) {
        d.dx = 0;
        setSwiping(null);
      }
    };
    const onPointerMove = (e: MouseEvent) => moveAt(e.clientX, e.clientY);
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches?.[0];
      if (t) moveAt(t.clientX, t.clientY);
    };
    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      clearTimeout(d.longTimer);
      if (d.longFired) openedAt.current = Date.now();
      dragRef.current = null;
      setSwiping(null);
      if (d.dx > SWIPE_REPLY_PX) startReply(d.msg);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('touchcancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('touchcancel', onUp);
    };
  }, [startReply]);

  function beginRowPointer(item: Message, clientX: number, clientY: number, button?: number) {
    if (button !== undefined && button !== 0) return;
    if (dragRef.current?.id === item.id && Date.now() - (dragRef.current.startedAt ?? 0) < 50) return;
    if (dragRef.current?.longTimer) clearTimeout(dragRef.current.longTimer);
    const longTimer = setTimeout(() => {
      if (dragRef.current && !dragRef.current.moved) {
        dragRef.current.longFired = true;
        setPressed(item.id);
      }
    }, 450);
    dragRef.current = {
      id: item.id,
      msg: item,
      startX: clientX,
      startY: clientY,
      dx: 0,
      moved: false,
      startedAt: Date.now(),
      longTimer,
    };
  }

  async function copyMessage(m: Message) {
    try {
      await navigator.clipboard.writeText(m.text);
      setPressed(null);
      setHovered(null);
      setCopied(m.id);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied((cur) => (cur === m.id ? null : cur)), 1500);
    } catch {}
  }

  function startForward(m: Message) {
    setForwarding(m);
    setReplying(null);
    setReportTarget(null);
    setPressed(null);
    clearTimeout(hoverTimer.current);
    setHovered(null);
    setCopied(null);
  }

  async function forwardTo(target: string) {
    if (!forwarding) return;
    const m = forwarding;
    setForwarding(null);
    if (m.file) await forwardFile(target, m.file, m.stamp);
    else await send(target, m.text);
    if (target !== peer) router.replace({ pathname: '/chat/[peer]', params: { peer: target } });
  }

  // What is on the screen is read. Only on this device; nobody is told (no read receipts).
  const focused = useIsFocused();
  const [visible, setVisible] = useState(() => globalThis.document?.visibilityState !== 'hidden');
  useEffect(() => {
    const doc = globalThis.document;
    if (!doc?.addEventListener) return;
    const on = () => setVisible(doc.visibilityState !== 'hidden');
    doc.addEventListener('visibilitychange', on);
    return () => doc.removeEventListener('visibilitychange', on);
  }, []);
  useEffect(() => {
    if (peer && focused && visible) markRead(peer);
  }, [peer, focused, visible, thread, markRead]);

  const stopRecorder = useCallback(() => {
    const r = recorderRef.current;
    if (!r) return null;
    recorderRef.current = null;
    clearInterval(r.timer);
    clearTimeout(r.limitTimer);
    setRecording(false);
    return r;
  }, []);

  const clearRecorded = useCallback(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.pause();
      previewAudioRef.current = null;
    }
    setPreviewPlaying(false);
    setRecorded((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const cancelRecording = useCallback(() => {
    const r = stopRecorder();
    if (r) {
      r.recorder.onstop = null;
      r.recorder.ondataavailable = null;
      if (r.recorder.state !== 'inactive') {
        try {
          r.recorder.stop();
        } catch {}
      }
      r.stream.getTracks().forEach((t) => t.stop());
    }
    clearRecorded();
    setRecordingSec(0);
    setRecordPanel(false);
  }, [stopRecorder, clearRecorded]);

  useEffect(() => () => cancelRecording(), [peer, cancelRecording]);

  const stopRecordingToPreview = useCallback(async () => {
    const r = stopRecorder();
    if (!r) return;
    const duration = Math.max(1, Math.round((Date.now() - r.startedAt) / 1000));
    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        const done = () => {
          r.stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(r.chunks, { type: r.recorder.mimeType || r.mimeType || 'audio/webm' }));
        };
        if (r.recorder.state === 'inactive') {
          done();
          return;
        }
        r.recorder.onstop = done;
        r.recorder.onerror = () => {
          r.stream.getTracks().forEach((t) => t.stop());
          reject(new Error('recording failed'));
        };
        r.recorder.stop();
      });
      const url = URL.createObjectURL(blob);
      setRecordingSec(duration);
      setRecorded({ blob, url, duration });
    } catch {
      setError(SEND_ERROR);
    }
  }, [stopRecorder]);

  const finishRecording = useCallback(async () => {
    if (!peer || sending) return;
    let blob: Blob | null = null;
    let duration = 1;
    const r = stopRecorder();
    if (r) {
      duration = Math.max(1, Math.round((Date.now() - r.startedAt) / 1000));
      try {
        blob = await new Promise<Blob>((resolve, reject) => {
          const done = () => {
            r.stream.getTracks().forEach((t) => t.stop());
            resolve(new Blob(r.chunks, { type: r.recorder.mimeType || r.mimeType || 'audio/webm' }));
          };
          if (r.recorder.state === 'inactive') {
            done();
            return;
          }
          r.recorder.onstop = done;
          r.recorder.onerror = () => {
            r.stream.getTracks().forEach((t) => t.stop());
            reject(new Error('recording failed'));
          };
          r.recorder.stop();
        });
      } catch {
        setError(SEND_ERROR);
        return;
      }
    } else if (recorded) {
      blob = recorded.blob;
      duration = recorded.duration;
    }
    if (!blob) return;
    clearRecorded();
    setRecordingSec(0);
    setRecordPanel(false);
    setSending(true);
    setError(null);
    try {
      await sendVoice(peer, blob, duration, replying?.id);
      setReplying(null);
    } catch {
      setError(SEND_ERROR);
    } finally {
      setSending(false);
    }
  }, [stopRecorder, recorded, clearRecorded, peer, sending, sendVoice, replying]);

  function openRecordPanel() {
    if (!peer || sending || isBlocked) return;
    setError(null);
    setPlusOpen(false);
    setStampsOpen(false);
    setStampDeleting(null);
    setPressed(null);
    setHovered(null);
    clearRecorded();
    setRecordingSec(0);
    setRecordPanel(true);
  }

  async function startRecording() {
    if (!peer || sending || isBlocked || recording) return;
    setError(null);
    clearRecorded();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType =
        AUDIO_TYPES.find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) ?? '';
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const startedAt = Date.now();
      setRecordingSec(0);
      setRecording(true);
      const timer = setInterval(() => {
        setRecordingSec(Math.floor((Date.now() - startedAt) / 1000));
      }, 250);
      const limitTimer = setTimeout(() => {
        void stopRecordingToPreview();
      }, VOICE_MAX_MS);
      recorderRef.current = { recorder, stream, chunks, mimeType, startedAt, timer, limitTimer };
      recorder.start();
    } catch {
      setError(SEND_ERROR);
    }
  }

  function togglePreview() {
    const el = previewAudioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }

  async function sendPickedMedia(blob: Blob | null) {
    if (!blob || !peer) return;
    if (blob.type.startsWith('video/') && blob.size > MAX_FILE_BYTES) {
      setError('10MBを超える動画は送れません');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendPhoto(peer, blob, replying?.id);
      setReplying(null);
    } catch {
      setError(SEND_ERROR);
    } finally {
      setSending(false);
    }
  }

  async function takePhoto() {
    if (!peer || sending || isBlocked) return;
    setPlusOpen(false);
    let blob: Blob | null = null;
    if (Platform.OS === 'web') {
      blob = await pickWebFile('image/*,video/*', 'environment');
    } else {
      const picked = await ImagePicker.launchCameraAsync({ mediaTypes: ['images', 'videos'], quality: 1 });
      const asset = picked.canceled ? null : picked.assets[0];
      if (asset) blob = asset.file ?? (await (await fetch(asset.uri)).blob());
    }
    await sendPickedMedia(blob);
  }

  async function pickPhoto() {
    if (!peer || sending || isBlocked) return;
    setPlusOpen(false);
    let blob: Blob | null = null;
    if (Platform.OS === 'web') {
      blob = await pickWebFile('image/*,video/*');
    } else {
      const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 1 });
      const asset = picked.canceled ? null : picked.assets[0];
      if (asset) blob = asset.file ?? (await (await fetch(asset.uri)).blob());
    }
    await sendPickedMedia(blob);
  }

  async function pickFile() {
    if (!peer || sending || isBlocked || Platform.OS !== 'web') return;
    setPlusOpen(false);
    const file = await pickWebFile();
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError('10MBを超えるファイルは送れません');
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendFile(peer, file, file.name || 'file', replying?.id);
      setReplying(null);
    } catch {
      setError(SEND_ERROR);
    } finally {
      setSending(false);
    }
  }

  async function createStamp() {
    if (!peer || sending || isBlocked) return;
    const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    setSending(true);
    setError(null);
    try {
      const blob = asset.file ?? (await (await fetch(asset.uri)).blob());
      await makeStamp(blob);
    } catch {
      setError(SEND_ERROR);
    } finally {
      setSending(false);
    }
  }

  async function pickStamp(st: StampItem) {
    if (!peer || sending || isBlocked) return;
    setStampsOpen(false);
    setStampDeleting(null);
    setSending(true);
    setError(null);
    try {
      await sendStamp(peer, st, replying?.id);
      setReplying(null);
    } catch {
      setError(SEND_ERROR);
    } finally {
      setSending(false);
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text || !peer || isBlocked) return;
    setError(null);
    // Never lost: without a connection it waits in the chat and goes out later.
    setDraft('');
    try {
      await send(peer, text, replying?.id);
      setReplying(null);
    } catch {
      setDraft(text);
      setError(SEND_ERROR);
    }
  }

  const title = group
    ? chatName(peer, contacts, groups)
    : contact
      ? contact.model
        ? `${contact.name}（${contact.model}）`
        : contact.name
      : peer
        ? shortId(peer)
        : '';

  const modalOpen = !!deletingId || !!blockingPeer || !!reportTarget;

  return (
    <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={s.fill} aria-hidden={modalOpen}>
        <View style={s.header}>
          <Pressable
            role="button"
            aria-label="戻る"
            style={s.headerIconBtn}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/' as Href))}>
            <MaterialIcons name="chevron-left" size={24} color={c.text} />
          </Pressable>
          <Text style={s.headerTitle} numberOfLines={1} testID="chat-title">
            {title}
          </Text>
          {peer && (
            <View style={s.headerActions}>
              {canCall && (
                <Pressable role="button" aria-label="音声通話" style={s.headerIconBtn} onPress={() => startCall(peer, false)}>
                  <MaterialIcons name="call" size={24} color={c.text} />
                </Pressable>
              )}
              <Pressable
                role="button"
                aria-label="メニュー"
                style={s.headerIconBtn}
                onPress={() => router.push(`/chat/${encodeURIComponent(peer)}/info` as Href)}>
                <MaterialIcons name="menu" size={24} color={c.text} />
              </Pressable>
            </View>
          )}
        </View>

        {!group && !contact && peer && (
          <View style={s.addBar}>
            <TextInput
              style={s.addInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="表示する名前"
              placeholderTextColor={c.muted}
              onSubmitEditing={() => newName.trim() && addContact(peer, newName.trim())}
            />
            <Pressable
              style={[s.addButton, !newName.trim() && s.disabled]}
              disabled={!newName.trim()}
              onPress={() => addContact(peer, newName.trim())}
              role="button">
              <Text style={s.sendText}>友だちに追加</Text>
            </Pressable>
          </View>
        )}

        {forwarding && (
          <View style={s.forwardPanel}>
            <Text style={s.forwardTitle}>転送先を選ぶ</Text>
            <View style={s.forwardList}>
              {forwardTargets.map((t) => (
                <Pressable key={t.room} role="button" style={s.forwardTarget} onPress={() => forwardTo(t.room)}>
                  <Text style={s.forwardTargetText}>{t.name}</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.forwardButtons}>
              <Pressable role="button" style={s.forwardCancel} onPress={() => setForwarding(null)}>
                <Text style={s.callText}>キャンセル</Text>
              </Pressable>
            </View>
          </View>
        )}

        {copied && (
          <View style={s.copiedToast}>
            <Text style={s.copiedText}>コピーしました</Text>
          </View>
        )}

        <FlatList
          ref={list}
          inverted
          data={thread}
          keyExtractor={(m) => m.id}
          contentContainerStyle={s.list}
          onScrollToIndexFailed={(info) => {
            // The row is not drawn yet (far up the chat): get near it, then try again.
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 100);
          }}
          renderItem={({ item }) => {
            const mine = item.from === me;
            if (item.call) {
              return (
                <View style={s.callRow}>
                  <Text style={[s.callNote, item.call.result === 'missed' && s.missed]}>
                    {item.text}
                    {'  '}
                    {new Date(item.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              );
            }
            const unsent = mine && item.pending === 'unsent';
            const original = item.replyTo !== undefined ? byId.get(item.replyTo) : undefined;
            const quoted = original !== undefined ? thread[original] : null;
            // Only a long press or a right click opens it (as LINE): opening on hover pushed the
            // bubble up under the mouse, so the next click landed on a cell.
            const showMenu = pressed === item.id;
            const menuCells: { label: string; icon: ComponentProps<typeof MaterialIcons>['name']; onPress: () => void }[] = [
              ...(!item.file ? [{ label: 'コピー', icon: 'content-copy' as const, onPress: () => void copyMessage(item) }] : []),
              { label: 'リプライ', icon: 'reply', onPress: () => startReply(item) },
              { label: '転送', icon: 'forward', onPress: () => startForward(item) },
              {
                label: '削除',
                icon: 'delete',
                onPress: () => {
                  setPressed(null);
                  setHovered(null);
                  setDeletingId(item.id);
                },
              },
              ...(!mine && !group
                ? [
                    {
                      label: '通報',
                      icon: 'report' as const,
                      onPress: () => {
                        setPressed(null);
                        setHovered(null);
                        setReportTarget({ peer: item.from, messageId: item.id });
                      },
                    },
                  ]
                : []),
            ];
            const actionPanel = showMenu && (
              <View
                style={[s.messagePanel, mine ? s.messagePanelMine : s.messagePanelTheirs]}
                testID="message-panel"
                {...((Platform.OS === 'web'
                  ? {
                      onMouseEnter: () => hoverIn(item.id),
                      onMouseLeave: () => hoverOut(item.id),
                    }
                  : {}) as object)}>
                {menuCells.map((cell) => (
                  <Pressable
                    key={cell.label}
                    role="button"
                    aria-label={cell.label}
                    style={s.panelCell}
                    onPress={() => {
                      if (Date.now() - openedAt.current < 300) return;
                      cell.onPress();
                    }}
                    onHoverIn={() => hoverIn(item.id)}
                    onHoverOut={() => hoverOut(item.id)}>
                    <MaterialIcons name={cell.icon} size={22} color="#ffffff" />
                    <Text style={s.panelLabel}>{cell.label}</Text>
                  </Pressable>
                ))}
              </View>
            );

            const isStamp = !!item.file && !!item.stamp;
            const isVisualMedia =
              !!item.file &&
              !item.stamp &&
              !item.file.name &&
              (item.file.type.startsWith('image/') || item.file.type.startsWith('video/'));
            const frameless = isStamp || (isVisualMedia && item.replyTo === undefined && !(group && !mine));
            const bubble = (
              <View
                style={[
                  frameless ? s.stampBox : [s.bubble, mine ? s.mine : s.theirs],
                  unsent && s.waiting,
                  mine && !!item.pending && s.full,
                  highlight === item.id && s.highlight,
                ]}>
                {group && !mine && <Text style={s.author}>{personName(item.from, contacts)}</Text>}
                {item.replyTo !== undefined &&
                  (quoted ? (
                    <Pressable style={s.quote} onPress={() => jumpTo(quoted.id)} role="button" testID="quote">
                      <Text style={s.quoteName} numberOfLines={1}>
                        {nameOf(quoted.from)}
                      </Text>
                      <Text style={s.quoteText} numberOfLines={1}>
                        {firstLine(quoted)}
                      </Text>
                    </Pressable>
                  ) : (
                    <View style={s.quote} testID="quote">
                      <Text style={s.quoteText}>このメッセージはありません</Text>
                    </View>
                  ))}
                {item.file ? (
                  isStamp ? (
                    <Stamp
                      file={item.file}
                      onPress={!mine ? () => setStampOffer((cur) => (cur === item.id ? null : item.id)) : undefined}
                    />
                  ) : item.file.name ||
                    (!item.file.type.startsWith('image/') &&
                      !item.file.type.startsWith('video/') &&
                      !item.file.type.startsWith('audio/')) ? (
                    <FileAttachment id={item.id} file={item.file} at={item.at} />
                  ) : item.file.type.startsWith('video/') ? (
                    <Video id={item.id} file={item.file} onOpen={setViewingVideo} />
                  ) : item.file.type.startsWith('audio/') ? (
                    <Voice id={item.id} file={item.file} />
                  ) : (
                    <Photo id={item.id} file={item.file} onOpen={setViewing} />
                  )
                ) : (
                  <Text style={s.text} selectable={!unsent}>
                    {item.text}
                  </Text>
                )}
                <Text style={s.time}>
                  {unsent
                    ? '未送信'
                    : new Date(item.at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
            );

            // Sent (or someone else's): open dark panel by long press, right click or hover; swipe right to reply.
            if (!mine || !item.pending) {
              const swipeDx = swiping && swiping.id === item.id ? swiping.dx : 0;
              type WebPtrEvent = {
                clientX?: number;
                clientY?: number;
                button?: number;
                touches?: { clientX: number; clientY: number }[];
                nativeEvent?: {
                  clientX?: number;
                  clientY?: number;
                  pageX?: number;
                  pageY?: number;
                  button?: number;
                  touches?: { clientX?: number; clientY?: number; pageX?: number; pageY?: number }[];
                };
              };
              const onStartEvt = (e: WebPtrEvent) => {
                const x =
                  e.clientX ??
                  e.nativeEvent?.clientX ??
                  e.touches?.[0]?.clientX ??
                  e.nativeEvent?.touches?.[0]?.clientX ??
                  e.nativeEvent?.pageX;
                const y =
                  e.clientY ??
                  e.nativeEvent?.clientY ??
                  e.touches?.[0]?.clientY ??
                  e.nativeEvent?.touches?.[0]?.clientY ??
                  e.nativeEvent?.pageY;
                const btn = e.button ?? e.nativeEvent?.button;
                if (typeof x === 'number' && typeof y === 'number') {
                  beginRowPointer(item, x, y, btn);
                }
              };
              const webRowHandlers =
                Platform.OS === 'web'
                  ? {
                      onPointerDown: onStartEvt,
                      onMouseDown: onStartEvt,
                      onTouchStart: onStartEvt,
                      onContextMenu: (e: { preventDefault: () => void }) => {
                        e.preventDefault();
                        setPressed(item.id);
                      },
                    }
                  : {};
              const row = (
                <View style={[s.itemWrap, mine ? s.itemWrapMine : s.itemWrapTheirs]}>
                  <View style={[s.swipeLine, mine && s.swipeLineMine]} {...(webRowHandlers as object)}>
                    {swipeDx > 12 && (
                      <View
                        style={[s.swipeReplyIcon, swipeDx > SWIPE_REPLY_PX && s.swipeReplyIconReady]}
                        testID="swipe-reply-icon"
                        aria-label="リプライ">
                        <MaterialIcons
                          name="reply"
                          size={18}
                          color={swipeDx > SWIPE_REPLY_PX ? c.onAccent : c.text}
                        />
                      </View>
                    )}
                    <Pressable
                      style={[
                        s.row,
                        mine ? s.rowMine : s.rowTheirs,
                        swipeDx > 0 && { transform: [{ translateX: Math.min(swipeDx, 76) }] },
                      ]}
                      onLongPress={() => {
                        if (!dragRef.current?.moved) setPressed(item.id);
                      }}
                      onHoverIn={() => hoverIn(item.id)}
                      onHoverOut={() => hoverOut(item.id)}
                      testID={highlight === item.id ? 'highlighted' : undefined}>
                      {group && !mine && (
                        <Avatar
                          name={personName(item.from, contacts)}
                          file={contacts.find((x) => x.pubkey === item.from)?.avatar}
                          size={28}
                        />
                      )}
                      {bubble}
                    </Pressable>
                  </View>
                  {actionPanel}
                </View>
              );

              const withStampOffer =
                !mine && isStamp && stampOffer === item.id ? (
                  <View style={s.theirsWrap}>
                    {row}
                    <View style={[s.offer, s.offerTheirs]}>
                      <Pressable
                        style={s.cancel}
                        onPress={() => {
                          const f = item.file!;
                          setStampOffer(null);
                          void addStamp(f, item.at);
                        }}
                        role="button">
                        <Text style={s.cancelText}>スタンプに追加</Text>
                      </Pressable>
                      <Pressable style={s.cancel} onPress={() => setStampOffer(null)} role="button">
                        <Text style={s.cancelText}>閉じる</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  row
                );

              if (item.id !== firstCautionId) return withStampOffer;
              return (
                <View style={s.cautionWrap}>
                  <View style={s.cautionCard} testID="caution-card" aria-hidden={!!(pressed || hovered)}>
                    <View style={s.cautionHeader}>
                      <MaterialIcons name="warning" size={20} color={c.danger} />
                      <Text style={s.cautionTitle}>お金やリンクの話に注意してください</Text>
                    </View>
                    <Text style={s.cautionBody}>
                      この相手は友だちではありません。お金の振り込みやリンクを開くよう求められたら、詐欺かもしれません。
                    </Text>
                    <View style={s.cautionButtons}>
                      <Pressable
                        role="button"
                        aria-label="通報"
                        style={s.cautionButton}
                        onPress={() => setReportTarget({ peer: item.from })}>
                        <Text style={s.cautionButtonText}>通報</Text>
                      </Pressable>
                      <Pressable
                        role="button"
                        aria-label="ブロック"
                        style={[s.cautionButton, s.cautionButtonDanger]}
                        onPress={() => setBlockingPeer(item.from)}>
                        <Text style={[s.cautionButtonText, s.cautionButtonDangerText]}>ブロック</Text>
                      </Pressable>
                    </View>
                  </View>
                  {withStampOffer}
                </View>
              );
            }
            return (
              <View style={s.mineWrap}>
                <Pressable
                  onPress={() => setOffered(offered === item.id ? null : item.id)}
                  onLongPress={() => setOffered(item.id)}
                  aria-label={unsent ? '未送信のメッセージ' : undefined}>
                  {bubble}
                </Pressable>
                {offered === item.id && (
                  <View style={s.offer}>
                    <Pressable
                      style={s.cancel}
                      onPress={() => {
                        setOffered(null);
                        retrySend();
                      }}
                      role="button">
                      <Text style={s.cancelText}>再送する</Text>
                    </Pressable>
                    <Pressable style={s.cancel} onPress={() => cancelSend(item.id)} role="button">
                      <Text style={s.cancelText}>削除する</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          }}
        />

        {error && <Text style={s.error}>{error}</Text>}

        {isBlocked ? (
          <View style={s.blockedBar}>
            <Text style={s.blockedText}>ブロック中</Text>
          </View>
        ) : (
          <>
            {replying && !recordPanel && (
              <View style={s.replyBar} testID="replying">
                <View style={s.replyBody}>
                  <Text style={s.quoteName} numberOfLines={1}>
                    {nameOf(replying.from)}
                  </Text>
                  <Text style={s.quoteText} numberOfLines={1}>
                    {firstLine(replying)}
                  </Text>
                </View>
                <Pressable role="button" aria-label="キャンセル" style={s.replyClose} onPress={() => setReplying(null)}>
                  <MaterialIcons name="close" size={24} color={c.muted} />
                </Pressable>
              </View>
            )}

            {plusOpen && !recordPanel && (
              <View style={s.plusPanel} testID="plus-panel">
                <Pressable
                  role="button"
                  aria-label="ファイル"
                  disabled={sending}
                  style={[s.plusItem, sending && s.disabled]}
                  onPress={pickFile}>
                  <View style={s.plusIcon}>
                    <MaterialIcons name="description" size={24} color={c.text} />
                  </View>
                  <Text style={s.plusLabel}>ファイル</Text>
                </Pressable>
              </View>
            )}

            {recordPanel ? (
              <View style={s.recordPanel} testID="record-panel">
                <View style={s.recordPanelTop}>
                  <Pressable
                    role="button"
                    aria-label="閉じる"
                    style={s.recordCloseBtn}
                    onPress={cancelRecording}>
                    <MaterialIcons name="close" size={24} color={c.muted} />
                  </Pressable>
                </View>
                {!recording && !recorded ? (
                  <>
                    <Text style={s.recordHint}>ボタンをタップして録音してください</Text>
                    <View style={s.recordControls}>
                      <Pressable
                        role="button"
                        aria-label="録音を開始"
                        disabled={sending}
                        style={[s.recordBigBtn, s.recordStartBtn, sending && s.disabled]}
                        onPress={startRecording}>
                        <MaterialIcons name="fiber-manual-record" size={28} color="#ffffff" />
                      </Pressable>
                    </View>
                  </>
                ) : recording ? (
                  <>
                    <Text style={s.recordElapsed}>{clock(recordingSec)}</Text>
                    <View style={s.recordControls}>
                      <Pressable
                        role="button"
                        aria-label="削除"
                        style={s.recordSideBtn}
                        onPress={cancelRecording}>
                        <MaterialIcons name="delete" size={24} color={c.text} />
                      </Pressable>
                      <Pressable
                        role="button"
                        aria-label="停止"
                        style={[s.recordBigBtn, s.recordStopBtn]}
                        onPress={stopRecordingToPreview}>
                        <MaterialIcons name="stop" size={28} color="#ffffff" />
                      </Pressable>
                      <Pressable
                        role="button"
                        aria-label="送る"
                        disabled={sending}
                        style={[s.recordSendBtn, sending && s.disabled]}
                        onPress={finishRecording}>
                        <MaterialIcons name="send" size={24} color={c.onAccent} />
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <>
                    {recorded && Platform.OS === 'web' && (
                      <audio
                        ref={previewAudioRef}
                        src={recorded.url}
                        onPlay={() => setPreviewPlaying(true)}
                        onPause={() => setPreviewPlaying(false)}
                        onEnded={() => setPreviewPlaying(false)}
                        style={{ display: 'none' }}
                      />
                    )}
                    <Text style={s.recordStoppedTime}>{clock(recorded?.duration ?? recordingSec)}</Text>
                    <View style={s.recordControls}>
                      <Pressable
                        role="button"
                        aria-label="削除"
                        style={s.recordSideBtn}
                        onPress={cancelRecording}>
                        <MaterialIcons name="delete" size={24} color={c.text} />
                      </Pressable>
                      <Pressable
                        role="button"
                        aria-label={previewPlaying ? '一時停止' : '再生'}
                        style={[s.recordBigBtn, s.recordPlayBtn]}
                        onPress={togglePreview}>
                        <MaterialIcons name={previewPlaying ? 'pause' : 'play-arrow'} size={28} color={c.surface} />
                      </Pressable>
                      <Pressable
                        role="button"
                        aria-label="送る"
                        disabled={sending}
                        style={[s.recordSendBtn, sending && s.disabled]}
                        onPress={finishRecording}>
                        <MaterialIcons name="send" size={24} color={c.onAccent} />
                      </Pressable>
                    </View>
                  </>
                )}
              </View>
            ) : (
              <View style={s.composer}>
                <Pressable
                  role="button"
                  aria-label="その他"
                  disabled={sending}
                  style={[s.barIconBtn, sending && s.disabled]}
                  onPress={() => {
                    setPlusOpen((v) => !v);
                    setStampsOpen(false);
                    setStampDeleting(null);
                  }}>
                  <MaterialIcons name="add" size={24} color={c.muted} />
                </Pressable>
                <Pressable
                  role="button"
                  aria-label="カメラ"
                  disabled={sending}
                  style={[s.barIconBtn, sending && s.disabled]}
                  onPress={takePhoto}>
                  <MaterialIcons name="photo-camera" size={24} color={c.muted} />
                </Pressable>
                <Pressable
                  role="button"
                  aria-label="写真"
                  disabled={sending}
                  style={[s.barIconBtn, sending && s.disabled]}
                  onPress={pickPhoto}>
                  <MaterialIcons name="image" size={24} color={c.muted} />
                </Pressable>
                <View style={s.inputWrap}>
                  <TextInput
                    ref={input}
                    style={s.input}
                    value={draft}
                    onChangeText={setDraft}
                    placeholder="メッセージ"
                    placeholderTextColor={c.muted}
                    multiline
                    numberOfLines={1}
                    onKeyPress={(e) => {
                      const ne = e.nativeEvent as unknown as { key: string; shiftKey?: boolean; isComposing?: boolean };
                      if (Platform.OS === 'web' && ne.key === 'Enter' && !ne.shiftKey && !ne.isComposing) {
                        (e as unknown as { preventDefault: () => void }).preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <Pressable
                    role="button"
                    aria-label="スタンプ"
                    disabled={sending}
                    style={[s.stampTrigger, sending && s.disabled]}
                    onPress={() => {
                      setStampsOpen((v) => !v);
                      setPlusOpen(false);
                      setStampDeleting(null);
                    }}>
                    <MaterialIcons name="insert-emoticon" size={24} color={c.muted} />
                  </Pressable>
                </View>
                {draft.trim().length > 0 ? (
                  <Pressable
                    role="button"
                    aria-label="送る"
                    disabled={sending}
                    style={[s.sendBtn, sending && s.disabled]}
                    onPress={submit}>
                    <MaterialIcons name="send" size={24} color={c.onAccent} />
                  </Pressable>
                ) : (
                  <Pressable
                    role="button"
                    aria-label="録音"
                    disabled={sending}
                    style={[s.barIconBtn, sending && s.disabled]}
                    onPress={openRecordPanel}>
                    <MaterialIcons name="mic" size={24} color={c.muted} />
                  </Pressable>
                )}
              </View>
            )}

            {stampsOpen && !recordPanel && (
              <View style={s.stampPanel}>
                <View style={s.stampGrid}>
                  {stamps.map((st) => (
                    <View key={st.sha256} style={s.stampCell}>
                      <Stamp
                        file={st}
                        max={72}
                        testID="stamp-item"
                        onPress={() => pickStamp(st)}
                        onLongPress={() => setStampDeleting((cur) => (cur === st.sha256 ? null : st.sha256))}
                      />
                      {stampDeleting === st.sha256 && (
                        <Pressable
                          role="button"
                          style={s.cancel}
                          onPress={() => {
                            removeStamp(st.sha256);
                            setStampDeleting(null);
                          }}>
                          <Text style={s.cancelText}>削除</Text>
                        </Pressable>
                      )}
                    </View>
                  ))}
                </View>
                <View style={s.forwardButtons}>
                  <Pressable role="button" style={[s.forwardCancel, sending && s.disabled]} disabled={sending} onPress={createStamp}>
                    <Text style={s.callText}>スタンプを作る</Text>
                  </Pressable>
                  <Pressable
                    role="button"
                    style={s.forwardCancel}
                    onPress={() => {
                      setStampsOpen(false);
                      setStampDeleting(null);
                    }}>
                    <Text style={s.callText}>閉じる</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </>
        )}
      </View>

      {deletingId && (
        <Dialog
          text="このメッセージはこの端末でのみ削除されます。相手の端末からは削除されません。"
          onClose={() => setDeletingId(null)}
          buttons={[
            {
              label: 'キャンセル',
              variant: 'text',
              onPress: () => setDeletingId(null),
            },
            {
              label: 'この端末でのみ削除',
              variant: 'danger',
              onPress: () => {
                deleteMessage(deletingId);
                setDeletingId(null);
              },
            },
          ]}
        />
      )}

      {blockingPeer && (
        <Dialog
          title={`${personName(blockingPeer, contacts)}をブロックしますか？`}
          text="ブロックした相手とはメッセージの送受信ができなくなります。相手には伝わりません。"
          stacked
          onClose={() => setBlockingPeer(null)}
          buttons={[
            {
              label: 'ブロック',
              variant: 'danger',
              onPress: () => {
                block(blockingPeer);
                setReplying(null);
                setForwarding(null);
                setBlockingPeer(null);
              },
            },
            {
              label: 'ブロックして通報',
              variant: 'outlined',
              onPress: () => {
                const target = blockingPeer;
                block(target);
                setReplying(null);
                setForwarding(null);
                setBlockingPeer(null);
                setReportTarget({ peer: target });
              },
            },
            {
              label: 'キャンセル',
              variant: 'text',
              onPress: () => setBlockingPeer(null),
            },
          ]}
        />
      )}

      {reportTarget && !group && (
        <ReportSheet
          peer={reportTarget.peer}
          messageId={reportTarget.messageId}
          onClose={() => setReportTarget(null)}
          onRequestBlock={() => {
            const target = reportTarget.peer;
            setReportTarget(null);
            setBlockingPeer(target);
          }}
        />
      )}

      {viewing && <PhotoViewer uri={viewing} onClose={() => setViewing(null)} />}
      {viewingVideo && <VideoViewer uri={viewingVideo} onClose={() => setViewingVideo(null)} />}
    </KeyboardAvoidingView>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 4,
      minHeight: 48,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
      backgroundColor: c.background,
    },
    headerIconBtn: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    headerTitle: {
      flex: 1,
      minWidth: 0,
      fontSize: 17,
      fontWeight: '600',
      color: c.text,
      paddingHorizontal: 4,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      flexShrink: 0,
    },
    list: { padding: 12, gap: 8 },
    itemWrap: { width: '100%', gap: 4 },
    itemWrapMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
    itemWrapTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
    // Full width, so the bubble's max width is a share of the screen, not of its own content.
    swipeLine: { flexDirection: 'row', alignItems: 'center', width: '100%' },
    swipeLineMine: { justifyContent: 'flex-end' },
    swipeReplyIcon: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.line,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 6,
      opacity: 0.65,
    },
    swipeReplyIconReady: {
      backgroundColor: c.accent,
      borderColor: c.accent,
      opacity: 1,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '80%' },
    rowMine: { alignSelf: 'flex-end', justifyContent: 'flex-end' },
    rowTheirs: { alignSelf: 'flex-start' },
    bubble: {
      flexShrink: 1,
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    stampBox: { flexShrink: 1, paddingVertical: 2, borderWidth: 1, borderColor: 'transparent' },
    mine: { backgroundColor: c.mine, borderBottomRightRadius: 4 },
    theirs: { backgroundColor: c.theirs, borderBottomLeftRadius: 4, borderColor: c.line },
    highlight: { borderColor: c.accent, borderWidth: 2 },
    messagePanel: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      maxWidth: 268,
      backgroundColor: '#1b211d',
      borderRadius: 12,
      padding: 6,
      zIndex: 50,
    },
    messagePanelMine: {
      alignSelf: 'flex-end',
    },
    messagePanelTheirs: {
      alignSelf: 'flex-start',
    },
    panelCell: {
      width: 64,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 6,
      paddingHorizontal: 2,
      gap: 2,
    },
    panelLabel: {
      fontSize: 11,
      color: '#ffffff',
      fontWeight: '600',
    },
    copiedToast: {
      alignSelf: 'center',
      backgroundColor: '#1b211d',
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 6,
      marginTop: 6,
    },
    copiedText: {
      fontSize: 13,
      color: '#ffffff',
      fontWeight: '600',
    },
    quote: { borderLeftWidth: 3, borderLeftColor: c.accent, paddingLeft: 8, marginBottom: 4, maxWidth: 260 },
    quoteName: { fontSize: 12, color: c.accent, fontWeight: '600' },
    quoteText: { fontSize: 13, color: c.muted },
    replyBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 8,
      marginTop: 6,
      paddingLeft: 10,
      borderLeftWidth: 3,
      borderLeftColor: c.accent,
    },
    replyBody: { flex: 1 },
    replyClose: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    text: { fontSize: 16, color: c.text, lineHeight: 22 },
    author: { fontSize: 12, color: c.accent, fontWeight: '600', marginBottom: 2 },
    time: { fontSize: 11, color: c.muted, alignSelf: 'flex-end', marginTop: 2 },
    waiting: { opacity: 0.6 },
    full: { maxWidth: '100%' },
    mineWrap: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '78%' },
    theirsWrap: { alignSelf: 'flex-start', alignItems: 'flex-start', maxWidth: '88%' },
    offer: { flexDirection: 'row', justifyContent: 'flex-end', gap: 4 },
    offerTheirs: { justifyContent: 'flex-start' },
    stampPanel: {
      gap: 10,
      padding: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      backgroundColor: c.surface,
    },
    stampGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'center' },
    stampCell: { alignItems: 'center', gap: 4 },
    cancel: { paddingHorizontal: 8, paddingVertical: 6 },
    cancelText: { fontSize: 14, color: c.accent, fontWeight: '600' },
    addBar: {
      flexDirection: 'row',
      gap: 8,
      padding: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
      backgroundColor: c.surface,
    },
    addInput: {
      flex: 1,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 8,
      fontSize: 15,
      color: c.text,
      backgroundColor: c.background,
    },
    addButton: { backgroundColor: c.accent, borderRadius: 20, paddingHorizontal: 14, minHeight: 44, justifyContent: 'center' },
    error: { fontSize: 13, color: c.danger, paddingHorizontal: 16, paddingBottom: 4 },
    blockedBar: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      backgroundColor: c.surface,
    },
    blockedText: { fontSize: 14, color: c.muted },
    forwardPanel: {
      gap: 10,
      padding: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.line,
      backgroundColor: c.surface,
    },
    forwardTitle: { fontSize: 15, color: c.text, fontWeight: '600' },
    forwardList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    forwardTarget: {
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: c.background,
    },
    forwardTargetText: { fontSize: 14, color: c.text },
    forwardButtons: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    forwardCancel: { paddingHorizontal: 10, paddingVertical: 8 },
    cautionWrap: { alignSelf: 'stretch', gap: 8 },
    cautionCard: {
      alignSelf: 'center',
      width: '100%',
      maxWidth: 360,
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      padding: 14,
      gap: 8,
    },
    cautionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    cautionTitle: {
      flex: 1,
      fontSize: 15,
      fontWeight: '700',
      color: c.text,
    },
    cautionBody: {
      fontSize: 13,
      lineHeight: 19,
      color: c.muted,
    },
    cautionButtons: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 4,
    },
    cautionButton: {
      flex: 1,
      minHeight: 44,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.line,
      backgroundColor: c.background,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 12,
    },
    cautionButtonDanger: {
      borderColor: c.danger,
    },
    cautionButtonText: {
      fontSize: 14,
      fontWeight: '600',
      color: c.text,
    },
    cautionButtonDangerText: {
      color: c.danger,
    },
    plusPanel: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 16,
      paddingHorizontal: 16,
      paddingVertical: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      backgroundColor: c.surface,
    },
    plusItem: {
      alignItems: 'center',
      gap: 6,
      minWidth: 64,
      minHeight: 44,
    },
    plusIcon: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    plusLabel: {
      fontSize: 12,
      color: c.text,
      fontWeight: '500',
    },
    composer: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 2,
      paddingVertical: 6,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      backgroundColor: c.background,
    },
    barIconBtn: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    inputWrap: {
      flex: 1,
      minWidth: 0,
      position: 'relative',
      justifyContent: 'center',
    },
    input: {
      width: '100%',
      maxHeight: 140,
      minHeight: 44,
      backgroundColor: c.surface,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: c.line,
      paddingLeft: 14,
      paddingRight: 44,
      paddingVertical: 10,
      fontSize: 16,
      lineHeight: 22,
      color: c.text,
    },
    stampTrigger: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    recordPanel: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
      backgroundColor: c.surface,
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 24,
      alignItems: 'center',
      gap: 14,
    },
    recordPanelTop: {
      alignSelf: 'stretch',
      flexDirection: 'row',
      justifyContent: 'flex-end',
    },
    recordCloseBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    recordHint: {
      fontSize: 14,
      color: c.muted,
      textAlign: 'center',
    },
    recordElapsed: {
      fontSize: 20,
      fontWeight: '700',
      color: c.accent,
      textAlign: 'center',
    },
    recordStoppedTime: {
      fontSize: 20,
      fontWeight: '700',
      color: c.text,
      textAlign: 'center',
    },
    recordControls: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 28,
    },
    recordBigBtn: {
      width: 68,
      height: 68,
      borderRadius: 34,
      alignItems: 'center',
      justifyContent: 'center',
    },
    recordStartBtn: {
      backgroundColor: c.danger,
    },
    recordStopBtn: {
      backgroundColor: c.danger,
    },
    recordPlayBtn: {
      backgroundColor: c.text,
    },
    recordSideBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    recordSendBtn: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: c.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    disabled: { opacity: 0.4 },
    callText: { fontSize: 15, color: c.accent, fontWeight: '600' },
    callRow: { alignSelf: 'center', paddingVertical: 2 },
    callNote: { fontSize: 13, color: c.muted },
    missed: { color: c.accent },
    sendText: { color: c.onAccent, fontSize: 15, fontWeight: '600' },
  });
