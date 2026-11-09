// The real service (npm start), as launchd runs it: it stops in order on SIGTERM, and on a crash too, so a
// crash never leaves bots silent in their calls. A small preload makes it crash on demand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'

const TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()

/** Starts src/server.ts in a data folder of its own; with crash, SIGUSR2 makes it throw (or reject) out of nowhere. */
function service(t: { after: (fn: () => unknown) => void }, crash?: 'throw' | 'reject') {
  const dir = fs.mkdtempSync(path.join(TMP, 'av-stop-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const preload = path.join(dir, 'crash.mjs')
  fs.writeFileSync(
    preload,
    crash === 'reject'
      ? "process.on('SIGUSR2', () => { Promise.reject(new Error('a test crash')) })\n"
      : "process.on('SIGUSR2', () => { setImmediate(() => { throw new Error('a test crash') }) })\n",
  )
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, path.join(ROOT, 'src/server.ts')], {
    cwd: ROOT,
    env: {
      ...process.env,
      ALEX_DATA_DIR: path.join(dir, 'data'),
      CONTROL_SOCKET: '',
      CONTROL_PORT: '8788', // left over in .env from before: warned about, and nothing more
      PORT: '0',
      HOST: '127.0.0.1',
      ELEVENLABS_API_KEY: '',
      ELEVENLABS_VOICE_ID: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGKILL'))
  let log = ''
  child.stdout.on('data', c => (log += c))
  child.stderr.on('data', c => (log += c))
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  // The whole start-up banner, up to its last line (the control socket's health check): on macOS a pipe delivers
  // what the service writes in separate chunks, so its first line can be read before the rest.
  const banner = /Alex is listening\.[\s\S]*curl --unix-socket .*\/health/
  const listening = async () => {
    for (let i = 0; i < 300 && !banner.test(log); i++) await new Promise(r => setTimeout(r, 50))
    assert.match(log, banner)
  }
  return { child, exited, listening, log: () => log, dir }
}

test('SIGTERM stops the service in order, and it exits 0', { timeout: 30_000 }, async t => {
  const s = service(t)
  await s.listening()
  assert.match(s.log(), /CONTROL_PORT does nothing now/)
  assert.equal(s.log().match(/CONTROL_PORT does nothing now/g)?.length, 1, 'said once')
  assert.match(s.log(), /curl --unix-socket .*control\.sock http:\/\/localhost\/health/)
  s.child.kill('SIGTERM')
  assert.equal(await s.exited, 0)
  assert.match(s.log(), /\[stop\] SIGTERM: ending 0 meeting session\(s\), and asking any other bot still in a call to leave/)
})

test('SIGHUP (closing the Terminal that runs npm start) stops the service in order too', { timeout: 30_000 }, async t => {
  const s = service(t)
  await s.listening()
  s.child.kill('SIGHUP')
  assert.equal(await s.exited, 0)
  assert.match(s.log(), /\[stop\] SIGHUP: ending 0 meeting session\(s\), and asking any other bot still in a call to leave/)
})

for (const crash of ['throw', 'reject'] as const) {
  test(`a crash (${crash === 'throw' ? 'an uncaught exception' : 'an unhandled rejection'}) stops the service as SIGTERM does, then exits non-zero`, { timeout: 30_000 }, async t => {
    const s = service(t, crash)
    await s.listening()
    s.child.kill('SIGUSR2')
    assert.equal(await s.exited, 1)
    assert.match(s.log(), /\[crash\] .*a test crash/)
    assert.match(s.log(), /\[stop\] a crash \((uncaught exception|unhandled rejection)\): ending 0 meeting session\(s\)/)
  })
}
