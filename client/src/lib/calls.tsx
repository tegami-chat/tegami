// 1:1 voice and video calls (philosophy #45), browser only for now (WebRTC).
//
// Signaling goes through the Tegami relay as gift-wrapped envelopes that expire after a
// minute (lib/signal.ts), so the relay sees neither who calls whom nor anything about the
// call. Sound and video go directly between the two browsers (WebRTC, encrypted with DTLS-SRTP).
//
// Signals: offer (with the caller's SDP), answer, ice (late candidates, batched), hangup,
// decline, busy. Most candidates travel inside the offer and the answer: each side waits a
// moment for candidates to be gathered before sending its description, so a call needs only
// a few envelopes (the relay limits how fast a key may send).
//
// Only contacts can ring. A call from anyone else is dropped without a trace.
// When I answer or decline on one device, my other devices stop ringing (a copy of the
// answer/decline goes to my own key).

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useTegami, type Signal } from './tegami';

// STUN only, for now. There is no TURN server yet, so calls can fail when both sides are
// behind strict NATs (symmetric NAT, some mobile carriers, some company or hotel networks):
// the two browsers then cannot reach each other directly and nothing relays the media.
// When a TURN server is set up, add it here, e.g.
//   { urls: ['turn:turn.tegami.chat:3478', 'turns:turn.tegami.chat:5349'], username, credential }
// (TURN credentials should be short-lived and fetched from the relay, not built in.)
export const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

/** How long a call rings before it gives up. */
export const RING_MS = 45_000;
/** How long to wait for the connection after the call is answered. */
const CONNECT_MS = 25_000;
/** How long to wait for candidates before sending the offer or answer. */
const GATHER_MS = 2_000;
/** How long the "call ended" screen stays. */
const ENDED_MS = 2_000;

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended';

export type CallView = {
  phase: CallPhase;
  peer: string;
  video: boolean;
  /** ms since epoch when the media connected. */
  connectedAt?: number;
  muted: boolean;
  cameraOff: boolean;
  local?: MediaStream;
  remote?: MediaStream;
  /** Shown on the ended screen. */
  endText?: string;
};

type Live = {
  id: string;
  peer: string;
  video: boolean;
  role: 'caller' | 'callee';
  offer?: string;
  pc?: RTCPeerConnection;
  stream?: MediaStream;
  pendingIce: RTCIceCandidateInit[];
  outIce: RTCIceCandidateInit[];
  descSent: boolean;
  connectedAt?: number;
  timers: ReturnType<typeof setTimeout>[];
};

type CallState = {
  call: CallView;
  /** Whether this browser can make calls at all. */
  supported: boolean;
  /** Must be called directly from a tap (iPhone asks for the microphone only then). */
  startCall: (peer: string, video: boolean) => void;
  accept: () => void;
  decline: () => void;
  hangUp: () => void;
  toggleMute: () => void;
  toggleCamera: () => void;
};

const IDLE: CallView = { phase: 'idle', peer: '', video: false, muted: false, cameraOff: false };

const Ctx = createContext<CallState | null>(null);

export function useCall() {
  const value = useContext(Ctx);
  if (!value) throw new Error('useCall must be used inside CallProvider');
  return value;
}

export function callsSupported() {
  return (
    typeof globalThis.RTCPeerConnection === 'function' &&
    typeof globalThis.navigator?.mediaDevices?.getUserMedia === 'function'
  );
}

function newId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function media(video: boolean) {
  return navigator.mediaDevices.getUserMedia(
    video ? { audio: true, video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } } : { audio: true },
  );
}

