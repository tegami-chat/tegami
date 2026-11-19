// The records on disk (concern 9): what people wrote and who they are, sealed with a key from
// the AI's own key. Runs with this computer's secret store (DPAPI, Keychain or libsecret);
// the parts that need one say SKIP where there is none.
//   node test/records.test.mjs

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as nip17 from 'nostr-tools/nip17';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from 'nostr-tools/utils';
import { forget, storeKind } from '../secrets.mjs';
import { Vault, seal, unseal } from '../vault.mjs';
import { onDisk, records } from './records.mjs';

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};
const homes = [];
const newHome = () => {
  const h = mkdtempSync(join(tmpdir(), 'tegami-records-'));
  homes.push(h);
  return h;
};
const { Agent } = await import('../lib.mjs');
const agentIn = (dir) => {
  process.env.TEGAMI_AGENT_HOME = dir;
  return new Agent('x');
};
const day = 86400;
const now = Math.floor(Date.now() / 1000);
const person = { sk: generateSecretKey() };
person.pk = getPublicKey(person.sk);
/** A message from `person` to the agent, as the relay hands it over. */
const wrapTo = (agent, text) => nip17.wrapEvent(person.sk, { publicKey: agent.pubkey }, text);

const quiet = (fn) => {
  const err = console.error;
  const said = [];
  console.error = (t) => said.push(String(t));
  try {
    return { value: fn(), said };
  } finally {
    console.error = err;
  }
};

