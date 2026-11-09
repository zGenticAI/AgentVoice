import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ttsError, ttsUrl, wholeSamples } from '../src/pipeline/tts.ts'

test('ElevenLabs zero retention is asked for only when the account has it (it is enterprise only)', () => {
  const plain = new URL(ttsUrl('voice 1', false))
  assert.equal(plain.pathname, '/v1/text-to-speech/voice%201/stream')
  assert.equal(plain.searchParams.get('output_format'), 'pcm_16000')
  assert.equal(plain.searchParams.has('enable_logging'), false)
  assert.equal(new URL(ttsUrl('voice', true)).searchParams.get('enable_logging'), 'false')
})

async function* chunks(...parts: number[][]) {
  for (const p of parts) yield Uint8Array.from(p)
}

test('TTS chunks are re-cut on 16-bit sample boundaries', async () => {
  const out: number[][] = []
  for await (const b of wholeSamples(chunks([1, 2, 3], [4, 5], [6]))) out.push([...b])
  assert.deepEqual(out, [[1, 2], [3, 4], [5, 6]])
  assert.ok(out.every(c => c.length % 2 === 0))
})

test('a failed ElevenLabs request is logged with its status and short code only, never the text it quotes back', () => {
  const quoting = '{"detail":{"status":"text_too_long","message":"Text \'Bob said the Acme deal is off\' is too long"}}'
  assert.equal(ttsError(400, quoting), 'ElevenLabs 400 (text_too_long)')
  assert.equal(ttsError(401, '{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}'), 'ElevenLabs 401 (invalid_api_key)')
  assert.equal(ttsError(500, 'Internal error: Bob said the Acme deal is off'), 'ElevenLabs 500', 'not JSON: nothing of it')
  assert.equal(ttsError(422, '{"detail":{"status":"Bob said the Acme deal is off"}}'), 'ElevenLabs 422', 'a code is one word')
  assert.equal(ttsError(429, '{"detail":[{"msg":"x"}]}'), 'ElevenLabs 429')
})
