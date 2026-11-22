// What the speaker probe measured, pooled by platform: npm run speaker-report [-- --json]
// Reads data/speaker-probe/*.json and changes nothing. docs/speaker-probe.md says how to read it. To clear the
// measurements: rm -r data/speaker-probe
import { WORDS } from '../commands.ts'
import { formatReport, pool, readProbeFiles } from '../speakers/report.ts'
import { PROBE_DIR } from '../transcript.ts'

const args = process.argv.slice(2)
const unknown = args.filter(arg => arg !== '--json')
if (unknown.length) {
  console.error(`Unknown option ${unknown[0]}.\nUsage: ${WORDS.run('speaker-report')} ${WORDS.optional('--json')}`)
  process.exit(1)
}
const { files, skipped } = readProbeFiles(PROBE_DIR)
const pooled = pool(files)
if (args.includes('--json')) console.log(JSON.stringify({ files: files.length, skipped, platforms: pooled }, null, 2))
else console.log(formatReport(pooled, { dir: PROBE_DIR, files: files.length, skipped }))
