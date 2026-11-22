// agentvoice service install [--replace] | print [launchd|systemd] | uninstall: keeps the voice service running for an
// installed AgentVoice, as scripts/install-service.sh does for a clone: a launchd agent on macOS
// (~/Library/LaunchAgents/<label>.plist), a systemd user service on Linux (~/.config/systemd/user/<label>.service), named
// after SERVICE_LABEL (from the environment, else your .env; local.agent-voice unless set). The file starts the package
// by absolute paths, [node, bin] as agentvoice setup writes them (src/setup/node-path.ts), in your AgentVoice folder with
// AGENTVOICE_HOME set to it, since launchd and systemd don't give a service your shell's environment. One voice service
// a computer (both modes listen on PORT 8787 by default): install never replaces a unit that runs the service from
// another folder, a clone's say, unless given --replace. Installed from npm only.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type CommandWords, INSTALL_FIRST, UPGRADE, WORDS, cloneRefusal } from '../commands.ts'
import { type InstallMode, isWithin, realPath, tildePath } from '../home.ts'
import {
  LABEL,
  type ServiceKind,
  UNSAFE_IN_UNIT,
  readBackHome,
  readBackProgram,
  readBackWorkingDirectory,
  renderUnit,
  serviceKind,
  unitFile,
} from '../service/units.ts'
import { sameFolder } from '../setup/files.ts'

export const SERVICE_USAGE = [
  'Usage: agentvoice service install [--replace]',
  '       agentvoice service print [launchd|systemd]',
  '       agentvoice service uninstall',
].join('\n')

export type ServiceArgs = { action: 'install'; replace: boolean } | { action: 'print'; kind?: ServiceKind } | { action: 'uninstall' }

/** A mistake in the command line: said with the usage, exit 2. */
export class UsageError extends Error {}
/** Why the service can't be installed, printed or removed: said, exit 1. */
export class ServiceError extends Error {}

/** The command line after agentvoice service. Throws UsageError for one it can't take. */
export function parseServiceArgs(argv: readonly string[]): ServiceArgs {
  const [action, ...rest] = argv
  if (action === 'install') {
    if (rest.length === 0) return { action, replace: false }
    if (rest.length === 1 && rest[0] === '--replace') return { action, replace: true }
  } else if (action === 'print') {
    if (rest.length === 0) return { action }
    if (rest.length === 1 && (rest[0] === 'launchd' || rest[0] === 'systemd')) return { action, kind: rest[0] }
  } else if (action === 'uninstall') {
    if (rest.length === 0) return { action }
  } else if (action === undefined) throw new UsageError('Which one? agentvoice service install, print or uninstall.')
  else throw new UsageError(`Unknown service command "${action}": agentvoice service install, print or uninstall.`)
  throw new UsageError(`agentvoice service ${action} doesn't take ${rest.join(' ')}.`)
}

/** What the command works with: this AgentVoice, this computer, and the commands it runs. Built from the real ones by main(). */
export interface ServiceContext {
  mode: InstallMode
  /** The AgentVoice folder (OWNER_DIR). */
  home: string
  packageDir: string
  version: string
  /** How messages name commands and docs pages: the installed words (WORDS, in the command). */
  words: CommandWords
  /** SERVICE_LABEL, as config read it (the environment, else your .env), or the default. */
  label: string
  /** [node, bin], as agentvoice setup writes them (agentvoiceCommand). */
  node: string
  bin: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Your home folder: where ~/Library/LaunchAgents and ~/.config are. */
  homeDir: string
  /** Runs launchctl or systemctl, their output to the terminal (none when quiet): the exit status. */
  run(command: string, args: string[], quiet?: boolean): number | null
  /** Whether a command is on PATH. */
  has(command: string): boolean
  out(text: string): void
  err(text: string): void
}

const NAME: Record<ServiceKind, string> = { launchd: 'launchd plist', systemd: 'systemd unit' }

/** A path as a shell command takes it: ~/... unless it needs quotes, which "~" can't be in. */
function arg(p: string, homeDir: string): string {
  const t = tildePath(p, homeDir)
  return /^~?[\w@%+=:,./-]+$/.test(t) ? t : `"${p}"`
}

