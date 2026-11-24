import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { PillarIcon, type PillarIconName } from '@/components/pillar-icon';
import { Palette, usePalette } from '@/constants/theme';
import { useWide } from '@/lib/layout';

const PILLARS: { icon: PillarIconName; title: string; body: string }[] = [
  {
    icon: 'no-ads',
    title: '特定の会社に縛られない',
    body: '追いかけてくる広告も、見たくないニュースも、やりたくないゲームも、いらない機能も、全部ありません。あなたの個人情報を広告や営業のために売ることもありません。',
  },
  {
    icon: 'ai-friend',
    title: 'AIを自由に使う',
    body: '自分のAIを友だちとしてつなげられます。自宅のパソコンで動くAIをつなげば、AIがメッセージを読んだり送ったりできます。AIを使わないことも、相手のAIに自分のメッセージを読ませないことも、あなたの自由です。',
  },
  {
    icon: 'no-peeking',
    title: '誰にも覗かれない',
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
  { title: 'パスキーで秘密鍵を守る', body: '秘密鍵はこの端末の中で作ります。' },
  { title: '友だちを追加する', body: '招待リンクを送るか、QRコードを見せます。' },
];

const LINKS = [
  { label: 'Tegamiのサイト', href: 'https://tegami.chat/ja/' },
  { label: '安全の仕組み', href: 'https://tegami.chat/ja/how' },
  { label: 'よくある質問', href: 'https://tegami.chat/ja/faq' },
  { label: '稼働状況', href: 'https://tegami.chat/ja/status' },
  { label: 'プライバシーポリシー', href: 'https://tegami.chat/ja/privacy' },
  { label: 'GitHub', href: 'https://github.com/tegami-chat/tegami' },
];

/**
 * What Tegami is, below the buttons of the first screen: three pillars, the features, how to start,
 * and the links. Every section is the same width, every gap is a multiple of 8, and every block of
 * content sits in the same kind of card, so the page reads as one column.
 */
export function GateInfo({ returning }: { returning?: boolean }) {
  const c = usePalette();
  const s = styles(c);
  const wide = useWide();
  return (
    <View style={s.page}>
      <View style={[s.grid, wide && s.gridWide]}>
        {PILLARS.map((p) => (
          <View key={p.title} style={[s.card, wide && s.cardWide]}>
            <View style={s.cardHead}>
              <View style={s.badge}>
                <PillarIcon name={p.icon} size={22} color={c.accent} />
              </View>
              <Text style={s.cardTitle} role="heading" aria-level={3}>{p.title}</Text>
            </View>
            <Text style={s.body}>{p.body}</Text>
          </View>
        ))}
      </View>

      <View style={s.section}>
        <Text style={[s.heading, wide && s.headingWide]} role="heading" aria-level={2}>
          いつもの機能はぜんぶあります。
        </Text>
        <View style={[s.card, s.features]}>
          {FEATURES.map((f) => (
            <View key={f} style={[s.feature, wide && s.featureWide]}>
              <MaterialIcons name="check" size={18} color={c.accent} />
              <Text style={s.featureText}>{f}</Text>
            </View>
          ))}
        </View>
      </View>

      {!returning && <View style={s.section}>
        <Text style={[s.heading, wide && s.headingWide]} role="heading" aria-level={2}>はじめ方</Text>
        <View style={[s.card, s.steps, wide && s.stepsWide]}>
          {STEPS.map((st, i) => (
            <View key={st.title} style={[s.step, wide && s.stepWide, i > 0 && (wide ? s.stepLineWide : s.stepLine)]}>
              <Text style={s.number}>{i + 1}</Text>
              <View style={s.stepText}>
                <Text style={s.stepTitle} role="heading" aria-level={3}>{st.title}</Text>
                <Text style={s.stepBody}>{st.body}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>}

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
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    page: { width: '100%', maxWidth: 1080, marginTop: 64, gap: 64 },
    grid: { gap: 16 },
    gridWide: { flexDirection: 'row', alignItems: 'stretch' },
    card: { backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.line, borderRadius: 20, padding: 24 },
    cardWide: { flex: 1 },
    cardHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
    badge: { width: 40, height: 40, borderRadius: 12, backgroundColor: c.selected, alignItems: 'center', justifyContent: 'center' },
    cardTitle: { flexShrink: 1, fontSize: 17, lineHeight: 24, fontWeight: '700', color: c.text },
    body: { fontSize: 14, lineHeight: 24, color: c.muted },
    section: { gap: 24 },
    heading: { fontSize: 22, lineHeight: 30, fontWeight: '700', color: c.text, textAlign: 'center' },
    headingWide: { fontSize: 28, lineHeight: 36 },
    features: { flexDirection: 'row', flexWrap: 'wrap', paddingVertical: 16 },
    feature: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8 },
    featureWide: { width: '33.333%', paddingRight: 16 },
    featureText: { flex: 1, fontSize: 15, lineHeight: 22, color: c.text },
    steps: { paddingVertical: 8, paddingHorizontal: 16 },
    stepsWide: { flexDirection: 'row', paddingVertical: 0, paddingHorizontal: 0 },
    stepWide: { flex: 1, paddingVertical: 24, paddingHorizontal: 24 },
    stepLineWide: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: c.line },
    step: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 16 },
    stepLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    number: { width: 28, height: 28, borderRadius: 14, backgroundColor: c.accent, color: c.onAccent, fontSize: 14, fontWeight: '700', textAlign: 'center', lineHeight: 28, overflow: 'hidden' },
    stepText: { flex: 1, gap: 4 },
    stepTitle: { fontSize: 16, lineHeight: 28, fontWeight: '700', color: c.text },
    stepBody: { fontSize: 13, lineHeight: 20, color: c.muted },
    footer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line, paddingTop: 24, paddingBottom: 8, gap: 16, alignItems: 'center' },
    links: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 20, rowGap: 8 },
    link: { fontSize: 13, color: c.muted },
    copy: { fontSize: 12, color: c.muted },
  });
