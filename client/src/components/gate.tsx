import { getPublicKey } from 'nostr-tools/pure';
import { useEffect, useState, type ReactNode } from 'react';
import { Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';

import { AccountList, accountName, goToAccount } from '@/components/account-list';
import { GateInfo } from '@/components/gate-info';
import { ThemeSwitch } from '@/components/theme-switch';
import { Palette, usePalette } from '@/constants/theme';
import { useWide } from '@/lib/layout';
import { accounts, accountWithKey, adding, cancelAdd, readyAccounts } from '@/lib/accounts';
import { useInsets } from '@/lib/insets';
import { RELAYS, useTegami } from '@/lib/tegami';
import { restoreFromCode, setRestoredKeys, takeRestoredKeys } from '@/lib/recovery';
import { arrival, bundleSecret, receiveTransfer, takeLinkKey, transferKey, type Bundle } from '@/lib/transfer';
import { PasskeyUnsupportedError, passkeysAvailable } from '@/lib/vault';

// A cancelled or timed-out passkey prompt is not an error worth showing.
function isCancel(e: unknown) {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
}

type Moving = { state: 'fetching' } | { state: 'ready'; bundle: Bundle } | { state: 'failed' };

/** First screen (no account yet) and the unlock screen (account protected by a passkey). */
export function Gate({ locked }: { locked: boolean }) {
  const c = usePalette();
  const s = styles(c);
  const { start, startWithoutPasskey, unlock } = useTegami();
  const [key, setKey] = useState(() => (locked ? null : takeLinkKey()));
  const [moving, setMoving] = useState<Moving | null>(key ? { state: 'fetching' } : null);
  // Pasting the link by hand: an iPhone Home Screen app keeps its own storage, and a
  // scanned QR code opens Safari, so the link has to be pasted into the app itself.
  const [pasting, setPasting] = useState(() => {
    // Sent here by the invite screen's 「ほかの端末から受け取る」: open the paste field at once.
    const sent = !locked && arrival.pasting;
    arrival.pasting = false;
    return sent;
  });
  const [pasted, setPasted] = useState('');

  function receivePasted() {
    const k = transferKey(pasted);
    setPasting(false);
    setPasted('');
    if (!k) return setMoving({ state: 'failed' });
    setKey(k);
    setMoving({ state: 'fetching' });
  }
  // Restoring with a recovery code after losing every device.
  const [restoring, setRestoring] = useState<null | 'input' | 'checking' | 'failed'>(null);
  const [code, setCode] = useState('');

  async function restore() {
    setRestoring('checking');
    try {
      const { bundle, keys } = await restoreFromCode(code);
      setRestoredKeys(keys);
      setCode('');
      setRestoring(null);
      setMoving({ state: 'ready', bundle });
    } catch {
      setRestoring('failed');
    }
  }
  const moved = moving?.state === 'ready' ? moving.bundle : undefined;
  // The account received is one this device already has: switch to it instead.
  const twin = moved ? accountWithKey(getPublicKey(bundleSecret(moved))) : undefined;
  // Adding another account: the person can go back to the one they were using.
  const canCancel = !locked && adding();
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [failed, setFailed] = useState(false);
  // Password managers (Bitwarden etc.) often catch the passkey prompt and cannot
  // find a passkey saved by the OS. After one miss, say where the passkey lives.
  const [missed, setMissed] = useState(false);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    receiveTransfer(RELAYS, key).then(
      (bundle) => alive && setMoving({ state: 'ready', bundle }),
      () => alive && setMoving({ state: 'failed' }),
    );
    return () => {
      alive = false;
    };
  }, [key]);

  async function go() {
    setBusy(true);
    setFailed(false);
    setUnsupported(false);
    try {
      if (moved) arrival.moved = true;
      // The iOS app keeps the key in the Keychain (no passkey screen to get through).
      if (Platform.OS !== 'web' && !locked && !passkeysAvailable()) {
        await startWithoutPasskey(moved);
        return;
      }
      await (locked ? unlock() : start(moved));
    } catch (e) {
      if (e instanceof PasskeyUnsupportedError && !locked) setUnsupported(true);
      else if (!isCancel(e)) setFailed(true);
      if (locked) setMissed(true);
    } finally {
      setBusy(false);
    }
  }

  // The first screen and the unlock screen: the information sections go below the buttons.
  const showInfo = !moved && !twin;

  if (moving && moving.state !== 'ready') {
    return (
      <Frame>
        <Icon />
        {moving.state === 'fetching' ? (
          <Text style={s.notice}>ほかの端末から受け取っています</Text>
        ) : (
          <>
            <Text style={s.notice}>このリンクは使えません。リンクは作ってから10分で使えなくなります。元の端末の設定で、もう一度作ってください。</Text>
            <Pressable style={s.secondary} onPress={() => {
                // Starting fresh from a dead link: after starting, go to the chats, not /link.
                arrival.moved = true;
                setMoving(null);
              }} role="button">
              <Text style={s.secondaryText}>新しく始める</Text>
            </Pressable>
          </>
        )}
      </Frame>
    );
  }

  return (
    <Frame long={showInfo}>
      <Icon />
      {moved ? (
        <Text style={s.promise}>{moved.myName ? `${moved.myName}さんのアカウントを受け取りました` : 'アカウントを受け取りました'}</Text>
      ) : locked ? (
        <Welcome />
      ) : (
        <Hero />
      )}
      {twin ? (
        <>
          <Text style={s.notice}>{`このアカウントは、この端末にすでにあります（${accountName(twin)}）`}</Text>
          <Pressable style={({ pressed }) => [s.primary, pressed && s.pressed]} onPress={() => {
              takeRestoredKeys(); // a code for that account must not stay waiting for another one
              goToAccount(twin.id);
            }} role="button">
            <Text style={s.primaryText}>切り替える</Text>
          </Pressable>
        </>
      ) : unsupported ? (
        <>
          <Text style={s.notice}>
            {passkeysAvailable()
              ? 'このパスキーの保存先では、鍵を守れませんでした。下の「いま使えるパスキーの保存先」から選んでください。iPhoneでは「設定」→「一般」→「自動入力とパスワード」で「パスワード」を入れると選べるようになります。'
              : Platform.OS === 'web'
                ? 'このブラウザはパスキーを使えません。'
                : 'この端末ではパスキーを使えません。'}
          </Text>
          <Consent />
          {passkeysAvailable() && (
            <Pressable style={({ pressed }) => [s.primary, busy && s.busy, pressed && s.pressed]} onPress={go} disabled={busy} role="button">
              <Text style={s.primaryText}>保存先を選び直す</Text>
            </Pressable>
          )}
          <Pressable style={s.secondary} onPress={() => {
              if (moved) arrival.moved = true;
              void startWithoutPasskey(moved);
            }} disabled={busy} role="button">
            <Text style={s.secondaryText}>パスキーを使わずに始める</Text>
          </Pressable>
          <Text style={s.small}>{Platform.OS === 'web' ? 'パスキーを使わない時は、鍵をこのブラウザの中だけに保存します。' : 'パスキーを使わない時は、鍵をこの端末の中だけに保存します。'}</Text>
        </>
      ) : (
        <>
          {!locked && <Consent />}
          <Pressable style={({ pressed }) => [s.primary, busy && s.busy, pressed && s.pressed]} onPress={go} disabled={busy} role="button">
            <Text style={s.primaryText}>{locked ? 'ロックを解除' : moved ? (Platform.OS === 'web' ? 'この端末で使う' : '同意してこの端末で使う') : Platform.OS === 'web' ? 'はじめる' : '同意してはじめる'}</Text>
          </Pressable>
        </>
      )}
      {failed && <Text style={s.notice}>{'パスキーを使えませんでした。\nもう一度押してください。'}</Text>}
      {missed && (
        <Text style={s.notice}>
          パスワード管理アプリの画面が出た時は、その画面で「ブラウザや端末のパスキーを使う」を選んでください。Tegami
          のパスキーは、始めた時に選んだ場所（Windows、iPhone、Googleなど）に保存されています。
        </Text>
      )}
      {!locked && !moved && !unsupported && !twin &&
        (pasting ? (
          <View style={s.paste}>
            <TextInput
              style={s.pasteInput}
              value={pasted}
              onChangeText={setPasted}
              placeholder="ほかの端末で作ったリンクを貼る"
              placeholderTextColor={c.muted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <Pressable style={s.secondary} onPress={receivePasted} disabled={!pasted.trim()} role="button">
              <Text style={s.secondaryText}>受け取る</Text>
            </Pressable>
          </View>
        ) : restoring ? (
          <View style={s.paste}>
            <TextInput
              style={s.pasteInput}
              value={code}
              onChangeText={(t) => {
                setCode(t);
                if (restoring === 'failed') setRestoring('input');
              }}
              placeholder="復旧コード"
              placeholderTextColor={c.muted}
              autoCapitalize="characters"
              autoCorrect={false}
              autoComplete="off"
              autoFocus
            />
            <Pressable style={s.secondary} onPress={restore} disabled={!code.trim() || restoring === 'checking'} role="button">
              <Text style={s.secondaryText}>{restoring === 'checking' ? '確認中' : '復旧'}</Text>
            </Pressable>
            {restoring === 'failed' && <Text style={s.notice}>コードが正しくありません。もう一度確認してください。</Text>}
          </View>
        ) : (
          <>
            <Pressable style={({ pressed }) => [s.outlined, pressed && s.pressed]} onPress={() => setPasting(true)} role="button">
              <Text style={s.outlinedText}>ほかの端末から受け取る</Text>
            </Pressable>
            <Pressable style={s.quiet} onPress={() => setRestoring('input')} role="button">
              <Text style={s.quietText}>復旧コードを使う</Text>
            </Pressable>
          </>
        ))}
      {locked && readyAccounts().length > 1 &&
        (switching ? (
          <View style={s.paste}>
            <AccountList add={false} />
          </View>
        ) : (
          <Pressable style={s.quiet} onPress={() => setSwitching(true)} role="button">
            <Text style={s.quietText}>アカウントを切り替える</Text>
          </Pressable>
        ))}
      {canCancel && (
        <Pressable style={s.quiet} onPress={() => {
            takeRestoredKeys();
            cancelAdd();
          }} role="button">
          <Text style={s.quietText}>キャンセル</Text>
        </Pressable>
      )}
      {!locked && !twin && passkeysAvailable() && <PasskeyStores />}
      {showInfo && <GateInfo returning={locked} />}
    </Frame>
  );
}

