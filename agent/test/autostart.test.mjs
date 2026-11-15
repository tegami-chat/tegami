// autostart on macOS (launchd) and Linux (systemd user unit). This runs on any system: it
// checks the files tegami-agent writes, and runs `autostart` with TEGAMI_PLATFORM set and
// TEGAMI_AUTOSTART_DRY=1 (the file is written, launchctl / systemctl are only printed).
// Whether launchd and systemd really start the watcher at login is not checked here.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { autostartCommands, autostartFile, carriedEnv, keepArgs, launchdLabel, launchdPlist, systemdName, systemdQuote, systemdUnit } from '../autostart.mjs';

const ROOT = resolve(import.meta.dirname, '..');
let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures++;
};

// ---------- the files ----------
const args = keepArgs({ node: '/opt/homebrew/bin/node', script: '/Users/a b/tegami/agent.mjs', agentName: 'claude', logPath: '/Users/a b/.tegami/agents/claude/watch.log' });
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', TEGAMI_RELAYS: 'wss://relay.tegami.chat' };
const plist = launchdPlist({ agentName: 'claude', args, env, workDir: '/Users/a b/.tegami/agents/claude' });
check('plist: label', plist.includes('<key>Label</key>\n  <string>chat.tegami.agent.claude</string>'));
check('plist: runs keep for this AI friend with its log', plist.includes('<string>keep</string>\n    <string>--agent</string>\n    <string>claude</string>\n    <string>--log</string>'));
check('plist: starts at login', /<key>RunAtLoad<\/key>\s*<true\/>/.test(plist));
check('plist: started again only after a failure', /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/.test(plist));
check('plist: carries PATH (so claude and node are found)', plist.includes('<key>PATH</key>\n    <string>/opt/homebrew/bin:/usr/bin:/bin</string>'));
check('plist: paths with spaces stay one argument', plist.includes('<string>/Users/a b/tegami/agent.mjs</string>'));
const odd = launchdPlist({ agentName: 'a&b', args: ['<x>'], env: {}, workDir: '/' });
check('plist: XML characters are escaped', odd.includes('&lt;x&gt;') && !odd.includes('<x>') && odd.includes('chat.tegami.agent.a-b'));
check('plist: well formed (tags balance)', (plist.match(/<dict>/g) ?? []).length === (plist.match(/<\/dict>/g) ?? []).length && (plist.match(/<array>/g) ?? []).length === 1);

const unit = systemdUnit({ agentName: 'claude', args, env, workDir: '/home/a/.tegami/agents/claude' });
check('unit: ExecStart runs keep, each word quoted', unit.includes('ExecStart="/opt/homebrew/bin/node" "/Users/a b/tegami/agent.mjs" "keep" "--agent" "claude" "--log"'));
check('unit: restarts 10 seconds after a failure', unit.includes('Restart=on-failure') && unit.includes('RestartSec=10'));
check('unit: started with the user session', unit.includes('[Install]\nWantedBy=default.target'));
check('unit: PATH is set', unit.includes('Environment="PATH=/opt/homebrew/bin:/usr/bin:/bin"'));
check('unit: % and $ and quotes are escaped for systemd', systemdQuote('a%b$c"d\\e') === '"a%%b$$c\\"d\\\\e"');
check('unit: file name', systemdName('claude') === 'tegami-agent-claude.service' && systemdName('a/b') === 'tegami-agent-a-b.service');

check('where: macOS LaunchAgents', autostartFile('darwin', 'claude', '/Users/a').replace(/\\/g, '/') === '/Users/a/Library/LaunchAgents/chat.tegami.agent.claude.plist');
check('where: Linux systemd user folder', autostartFile('linux', 'claude', '/home/a', {}).replace(/\\/g, '/') === '/home/a/.config/systemd/user/tegami-agent-claude.service');
check('where: Linux follows XDG_CONFIG_HOME', autostartFile('linux', 'claude', '/home/a', { XDG_CONFIG_HOME: '/cfg' }).replace(/\\/g, '/') === '/cfg/systemd/user/tegami-agent-claude.service');
const mac = autostartCommands('darwin', 'on', { agentName: 'claude', file: '/f.plist', uid: 501 }).map((c) => c.cmd.join(' '));
check('macOS on: bootout (old copy) then bootstrap in the GUI session', mac.join(' | ') === 'launchctl bootout gui/501/chat.tegami.agent.claude | launchctl bootstrap gui/501 /f.plist');
const lin = autostartCommands('linux', 'on', { agentName: 'claude' }).map((c) => c.cmd.join(' '));
check('Linux on: daemon-reload then enable --now', lin.join(' | ') === 'systemctl --user daemon-reload | systemctl --user enable --now tegami-agent-claude.service');
check('Linux off: disable --now', autostartCommands('linux', 'off', { agentName: 'claude' })[0].cmd.join(' ') === 'systemctl --user disable --now tegami-agent-claude.service');
check('carried variables: PATH, and the AI folder when set', (() => {
  const c = carriedEnv({ PATH: '/p', TEGAMI_AGENT_HOME: '/h', SECRET: 'x', OPENAI_API_KEY: 'k' });
  return c.PATH === '/p' && c.TEGAMI_AGENT_HOME === '/h' && !c.SECRET && !c.OPENAI_API_KEY;
})());
check('launchd label', launchdLabel('my ai') === 'chat.tegami.agent.my-ai');

// ---------- the command, as on macOS and Linux ----------
const HOME = mkdtempSync(join(tmpdir(), 'tegami-agent-'));
const FAKE = mkdtempSync(join(tmpdir(), 'tegami-home-'));
try {
  const base = { ...process.env, TEGAMI_AGENT_HOME: HOME, TEGAMI_AUTOSTART_HOME: FAKE, TEGAMI_AUTOSTART_DRY: '1', XDG_CONFIG_HOME: '' };
  const cli = (platform, ...a) => execFileSync(process.execPath, [join(ROOT, 'agent.mjs'), ...a], { env: { ...base, TEGAMI_PLATFORM: platform }, encoding: 'utf8' });
  cli('linux', 'init', '--name', 'テスト');
  const onL = cli('linux', 'autostart', 'on');
  const unitFile = join(FAKE, '.config', 'systemd', 'user', 'tegami-agent-claude.service');
  check('Linux: autostart on writes the unit', existsSync(unitFile) && readFileSync(unitFile, 'utf8').includes(`${systemdQuote(join(ROOT, 'agent.mjs'))} "keep" "--agent" "claude"`));
  check('Linux: and enables it', onL.includes('would run: systemctl --user enable --now tegami-agent-claude.service'));
  check('Linux: status sees it', cli('linux', 'autostart', 'status').includes('Starts at login:   yes'));
  check('Linux: autostart off removes it', cli('linux', 'autostart', 'off').includes('disable --now') && !existsSync(unitFile));
  const onM = cli('darwin', 'autostart', 'on');
  const plistFile = join(FAKE, 'Library', 'LaunchAgents', 'chat.tegami.agent.claude.plist');
  check('macOS: autostart on writes the plist and bootstraps it', existsSync(plistFile) && /launchctl bootstrap gui\/\d+ /.test(onM));
  check('macOS: the plist carries the AI folder', readFileSync(plistFile, 'utf8').includes(`<key>TEGAMI_AGENT_HOME</key>`));
  check('macOS: autostart off removes it', cli('darwin', 'autostart', 'off').includes('launchctl bootout') && !existsSync(plistFile));
} finally {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(FAKE, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