/** The kind of service for this computer, or why there is none (Run agentvoice start instead). */
function kindHere(ctx: ServiceContext, installing: boolean): ServiceKind {
  const kind = serviceKind(ctx.platform)
  if (!kind) throw new ServiceError(`This installs the service on macOS (launchd) or Linux (systemd) only. Run ${ctx.words.start} instead.`)
  if (installing && kind === 'systemd' && !ctx.has('systemctl')) {
    throw new ServiceError(`systemctl was not found: on Linux this installs a systemd user service. Run ${ctx.words.start} instead.`)
  }
  return kind
}

/**
 * The unit for this AgentVoice, checked: the label, the paths (no quote mark, backslash, "$" or control character),
 * and the file as launchd or systemd will read it back (a plist must also be valid). Throws ServiceError, and nothing
 * is installed, for one that isn't right.
 */
export function checkedUnit(kind: ServiceKind, ctx: ServiceContext): string {
  if (!LABEL.test(ctx.label)) throw new ServiceError(`SERVICE_LABEL "${ctx.label}" may have only letters, digits, dots, hyphens and underscores.`)
  for (const p of [ctx.home, ctx.node, ctx.bin]) {
    if (UNSAFE_IN_UNIT.test(p)) {
      throw new ServiceError(
        `The path ${JSON.stringify(p)} can't go into a service file: it has a quote mark, backslash, "$" or control character in it. ` +
          `Move your AgentVoice folder (AGENTVOICE_HOME), AgentVoice or node to a folder without one, or run ${ctx.words.start} instead.`,
      )
    }
  }
  const text = renderUnit(kind, { label: ctx.label, home: ctx.home, node: ctx.node, bin: ctx.bin, version: ctx.version })
  const what = `The ${NAME[kind]} agentvoice service install made`
  if (kind === 'launchd') lintPlist(text, ctx, what)
  if (readBackWorkingDirectory(kind, text) !== ctx.home || readBackHome(kind, text) !== ctx.home) {
    throw new ServiceError(`${what} doesn't give back your AgentVoice folder (${ctx.home}) as ${kind} will read it, so nothing was installed.`)
  }
  const program = readBackProgram(kind, text)
  if (program?.[0] !== ctx.node || program[1] !== ctx.bin || program[2] !== 'start') {
    throw new ServiceError(`${what} doesn't give back the command (${ctx.node} ${ctx.bin} start) as ${kind} will read it, so nothing was installed.`)
  }
  return text
}

