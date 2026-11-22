// Shown when this account's key is not registered with the relay yet and no invite code
// registered it: Cloudflare Turnstile checks that a person (not a script) is starting
// Tegami, then the relay registers the key without an invite (lib/register.ts).
// Also shown, with no way forward, when the operator stopped this key, and when the account
// was deleted (from another device): then only removing it from this device is left.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { usePalette } from '@/constants/theme';
import { TURNSTILE_SITEKEY } from '@/lib/register';
import { inviteCodeOf, useTegami } from '@/lib/tegami';

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

let script: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  const w = globalThis as unknown as { turnstile?: TurnstileApi; document: Document };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  script ??= new Promise((resolve, reject) => {
    const el = w.document.createElement('script');
    el.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    el.async = true;
    el.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile')));
    el.onerror = () => {
      script = null;
      reject(new Error('turnstile'));
    };
    w.document.head.appendChild(el);
  });
  return script;
}

export function RegisterGate() {
  const c = usePalette();
  const { registration, registerWith, removeFromDevice } = useTegami();
  const box = useRef<View>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  // The apps have no Turnstile: a new key registers with an invite code pasted here.
  const [pasted, setPasted] = useState('');
  const [checking, setChecking] = useState(false);
  const [refused, setRefused] = useState(false);

  async function registerWithPasted() {
    // A whole invite link (...#<npub>&n=<name>&c=<code>) or the bare code.
    const text = pasted.trim();
    const code = inviteCodeOf(text) || (/^[a-z2-9]{6,32}$/.test(text) ? text : '');
    if (!code) return setRefused(true);
    setChecking(true);
    setRefused(false);
    try {
      if (!(await registerWith({ invite: code }))) setRefused(true);
    } finally {
      setChecking(false);
    }
  }

  const onToken = useCallback(
    async (token: string) => {
      if (!(await registerWith({ turnstile: token }))) setFailed(true);
    },
    [registerWith],
  );

  useEffect(() => {
    if (registration !== 'needed' || Platform.OS !== 'web' || !TURNSTILE_SITEKEY) return;
    let id: string | null = null;
    let api: TurnstileApi | null = null;
    let alive = true;
    loadTurnstile()
      .then((t) => {
        if (!alive || !box.current) return;
        api = t;
        id = t.render(box.current as unknown as HTMLElement, {
          sitekey: TURNSTILE_SITEKEY,
          language: 'ja',
          callback: (token: string) => void onToken(token),
          'error-callback': () => setFailed(true),
          'expired-callback': () => setFailed(true),
        });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (api && id) api.remove(id);
    };
  }, [registration, onToken, round]);

  const s = styles(c);
  if (registration === 'deleted') {
    return (
      <View style={s.fill}>
        <Text style={s.text}>このアカウントは削除済みです。この端末からも削除してください。</Text>
        <Pressable role="button" onPress={() => void removeFromDevice()}>
          <Text style={s.action}>この端末から削除</Text>
        </Pressable>
      </View>
    );
  }
  if (registration === 'blocked') {
    return (
      <View style={s.fill}>
        <Text style={s.text}>このアカウントは止められています。</Text>
      </View>
    );
  }
  if (Platform.OS !== 'web') {
    return (
      <View style={s.fill}>
        <Text style={s.title}>招待コードを入れてください</Text>
        <Text style={s.text}>Tegamiは招待で広がります。友だちからもらった招待のリンクかコードを貼ってください。</Text>
        <TextInput
          style={s.input}
          value={pasted}
          onChangeText={(t) => {
            setPasted(t);
            setRefused(false);
          }}
          placeholder="招待のリンクかコード"
          placeholderTextColor={c.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
        />
        {refused && <Text style={s.text}>このコードは使えませんでした。もう一度確かめてください。</Text>}
        <Pressable role="button" disabled={!pasted.trim() || checking} onPress={() => void registerWithPasted()}>
          <Text style={s.action}>{checking ? '確認中' : '始める'}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={s.fill}>
      <View ref={box} key={round} />
      {failed && (
        <>
          <Text style={s.text}>確認できませんでした。通信を確認して、もう一度お試しください。</Text>
          <Pressable
            role="button"
            onPress={() => {
              setFailed(false);
              setRound((n) => n + 1);
            }}>
            <Text style={s.action}>もう一度</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = (c: ReturnType<typeof usePalette>) =>
  StyleSheet.create({
    fill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: c.background },
    title: { fontSize: 20, color: c.text, fontWeight: '600', textAlign: 'center' },
    text: { fontSize: 16, color: c.text, textAlign: 'center' },
    input: { alignSelf: 'stretch', borderWidth: 1, borderColor: c.muted, borderRadius: 10, padding: 12, fontSize: 16, color: c.text },
    action: { fontSize: 16, color: c.accent, fontWeight: '600' },
  });
