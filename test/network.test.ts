import assert from 'node:assert/strict'
import type http from 'node:http'
import { test } from 'node:test'
import * as network from '../src/network.ts'
import { hasLocalToken, sameSecret } from '../src/network.ts'

function req(remoteAddress: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as http.IncomingMessage
}

test('forwarding headers make no difference to anything', () => {
  // A proxy can add these or not: nothing decides who is local from them.
  const forwarded = req('8.8.8.8', { 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '127.0.0.1', 'x-forwarded-host': 'localhost' })
  assert.ok(!hasLocalToken(forwarded, 'a'.repeat(64)), 'a forwarded loopback address does not stand in for the local token')
})

test('the control side checks no Host: no browser can reach its Unix socket, so DNS rebinding has nothing to reach', () => {
  assert.equal('isControlHost' in network, false)
})

test('the local token goes as a bearer token, and nothing else passes', () => {
  const token = 'a'.repeat(64)
  assert.ok(hasLocalToken(req('127.0.0.1', { authorization: `Bearer ${token}` }), token))
  assert.ok(hasLocalToken(req('127.0.0.1', { authorization: `bearer ${token}` }), token))
  assert.ok(!hasLocalToken(req('127.0.0.1', { authorization: `Bearer ${'b'.repeat(64)}` }), token))
  assert.ok(!hasLocalToken(req('127.0.0.1', { authorization: `Bearer ${token.slice(1)}` }), token))
  assert.ok(!hasLocalToken(req('127.0.0.1', { authorization: token }), token))
  assert.ok(!hasLocalToken(req('127.0.0.1'), token))
  assert.ok(!hasLocalToken(req('127.0.0.1', { authorization: 'Bearer ' }), ''), 'no token set: nothing passes')
})

test('secrets are compared whole', () => {
  assert.ok(sameSecret('abc', 'abc'))
  assert.ok(!sameSecret('abc', 'abd'))
  assert.ok(!sameSecret('abc', 'abcd'))
})