/** A plist must be valid: plutil -lint on macOS, else xmllint if there is one. */
function lintPlist(text: string, ctx: ServiceContext, what: string): void {
  const tool = ctx.platform === 'darwin' && ctx.has('plutil') ? 'plutil' : ctx.has('xmllint') ? 'xmllint' : null
  if (!tool) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvoice-service-'))
  try {
    const staged = path.join(dir, 'unit.plist')
    fs.writeFileSync(staged, text, { mode: 0o600 })
    const lint = spawnSync(tool, tool === 'plutil' ? ['-lint', '-s', staged] : ['--noout', staged], { encoding: 'utf8' })
    if (lint.status !== 0) {
      throw new ServiceError(`${what} is not valid ${tool === 'plutil' ? '(plutil -lint)' : 'XML (xmllint)'}, so nothing was installed.${lint.stderr ? `\n${lint.stderr.trimEnd()}` : ''}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** The installed unit's file for this label, what it holds (null if there is none), and the folder it runs the service in. */
function installed(kind: ServiceKind, ctx: ServiceContext): { file: string; text: string | null; dir: string | null } {
  const file = unitFile(kind, ctx.label, ctx.env, ctx.homeDir)
  let text: string | null = null
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new ServiceError(`${tildePath(file, ctx.homeDir)} can't be read (${(err as NodeJS.ErrnoException).code}).`)
  }
  return { file, text, dir: text === null ? null : readBackWorkingDirectory(kind, text) }
}

/**
 * Units of other labels that also run this AgentVoice's voice service: from this AgentVoice folder, or this package's
 * bin. The two would fight over the port.
 */
function others(kind: ServiceKind, ctx: ServiceContext, target: string): string[] {
  const folder = path.dirname(target)
  let names: string[]
  try {
    names = fs.readdirSync(folder)
  } catch {
    return []
  }
  const ext = kind === 'launchd' ? '.plist' : '.service'
  const found: string[] = []
  for (const name of names.sort()) {
    const file = path.join(folder, name)
    if (!name.endsWith(ext) || file === target) continue
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const dir = readBackWorkingDirectory(kind, text)
    const program = readBackProgram(kind, text) ?? []
    if ((dir !== null && sameFolder(dir, ctx.home)) || program.some(word => path.isAbsolute(word) && isWithin(word, ctx.packageDir))) found.push(file)
  }
  return found
}

/** Runs one of the service manager's commands; throws if it fails. */
function must(ctx: ServiceContext, command: string, args: string[]): void {
  const status = ctx.run(command, args)
  if (status !== 0) throw new ServiceError(`${[command, ...args].join(' ')} failed (exit ${status ?? 'by a signal'}).`)
}

function install(ctx: ServiceContext, replace: boolean): void {
  if (!fs.existsSync(path.join(ctx.home, '.env'))) throw new ServiceError(`${tildePath(path.join(ctx.home, '.env'), ctx.homeDir)} is not there yet. Run agentvoice init first.`)
  const kind = kindHere(ctx, true)
  const text = checkedUnit(kind, ctx)
  const t = (p: string) => tildePath(p, ctx.homeDir)
  const { file: target, text: current, dir } = installed(kind, ctx)
  if (current !== null && (dir === null || !sameFolder(dir, ctx.home)) && !replace) {
    throw new ServiceError(
      `${t(target)} runs the voice service from ${dir === null ? 'a folder it doesn\'t name' : t(dir)}. Stop and remove that one first ` +
        `(${ctx.words.doc('setup')}, "Keeping it running"), or run agentvoice service install --replace to replace it.`,
    )
  }
  for (const other of others(kind, ctx, target)) {
    ctx.err(`Warning: ${t(other)} also runs this voice service (from ${t(ctx.home)}, or with ${t(ctx.bin)}). Stop and remove it (see "Keeping it running" in ${ctx.words.doc('setup')}), or the two fight over the port.`)
  }
  // The AgentVoice folder and its data folder, which only you can open, as init and the service make them.
  for (const dir of [ctx.home, path.join(ctx.home, 'data')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
  }
  const log = path.join(ctx.home, 'data/agent-voice.log')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const staged = `${target}.${process.pid}.tmp`
  try {
    fs.writeFileSync(staged, text, { mode: 0o644 })
    fs.renameSync(staged, target)
  } finally {
    fs.rmSync(staged, { force: true })
  }
  const upgrade = [
    `After upgrading AgentVoice (${UPGRADE}), run agentvoice service install again: it restarts the service on the new version.`,
    'After switching Node (nvm keeps a prefix per version), reinstall AgentVoice there and run it again.',
  ]
  const confirm = `To confirm it started (a missing setting stops it at once): tail -n 20 ${arg(log, ctx.homeDir)}, and the details on its control socket (the line the log shows when it starts: curl --unix-socket ...)`
  if (kind === 'launchd') {
    ctx.run('launchctl', ['unload', target], true)
    must(ctx, 'launchctl', ['load', target])
    if (ctx.run('launchctl', ['list', ctx.label], true) !== 0) throw new ServiceError(`launchd did not take ${t(target)}: the service is not running. See ${t(log)}.`)
    ctx.out(
      [
        `The meeting assistant's voice service is installed and loaded as the launchd agent ${ctx.label}. Logs: ${t(log)}`,
        confirm,
        `To stop it: launchctl unload ${arg(target, ctx.homeDir)}`,
        ...upgrade,
      ].join('\n'),
    )
    return
  }
  must(ctx, 'systemctl', ['--user', 'daemon-reload'])
  must(ctx, 'systemctl', ['--user', 'enable', `${ctx.label}.service`])
  must(ctx, 'systemctl', ['--user', 'restart', `${ctx.label}.service`])
  if (ctx.run('systemctl', ['--user', 'is-active', '--quiet', `${ctx.label}.service`], true) !== 0) {
    throw new ServiceError(`The service ${ctx.label} did not start. See ${t(log)}, and: systemctl --user status ${ctx.label}`)
  }
  ctx.out(
    [
      `The meeting assistant's voice service is installed and loaded as the systemd user service ${ctx.label}. Logs: ${t(log)}`,
      confirm,
      `To stop it: systemctl --user stop ${ctx.label}`,
      `To keep it running while you are logged out: loginctl enable-linger ${ctx.env.USER || os.userInfo().username}`,
      ...upgrade,
    ].join('\n'),
  )
}

function uninstall(ctx: ServiceContext): void {
  const kind = kindHere(ctx, true)
  const t = (p: string) => tildePath(p, ctx.homeDir)
  const { file, text, dir } = installed(kind, ctx)
  if (text === null) {
    ctx.out(`No voice service is installed as ${ctx.label} (${t(file)} is not there): nothing to remove.`)
    return
  }
  if (dir === null || !sameFolder(dir, ctx.home)) {
    throw new ServiceError(
      `${t(file)} runs the voice service from ${dir === null ? 'a folder it doesn\'t name' : t(dir)}, not your AgentVoice folder (${t(ctx.home)}), ` +
        `so it was left as it is. Remove it as that one was installed (${ctx.words.doc('setup')}, "Keeping it running").`,
    )
  }
  if (kind === 'launchd') {
    ctx.run('launchctl', ['unload', file], true)
    fs.rmSync(file, { force: true })
  } else {
    ctx.run('systemctl', ['--user', 'disable', '--now', `${ctx.label}.service`])
    fs.rmSync(file, { force: true })
    must(ctx, 'systemctl', ['--user', 'daemon-reload'])
  }
  ctx.out(`Stopped the voice service ${ctx.label} and removed ${t(file)}. Your AgentVoice folder (${t(ctx.home)}) is as it was.`)
}

/** Runs agentvoice service with these arguments. Throws UsageError or ServiceError. */
export function service(args: ServiceArgs, ctx: ServiceContext): void {
  if (ctx.mode === 'clone') throw new ServiceError(cloneRefusal(ctx.packageDir))
  if (args.action === 'print') {
    ctx.out(checkedUnit(args.kind ?? kindHere(ctx, false), ctx).trimEnd())
    return
  }
  if (args.action === 'uninstall') {
    // From npx too: after npm uninstall -g, npx is how the command is still at hand to remove the unit.
    uninstall(ctx)
    return
  }
  // A unit can't point into npx's cache, which npm clears.
  if (realPath(ctx.packageDir).split(path.sep).includes('_npx')) throw new ServiceError(`${INSTALL_FIRST}: a service can't point into npx's cache, which npm clears.`)
  install(ctx, args.replace)
}

/** Run as a command (agentvoice service), not imported. */
function isEntryPoint(): boolean {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(SERVICE_USAGE)
    return
  }
  try {
    const args = parseServiceArgs(argv)
    const { INSTALL_MODE, OWNER_DIR, PACKAGE_DIR, PACKAGE_VERSION } = await import('../home.ts')
    if (INSTALL_MODE === 'clone') throw new ServiceError(cloneRefusal(PACKAGE_DIR))
    // config reads your .env, for SERVICE_LABEL.
    const { config } = await import('../config.ts')
    const { agentvoiceCommand } = await import('../setup/node-path.ts')
    const { onPath } = await import('../setup/folder.ts')
    const [node, bin] = agentvoiceCommand()
    service(args, {
      mode: INSTALL_MODE,
      home: OWNER_DIR,
      packageDir: PACKAGE_DIR,
      version: PACKAGE_VERSION,
      words: WORDS,
      label: config.serviceLabel,
      node,
      bin,
      platform: process.platform,
      env: process.env,
      homeDir: os.homedir(),
      run: (command, cmdArgs, quiet) => spawnSync(command, cmdArgs, { stdio: ['ignore', quiet ? 'ignore' : 'inherit', quiet ? 'ignore' : 'inherit'] }).status,
      has: command => onPath(command) !== null,
      out: text => console.log(text),
      err: text => console.error(text),
    })
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n${SERVICE_USAGE}`)
      process.exitCode = 2
    } else if (err instanceof ServiceError) {
      console.error(err.message)
      process.exitCode = 1
    } else throw err
  }
}

if (isEntryPoint()) await main()