/** The page around every gate screen: Tegami and the light and dark switch on top, as on tegami.chat. */
function Frame({ children, long }: { children: ReactNode; long?: boolean }) {
  const c = usePalette();
  const s = styles(c);
  const insets = useInsets();
  return (
    <View style={[s.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={s.top}>
        <View style={s.logo}>
          <Image source={ICON} style={s.logoIcon} aria-hidden />
          <Text style={s.logoText}>Tegami</Text>
        </View>
        <ThemeSwitch />
      </View>
      <ScrollView contentContainerStyle={[s.start, long && s.startLong]}>{children}</ScrollView>
    </View>
  );
}

const ICON = require('../../assets/images/icon.png');

function Icon() {
  const c = usePalette();
  const s = styles(c);
  return <Image source={ICON} style={s.icon} aria-hidden />;
}

/** The unlock screen: whose account this is, and that the talks are kept here. */
function Welcome() {
  const s = styles(usePalette());
  const i = accounts();
  const name = i.list.find((a) => a.id === i.current)?.name;
  return (
    <View style={s.hero}>
      <Text style={s.welcome} role="heading" aria-level={1}>{name ? `おかえりなさい、${name}さん` : "おかえりなさい"}</Text>
      <Text style={s.kicker}>トークは暗号化して、この端末にあります。</Text>
      <Text style={s.welcomeBody}>パスキーでロックを解除すると、続きから使えます。</Text>
    </View>
  );
}

/**
 * Phone apps only (App Store 1.2): starting means agreeing to the terms. The web version is unchanged.
 * The caller shows it only where a button starts the app; it also hides itself on the web.
 */
function Consent() {
  const s = styles(usePalette());
  if (Platform.OS === 'web') return null;
  return (
    <Text style={s.consent}>
      <Text style={s.consentLink} role="link" onPress={() => void Linking.openURL('https://tegami.chat/ja/terms')}>利用規約</Text>
      と
      <Text style={s.consentLink} role="link" onPress={() => void Linking.openURL('https://tegami.chat/ja/privacy')}>プライバシーポリシー</Text>
      に同意して始めます。
    </Text>
  );
}

/** The first lines of tegami.chat: what Tegami is, and the two promises. */
function Hero() {
  const c = usePalette();
  const s = styles(c);
  const wide = useWide();
  // Each promise stays on one line. On a phone the size follows the width so
  // 「トークはあなたのもの。」 (11 characters) fits, as on tegami.chat.
  const { width } = useWindowDimensions();
  const phone = Math.min(30, Math.floor((width - 40) / 11.5));
  const h1 = [s.h1, wide ? s.h1Wide : { fontSize: phone, lineHeight: Math.round(phone * 1.2) }];
  return (
    <View style={s.hero}>
      <Text style={s.beta}>ベータ版</Text>
      <Text style={s.kicker}>
        <Text style={s.nostr}>Nostrで動く</Text>、オープンソースのメッセージアプリ
      </Text>
      <Text style={h1} role="heading" aria-level={1}>
        トークは
        <Text style={s.green}>あなたのもの。</Text>
      </Text>
      <Text style={[h1, s.h1Second]} role="heading" aria-level={1}>
        AIの
        <Text style={s.green}>持ち込み自由。</Text>
      </Text>
    </View>
  );
}

// Where a passkey can keep Tegami's key. Only stores tried on real devices are listed.
// A store must return the WebAuthn PRF value; Bitwarden saves the passkey but does not.
// Tried: iPhone (Safari, 2026-11-12), Windows Hello (Chrome, 2026-11-11), Bitwarden (Chrome and iPhone, 2026-11-11/12).
const STORES_OK = ['iPhone（iCloudキーチェーン）', 'Windows（Windows Hello）'];
const STORES_PLANNED = ['Bitwarden'];

function PasskeyStores() {
  const c = usePalette();
  const s = styles(c);
  return (
    <View style={s.stores}>
      <Text style={s.storesHeading}>いま使えるパスキーの保存先</Text>
      {STORES_OK.map((name) => (
        <Text key={name} style={s.storesItem}>{name}</Text>
      ))}
      <Text style={[s.storesHeading, s.storesGap]}>対応予定</Text>
      {STORES_PLANNED.map((name) => (
        <Text key={name} style={s.storesItem}>{name}</Text>
      ))}
    </View>
  );
}

const styles = (c: Palette) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: c.background },
    top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
    logo: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    logoIcon: { width: 28, height: 28, borderRadius: 7 },
    logoText: { fontSize: 17, fontWeight: '700', color: c.text },
    start: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 32 },
    // A long page starts at the top; centering would cut off its top when it overflows.
    startLong: { justifyContent: 'flex-start' },
    icon: { width: 72, height: 72, borderRadius: 18, marginBottom: 24, borderWidth: StyleSheet.hairlineWidth, borderColor: c.line },
    hero: { alignItems: 'center', marginBottom: 32 },
    beta: { fontSize: 12, color: c.accent, backgroundColor: c.selected, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2, overflow: 'hidden' },
    kicker: { marginTop: 12, fontSize: 14, fontWeight: '500', color: c.muted, textAlign: 'center' },
    nostr: { color: c.nostr },
    h1: { marginTop: 16, fontSize: 40, lineHeight: 46, fontWeight: '700', color: c.text, textAlign: 'center', letterSpacing: -0.5 },
    h1Wide: { fontSize: 52, lineHeight: 60 },
    h1Second: { marginTop: 4 },
    green: { color: c.accent },
    welcome: { fontSize: 24, lineHeight: 32, fontWeight: "700", color: c.text, textAlign: "center" },
    welcomeBody: { marginTop: 4, fontSize: 14, color: c.muted, textAlign: "center" },
    promise: { fontSize: 18, color: c.muted, marginBottom: 32, textAlign: 'center' },
    primary: { backgroundColor: c.accent, borderRadius: 999, height: 52, width: '100%', maxWidth: 320, alignItems: 'center', justifyContent: 'center' },
    primaryText: { color: c.onAccent, fontSize: 17, fontWeight: '600' },
    busy: { opacity: 0.5 },
    // Pressed: the same dip on every button of this screen.
    pressed: { opacity: 0.6 },
    // As easy to see as 「はじめる」: the same size, outlined instead of filled.
    outlined: { borderWidth: 1.5, borderColor: c.accent, borderRadius: 999, height: 52, width: '100%', maxWidth: 320, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
    outlinedText: { color: c.accent, fontSize: 17, fontWeight: '600' },
    secondary: { paddingVertical: 12, paddingHorizontal: 24 },
    secondaryText: { color: c.accent, fontSize: 15, fontWeight: '600' },
    quiet: { paddingVertical: 6, paddingHorizontal: 24 },
    quietText: { color: c.muted, fontSize: 14 },
    small: { fontSize: 12, color: c.muted, textAlign: 'center', maxWidth: 320 },
    consent: { fontSize: 12, color: c.muted, textAlign: 'center', maxWidth: 340, lineHeight: 20, marginBottom: 4 },
    consentLink: { color: c.accent, textDecorationLine: 'underline' },
    notice: { fontSize: 14, color: c.muted, textAlign: 'center', maxWidth: 320, lineHeight: 22 },
    paste: { width: '100%', maxWidth: 320, alignItems: 'center', gap: 4 },
    pasteInput: {
      width: '100%',
      backgroundColor: c.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.line,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      color: c.text,
    },
    stores: { marginTop: 16, width: '100%', maxWidth: 320, alignItems: 'center', paddingVertical: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    storesHeading: { fontSize: 12, color: c.muted, marginBottom: 2, textAlign: 'center' },
    storesGap: { marginTop: 10 },
    storesItem: { fontSize: 13, color: c.muted, lineHeight: 20, textAlign: 'center' },
  });
