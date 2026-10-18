// 入口一致性：执行真实适配器，文件读写仅发生在隔离夹具。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { apply } from '../src/plugin.js'
import { run } from '../src/cli.js'
import { inspectPatches } from '../src/patch/service.js'
import { PATCHES } from '../src/patch/index.js'
import { writeDisabled } from '../src/patch/patch-selection.js'
import { applyPatches } from '../src/patch/transaction.js'
import { hashText } from '../src/patch/fsx.js'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-entrypoints-'))
  const home = path.join(dir, 'home')
  const root = path.join(dir, 'host')
  fs.mkdirSync(root, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const commands = new Map()
  const tools = new Map()
  let handler
  const ctx = {
    on() {},
    get() { return undefined },
    systemPrompt: { section() {} },
    inject(names, callback) {
      if (names.includes('commands')) callback({ commands: { register(value) { commands.set(value.name, value) } } })
      if (names.includes('tools')) callback({ tools: { register(value) { tools.set(value.name, value) } } })
      if (names.includes('webServer')) callback({
        effect(fn) { fn() },
        webServer: { register(route) { handler = route.handler; return () => {} } },
      })
    },
  }
  apply(ctx, { hostRoot: root })
  return { home, root, commands, tools, handler }
}

async function request(handler, method, route, body = {}) {
  const req = new EventEmitter()
  Object.assign(req, {
    method,
    url: `/breaklimit${route}`,
    headers: { host: 'localhost:3082', origin: 'http://localhost:3082' },
  })
  let status
  let payload
  const res = {
    writeHead(value) { status = value },
    end(value) { payload = JSON.parse(value) },
  }
  const pending = handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await pending
  return { status, payload }
}

function cli(args, env) {
  const original = process.stdout.write
  let text = ''
  process.stdout.write = (value) => { text += value; return true }
  try { return { code: run(args, env), text } }
  finally { process.stdout.write = original }
}

test('CLI、HTTP、宿主命令和模型工具读取同一份选择并应用', async (t) => {
  const { home, root, commands, tools, handler } = fixture(t)
  for (const patch of PATCHES) {
    const response = await request(handler, 'POST', '/patches/enabled', { id: patch.id, enabled: false })
    assert.equal(response.status, 200)
  }
  const expected = inspectPatches({ root, home }).preflight
  assert.equal(expected.ok, true)
  assert.deepEqual(expected.findings, [])
  const status = await request(handler, 'GET', '/status')
  assert.deepEqual(status.payload.data.preflight, expected)
  assert.equal(status.payload.data.http.mounted, true)
  const env = { DSH_HOME: home }
  assert.equal(cli(['--host-root', root, '--status'], env).code, 0)
  assert.match(commands.get('breaklimit').handler({ rawInput: 'status' }).text, /待写入 0/)
  assert.match(tools.get('breaklimit_status').execute({}, {}), /待写入 0/)
  assert.equal((await request(handler, 'POST', '/apply')).payload.ok, true)
  assert.equal(commands.get('breaklimit').handler({ rawInput: 'apply' }).kind, 'success')
  assert.match(tools.get('breaklimit_apply').execute({}, {}), /已|无需|没有/)
  assert.equal(cli(['--host-root', root, '--apply'], env).code, 0)
  assert.deepEqual(fs.readdirSync(root), [])
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
})

test('CLI 回退依据事务记录，不受之后禁用全部补丁影响', (t) => {
  const { home, root } = fixture(t)
  const before = 'const LIMIT = 1\n'
  const target = 'example.js'
  fs.writeFileSync(path.join(root, target), before)
  const result = applyPatches({
    root, home,
    patches: [{ id: 'fixture', kind: 'replace', title: 'Fixture', targets: [
      { path: target, before: 'LIMIT = 1', after: 'LIMIT = 2', expectHits: 1 },
    ] }],
    hashes: { fixture: { [target]: hashText(before) } },
  })
  assert.equal(result.ok, true)
  writeDisabled(home, PATCHES.map(patch => patch.id))
  const reverted = cli(['--host-root', root, '--revert'], { DSH_HOME: home })
  assert.equal(reverted.code, 0)
  assert.equal(fs.readFileSync(path.join(root, target), 'utf8'), before)
})
