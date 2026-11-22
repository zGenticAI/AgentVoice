// The node and the bin that agentvoice setup and agentvoice service install write down (src/setup/node-path.ts): by
// absolute paths that outlast an upgrade of Node where they can, Homebrew's above all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PACKAGE_NAME } from '../src/home.ts'
import { agentvoiceCommand, stableNodePath } from '../src/setup/node-path.ts'

const TMP = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir()

/** A Homebrew-shaped prefix: <p>/Cellar/<formula>/<version>/bin/node, and <p>/opt/<formula> linking to one version. */
function brew(t: { after: (fn: () => unknown) => void }, formula: string, versions: string[], optTo: string | null) {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'av-brew-')))
  t.after(() => fs.rmSync(prefix, { recursive: true, force: true }))
  for (const version of versions) {
    fs.mkdirSync(path.join(prefix, 'Cellar', formula, version, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(prefix, 'Cellar', formula, version, 'bin/node'), '#!/bin/sh\n', { mode: 0o755 })
  }
  fs.mkdirSync(path.join(prefix, 'opt'))
  if (optTo) fs.symlinkSync(`../Cellar/${formula}/${optTo}`, path.join(prefix, 'opt', formula))
  return { prefix, cellar: (version: string) => path.join(prefix, 'Cellar', formula, version, 'bin/node'), opt: path.join(prefix, 'opt', formula, 'bin/node') }
}

test("Homebrew's Node is written as the formula's opt link, which brew upgrade keeps, when it leads to the same node", t => {
  for (const formula of ['node', 'node@24']) {
    const b = brew(t, formula, ['24.22.1'], '24.22.1')
    assert.equal(stableNodePath(b.cellar('24.22.1')), b.opt, formula)
  }
})

test("an opt link that leads to another version, or none, leaves Node's own path", t => {
  const other = brew(t, 'node', ['24.21.0', '24.22.1'], '24.21.0')
  assert.equal(stableNodePath(other.cellar('24.22.1')), other.cellar('24.22.1'), 'opt names another version')
  const none = brew(t, 'node', ['24.22.1'], null)
  assert.equal(stableNodePath(none.cellar('24.22.1')), none.cellar('24.22.1'), 'no opt link')
  // Not Homebrew's shape: a Cellar folder somewhere else in the path.
  const odd = brew(t, 'node', ['24.22.1'], '24.22.1')
  const deeper = path.join(odd.prefix, 'Cellar/node/24.22.1/bin/node/extra')
  assert.equal(stableNodePath(deeper), deeper)
})

test("nvm's, fnm's and Volta's folders, and a system Node, are written as they are", () => {
  for (const node of [
    '/home/sam/.nvm/versions/node/v24.22.1/bin/node',
    '/home/sam/.local/share/fnm/node-versions/v24.22.1/installation/bin/node',
    '/home/sam/.volta/tools/image/node/24.22.1/bin/node',
    '/usr/bin/node',
    '/usr/local/bin/node',
  ]) {
    assert.equal(stableNodePath(node), node)
  }
})

test("agentvoiceCommand is [node, the package's bin/agentvoice.js], by the package folder's real path", t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'av-cmd-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pkg = path.join(dir, 'lib/node_modules', PACKAGE_NAME)
  fs.mkdirSync(pkg, { recursive: true })
  fs.symlinkSync(path.join(dir, 'lib'), path.join(dir, 'lib-link'))
  assert.deepEqual(agentvoiceCommand('/usr/bin/node', path.join(dir, 'lib-link/node_modules', PACKAGE_NAME)), ['/usr/bin/node', path.join(pkg, 'bin/agentvoice.js')])
  const [node, bin] = agentvoiceCommand()
  assert.equal(node, stableNodePath(process.execPath))
  assert.equal(path.basename(bin), 'agentvoice.js')
})
