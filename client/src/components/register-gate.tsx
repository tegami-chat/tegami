// Shown when this account's key is not registered with the relay yet and no invite code
// registered it: Cloudflare Turnstile checks that a person (not a script) is starting
// Tegami, then the relay registers the key without an invite (lib/register.ts).
// Also shown, with no way forward, when the operator stopped this key.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { usePalette } from '@/constants/theme';
import { TURNSTILE_SITEKEY } from '@/lib/register';
import { useTegami } from '@/lib/tegami';

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
  const { registration, registerWith } = useTegami();
  const box = useRef<View>(null);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);

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
  if (registration === 'blocked') {
    return (
      <View style={s.fill}>
        <Text style={s.text}>このアカウントは止められています。</Text>
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
    text: { fontSize: 16, color: c.text, textAlign: 'center' },
    action: { fontSize: 16, color: c.accent, fontWeight: '600' },
  });
