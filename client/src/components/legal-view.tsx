// A terms or policy page, read inside the app. The blocks come from src/content/legal.json, which
// scripts/build-legal.mjs makes from the website's text, so the app and tegami.chat say the same.
import { Linking, StyleSheet, Text, View } from 'react-native';

import { SettingsPage } from '@/components/settings-ui';
import { Palette, usePalette } from '@/constants/theme';
import legal from '@/content/legal.json';

type Piece = { text: string; href?: string };
type Rich = string | Piece[];
type Item = { text: Rich; sub?: List[] };
type List = { type: 'ol' | 'ul'; items: Item[] };
type Block =
  | { type: 'h1' | 'h2' | 'p' | 'date'; text: Rich }
  | List
  | { type: 'rows'; rows: { title: Rich; fields: { label: Rich; text: Rich }[] }[] }
  | { type: 'dl'; items: { term: Rich; text: Rich }[] };

export type LegalName = keyof typeof legal;

function Rich({ value, style, linkColor }: { value: Rich; style: object; linkColor: string }) {
  if (typeof value === 'string') return <Text style={style}>{value}</Text>;
  return (
    <Text style={style}>
      {value.map((p, i) =>
        p.href ? (
          <Text key={i} role="link" style={{ color: linkColor, textDecorationLine: 'underline' }} onPress={() => void Linking.openURL(p.href as string)}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

export function LegalView({ name }: { name: LegalName }) {
  const c = usePalette();
  const s = styles(c);
  const blocks = legal[name] as Block[];

  const rich = (value: Rich, style: object = s.body) => <Rich value={value} style={style} linkColor={c.accent} />;

  const list = (l: List, depth = 0) => (
    <View style={[s.list, depth > 0 && s.nested]}>
      {l.items.map((item, i) => (
        <View key={i} style={s.item}>
          <View style={s.itemRow}>
            <Text style={s.mark}>{l.type === 'ol' ? `${i + 1}.` : '・'}</Text>
            <View style={s.fill}>{rich(item.text)}</View>
          </View>
          {item.sub?.map((sub, j) => <View key={j}>{list(sub, depth + 1)}</View>)}
        </View>
      ))}
    </View>
  );

  return (
    <SettingsPage>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'h1':
            return null;
          case 'h2':
            return (
              <View key={i} style={s.h2}>
                {rich(b.text, s.h2Text)}
              </View>
            );
          case 'p':
            return <View key={i}>{rich(b.text)}</View>;
          case 'date':
            return <View key={i}>{rich(b.text, s.date)}</View>;
          case 'ol':
          case 'ul':
            return <View key={i}>{list(b)}</View>;
          case 'rows':
            return (
              <View key={i} style={s.cards}>
                {b.rows.map((r, j) => (
                  <View key={j} style={s.card}>
                    {rich(r.title, s.cardTitle)}
                    {r.fields.map((f, k) => (
                      <View key={k}>
                        {rich(f.label, s.label)}
                        {rich(f.text)}
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            );
          case 'dl':
            return (
              <View key={i} style={s.cards}>
                {b.items.map((d, j) => (
                  <View key={j}>
                    {rich(d.term, s.label)}
                    {rich(d.text)}
                  </View>
                ))}
              </View>
            );
        }
      })}
    </SettingsPage>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    fill: { flex: 1 },
    body: { fontSize: 15, lineHeight: 24, color: c.text },
    h2: { marginTop: 14 },
    h2Text: { fontSize: 17, lineHeight: 24, fontWeight: '700', color: c.text },
    date: { fontSize: 13, lineHeight: 20, color: c.muted, marginTop: 14 },
    list: { gap: 8 },
    nested: { marginTop: 8, marginLeft: 16 },
    item: {},
    itemRow: { flexDirection: 'row', gap: 6 },
    mark: { fontSize: 15, lineHeight: 24, color: c.muted, minWidth: 22 },
    cards: { gap: 10 },
    card: { backgroundColor: c.surface, borderRadius: 12, borderWidth: 1, borderColor: c.line, padding: 14, gap: 8 },
    cardTitle: { fontSize: 15, lineHeight: 22, fontWeight: '700', color: c.text },
    label: { fontSize: 13, lineHeight: 20, color: c.muted },
  });
