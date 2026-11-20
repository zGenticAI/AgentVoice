// A prepared deck written into a decks folder as prepare writes it (0700/0600, a manifest with each image's hash), with
// images encoded here, one colour per slide, and a script for it: for the tests that join a meeting with slides.
import fs from 'node:fs'
import path from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { sha256 } from '../../../src/slides/deck.ts'
import type { Manifest } from '../../../src/slides/manifest.ts'

const COLOURS = ['#3366aa', '#aa3366', '#66aa33', '#aaaa33', '#33aaaa', '#aa6633', '#6633aa', '#336633']

/** A 1280x720 WebP of one colour. */
export function slideImage(colour: string): Buffer {
  const canvas = createCanvas(1280, 720)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, 1280, 720)
  return canvas.encodeSync('webp', 90)
}

export const DECK_ID = 'q4-plan-abcdef'

/** The slides' titles and text, by page. */
export const PAGES = [
  { title: 'Welcome', text: 'Welcome\nThe Q4 plan' },
  { title: 'Pricing', text: 'Pricing\nTeam: twelve dollars\nBusiness: twenty-nine dollars' },
  { title: 'Customers', text: 'Customers\nA confidential list' },
  { title: 'Security', text: 'Security\nCertifications' },
  { title: 'Next steps', text: 'Next steps\nShip in March' },
]

/**
 * The script for the deck: page 3 excluded (never in the meeting), page 4 a backup slide. With comments, as the owner's
 * file has them: the CLI and the channel strip them before sending.
 */
export const SCRIPT = `---
deck: ${DECK_ID}
title: Q4 plan
minutes: 10
---

<!-- Notes for me only: never say the discount. -->

## 1 · Welcome

Hello everyone. This is the plan for the quarter.

## 2 · Pricing

Team is twelve dollars a month. Business is twenty-nine. That covers pricing.

## 3 · Customers
exclude: yes

## 4 · Security
on-request: yes

Here are the security details.

## 5 · Next steps

We ship in March. Thank you.
`

/** Writes the deck into decksDir (made if needed). Returns its folder and manifest. */
export function writeDeck(decksDir: string, opts: { id?: string; images?: Buffer[] } = {}): { dir: string; manifest: Manifest; images: Buffer[] } {
  const id = opts.id ?? DECK_ID
  fs.mkdirSync(decksDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(decksDir, 0o700)
  const dir = path.join(decksDir, id)
  fs.mkdirSync(dir, { mode: 0o700 })
  const images = opts.images ?? PAGES.map((_, i) => slideImage(COLOURS[i % COLOURS.length]))
  const slides = PAGES.map((page, i) => {
    const n = i + 1
    const file = `${String(n).padStart(3, '0')}.webp`
    fs.writeFileSync(path.join(dir, file), images[i], { mode: 0o600 })
    return { n, title: page.title, pageLabel: null, text: page.text, file, bytes: images[i].length, sha256: sha256(images[i]), textHash: sha256(page.text), warnings: [] }
  })
  const manifest: Manifest = { format: 1, id, label: 'q4-plan', created: '2026-11-19T10:00:00Z', pages: PAGES.length, excluded: 0, script: null, slides }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 })
  return { dir, manifest, images }
}