try {
  // ---------- seal and unseal ----------
  const key = Buffer.alloc(32, 7);
  const s = seal(key, 'messages.json', [{ text: 'こんにちは' }]);
  check('a sealed record shows no text', !JSON.stringify(s).includes('こんにちは') && s.tegamiSealed === 1);
  check('a sealed record opens with its key', unseal(key, 'messages.json', s)[0].text === 'こんにちは');
  const fails = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check('a sealed record does not open with another key', fails(() => unseal(Buffer.alloc(32, 8), 'messages.json', s)));
  check('a sealed record does not pass for another file', fails(() => unseal(key, 'contacts.json', s)));
  const bent = Buffer.from(s.data, 'base64');
  bent[20] ^= 1;
  check('a changed byte is found', fails(() => unseal(key, 'messages.json', { ...s, data: bent.toString('base64') })));

  const kind = storeKind();
  if (kind === 'none' || kind === 'plain') console.log(`SKIP the parts with a secret store (this computer: ${kind})`);
  else {
    // ---------- with the system's store ----------
    const D = newHome();
    const a = agentIn(D);
    a.init({ name: '試験のAI', model: 'test' });
    a.addContact({ pubkey: person.pk, name: 'テストA', trusted: true });
    a.receive(wrapTo(a, '秘密の話です'));
    a.state.peerAis = { [bytesToHex(generateSecretKey())]: { until: 0, name: 'テストBのAI' } };
    a.saveState();
    check(`the message is kept (store: ${kind})`, a.messages.some((m) => m.text === '秘密の話です'));
    const read = records(D);
    check('messages.json opens with the AI\'s key', read('messages.json', []).some((m) => m.text === '秘密の話です'));
    check('contacts.json opens with the AI\'s key', read('contacts.json', [])[0]?.name === 'テストA');
    check(`no message text on disk (${onDisk(D, '秘密の話です').join(', ')})`, !onDisk(D, '秘密の話です').length);
    check(`no name of a person or their AI on disk (${onDisk(D, 'テストA').concat(onDisk(D, 'テストBのAI')).join(', ')})`, !onDisk(D, 'テストA').length && !onDisk(D, 'テストBのAI').length);
    check('the files on disk are sealed', ['messages.json', 'contacts.json', 'state.json'].every((f) => JSON.parse(readFileSync(join(D, f), 'utf8')).tegamiSealed === 1));
    const b = agentIn(D);
    check('a new start opens the records again', b.messages.some((m) => m.text === '秘密の話です') && b.contacts[0]?.name === 'テストA' && b.state.peerAis && Object.values(b.state.peerAis)[0].name === 'テストBのAI');
    check('the watcher\'s records line says they are encrypted', b.recordsLine('ollama').includes('encrypted'));

    // ---------- moving plain records over ----------
    const P = newHome();
    const p0 = agentIn(P);
    p0.init({ name: '試験のAI', model: 'test' });
    writeFileSync(join(P, 'contacts.json'), JSON.stringify([{ pubkey: person.pk, name: '古い名前', trusted: true }]));
    writeFileSync(join(P, 'messages.json'), JSON.stringify([
      { id: '1', from: person.pk, peer: person.pk, at: now - 40 * day, text: '四十日前の文' },
      { id: '2', from: person.pk, peer: person.pk, at: now - day, text: '昨日の文' },
    ]));
    writeFileSync(join(P, 'state.json'), JSON.stringify({ lastRead: 0, replied: [], peerAis: { x: { until: 0, name: '古いAIの名前' } } }));
    const p1 = agentIn(P);
    check('plain records from before are read at start', p1.contacts[0]?.name === '古い名前' && p1.messages.some((m) => m.text === '昨日の文'));
    check('and written back sealed: no plain text left', !onDisk(P, '古い名前').length && !onDisk(P, '昨日の文').length && !onDisk(P, '古いAIの名前').length);
    check('messages older than keepDays are dropped at start', !p1.messages.some((m) => m.text === '四十日前の文') && !JSON.stringify(records(P)('messages.json', [])).includes('四十日前の文'));

    // ---------- pruning a sealed file ----------
    const old = records(P)('messages.json', []);
    p1.vault.write('messages.json', [...old, { id: '3', from: person.pk, peer: person.pk, at: now - 31 * day, text: '三十一日前の文' }]);
    const p2 = agentIn(P);
    check('pruning works on the sealed file too', !p2.messages.some((m) => m.text === '三十一日前の文') && !JSON.stringify(records(P)('messages.json', [])).includes('三十一日前の文'));

    // ---------- the store does not open (a locked keyring) ----------
    const L = newHome();
    const l0 = agentIn(L);
    l0.init({ name: '試験のAI', model: 'test' });
    const keyFile = readFileSync(join(L, 'key.json'), 'utf8');
    writeFileSync(join(L, 'key.json'), JSON.stringify({ ...JSON.parse(keyFile), store: 'locked-test', data: 'x', account: 'x' }));
    const { value: l1, said } = quiet(() => {
      const l = agentIn(L);
      l.addContact({ pubkey: person.pk, name: 'ロック中の名前', trusted: true });
      return l;
    });
    check('a locked store: nothing is written, not even names', !existsSync(join(L, 'contacts.json')) && l1.contacts[0]?.name === 'ロック中の名前');
    check('and one line says so', said.length === 1 && said[0].includes('does not open'));
  }

  // ---------- no store: message text stays in memory ----------
  process.env.TEGAMI_SECRET_STORE = 'plain';
  const N = newHome();
  const n0 = agentIn(N);
  n0.init({ name: '試験のAI', model: 'test' });
  n0.addContact({ pubkey: person.pk, name: 'テストA', trusted: true });
  writeFileSync(join(N, 'messages.json'), JSON.stringify([{ id: '9', from: person.pk, peer: person.pk, at: now, text: '前からの平文' }]));
  const { value: n1, said: noted } = quiet(() => {
    const n = agentIn(N);
    n.receive(wrapTo(n, 'メモリの中だけ'));
    n.receive(wrapTo(n, 'もう1通'));
    return n;
  });
  check('no store: messages are kept in memory', n1.messages.some((m) => m.text === 'メモリの中だけ') && n1.messages.some((m) => m.text === '前からの平文'));
  check('no store: no message text on disk, and the plain file from before is gone', !existsSync(join(N, 'messages.json')) && !onDisk(N, 'メモリの中だけ').length && !onDisk(N, '前からの平文').length);
  check('no store: one line says so, once', noted.length === 1 && noted[0].includes('memory'));
  check('no store: the records line says so', n1.recordsLine('ollama').includes('memory only'));

  // ---------- no store here, and nobody chose plain ----------
  process.env.TEGAMI_SECRET_STORE = 'none';
  const R = newHome();
  let refused = '';
  try {
    agentIn(R).init({ name: 'x', model: 'y' });
  } catch (e) {
    refused = e.message;
  }
  check('no store: a new key is refused without --insecure-store', refused.includes('--insecure-store') && !existsSync(join(R, 'key.json')));
  process.env.TEGAMI_INSECURE_STORE = '1';
  quiet(() => agentIn(R).init({ name: 'x', model: 'y' }));
  check('with --insecure-store the key is kept unencrypted, on purpose', !!JSON.parse(readFileSync(join(R, 'key.json'), 'utf8')).secretHex);
  delete process.env.TEGAMI_INSECURE_STORE;
  const { saveKey, loadKeys } = await import('../backends.mjs');
  let keyRefused = '';
  try {
    saveKey(R, 'openai', 'sk-test-1234567890');
  } catch (e) {
    keyRefused = e.message;
  }
  check('no store: an API key is refused without --insecure-store', keyRefused.includes('--insecure-store') && !loadKeys(R).openai);
  // A plain key from before stays usable where there is still no store.
  const legacy = newHome();
  const hex = bytesToHex(generateSecretKey());
  writeFileSync(join(legacy, 'key.json'), JSON.stringify({ secretHex: hex }));
  const { value: lg } = quiet(() => agentIn(legacy));
  check('no store: a plain key from before keeps working', lg.pubkey === getPublicKey(Buffer.from(hex, 'hex')));
  delete process.env.TEGAMI_SECRET_STORE;

  // ---------- the vault on its own ----------
  const V = newHome();
  const v = new Vault(V, () => Buffer.alloc(32, 1));
  v.write('settings.json', { a: 1 });
  check('other files are written as they are', JSON.parse(readFileSync(join(V, 'settings.json'), 'utf8')).a === 1);
} finally {
  for (const h of homes) {
    // Keychain and libsecret keep the key outside the folder: take it out of the store too.
    if (existsSync(join(h, 'key.json'))) forget(JSON.parse(readFileSync(join(h, 'key.json'), 'utf8')));
    rmSync(h, { recursive: true, force: true });
  }
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
