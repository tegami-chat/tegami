import Svg, { Path } from 'react-native-svg';

// Icon shapes from Lucide (ISC licence, https://lucide.dev): megaphone-off, bot-message-square, eye-off.
export type PillarIconName = 'no-ads' | 'ai-friend' | 'no-peeking';

const PATHS: Record<PillarIconName, string[]> = {
  'no-ads': [
    'M11.636 6A13 13 0 0 0 19.4 3.2 1 1 0 0 1 21 4v11.344',
    'M14.378 14.357A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h1',
    'm2 2 20 20',
    'M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14',
    'M8 8v6',
  ],
  'ai-friend': [
    'M12 6V2H8',
    'M15 11v2',
    'M2 12h2',
    'M20 12h2',
    'M20 16a2 2 0 0 1-2 2H8.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 4 20.286V8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z',
    'M9 11v2',
  ],
  'no-peeking': [
    'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49',
    'M14.084 14.158a3 3 0 0 1-4.242-4.242',
    'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143',
    'm2 2 20 20',
  ],
};

export function PillarIcon({ name, size = 22, color }: { name: PillarIconName; size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name].map((d) => <Path key={d} d={d} />)}
    </Svg>
  );
}
