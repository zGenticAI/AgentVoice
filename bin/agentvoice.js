#!/usr/bin/env node
// The agentvoice command. Plain JavaScript, because Node won't strip types from a file under node_modules: it
// registers tsx in this process (resolved from this package, never from the folder you are in), then runs the command.
const [major] = process.versions.node.split('.').map(Number)
if (major < 24) {
  console.error(`AgentVoice needs Node.js 24 or later; this is Node ${process.version}.`)
  process.exit(1)
}
// npm run and npx set INIT_CWD to the folder they were run in. Run directly, this command could inherit a stale one
// from whatever started it, and join --slides and slides resolve their paths from it.
process.env.INIT_CWD = process.cwd()
// tsx keeps the code it compiles in two folders in your temp folder: <tmp>/tsx-<uid>, whose entries it runs as they
// are, and <tmp>/tsx, an old one, which it deletes with everything in it. On Linux that is /tmp, where another user
// could make either one first: to plant code that would run as you, or to swap a link in and out of the old one while
// tsx deletes it, so that the deletion goes into your files. So tsx keeps compiled code in memory only, whatever this
// was set to: it compiles at each start (about 0.1 s more), and never touches either folder. It is read when tsx
// loads. (The slide converter's child has a temp folder of its own, in the decks folder.)
process.env.TSX_DISABLE_CACHE = '1'
const { register } = await import('tsx/esm/api')
register()
await import(new URL('../src/cli/agentvoice.ts', import.meta.url).href)
