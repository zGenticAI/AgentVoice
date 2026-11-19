// A stand-in for the converter child (src/slides/render-child.ts), for the tests of the parent's side
// (src/slides/convert.ts). What it does comes from $HOME/fake-child.json, since the parent gives a child nothing else:
// - env: write the names and values of its environment to $HOME/child-env.json, and its limits (Linux's
//   /proc/self/limits, where there is one) to $HOME/child-limits.txt;
// - hang: start a grandchild in its own process group, write both pids to $HOME/child-pids.json, and never end;
// - files: write page images of these sizes (zeros) where the job says, as the real child writes its WebPs;
// - lines: write these lines to stdout, then exit with `exit` (0 unless given).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const home = process.env.HOME ?? ''
const plan = JSON.parse(fs.readFileSync(path.join(home, 'fake-child.json'), 'utf8')) as {
  env?: boolean
  hang?: boolean
  files?: { n: number; bytes: number }[]
  lines?: string[]
  exit?: number
}
const job = JSON.parse(process.argv[2] ?? '{}') as { out?: string }
if (plan.env) {
  fs.writeFileSync(path.join(home, 'child-env.json'), JSON.stringify(process.env))
  if (fs.existsSync('/proc/self/limits')) fs.writeFileSync(path.join(home, 'child-limits.txt'), fs.readFileSync('/proc/self/limits', 'utf8'))
}
for (const file of plan.files ?? []) fs.writeFileSync(path.join(job.out ?? home, `${String(file.n).padStart(3, '0')}.webp`), Buffer.alloc(file.bytes))
if (plan.hang) {
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  fs.writeFileSync(path.join(home, 'child-pids.json'), JSON.stringify([process.pid, grandchild.pid]))
  setInterval(() => {}, 1000)
} else {
  for (const line of plan.lines ?? []) process.stdout.write(`${line}\n`)
  process.stdout.write('', () => process.exit(plan.exit ?? 0))
}
