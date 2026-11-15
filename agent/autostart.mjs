// Starting the watcher at login on macOS (a launchd agent) and Linux (a systemd user unit).
// Windows uses Task Scheduler (agent.mjs). Both start `keep`, which runs `watch` and starts
// it again when it stops; `keep` exits on its own when another watcher already runs.

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Variables the watcher needs at login: where `claude` and `node` are, and test overrides. */
export function carriedEnv(env = process.env) {
  const out = { PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
  for (const k of ['TEGAMI_AGENT_HOME', 'TEGAMI_RELAYS', 'HOME', 'LANG']) if (env[k]) out[k] = env[k];
  return out;
}

export function launchdLabel(agentName) {
  return `chat.tegami.agent.${agentName.replace(/[^A-Za-z0-9.-]/g, '-')}`;
}

export function systemdName(agentName) {
  return `tegami-agent-${agentName.replace(/[^A-Za-z0-9_.-]/g, '-')}.service`;
}

/** Where the file goes: ~/Library/LaunchAgents (macOS) or ~/.config/systemd/user (Linux). */
export function autostartFile(platform, agentName, home = homedir(), env = process.env) {
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents', `${launchdLabel(agentName)}.plist`);
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(config, 'systemd', 'user', systemdName(agentName));
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The command line of the watcher: node, this script, keep, the AI friend, the log file. */
export function keepArgs({ node, script, agentName, logPath }) {
  return [node, script, 'keep', '--agent', agentName, '--log', logPath];
}

/**
 * The launchd agent: started at login (RunAtLoad), started again by launchd if `keep`
 * itself crashes (KeepAlive on failure only, so "another watcher runs" stays stopped).
 */
export function launchdPlist({ agentName, args, env, workDir }) {
  const strings = (list) => list.map((a) => `    <string>${xml(a)}</string>`).join('\n');
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(launchdLabel(agentName))}</string>
  <key>ProgramArguments</key>
  <array>
${strings(args)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(workDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/** One word of an ExecStart= line: quoted, with systemd's escapes (\\ \" %% $$). */
export function systemdQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$').replace(/\n/g, '\\n')}"`;
}

/**
 * The systemd user unit: started with the user's session (default.target), started again
 * 10 seconds after a crash. "Another watcher runs" exits 0 and is not restarted.
 */
export function systemdUnit({ agentName, args, env, workDir }) {
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`)
    .join('\n');
  return `[Unit]
Description=Tegami: keeps the AI friend "${agentName.replace(/["\\\n]/g, '')}" answering messages (tegami-agent)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${args.map(systemdQuote).join(' ')}
WorkingDirectory=${systemdQuote(workDir)}
${envLines}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/**
 * The commands that turn the file on, off, or report on it. uid: the user's number (macOS).
 * Each is [program, ...args]; `ignoreFail` ones may fail (nothing to stop yet).
 */
export function autostartCommands(platform, action, { agentName, file, uid }) {
  if (platform === 'darwin') {
    const target = `gui/${uid}/${launchdLabel(agentName)}`;
    if (action === 'on') return [{ cmd: ['launchctl', 'bootout', target], ignoreFail: true }, { cmd: ['launchctl', 'bootstrap', `gui/${uid}`, file] }];
    if (action === 'off') return [{ cmd: ['launchctl', 'bootout', target], ignoreFail: true }];
    return [{ cmd: ['launchctl', 'print', target], ignoreFail: true }];
  }
  const unit = systemdName(agentName);
  if (action === 'on') return [{ cmd: ['systemctl', '--user', 'daemon-reload'] }, { cmd: ['systemctl', '--user', 'enable', '--now', unit] }];
  if (action === 'off') return [{ cmd: ['systemctl', '--user', 'disable', '--now', unit], ignoreFail: true }, { cmd: ['systemctl', '--user', 'daemon-reload'], ignoreFail: true }];
  return [{ cmd: ['systemctl', '--user', 'is-enabled', unit], ignoreFail: true }];
}
