// Voice message playback on the phone apps lives in voice-player.native.ts. The browser plays
// with an <audio> element in photo.tsx, so this is empty here.

export type VoicePlayer = { toggle: () => void; remove: () => void };
export type VoiceHandlers = {
  onPlaying: (playing: boolean) => void;
  onProgress: (fraction: number) => void;
  onDuration: (seconds: number) => void;
};

export function createVoicePlayer(_uri: string, _handlers: VoiceHandlers): VoicePlayer {
  return { toggle() {}, remove() {} };
}
