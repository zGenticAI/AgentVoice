// Prepares a slide deck for the assistant to present, and checks its script: npm run slides -- prepare <deck.pdf>
// [--exclude <pages>] [--label <name>], check <deck.script.md>, list, delete <id> | --all. None of them needs a key or
// the network. docs/presenting.md says how to export a PDF and write the script.
//
// prepare reads any PDF it is given and writes its text into data/decks, so a Claude Code session should never be
// allowed to run it without asking (docs/claude-code.md).
import path from 'node:path'
import { config } from '../config.ts'
import { identity } from '../identity.ts'
import { runCheck, runDelete, runList, runPrepare } from '../slides/actions.ts'
import { decksDir } from '../slides/deck.ts'
import { SLIDES_USAGE, slidesArgs } from './slides-args.ts'

const args = slidesArgs(process.argv.slice(2))
if ('problem' in args) {
  console.error(`${args.problem}\n${SLIDES_USAGE}`)
  process.exit(1)
}
// npm runs scripts from the project's folder: a file is found from where you ran npm.
const cwd = process.env.INIT_CWD || process.cwd()
const decks = decksDir(config.dataDir)
const retentionDays = config.deckRetentionDays

let outcome
switch (args.command) {
  case 'help':
    outcome = { lines: [SLIDES_USAGE], code: 0 }
    break
  case 'prepare':
    // As given: a link is refused as one, before it could be made into a path.
    outcome = await runPrepare({ input: args.file, exclude: args.exclude, label: args.label, decksDir: decks, name: identity.name, cwd })
    break
  case 'check':
    outcome = runCheck({ file: path.resolve(cwd, args.file), decksDir: decks, retentionDays, cwd })
    break
  case 'list':
    outcome = runList({ decksDir: decks, retentionDays, cwd })
    break
  case 'delete':
    outcome = runDelete({ decksDir: decks, ids: args.ids, all: args.all })
    break
}
const print = outcome.code ? console.error : console.log
for (const line of outcome.lines) print(line)
process.exitCode = outcome.code
