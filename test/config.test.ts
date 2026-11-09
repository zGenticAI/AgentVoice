import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { ROOT, pathSetting, publicUrlProblem } from '../src/config.ts'

test('a path from .env may start with "~" for the home folder, as the advice for a long data path suggests', () => {
  assert.equal(pathSetting('~/.agent-voice/control.sock', '/home/sam'), '/home/sam/.agent-voice/control.sock')
  assert.equal(pathSetting('~', '/home/sam'), '/home/sam')
  assert.equal(pathSetting('/var/run/alex.sock', '/home/sam'), '/var/run/alex.sock')
  assert.equal(pathSetting('data/control.sock', '/home/sam'), path.join(ROOT, 'data/control.sock'), 'relative to the repo')
  assert.equal(pathSetting('~sam/x', '/home/sam'), path.join(ROOT, '~sam/x'), 'only "~" or "~/" means home')
})

test("PUBLIC_URL has to be the tunnel's https address: anything else would leave a silent bot in the meeting", () => {
  assert.equal(publicUrlProblem('https://assistant.example.com'), '')
  assert.equal(publicUrlProblem('https://assistant.example.com:8443'), '')
  assert.match(publicUrlProblem(''), /^PUBLIC_URL is not set\. Set it in \.env to your tunnel's https address/)
  assert.match(publicUrlProblem('assistant.example.com'), /which is not an address/)
  assert.match(publicUrlProblem('http://assistant.example.com'), /has to be your tunnel's https address/)
  for (const local of ['https://localhost', 'https://localhost:8787', 'https://127.0.0.1:8787', 'https://0.0.0.0', 'https://[::1]:8787', 'https://alex.localhost', 'https://localhost.', 'https://[::ffff:127.0.0.1]']) {
    assert.match(publicUrlProblem(local), /this computer's own address/, local)
  }
  // The bot is on the internet: a private network's address passes a curl from that network, but never reaches the bot.
  for (const lan of ['https://10.0.0.5', 'https://192.168.1.10', 'https://172.16.0.1', 'https://172.31.255.1', 'https://169.254.1.1', 'https://100.64.0.1', 'https://100.127.0.1', 'https://mymac.local', 'https://host.internal', 'https://box.lan', 'https://nas.home.arpa', 'https://[fd00::1]', 'https://[fe80::1]']) {
    assert.match(publicUrlProblem(lan), /an address on a private network/, lan)
  }
  for (const pub of ['https://172.32.0.1', 'https://100.128.0.1', 'https://8.8.8.8', 'https://[2001:db8::1]', 'https://Assistant.Example.com', 'https://assistant.example.com/']) {
    assert.equal(publicUrlProblem(pub), '', pub)
  }
  // The page is <address>/agent: anything after the address would lose it.
  for (const extra of ['https://assistant.example.com/agent', 'https://assistant.example.com?x=1', 'https://assistant.example.com#f', 'https://user:pass@assistant.example.com']) {
    assert.match(publicUrlProblem(extra), /give only your tunnel's address/, extra)
  }
})
