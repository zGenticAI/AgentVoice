// The voice service's unit, as launchd (a plist in ~/Library/LaunchAgents) or systemd (a user service) reads it back:
// where the installed one is for a label, the folder it runs in and the program it starts. agentvoice check reads them
// to say when the installed service no longer matches this AgentVoice (another bin or node, or a node that is gone).
// Pure, apart from the paths' defaults.
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
