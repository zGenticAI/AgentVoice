// A stand-in for the converter child (src/slides/render-child.ts), for the tests of the parent's side
// (src/slides/convert.ts). What it does comes from $HOME/fake-child.json, since the parent gives a child nothing else:
// - env: write the names and values of its environment to $HOME/child-env.json;
// - hang: start a grandchild in its own process group, write both pids to $HOME/child-pids.json, and never end;
// - lines: write these lines to stdout, then exit with `exit` (0 unless given).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const home = process.env.HOME ?? ''
const plan = JSON.parse(fs.readFileSync(path.join(home, 'fake-child.json'), 'utf8')) as {
  env?: boolean
  hang?: boolean
  lines?: string[]
  exit?: number
}
if (plan.env) fs.writeFileSync(path.join(home, 'child-env.json'), JSON.stringify(process.env))
if (plan.hang) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fs.writeFileSync(path.join(home, 'child-pids.json'), JSON.stringify([process.pid, grandchild.pid]))
  setInterval(() => {}, 1000)
} else {
  for (const line of plan.lines ?? []) process.stdout.write(`${line}\n`)
  process.stdout.write('', () => process.exit(plan.exit ?? 0))
}
