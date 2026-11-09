import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spokenThinking } from '../src/brain/brain.ts'

test('spoken turns think as little as the model allows: adaptive on Opus, between tools elsewhere', () => {
  assert.deepEqual(spokenThinking('claude-opus-5-5'), { type: 'adaptive' })
  assert.deepEqual(spokenThinking('claude-sonnet-5-5'), { type: 'between_tools' })
})
