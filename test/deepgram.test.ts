import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keyterms } from '../src/config.ts'
import { fluxUrl } from '../src/pipeline/deepgram.ts'

test("the assistant's name and the owner's are always keyterms (and the company, when set), plus any extra ones from .env", () => {
  assert.deepEqual(keyterms(''), ['Alex', 'Sam'])
  assert.deepEqual(keyterms(' Recall.ai , ,Kubernetes,alex, Cloudflare Tunnel '), ['Alex', 'Sam', 'Recall.ai', 'Kubernetes', 'Cloudflare Tunnel'])
  const warned: string[] = []
  assert.equal(keyterms(Array.from({ length: 150 }, (_, i) => `term${i}`).join(','), m => warned.push(m)).length, 100)
  assert.equal(warned.length, 1)
  assert.match(warned[0], /Left out: term98, term99, /)
})

test("keyterms stay within Deepgram's token limit, so a long list can't refuse the whole stream", () => {
  const warned: string[] = []
  const phrases = Array.from({ length: 100 }, (_, i) => `the quarterly planning review number ${i}`) // 6 words each
  const kept = keyterms(phrases.join(','), m => warned.push(m))
  const tokens = kept.reduce((n, t) => n + Math.max(2, Math.ceil(t.split(/\s+/).length * 1.3)), 0)
  assert.ok(tokens <= 500, `${tokens} tokens`)
  assert.deepEqual(kept.slice(0, 2), ['Alex', 'Sam'], 'the name always comes first, then the owner')
  assert.ok(kept.length < 102)
  assert.equal(warned.length, 1)
  assert.deepEqual(keyterms('Sam, Recall.ai', m => warned.push(m)), ['Alex', 'Sam', 'Recall.ai'])
  assert.equal(warned.length, 1, 'no warning when everything fits')
})

test('each keyterm is its own query parameter on the Flux address', () => {
  const url = new URL(fluxUrl({ keyterms: ['Alex', 'Acme', 'Cloudflare Tunnel'] }))
  assert.equal(url.pathname, '/v2/listen')
  assert.equal(url.searchParams.get('model'), 'flux-general-en')
  assert.deepEqual(url.searchParams.getAll('keyterm'), ['Alex', 'Acme', 'Cloudflare Tunnel'])
  assert.match(url.search, /keyterm=Alex&keyterm=Acme&keyterm=Cloudflare\+Tunnel/)
})

test('the Flux stream opts out of Deepgram keeping meeting audio for model improvement', () => {
  assert.equal(new URL(fluxUrl({ keyterms: [] })).searchParams.get('mip_opt_out'), 'true')
})
