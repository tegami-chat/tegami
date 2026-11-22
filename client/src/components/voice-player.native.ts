import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';

import type { VoiceHandlers, VoicePlayer } from './voice-player';

export type { VoiceHandlers, VoicePlayer };

/** Plays one kept voice file (a file:// address). Call remove() when the message leaves the screen. */
export function createVoicePlayer(uri: string, h: VoiceHandlers): VoicePlayer {
  const player = createAudioPlayer({ uri });
  void setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  const sub = player.addListener('playbackStatusUpdate', (status) => {
    h.onPlaying(status.playing);
    if (status.duration > 0) {
      h.onDuration(Math.round(status.duration));
      h.onProgress(Math.min(1, status.currentTime / status.duration));
    }
    if (status.didJustFinish) {
      h.onPlaying(false);
      h.onProgress(0);
      void player.seekTo(0);
    }
  });
  return {
    toggle() {
      if (player.playing) player.pause();
      else player.play();
    },
    remove() {
      sub.remove();
      player.remove();
    },
  };
}
