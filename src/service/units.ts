// The voice service's unit, as launchd (a plist in ~/Library/LaunchAgents) or systemd (a user service) reads it: the
// file agentvoice service install writes for an installed package (systemdUnit, launchdPlist), where the installed one
// is for a label, and what one reads back as: the folder it runs in and the program it starts. agentvoice service
// install reads its own file back before installing it, and agentvoice check reads the installed one to say when it no
// longer matches this AgentVoice (another bin or node, or a node that is gone). A clone's service is still
// scripts/install-service.sh with its two templates, which this leaves as they are. Pure, apart from the paths' defaults.
import os from 'node:os'
import path from 'node:path'

export type ServiceKind = 'launchd' | 'systemd'

/** The service manager on this computer: launchd on macOS, systemd on Linux, else none. */
export function serviceKind(platform: NodeJS.Platform = process.platform): ServiceKind | null {
  return platform === 'darwin' ? 'launchd' : platform === 'linux' ? 'systemd' : null
}

/** Where the unit for a label is installed: ~/Library/LaunchAgents/<label>.plist, or ${XDG_CONFIG_HOME:-~/.config}/systemd/user/<label>.service. */
export function unitFile(kind: ServiceKind, label: string, env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  return kind === 'launchd'
    ? path.join(homeDir, 'Library/LaunchAgents', `${label}.plist`)
    : path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'systemd/user', `${label}.service`)
}

const xmlText = (text: string) =>
  text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
// systemd: "%%" is a "%" (a lone "%" starts a specifier, which no path AgentVoice writes has).
const unitText = (text: string) => text.replaceAll('%%', '%')

/** The folder the unit runs the service in, as launchd or systemd reads it: null if it names none. */
export function readBackWorkingDirectory(kind: ServiceKind, text: string): string | null {
  if (kind === 'launchd') {
    const m = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
    return m ? xmlText(m[1]) : null
  }
  const m = /^WorkingDirectory=(.*)$/m.exec(text)
  return m ? unitText(m[1].trim()) : null
}

/** The program and arguments the unit starts, as launchd or systemd reads them: null if it names none. */
export function readBackProgram(kind: ServiceKind, text: string): string[] | null {
  if (kind === 'launchd') {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1]
    return array === undefined ? null : [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(m => xmlText(m[1]))
  }
  const line = /^ExecStart=(.*)$/m.exec(text)?.[1]
  // Words, a double-quoted one as one word (the paths are refused when they have a quote mark or backslash in them).
  return line === undefined ? null : [...line.matchAll(/"([^"]*)"|(\S+)/g)].map(m => unitText(m[1] ?? m[2]))
}

/** What a unit is made from: the label (SERVICE_LABEL), the AgentVoice folder, and [node, bin] (agentvoiceCommand). */
export interface UnitInput {
  label: string
  /** The AgentVoice folder: the service runs in it, with AGENTVOICE_HOME set to it, and logs to its data/agent-voice.log. */
  home: string
  node: string
  bin: string
  /** The package's version, named in the file's comment. */
  version: string
}

/** The labels a unit file can be named after: they name a file and go into the files as they are. */
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
/**
 * What no path in a unit may have: a quote mark, a backslash, "$" or a control character, which would need escaping
 * that differs from one line of a systemd unit to the next (a line break would end the line). As
 * scripts/install-service.sh refuses them.
 */
export const UNSAFE_IN_UNIT = /["\\$\u0000-\u001f\u007f]/

/** A path as a systemd unit holds it: each "%" doubled, since "%" starts a specifier. */
export const forSystemd = (text: string): string => text.replaceAll('%', '%%')
/** A path as a plist holds it: "&", "<" and ">" as entities. */
export const forPlist = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
/** The version as an XML comment can hold it: a comment can't have "--" in it. */
const inComment = (text: string) => text.replaceAll('--', '- -')

/** The systemd user service that keeps an installed AgentVoice's voice service running. */
export function systemdUnit({ label, home, node, bin, version }: UnitInput): string {
  const h = forSystemd(home)
  return `# Keeps the AgentVoice voice service running, as a systemd user service. Written by agentvoice service install
# (@zgentic/agentvoice ${version}): run it again after upgrading AgentVoice or Node.
[Unit]
Description=${label}: the meeting assistant's voice service
# No After=/Wants=network-online.target: that is a system unit, which a user's service manager doesn't have.

[Service]
Type=simple
WorkingDirectory=${h}
Environment="AGENTVOICE_HOME=${h}"
ExecStart="${forSystemd(node)}" "${forSystemd(bin)}" start
# Started again whenever it stops, as launchd's KeepAlive does on macOS.
Restart=always
RestartSec=5
# The service stops in order on SIGTERM, within 20 s. SIGTERM goes to the main process only: the service itself.
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=20
StandardOutput=append:${h}/data/agent-voice.log
StandardError=append:${h}/data/agent-voice.log

[Install]
WantedBy=default.target
`
}

/** The launchd agent that keeps an installed AgentVoice's voice service running. */
export function launchdPlist({ label, home, node, bin, version }: UnitInput): string {
  const h = forPlist(home)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Keeps the AgentVoice voice service running on macOS. Written by agentvoice service install
     (@zgentic/agentvoice ${inComment(version)}): run it again after upgrading AgentVoice or Node. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${forPlist(label)}</string>
  <key>WorkingDirectory</key><string>${h}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTVOICE_HOME</key><string>${h}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>${forPlist(node)}</string>
    <string>${forPlist(bin)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${h}/data/agent-voice.log</string>
  <key>StandardErrorPath</key><string>${h}/data/agent-voice.log</string>
</dict>
</plist>
`
}

/** The unit of that kind. */
export const renderUnit = (kind: ServiceKind, input: UnitInput): string => (kind === 'launchd' ? launchdPlist(input) : systemdUnit(input))

/** AGENTVOICE_HOME as the unit gives it to the service, as launchd or systemd reads it: null if it gives none. */
export function readBackHome(kind: ServiceKind, text: string): string | null {
  if (kind === 'launchd') {
    const m = /<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*?<key>AGENTVOICE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text)
    return m ? xmlText(m[1]) : null
  }
  const m = /^Environment="AGENTVOICE_HOME=([^"]*)"$/m.exec(text)
  return m ? unitText(m[1]) : null
}
