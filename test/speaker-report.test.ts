// npm run speaker-report: the probe's files pooled by platform, read and never changed, and only the probe's own files.
import { type TestContext, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT } from '../src/config.ts'
import type { Platform } from '../src/recall.ts'
import { SpeakerProbe, gridConfigs, gridKey } from '../src/speakers/probe.ts'
import { ENOUGH_TURNS, formatReport, pool, poolPlatform, readProbeFiles } from '../src/speakers/report.ts'

const T0 = Date.UTC(2026, 10, 15, 10, 0, 0)

function tempDir(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-report-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** Writes one meeting's file: `turns` turns by Probe Alpha, each starting with "Alpha", speech_on `lagMs` after the first word. */
function meetingFile(dir: string, stem: string, platform: Platform, turns: number, lagMs: number): string {
  const probe = new SpeakerProbe({ platform, botName: "Alex (Sam's AI assistant)", dir })
  const alpha = (kind: 'join' | 'speech_on' | 'speech_off', rx: number) =>
    probe.event(
      { kind, pid: 1, name: 'Probe Alpha', isHost: false, platform: 'desktop', extra: { key: 'none', stableId: false }, emailPresent: false, at: T0 + rx - 150, rel: rx / 1000, botId: 'b' },
      T0 + rx,
    )
  probe.connected(false)
  alpha('join', 0)
  probe.pageConnected(T0 - 500)
  for (let i = 0; i < turns; i++) {
    const fw = 10_000 + i * 8000
    alpha('speech_on', fw + lagMs)
    alpha('speech_off', fw + 2500)
    probe.turnStarted(T0 + fw + 200)
    probe.turnEnded({ rx: T0 + fw + 2600, first: T0 + fw, last: T0 + fw + 2000, words: 8, wordTimes: false, codeword: 0 })
  }
  const file = probe.write({ stem, startedAt: new Date(T0), endedAt: new Date(T0 + 20 * 60_000), ending: 'ended' })
  assert.ok(file)
  return file
}

test("the report pools each platform's meetings: timings, the roster and the bot, and the settings once there is enough to go on", t => {
  const dir = tempDir(t)
  meetingFile(dir, 'zoom-1', 'zoom', 25, 300)
  meetingFile(dir, 'zoom-2', 'zoom', 20, 500)
  meetingFile(dir, 'meet-1', 'google_meet', 10, 400)
  const { files, skipped } = readProbeFiles(dir)
  assert.equal(files.length, 3)
  assert.equal(skipped, 0)
  const pooled = pool(files)
  assert.deepEqual(Object.keys(pooled).sort(), ['google_meet', 'zoom'])
  const zoom = pooled.zoom!
  assert.equal(zoom.meetings, 2)
  assert.equal(zoom.minutes, 40)
  assert.equal(zoom.scored.turns, 45)
  assert.equal(zoom.scored.normal, 45)
  assert.equal(zoom.timings.on_minus_fw_rx_ms.n, 45)
  assert.equal(zoom.timings.on_minus_fw_rx_ms.p10, 300)
  assert.equal(zoom.timings.on_minus_fw_rx_ms.p90, 500)
  assert.deepEqual(zoom.on_minus_fw_rx_median_per_meeting, { min: 300, max: 500 })
  assert.equal(zoom.timings.delay_speech_on_ms.p50, 150)
  assert.equal(zoom.participants.total, 2)
  assert.equal(zoom.endpoint.meetings_without_events, 0)
  assert.equal(zoom.enough, zoom.scored.normal >= ENOUGH_TURNS)
  assert.ok(zoom.settings.length > 0)
  assert.ok(zoom.settings.every(s => s.precision >= 0.98))
  for (let i = 1; i < zoom.settings.length; i++) assert.ok(zoom.settings[i - 1].coverage >= zoom.settings[i].coverage)
  assert.equal(pooled.google_meet!.enough, false)

  const text = formatReport(pooled, { dir, files: files.length, skipped })
  assert.match(text, /^Speaker probe: 3 meeting file\(s\) in /)
  assert.match(text, /\nZoom: 2 meeting\(s\), 40 minutes/)
  assert.match(text, /Settings right at least 98% of the time \(end of turn, normal turns\), by coverage:\n {4}\(clock\|before ms/)
  assert.match(text, /\nGoogle Meet: 1 meeting\(s\)[\s\S]*Settings: not enough data \(10 scored normal turns; 40 needed\)\./)
  assert.doesNotMatch(text, /Probe|Alpha/)
})

test("only the probe's own files are read: not links, folders, other kinds or versions, nor what isn't JSON", t => {
  const dir = tempDir(t)
  const real = meetingFile(dir, 'zoom-1', 'zoom', 3, 300)
  const outside = path.join(tempDir(t), 'elsewhere.json')
  fs.copyFileSync(real, outside)
  fs.symlinkSync(outside, path.join(dir, 'link.json'))
  fs.mkdirSync(path.join(dir, 'folder.json'))
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"kind":"speaker-probe",')
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ kind: 'something-else', v: 1, platform: 'zoom' }))
  fs.writeFileSync(path.join(dir, 'v2.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(real, 'utf8')), v: 2 }))
  fs.writeFileSync(path.join(dir, 'webex.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(real, 'utf8')), platform: 'webex' }))
  fs.writeFileSync(path.join(dir, 'zoom-2.json.next'), fs.readFileSync(real))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
  const { files, skipped } = readProbeFiles(dir)
  assert.equal(files.length, 1)
  assert.equal(skipped, 6)
  assert.deepEqual(readProbeFiles(path.join(dir, 'missing')), { files: [], skipped: 0 })
  assert.match(formatReport(pool([]), { dir, files: 0, skipped: 0 }), /Nothing measured yet/)
})

test('npm run speaker-report reads the data folder and changes nothing in it; --json gives the pooled numbers', { timeout: 30_000 }, async t => {
  const data = tempDir(t)
  const dir = path.join(data, 'speaker-probe')
  fs.mkdirSync(dir, { mode: 0o700 })
  meetingFile(dir, 'zoom-1', 'zoom', 5, 300)
  fs.writeFileSync(path.join(dir, 'junk.json'), 'nope')
  const before = fs.readdirSync(dir).map(name => [name, fs.statSync(path.join(dir, name)).mtimeMs])
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>(resolve => {
      const child = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), [path.join(ROOT, 'src/cli/speaker-report.ts'), ...args], {
        env: { ...process.env, ALEX_DATA_DIR: data },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = ''
      child.stdout.on('data', c => (out += c))
      child.stderr.on('data', c => (out += c))
      child.on('close', code => resolve({ code, out }))
    })
  const text = await run([])
  assert.equal(text.code, 0, text.out)
  assert.match(text.out, /Speaker probe: 1 meeting file\(s\) in .*speaker-probe \(1 skipped: not the probe's\)\./)
  assert.match(text.out, /Zoom: 1 meeting\(s\), 20 minutes/)
  const json = await run(['--json'])
  assert.equal(json.code, 0, json.out)
  const parsed = JSON.parse(json.out)
  assert.deepEqual([parsed.files, parsed.skipped, parsed.platforms.zoom.scored.turns], [1, 1, 5])
  const wrong = await run(['--platform', 'zoom'])
  assert.equal(wrong.code, 1)
  assert.match(wrong.out, /Unknown option --platform\.\nUsage: npm run speaker-report \[-- --json\]/)
  assert.deepEqual(
    fs.readdirSync(dir).map(name => [name, fs.statSync(path.join(dir, name)).mtimeMs]),
    before,
  )
})

test('settings are listed only when right at least 98% of the time, most coverage first and then the smaller tolerances, from 40 scored normal turns', () => {
  const [a, b, c, d] = [
    { clock: 'rx', startTol: 400, endTol: 300, minShare: 0.4, ratio: 2 },
    { clock: 'rx', startTol: 800, endTol: 600, minShare: 0.25, ratio: 1.5 },
    { clock: 'rx', startTol: 200, endTol: 150, minShare: 0.4, ratio: 2 },
    { clock: 'abs_adj', startTol: 200, endTol: 150, minShare: 0.4, ratio: 2 },
  ] as const
  const grid = (turns: number) => {
    const cells: Record<string, number[]> = {}
    for (const cfg of gridConfigs()) cells[gridKey(cfg, 'eot', 'normal')] = [0, 0, turns]
    cells[gridKey(a, 'eot', 'normal')] = [turns - 5, 0, 5]
    cells[gridKey(b, 'eot', 'normal')] = [turns - 2, 2, 0]
    cells[gridKey(c, 'eot', 'normal')] = [turns - 10, 0, 10]
    cells[gridKey(d, 'eot', 'normal')] = [turns - 5, 0, 5]
    return cells
  }
  const file = (turns: number) => ({ kind: 'speaker-probe', v: 1, platform: 'zoom', scored: { turns, unmapped: 0, grid: grid(turns) } })
  const p = poolPlatform([file(50)])
  assert.equal(p.scored.normal, 50)
  assert.equal(p.enough, true)
  assert.deepEqual(
    p.settings.map(s => s.setting),
    ['abs_adj|200|150|0.4|2', 'rx|400|300|0.4|2', 'rx|200|150|0.4|2'],
    '96% right is left out; on a tie, the smaller tolerances',
  )
  assert.deepEqual([p.settings[1].coverage, p.settings[1].precision], [0.9, 1])
  assert.equal(poolPlatform([file(ENOUGH_TURNS - 1)]).enough, false)
  assert.equal(poolPlatform([file(ENOUGH_TURNS)]).enough, true)
})
