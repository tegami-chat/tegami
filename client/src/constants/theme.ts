import { useColorScheme } from 'react-native';

// Warm paper colors, shared with tegami.chat.
export const Colors = {
  light: {
    background: '#faf7f2',
    surface: '#ffffff',
    text: '#22201c',
    muted: '#6b655c',
    line: '#e4ddd2',
    accent: '#b5452f',
    onAccent: '#ffffff',
    danger: '#c8372d',
    mine: '#f3e1da',
    theirs: '#ffffff',
  },
  dark: {
    background: '#1a1917',
    surface: '#23211e',
    text: '#ece8e1',
    muted: '#a39c91',
    line: '#34312c',
    accent: '#e0775f',
    onAccent: '#1a1917',
    danger: '#e05245',
    mine: '#4a2c24',
    theirs: '#2b2925',
  },
} as const;

export type Palette = Record<keyof (typeof Colors)['light'], string>;

export function usePalette(): Palette {
  return useColorScheme() === 'dark' ? Colors.dark : Colors.light;
}
