// 规则索引损坏（corrupt）防护与恢复测试：全写入口拒写保护原件，并验证恢复流程。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import * as rules from '../src/context/rules.js'
import { createHandler } from '../src/serve/http.js'

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-corrupt-test-'))
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return home
}

function writeCorruptIndex(home, content = '{ bad json syntax') {
  const file = rules.rulesIndexPath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return file
}

async function request(handler, method, route, body = {}, headers = {}) {
  const req = new EventEmitter()
  Object.assign(req, {
    method,
    url: `/breaklimit${route}`,
    headers: { host: 'localhost:3082', origin: 'http://localhost:3082', ...headers },
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

test('rules.readIndex 对坏 JSON 与未知版本返回 kind=corrupt', (t) => {
  const home = tempHome(t)
  writeCorruptIndex(home, '{ not valid json')
  assert.equal(rules.readIndex(home).kind, 'corrupt')

  writeCorruptIndex(home, JSON.stringify({ version: 9999, revision: 1, rules: [] }))
  assert.equal(rules.readIndex(home).kind, 'corrupt')
})

test('索引损坏时，五个写入口全量拒绝，保持 rules.json 字节未变且不写正文', (t) => {
  const home = tempHome(t)
  const corruptContent = '{ bad json content that should never be overwritten }'
  const file = writeCorruptIndex(home, corruptContent)

  // 1. saveRule
  const saveRes = rules.saveRule(home, 'test-rule', 'some body', { name: 'Test', target: 'AGENTS.md' })
  assert.equal(saveRes.ok, false)
  assert.equal(saveRes.code, 'index_corrupt')
  assert.equal(fs.readFileSync(file, 'utf8'), corruptContent)
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'bodies', 'test-rule.md')), false)

  // 2. activateRule
  const actRes = rules.activateRule(home, 'test-rule')
  assert.equal(actRes.ok, false)
  assert.equal(actRes.code, 'index_corrupt')
  assert.equal(fs.readFileSync(file, 'utf8'), corruptContent)

  // 3. deactivateRule
  const deactRes = rules.deactivateRule(home)
  assert.equal(deactRes.ok, false)
  assert.equal(deactRes.code, 'index_corrupt')
  assert.equal(fs.readFileSync(file, 'utf8'), corruptContent)

  // 4. deleteRule
  const delRes = rules.deleteRule(home, 'test-rule')
  assert.equal(delRes.ok, false)
  assert.equal(delRes.code, 'index_corrupt')
  assert.equal(fs.readFileSync(file, 'utf8'), corruptContent)

  // 5. resetRules
  const resetRes = rules.resetRules(home)
  assert.equal(resetRes.ok, false)
  assert.equal(resetRes.code, 'index_corrupt')
  assert.equal(fs.readFileSync(file, 'utf8'), corruptContent)
})

test('ensureInitialState 在索引损坏时跳过自动导入，绝不覆写 rules.json', (t) => {
  const home = tempHome(t)
  const corruptContent = '{ corrupt json on startup }'
  const file = writeCorruptIndex(home, corruptContent)
  // 宿主存在已有的 AGENTS.md
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# Existing Host Instructions\n', 'utf8')

  const res = rules.ensureInitialState(home)
  assert.equal(res.active, null)
  assert.equal(res.imported, null)
  assert.equal(res.corrupt, true)
  // 确保 rules.json 没被覆写为包含 default 的空清单
  assert.equal(fs.readFileSync(file, 'utf8'), corruptContent)
})

