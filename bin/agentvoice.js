#!/usr/bin/env node
// The agentvoice command. Plain JavaScript, because Node won't strip types from a file under node_modules: it
// registers tsx in this process (resolved from this package, never from the folder you are in), then runs the command.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const [major] = process.versions.node.split('.').map(Number)
if (major < 24) {
  console.error(`AgentVoice needs Node.js 24 or later; this is Node ${process.version}.`)
  process.exit(1)
}
// npm run and npx set INIT_CWD to the folder they were run in. Run directly, this command could inherit a stale one
// from whatever started it, and join --slides and slides resolve their paths from it.
process.env.INIT_CWD = process.cwd()
// tsx keeps compiled code in <temp folder>/tsx-<uid> and runs what it finds there. On Linux that is /tmp, where another
// user could make the folder first and plant code that would run as you. Use the cache only when it is a real folder of
// yours that nobody else can write; otherwise compile without one (slower to start, nothing else changes). The slide
// converter's child process inherits the setting.
if (!process.env.TSX_DISABLE_CACHE) {
  const uid = process.geteuid?.()
  const cache = path.join(os.tmpdir(), `tsx-${uid ?? os.userInfo().username}`) // tsx's own name for it
  let safe = false
  try {
    try {
      fs.mkdirSync(cache, { mode: 0o700 })
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
    }
    const st = fs.lstatSync(cache) // a symlink is not a directory here
    safe = st.isDirectory() && st.uid === uid && (st.mode & 0o022) === 0
    if (safe && (st.mode & 0o077) !== 0) fs.chmodSync(cache, 0o700)
  } catch {
    safe = false
  }
  if (!safe) process.env.TSX_DISABLE_CACHE = '1'
}
const { register } = await import('tsx/esm/api')
register()
await import(new URL('../src/cli/agentvoice.ts', import.meta.url).href)
