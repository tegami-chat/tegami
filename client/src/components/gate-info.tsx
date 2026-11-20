import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { Palette, usePalette } from '@/constants/theme';
import { useWide } from '@/lib/layout';

const PILLARS = [
  {
    title: 'プラットフォームから自由に。',
    body: '追いかけてくる広告も、見たくないニュースも、やりたくないゲームも、いらない機能も、全部ありません。あなたの個人情報を広告や営業のために売ることもありません。',
  },
  {
    title: 'AIを自由に使う。',
    body: '自分のAIを、友だちとしてつなげられます。MCP（AIとツールをつなぐ仕組み）を使えば、AIがメッセージを読んだり送ったりできます。AIを使わないことも、相手のAIに自分の文を読ませないことも、あなたの自由です。',
  },
  {
    title: '誰にも覗かれない。',
    body: 'メッセージは端末の中で暗号化してから送り、端末に保存します。Tegamiのサーバーを通る間も暗号化したままなので、運営者にも読めません。',
  },
];

const FEATURES = [
  '1対1のトーク',
  'グループトーク',
  '写真と動画',
  '音声通話',
  'ビデオ通話',
  'スタンプ',
  '音声メッセージ',
  'ファイル',
  '検索',
  'スマホとパソコンで同時利用',
  '機種変更の引き継ぎ',
  'ブロックと通報',
  '自分のAIとトーク',
  '複数のアカウント',
  'トーク履歴をいつでも書き出し',
];

const STEPS = [
  { title: '「はじめる」を押す', body: '電話番号もメールアドレスもいりません。' },
  { title: 'パスキーで鍵を守る', body: 'アカウントの鍵は、この端末の中で作ります。' },
  { title: '友だちを追加する', body: '招待リンクを送るか、QRコードを見せます。' },
];

const LINKS = [
  { label: 'Tegamiのサイト', href: 'https://tegami.chat/ja/' },
  { label: '安全の仕組み', href: 'https://tegami.chat/ja/how' },
  { label: 'よくある質問', href: 'https://tegami.chat/ja/faq' },
  { label: '稼働状況', href: 'https://tegami.chat/ja/status' },
  { label: 'プライバシーポリシー', href: 'https://tegami.chat/ja/privacy' },
  { label: '運営者情報', href: 'https://tegami.chat/ja/about' },
  { label: 'GitHub', href: 'https://github.com/tegami-chat/tegami' },
];

/** What Tegami is, below the buttons of the first screen: three pillars, the features, how to start, and the links. */
export function GateInfo() {
  const c = usePalette();
  const s = styles(c);
  const wide = useWide();
  const row = wide ? s.row : s.column;
  return (
    <View style={s.section}>
      <View style={s.inner}>
        <View style={row}>
          {PILLARS.map((p) => (
            <View key={p.title} style={s.card}>
              <Text style={s.cardTitle} role="heading" aria-level={3}>{p.title}</Text>
              <Text style={s.body}>{p.body}</Text>
            </View>
          ))}
        </View>

        <Text style={s.heading} role="heading" aria-level={2}>{wide ? 'いつもの機能はぜんぶあります。' : 'いつもの機能は\nぜんぶあります。'}</Text>
        <View style={s.chips}>
          {FEATURES.map((f) => (
            <Text key={f} style={s.chip}>{f}</Text>
          ))}
        </View>

        <Text style={s.heading} role="heading" aria-level={2}>はじめ方</Text>
        <View style={row}>
          {STEPS.map((st, i) => (
            <View key={st.title} style={s.card}>
              <Text style={s.number}>{i + 1}</Text>
              <Text style={s.cardTitle} role="heading" aria-level={3}>{st.title}</Text>
              <Text style={s.body}>{st.body}</Text>
            </View>
          ))}
        </View>

        <View style={s.footer}>
          <View style={s.links}>
            {LINKS.map((l) => (
              <Link key={l.href} href={l.href as never} target="_blank" rel="noopener" style={s.link}>
                {l.label}
              </Link>
            ))}
          </View>
          <Text style={s.copy}>© 2026 Tegami contributors. AGPL-3.0</Text>
        </View>
      </View>
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    section: { width: '100%', alignItems: 'center', marginTop: 56 },
    inner: { width: '100%', maxWidth: 960, paddingHorizontal: 16, gap: 48 },
    row: { flexDirection: 'row', gap: 16, alignItems: 'stretch' },
    column: { flexDirection: 'column', gap: 16 },
    card: { flex: 1, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 16, padding: 20, gap: 8 },
    cardTitle: { fontSize: 18, fontWeight: '700', color: c.text },
    body: { fontSize: 14, lineHeight: 22, color: c.muted },
    heading: { fontSize: 24, fontWeight: '700', color: c.text, textAlign: 'center' },
    chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: -24 },
    chip: { fontSize: 14, color: c.text, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 6, overflow: 'hidden' },
    number: { alignSelf: 'flex-start', width: 32, height: 32, borderRadius: 16, backgroundColor: c.selected, color: c.accent, fontSize: 16, fontWeight: '700', textAlign: 'center', lineHeight: 32, overflow: 'hidden' },
    footer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, paddingTop: 20, paddingBottom: 8, gap: 12, alignItems: 'center' },
    links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 16, rowGap: 6 },
    link: { fontSize: 12, color: c.muted, textDecorationLine: 'underline' },
    copy: { fontSize: 12, color: c.muted },
  });
