// npm run slides -- prepare's parent side, alone in a process of its own, for the tests that stop it with a signal
// (test/slides-convert.test.ts). It runs prepareDeck on the PDF with the fake child (which reads its plan from $HOME).
import { prepareDeck } from '../../../src/slides/convert.ts'

const [input, decksDir, childScript] = process.argv.slice(2)
await prepareDeck({ input, decksDir, childScript, timeoutMs: 60_000 }).catch(() => process.exit(2))
