// 规则存储的恢复与互斥（#4 激活意图、#5 外部改动保护、#6 规则操作锁 + 清单版本），
// 以及同落点换规则时首次接管原文的快照不被覆盖。
//
// 这些用例都只测一件事：失败之后磁盘上还剩什么。断言因此全部落在文件内容、清单字段
// 与返回的结构化错误上，不测内部写法。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  activateRule,
  deactivateRule,
  ensureInitialState,
  landingPath,
  readActive,
  readIndex,
  ruleTextPath,
  rulesIndexPath,
  saveRule,
  targetPath,
} from '../src/context/rules.js'
import { acquireFileLock, lockFilePath, releaseFileLock } from '../src/patch/lock.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-rules-recovery-'))
}

function seedTarget(home, target, text) {
  fs.writeFileSync(targetPath(home, target), text, 'utf8')
}

function readIndexFile(home) {
  return JSON.parse(fs.readFileSync(rulesIndexPath(home), 'utf8'))
}

/** 让下一次针对 rules.json 的改名失败，模拟清单写不进去。 */
function failIndexRenameOnce(home) {
  const original = fs.renameSync
  const index = rulesIndexPath(home)
  fs.renameSync = (from, to) => {
    if (to === index) throw new Error('模拟清单改名失败')
    return original(from, to)
  }
  return () => { fs.renameSync = original }
}

test('清单写失败：激活报错、落点未被改写、快照被回收，不留下半个激活', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  const before = readIndexFile(home)

  const restore = failIndexRenameOnce(home)
  let result
  try {
    result = activateRule(home, 'alpha')
  } finally {
    restore()
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'index_write_failed')
  assert.equal(typeof result.reason, 'string')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(readActive(home), null)
  assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), false)
  const after = readIndexFile(home)
  assert.equal(after.active, null)
  assert.equal(after.revision, before.revision)
  assert.equal(fs.existsSync(lockFilePath(home)), false)
})

test('外部改动保护：保存跳过同步，取消激活保留记录与快照', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)

  seedTarget(home, 'AGENTS.md', 'USER_EXTERNAL')

  const saved = saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' })
  assert.equal(saved.ok, true)
  assert.equal(saved.landingStale, true)
  assert.equal(saved.landingSynced, false)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'USER_EXTERNAL')
  assert.equal(fs.readFileSync(ruleTextPath(home, 'alpha'), 'utf8'), 'A body v2')

  const off = deactivateRule(home)
  assert.equal(off.ok, true)
  assert.equal(off.skipped.length, 1)
  assert.equal(off.kept, true)
  assert.equal(readActive(home), 'alpha')
  assert.notEqual(readIndex(home).landing, null)
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'USER_EXTERNAL')
})

test('互斥：锁被占用时保存被拒绝，清单与正文都不动', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  const before = fs.readFileSync(rulesIndexPath(home), 'utf8')

  const holder = acquireFileLock(home, 'recovery-holder')
  assert.equal(holder.conflict, undefined)
  let result
  try {
    result = saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' })
  } finally {
    releaseFileLock(holder)
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'locked')
  assert.equal(fs.readFileSync(rulesIndexPath(home), 'utf8'), before)
  assert.equal(fs.readFileSync(ruleTextPath(home, 'alpha'), 'utf8'), 'A body')
})

test('版本冲突：清单在读写之间被外部改写则不覆盖', () => {
  const home = tempHome()
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  const before = readIndexFile(home)
  const external = {
    ...before,
    revision: 99,
    rules: [...before.rules, { id: 'external', name: '外部', target: 'AGENTS.md', activatedAt: null }],
  }

  // 清单临时文件落盘、还没改名的那一瞬间，外部把它换掉：CAS 必须看见这个改动。
  const originalWrite = fs.writeFileSync
  fs.writeFileSync = (file, data, ...rest) => {
    const written = originalWrite(file, data, ...rest)
    if (String(file).includes('.rules.json.bkl-')) {
      originalWrite(rulesIndexPath(home), `${JSON.stringify(external, null, 2)}\n`, 'utf8')
    }
    return written
  }
  let result
  try {
    result = saveRule(home, 'alpha', 'A body v2', { target: 'AGENTS.md' })
  } finally {
    fs.writeFileSync = originalWrite
  }

  assert.equal(result.ok, false)
  assert.equal(result.code, 'conflict')
  const after = readIndexFile(home)
  assert.equal(after.revision, 99)
  assert.equal(after.rules.some(rule => rule.id === 'external'), true)
})

test('同落点换规则：落点被手改过时不覆盖首次接管时的快照', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)

  // 用户手改落点：此时快照是 alpha 激活前的原文，落点是用户内容。
  seedTarget(home, 'AGENTS.md', 'USER_EXTERNAL')

  const switched = activateRule(home, 'beta')
  assert.equal(switched.ok, true)
  assert.equal(switched.snapshotKept, true)
  assert.equal(switched.previousLanding.skipped.length, 1)
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'B body')
  assert.equal(readActive(home), 'beta')
})

test('同落点手改后取消激活：落点保持手改内容，快照仍在', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(activateRule(home, 'alpha').ok, true)
  seedTarget(home, 'AGENTS.md', 'USER_EXTERNAL')

  const off = deactivateRule(home)
  assert.equal(off.ok, true)
  assert.equal(off.skipped.length, 1)
  assert.equal(off.restored, false)
  assert.equal(off.kept, true)
  assert.equal(readActive(home), 'alpha')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'USER_EXTERNAL')
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original text')
})

test('正常切换（未手改落点）：写新快照，snapshotKept 为 false', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'original text')
  assert.equal(saveRule(home, 'alpha', 'A body', { target: 'AGENTS.md' }).ok, true)
  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)
  const first = activateRule(home, 'alpha')
  assert.equal(first.ok, true)
  assert.equal(first.snapshotKept, false)

  const switched = activateRule(home, 'beta')
  assert.equal(switched.ok, true)
  assert.equal(switched.snapshotKept, false)
  assert.equal(switched.previousLanding.restored, true)
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'B body')

  const off = deactivateRule(home)
  assert.equal(off.restored, true)
  assert.equal(fs.readFileSync(targetPath(home, 'AGENTS.md'), 'utf8'), 'original text')
  assert.equal(fs.existsSync(landingPath(home, 'AGENTS.md')), false)
})

test('首轮导入：原文留在 bodies/default.md，切换规则只可能丢干净快照', () => {
  const home = tempHome()
  seedTarget(home, 'AGENTS.md', 'existing instructions')
  const imported = ensureInitialState(home)
  assert.equal(imported.imported, 'default')
  assert.equal(fs.readFileSync(ruleTextPath(home, 'default'), 'utf8'), 'existing instructions')

  assert.equal(saveRule(home, 'beta', 'B body', { target: 'AGENTS.md' }).ok, true)
  seedTarget(home, 'AGENTS.md', 'USER_EXTERNAL')
  const switched = activateRule(home, 'beta')
  assert.equal(switched.ok, true)
  assert.equal(switched.snapshotKept, true)
  assert.equal(fs.readFileSync(ruleTextPath(home, 'default'), 'utf8'), 'existing instructions')
  assert.equal(fs.readFileSync(landingPath(home, 'AGENTS.md'), 'utf8'), 'existing instructions')
})
