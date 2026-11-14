// The call screen: covers the app while a call rings, connects or goes on, wherever the
// person is. Browser only for now (lib/calls.tsx).

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useCall } from '@/lib/calls';
import { clock, personName, useTegami } from '@/lib/tegami';

const BG = '#111412';
const TEXT = '#dee4de';
const MUTED = '#c0c9c1';
const RED = '#ba1a1a';
const GREEN = '#106c4a';
const KEY = '#2a312c';

/** A <video> or <audio> element playing a stream. */
function Media({ stream, kind, mirror, small }: { stream?: MediaStream; kind: 'video' | 'audio'; mirror?: boolean; small?: boolean }) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== (stream ?? null)) ref.current.srcObject = stream ?? null;
  }, [stream]);
  if (kind === 'audio') return <audio ref={ref} autoPlay data-call="remote-audio" />;
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={mirror}
      data-call={mirror ? 'local-video' : 'remote-video'}
      style={
        small
          ? { position: 'absolute', right: 16, top: 16, width: 112, height: 150, objectFit: 'cover', borderRadius: 12, transform: 'scaleX(-1)', background: '#000' }
          : { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', background: '#000' }
      }
    />
  );
}

function Round({
  label,
  icon,
  color,
  onPress,
}: {
  label: string;
  icon: ComponentProps<typeof MaterialIcons>['name'];
  color: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} role="button" aria-label={label} style={[s.round, { backgroundColor: color }]}>
      <MaterialIcons name={icon} size={24} color="#ffffff" />
      <Text style={s.roundText}>{label}</Text>
    </Pressable>
  );
}

function Elapsed({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <Text style={s.status}>{since ? clock((now - since) / 1000) : ''}</Text>;
}

/** A soft two-tone ring while a call comes in (Web Audio; silent if the browser blocks it). */
function useRing(on: boolean) {
  useEffect(() => {
    if (!on || Platform.OS !== 'web') return;
    const AC = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    let ctx: AudioContext | null = null;
    try {
      ctx = AC ? new AC() : null;
    } catch {}
    const beep = () => {
      globalThis.navigator?.vibrate?.([300, 200, 300]);
      if (!ctx || ctx.state === 'closed') return;
      for (const [f, at] of [[660, 0], [880, 0.35]] as const) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + at + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + at);
        o.stop(ctx.currentTime + at + 0.32);
      }
    };
    beep();
    const t = setInterval(beep, 2500);
    return () => {
      clearInterval(t);
      ctx?.close().catch(() => {});
    };
  }, [on]);
}

export function CallScreen() {
  const { call, accept, decline, hangUp, toggleMute, toggleCamera } = useCall();
  const { contacts } = useTegami();
  useRing(call.phase === 'incoming');
  if (call.phase === 'idle') return null;

  const name = personName(call.peer, contacts);
  const showVideo = call.video && (call.phase === 'connecting' || call.phase === 'active' || call.phase === 'outgoing');
  const status =
    call.phase === 'incoming'
      ? call.video
        ? 'ビデオ通話'
        : '音声通話'
      : call.phase === 'outgoing'
        ? '呼び出し中'
        : call.phase === 'connecting'
          ? '接続中'
          : call.phase === 'ended'
            ? call.endText
            : null;

  return (
    <View style={s.fill} aria-live="polite">
      {showVideo && <Media stream={call.remote} kind="video" />}
      {showVideo && call.local && !call.cameraOff && <Media stream={call.local} kind="video" mirror small />}
      {!call.video && call.remote && <Media stream={call.remote} kind="audio" />}
      <View style={s.top}>
        <Text style={s.name} numberOfLines={1}>
          {name}
        </Text>
        {call.phase === 'active' ? <Elapsed since={call.connectedAt} /> : <Text style={s.status}>{status}</Text>}
      </View>
      <View style={s.keys}>
        {call.phase === 'incoming' && (
          <>
            <Round label="拒否" icon="call-end" color={RED} onPress={decline} />
            <Round label="応答" icon={call.video ? 'videocam' : 'call'} color={GREEN} onPress={accept} />
          </>
        )}
        {(call.phase === 'outgoing' || call.phase === 'connecting' || call.phase === 'active') && (
          <>
            <Round
              label={call.muted ? 'ミュート解除' : 'ミュート'}
              icon={call.muted ? 'mic-off' : 'mic'}
              color={KEY}
              onPress={toggleMute}
            />
            {call.video && (
              <Round
                label={call.cameraOff ? 'カメラをオン' : 'カメラをオフ'}
                icon={call.cameraOff ? 'videocam-off' : 'videocam'}
                color={KEY}
                onPress={toggleCamera}
              />
            )}
            <Round label="通話を終了" icon="call-end" color={RED} onPress={hangUp} />
          </>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 100, backgroundColor: BG, justifyContent: 'space-between', overflow: 'hidden' },
  top: { alignItems: 'center', paddingTop: 72, paddingHorizontal: 24, gap: 8 },
  name: { fontSize: 28, fontWeight: '600', color: TEXT, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
  status: { fontSize: 16, color: MUTED, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 6 },
  keys: { flexDirection: 'row', justifyContent: 'center', gap: 28, paddingBottom: 64, paddingHorizontal: 16, flexWrap: 'wrap' },
  round: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center', padding: 6, gap: 2 },
  roundText: { color: '#ffffff', fontSize: 11, fontWeight: '600', textAlign: 'center' },
});
