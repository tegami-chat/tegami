import { useColorScheme } from 'react-native';

// Forest green with a Nostr purple accent (decided 2026-11-13, option A). The tones come from
// Material Color Utilities (Material Design 3, seed #1d6b4b), so text and backgrounds keep
// readable contrast in both light and dark.
export const Colors = {
  light: {
    background: '#f5fbf4',
    surface: '#ffffff',
    text: '#171d19',
    muted: '#404943',
    line: '#c0c9c1',
    accent: '#106c4a',
    onAccent: '#ffffff',
    danger: '#ba1a1a',
    mine: '#a1f4c8',
    theirs: '#ffffff',
    nostr: '#7c2eda',
  },
  dark: {
    background: '#111412',
    surface: '#1b211d',
    text: '#dee4de',
    muted: '#c0c9c1',
    line: '#404943',
    accent: '#8fd5b0',
    onAccent: '#003824',
    danger: '#e05245',
    mine: '#005236',
    theirs: '#1b211d',
    nostr: '#d8b9ff',
  },
} as const;

export type Palette = Record<keyof (typeof Colors)['light'], string>;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? Colors.dark : Colors.light;
}
