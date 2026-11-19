// A slide's title, read from pdf.js's text items (src/slides/page-text.ts titleOf): the first line of the page's
// largest words, joined as the page text joins them. The item sequences are the ones pdf.js gives for real decks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { type TextItem, titleOf } from '../src/slides/page-text.ts'

const item = (str: string, px: number, more: Partial<TextItem> = {}): TextItem => ({ str, px, hasEOL: false, sep: '', ...more })

test('the space between runs is kept: pdf.js gives it as an item of its own at each change of font, or as a gap', () => {
  // 'Revenue ' + bold 'grew' + ' 40%': before, "Revenuegrew40%".
  assert.equal(titleOf([item('Revenue', 44), item(' ', 44), item('grew', 44), item(' ', 44), item(' ', 44), item('40%', 44), item('', 18, { hasEOL: true }), item('Body', 18)]), 'Revenue grew 40%')
  assert.equal(titleOf([item('Café', 44), item(' ', 30), item('日本', 44), item(' ', 30), item('launch', 44)]), 'Café 日本 launch', 'a space item of another size still parts the words')
  assert.equal(titleOf([item('Gap', 40), item('title', 40, { sep: ' ' })]), 'Gap title', 'two words drawn apart, with no space between')
  assert.equal(titleOf([item(' ', 44), item('Plain title here', 44)]), 'Plain title here', 'a space before the title adds nothing')
  assert.equal(titleOf([item('First line', 44, { hasEOL: true }), item('Second line', 44)]), 'First line', 'the end of a line ends the title')
  assert.equal(titleOf([item('First', 44), item('Second', 44, { sep: '\n' })]), 'First', 'and so does a run lower down')
})

test('a title is words or figures: never a bullet, a quote mark, an icon glyph or a page number in a large font', () => {
  assert.equal(titleOf([item('“', 120), item('Quotations are commonly printed', 40)]), 'Quotations are commonly printed')
  assert.equal(titleOf([item('\u{92400}\u{92400}', 60), item('and many more...', 30)]), 'and many more...')
  assert.equal(titleOf([item('⊡', 60), item('Here you have a list of items', 42)]), 'Here you have a list of items')
  assert.equal(titleOf([item('27', 80), item('Transition', 40)]), 'Transition')
  assert.equal(titleOf([item('89,526,124', 60), item('$', 60)]), '89,526,124$', 'a figure is a title, and a sign at its size joins it')
  assert.equal(titleOf([item('Q4', 60)]), 'Q4')
  assert.equal(titleOf([item('•', 40), item(' ', 40)]), '', 'nothing but glyphs: no title')
})