test('recoverCorruptIndex 备份损坏清单至 $DSH_HOME/dsh-breaklimit-backup 并写空清单', (t) => {
  const home = tempHome(t)
  const corruptContent = '{ corrupt json to be backed up }'
  const file = writeCorruptIndex(home, corruptContent)
  const originalSize = Buffer.byteLength(corruptContent, 'utf8')

  // 保留现有的正文文件
  const bodiesDir = path.join(home, 'breaklimit', 'bodies')
  fs.mkdirSync(bodiesDir, { recursive: true })
  fs.writeFileSync(path.join(bodiesDir, 'keep-me.md'), 'important body content', 'utf8')

  const res = rules.recoverCorruptIndex(home)
  assert.equal(res.ok, true)
  assert.equal(res.rulesIndex, 'ok')
  assert.equal(res.backupBytes, originalSize)
  assert.ok(typeof res.backupPath === 'string' && res.backupPath.includes('dsh-breaklimit-backup'))
  assert.ok(fs.existsSync(res.backupPath))
  assert.equal(fs.readFileSync(res.backupPath, 'utf8'), corruptContent)

  // 原 rules.json 已变为合法的 version: 2 空清单
  const newIndex = rules.readIndex(home)
  assert.equal(newIndex.kind, 'ok')
  assert.equal(newIndex.version, 2)
  assert.deepEqual(newIndex.rules, [])

  // 正文文件完好无损
  assert.equal(fs.readFileSync(path.join(bodiesDir, 'keep-me.md'), 'utf8'), 'important body content')

  // 正常索引下再次调用 recover 应该被拒绝
  const secondRes = rules.recoverCorruptIndex(home)
  assert.equal(secondRes.ok, false)
  assert.equal(secondRes.code, 'index_not_corrupt')
})

test('HTTP 接口：损坏时写操作返回 409 index_corrupt，recover 路由成功恢复', async (t) => {
  const home = tempHome(t)
  writeCorruptIndex(home, '{ corrupt json for http }')
  const handler = createHandler({ get() { return undefined } }, {}, { enabled: true, counters: {} })

  // GET /rules/status 应该返回 rulesIndex = corrupt，且清单路径可定位
  const statusRes = await request(handler, 'GET', '/rules/status')
  assert.equal(statusRes.status, 200)
  assert.equal(statusRes.payload.data.rulesIndex, 'corrupt')
  assert.equal(statusRes.payload.data.rulesIndexPath, 'breaklimit/rules.json')

  // POST /rules/save 应该返回 409 index_corrupt
  const saveRes = await request(handler, 'POST', '/rules/save', { id: 'sample', text: 'body', name: 'Sample' })
  assert.equal(saveRes.status, 409)
  assert.equal(saveRes.payload.code, 'index_corrupt')

  // POST /rules/activate 应该返回 409 index_corrupt
  const actRes = await request(handler, 'POST', '/rules/activate', { id: 'sample' })
  assert.equal(actRes.status, 409)
  assert.equal(actRes.payload.code, 'index_corrupt')

  // POST /rules/delete 应该返回 409 index_corrupt
  const delRes = await request(handler, 'POST', '/rules/delete', { id: 'sample' })
  assert.equal(delRes.status, 409)
  assert.equal(delRes.payload.code, 'index_corrupt')

  // POST /rules/recover-corrupt 应该成功恢复
  const recRes = await request(handler, 'POST', '/rules/recover-corrupt', {})
  assert.equal(recRes.status, 200)
  assert.equal(recRes.payload.code, 'recovered')
  assert.equal(recRes.payload.data.rulesIndex, 'ok')
  // 备份路径必须能直接拿去磁盘上找：保留 dsh-breaklimit-backup/<时间戳>/rules.json
  // 三个层级，只把 $DSH_HOME 换成相对路径，不能折成 `…/rules.json`。
  const backupPath = recRes.payload.data.backupPath
  assert.match(backupPath, /^dsh-breaklimit-backup\/\d{14}\/rules\.json$/u)
  assert.equal(fs.existsSync(path.join(home, backupPath)), true)

  // 恢复后再读状态，rulesIndex 变成 ok
  const newStatus = await request(handler, 'GET', '/rules/status')
  assert.equal(newStatus.payload.data.rulesIndex, 'ok')
})