function gathered(pc: RTCPeerConnection, ms: number) {
  return new Promise<void>((done) => {
    if (pc.iceGatheringState === 'complete') return done();
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        done();
      }
    });
  });
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { me, contacts, sendSignal, onSignal, recordCall } = useTegami();
  const [view, setView] = useState<CallView>(IDLE);
  const live = useRef<Live | null>(null);
  const endedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const contactsRef = useRef(contacts);
  contactsRef.current = contacts;
  const supported = useMemo(callsSupported, []);

  const signal = useCallback(
    (l: Live, data: Record<string, unknown>, alsoMe = false) =>
      sendSignal(l.peer, { ...data, id: l.id }, alsoMe).catch(() => {
        // The relay could not be reached. The other side times out on its own.
      }),
    [sendSignal],
  );

  /**
   * Ends the call on this device. text: what the ended screen says (none: back at once).
   * record: whether to note the call in the chat.
   */
  const end = useCallback(
    (l: Live, text?: string, record = true) => {
      if (live.current !== l) return;
      live.current = null;
      for (const t of l.timers) clearTimeout(t);
      l.stream?.getTracks().forEach((t) => t.stop());
      try {
        l.pc?.close();
      } catch {}
      if (record && me) {
        const seconds = l.connectedAt ? Math.round((Date.now() - l.connectedAt) / 1000) : undefined;
        const result = l.connectedAt ? 'done' : l.role === 'caller' ? 'unanswered' : 'missed';
        recordCall(l.peer, l.role === 'caller' ? me : l.peer, { video: l.video, result, seconds }, l.id);
      }
      clearTimeout(endedTimer.current);
      if (text) {
        setView((v) => ({ ...IDLE, phase: 'ended', peer: l.peer, video: l.video, endText: text, connectedAt: v.connectedAt }));
        endedTimer.current = setTimeout(() => setView((v) => (v.phase === 'ended' ? IDLE : v)), ENDED_MS);
      } else {
        setView(IDLE);
      }
    },
    [me, recordCall],
  );

  const connected = useCallback((l: Live) => {
    if (l.connectedAt || live.current !== l) return;
    l.connectedAt = Date.now();
    setView((v) => ({ ...v, phase: 'active', connectedAt: l.connectedAt }));
  }, []);

  /** A peer connection with my media on it, wired to this call. */
  const makePc = useCallback(
    (l: Live, stream: MediaStream) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      l.pc = pc;
      for (const t of stream.getTracks()) pc.addTrack(t, stream);
      pc.ontrack = (e) => {
        const remote = e.streams[0] ?? new MediaStream([e.track]);
        if (live.current === l) setView((v) => ({ ...v, remote }));
      };
      let flush: ReturnType<typeof setTimeout> | undefined;
      pc.onicecandidate = (e) => {
        // Candidates found before the offer/answer was sent travel inside it.
        if (!e.candidate || !l.descSent) return;
        l.outIce.push(e.candidate.toJSON());
        if (flush) return;
        flush = setTimeout(() => {
          flush = undefined;
          const c = l.outIce.splice(0);
          if (c.length && live.current === l) signal(l, { t: 'ice', c });
        }, 300);
      };
      let lost: ReturnType<typeof setTimeout> | undefined;
      const onState = () => {
        const s = pc.connectionState ?? pc.iceConnectionState;
        const ice = pc.iceConnectionState;
        if (s === 'connected' || ice === 'connected' || ice === 'completed') {
          clearTimeout(lost);
          lost = undefined;
          connected(l);
        } else if (s === 'failed' || ice === 'failed') {
          signal(l, { t: 'hangup' });
          end(l, 'つながりませんでした');
        } else if ((s === 'disconnected' || ice === 'disconnected') && !lost) {
          // Often comes back by itself (the network changed for a moment).
          lost = setTimeout(() => {
            if (pc.connectionState === 'connected' || pc.iceConnectionState === 'connected') return;
            signal(l, { t: 'hangup' });
            end(l, 'つながりませんでした');
          }, 10_000);
          l.timers.push(lost);
        }
      };
      pc.onconnectionstatechange = onState;
      pc.oniceconnectionstatechange = onState;
      return pc;
    },
    [signal, end, connected],
  );

  const waitForConnection = useCallback(
    (l: Live) => {
      l.timers.push(
        setTimeout(() => {
          if (l.connectedAt) return;
          signal(l, { t: 'hangup' });
          end(l, 'つながりませんでした');
        }, CONNECT_MS),
      );
    },
    [signal, end],
  );

  const addIce = useCallback((l: Live, list: RTCIceCandidateInit[]) => {
    if (!l.pc?.remoteDescription) {
      l.pendingIce.push(...list);
      return;
    }
    for (const c of list) l.pc.addIceCandidate(c).catch(() => {});
  }, []);

  const failedMedia = useCallback((l: Live) => {
    end(l, l.video ? 'カメラかマイクを使えませんでした' : 'マイクを使えませんでした', false);
  }, [end]);

  const startCall = useCallback(
    (peer: string, video: boolean) => {
      if (live.current || !supported) return;
      // Ask for the microphone first, inside the tap (iPhone allows it only then).
      const asked = media(video);
      const l: Live = { id: newId(), peer, video, role: 'caller', pendingIce: [], outIce: [], descSent: false, timers: [] };
      live.current = l;
      clearTimeout(endedTimer.current);
      setView({ ...IDLE, phase: 'outgoing', peer, video });
      (async () => {
        let stream: MediaStream;
        try {
          stream = await asked;
        } catch {
          return failedMedia(l);
        }
        if (live.current !== l) return stream.getTracks().forEach((t) => t.stop());
        l.stream = stream;
        setView((v) => ({ ...v, local: stream }));
        const pc = makePc(l, stream);
        await pc.setLocalDescription(await pc.createOffer());
        await gathered(pc, GATHER_MS);
        if (live.current !== l) return;
        l.descSent = true;
        await signal(l, { t: 'offer', video, sdp: pc.localDescription?.sdp ?? '' });
        l.timers.push(
          setTimeout(() => {
            if (live.current !== l || l.pc?.remoteDescription) return;
            signal(l, { t: 'hangup' });
            end(l, '応答がありません');
          }, RING_MS),
        );
      })().catch(() => end(l, 'つながりませんでした', false));
    },
    [supported, makePc, signal, end, failedMedia],
  );

  const accept = useCallback(() => {
    const l = live.current;
    if (!l || l.role !== 'callee' || l.pc || !l.offer) return;
    // Ask for the microphone first, inside the tap (iPhone allows it only then).
    const asked = media(l.video);
    for (const t of l.timers.splice(0)) clearTimeout(t);
    setView((v) => ({ ...v, phase: 'connecting' }));
    (async () => {
      let stream: MediaStream;
      try {
        stream = await asked;
      } catch {
        signal(l, { t: 'decline' }, true);
        return failedMedia(l);
      }
      if (live.current !== l) return stream.getTracks().forEach((t) => t.stop());
      l.stream = stream;
      setView((v) => ({ ...v, local: stream }));
      const pc = makePc(l, stream);
      await pc.setRemoteDescription({ type: 'offer', sdp: l.offer });
      addIce(l, l.pendingIce.splice(0));
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc, GATHER_MS);
      if (live.current !== l) return;
      l.descSent = true;
      // A copy to my other devices, so they stop ringing.
      await signal(l, { t: 'answer', sdp: pc.localDescription?.sdp ?? '' }, true);
      waitForConnection(l);
    })().catch(() => {
      signal(l, { t: 'hangup' });
      end(l, 'つながりませんでした');
    });
  }, [makePc, signal, end, addIce, failedMedia, waitForConnection]);

  const decline = useCallback(() => {
    const l = live.current;
    if (!l || l.role !== 'callee') return;
    signal(l, { t: 'decline' }, true);
    end(l, undefined, false);
  }, [signal, end]);

  const hangUp = useCallback(() => {
    const l = live.current;
    if (!l) {
      clearTimeout(endedTimer.current);
      setView(IDLE);
      return;
    }
    if (l.role === 'callee' && !l.pc) return decline();
    signal(l, { t: 'hangup' });
    // Hanging up my own call before it was answered is not worth a note in the chat.
    end(l, '通話が終了しました', !!l.connectedAt || l.role === 'callee');
  }, [signal, end, decline]);

  const toggleMute = useCallback(() => {
    const tracks = live.current?.stream?.getAudioTracks() ?? [];
    const muted = tracks.every((t) => t.enabled);
    for (const t of tracks) t.enabled = !muted;
    setView((v) => ({ ...v, muted }));
  }, []);

  const toggleCamera = useCallback(() => {
    const tracks = live.current?.stream?.getVideoTracks() ?? [];
    const off = tracks.every((t) => t.enabled);
    for (const t of tracks) t.enabled = !off;
    setView((v) => ({ ...v, cameraOff: off }));
  }, []);

  // Signals from the other person (and copies from my other devices).
  useEffect(() => {
    if (!me) return;
    return onSignal((s: Signal) => {
      const d = s.data;
      const t = str(d.t);
      const id = str(d.id);
      if (!id) return;
      const l = live.current;

      // My other device answered or declined this call: stop ringing here.
      if (s.from === me) {
        if (l && l.role === 'callee' && !l.pc && l.id === id && (t === 'answer' || t === 'decline')) end(l, undefined, false);
        return;
      }

      if (t === 'offer') {
        // Only contacts can ring. Anyone else: nothing happens, nothing is kept.
        if (!contactsRef.current.some((c) => c.pubkey === s.from)) return;
        const sdp = str(d.sdp);
        if (!sdp) return;
        if (l) {
          if (l.id === id) return;
          // Busy: say so, and note the missed call.
          sendSignal(s.from, { t: 'busy', id }).catch(() => {});
          recordCall(s.from, s.from, { video: d.video === true, result: 'missed' }, id);
          return;
        }
        const n: Live = {
          id,
          peer: s.from,
          video: d.video === true,
          role: 'callee',
          offer: sdp,
          pendingIce: [],
          outIce: [],
          descSent: false,
          timers: [],
        };
        live.current = n;
        clearTimeout(endedTimer.current);
        setView({ ...IDLE, phase: 'incoming', peer: s.from, video: n.video });
        // The ring stops on its own; the caller gives up at the same time.
        n.timers.push(setTimeout(() => end(n, undefined, true), RING_MS));
        return;
      }

      if (!l || l.id !== id || l.peer !== s.from) return;
      if (t === 'answer' && l.role === 'caller' && l.pc && !l.pc.remoteDescription) {
        const sdp = str(d.sdp);
        if (!sdp) return;
        for (const x of l.timers.splice(0)) clearTimeout(x);
        setView((v) => ({ ...v, phase: 'connecting' }));
        l.pc
          .setRemoteDescription({ type: 'answer', sdp })
          .then(() => addIce(l, l.pendingIce.splice(0)))
          .catch(() => {
            signal(l, { t: 'hangup' });
            end(l, 'つながりませんでした');
          });
        waitForConnection(l);
      } else if (t === 'ice' && Array.isArray(d.c)) {
        addIce(l, (d.c as unknown[]).filter((c): c is RTCIceCandidateInit => !!c && typeof c === 'object').slice(0, 50));
      } else if (t === 'hangup') {
        // Hung up while ringing here: a missed call, quietly.
        end(l, l.role === 'callee' && !l.pc ? undefined : '通話が終了しました');
      } else if (t === 'decline' && l.role === 'caller') {
        end(l, '応答がありません');
      } else if (t === 'busy' && l.role === 'caller') {
        end(l, '相手は通話中です');
      }
    });
  }, [me, onSignal, sendSignal, recordCall, end, signal, addIce, waitForConnection]);

  // Leaving the page ends the call for the other person too.
  useEffect(() => {
    const bye = () => {
      const l = live.current;
      if (l && (l.pc || l.role === 'caller')) signal(l, { t: 'hangup' });
    };
    globalThis.addEventListener?.('pagehide', bye);
    return () => globalThis.removeEventListener?.('pagehide', bye);
  }, [signal]);

  const value: CallState = { call: view, supported, startCall, accept, decline, hangUp, toggleMute, toggleCamera };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
