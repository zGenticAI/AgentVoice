// The words for commands, the owner's files and the docs, in the mode this runs in (src/home.ts). One place decides
// how a message names a command (npm run join, or agentvoice join), the settings file (.env in a clone, its real place
// installed from npm, which the command may well be run away from) and a docs page (docs/setup.md, or that page of the
// running version on GitHub), so a clone's messages stay word for word what they were. Every string in src/ that names
// one of them is built here (test/command-words.test.ts). Imports only home.ts.
import os from 'node:os'
import path from 'node:path'
import { INSTALL_MODE, type InstallMode, OWNER_DIR, PACKAGE_NAME, PACKAGE_VERSION, tildePath } from './home.ts'

export type Script = 'join' | 'check' | 'slides' | 'check-name' | 'speaker-report' | 'flux-probe'

export interface CommandWords {
  /**
   * A command with its arguments. run('slides', 'check <the script>'): 'npm run slides -- check <the script>' in a clone,
   * 'agentvoice slides check <the script>' installed. run('join'): 'npm run join' / 'agentvoice join'.
   */
  run(script: Script, args?: string): string
  /** A usage line's optional first option: '[-- --json]' in a clone (after npm run x), '[--json]' installed. */
  optional(option: string): string
  /** 'npm start' | 'agentvoice start' */
  start: string
  /** 'scripts/install-service.sh' | 'agentvoice service install' */
  serviceInstall: string
  /** The settings file as a sentence names it ("in .env", "to .env"): '.env' | ~/.agentvoice/.env. */
  envFile: string
  /** A file or folder of the owner's, from their folder: 'data/transcripts/' | '~/.agentvoice/data/transcripts/'. */
  ownerPath(rel: string): string
  /** The profile when PROFILE_FILE is not set: 'profile.md in this folder' | '~/.agentvoice/profile.md'. */
  profileHere: string
  /** How to start a profile: 'copy profile.example.md to start one' | 'agentvoice init makes one from the example'. */
  startProfile: string
  /** What the service and a channel must share to find each other (the control socket). */
  sameFolder: string
  /** A docs page: 'docs/<page>.md' | '<DOCS_URL>/v<version>/docs/<page>.md', that page of the running version on GitHub. */
  doc(page: string): string
  /** 'npm install' | 'npm install -g <PACKAGE_NAME>' */
  reinstall: string
}

/** The repository's files on GitHub, by tag: <DOCS_URL>/v<version>/docs/<page>.md. */
export const DOCS_URL = 'https://github.com/zGenticAI/AgentVoice/blob'
/** The README on GitHub, the package's homepage: where agentvoice --help sends you. */
export const README_URL = `${DOCS_URL.slice(0, -'/blob'.length)}#readme`

export function commandWords(mode: InstallMode, ownerDir: string, version = PACKAGE_VERSION, home = os.homedir()): CommandWords {
  const shown = (rel: string) => tildePath(path.join(ownerDir, rel), home)
  if (mode === 'clone') {
    return {
      run: (script, args) => `npm run ${script}${args ? ` -- ${args}` : ''}`,
      optional: option => `[-- ${option}]`,
      start: 'npm start',
      serviceInstall: 'scripts/install-service.sh',
      envFile: '.env',
      ownerPath: rel => rel,
      profileHere: 'profile.md in this folder',
      startProfile: 'copy profile.example.md to start one',
      sameFolder: 'the same .env (CONTROL_SOCKET) and the same data folder',
      doc: page => `docs/${page}.md`,
      reinstall: 'npm install',
    }
  }
  return {
    run: (script, args) => `agentvoice ${script}${args ? ` ${args}` : ''}`,
    optional: option => `[${option}]`,
    start: 'agentvoice start',
    serviceInstall: 'agentvoice service install',
    envFile: shown('.env'),
    ownerPath: shown,
    profileHere: shown('profile.md'),
    startProfile: 'agentvoice init makes one from the example',
    sameFolder: `the same AgentVoice folder (AGENTVOICE_HOME, now ${tildePath(ownerDir, home)})`,
    doc: page => `${DOCS_URL}/v${version}/docs/${page}.md`,
    reinstall: `npm install -g ${PACKAGE_NAME}`,
  }
}

/** The words for this process's mode and owner's folder. */
export const WORDS = commandWords(INSTALL_MODE, OWNER_DIR)
export const PROFILE_HERE = WORDS.profileHere

// Sentences used only where one mode is known (they name npm or the clone's scripts, so they live here too).
/** How a clone is set up, for the commands that only an installed package has. */
export const CLONE_SETUP =
  'set it up as its README says (cp .env.example .env, scripts/install-service.sh, ' +
  'scripts/install-channel.sh, scripts/install-codex.sh, scripts/install-opencode.sh)'
/** Why a command only an installed package has (init, setup, service) refuses in a clone, and the clone's way instead. */
export const cloneRefusal = (root: string): string => `This is a cloned folder (${root}): ${CLONE_SETUP}.`
export const INSTALL_FIRST = `Install AgentVoice first (npm install -g ${PACKAGE_NAME})`
export const UPGRADE = `npm install -g ${PACKAGE_NAME}@latest`
/** What the slide converter needs, when the optional native canvas is missing. */
export const CANVAS_MISSING =
  INSTALL_MODE === 'clone'
    ? `Slide rendering needs @napi-rs/canvas: run ${WORDS.reinstall} (without --omit=optional).`
    : `Slide rendering needs @napi-rs/canvas: reinstall AgentVoice without --omit=optional: ${WORDS.reinstall}.`
