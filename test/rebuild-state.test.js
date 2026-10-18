// 状态清单重建的判据与链路测试。
//
// 场景是真实发生过的那一个：宿主上躺着本方写入的内容，应用记录连同快照一起没了。
// 旧实现只认事务目录里的快照，于是这种树两头堵死——重建不出记录，apply 被
// 「整文件预哈希不符」整批阻断，revert 因为没有记录直接报未应用。
//
// 断言对齐的是契约，不是当前产出：
//   盘上 = 原文 + 本方声明      →  采纳，原文来源记为 git HEAD
//   盘上多一处改动              →  拒绝，理由指向「还含有其他改动」
//   声明哈希不认这份原文        →  拒绝
//   哈希表采自另一棵树          →  git 来源拒绝，快照来源照采纳（快照自带证明）
//   重建之后                    →  预检认成 applied，apply 不再写盘，revert 还能还原

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { hashText, readTextOrNull } from '../src/patch/fsx.js'
import { createLock } from '../src/patch/lock.js'
import { preflight } from '../src/patch/preflight.js'
import { readState } from '../src/patch/state.js'
import { applyPatches, revertPatches } from '../src/patch/transaction.js'
import { replaceVariantsByPath } from '../src/patch/index.js'
import { judgeAdoption, rebuildState } from '../tools/rebuild-state.mjs'

const PATCH_ID = 'T-01'
const ORIGINAL = 'VALUE = 2000\n'
const PATCHED = 'VALUE = 20000\n'
const HEAD_COMMIT = 'abc123'

function patchSet() {
  return [{
    id: PATCH_ID,
    title: '测试补丁',
    kind: 'replace',
    targets: [{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }],
  }]
}

function hashTable() {
  return { [PATCH_ID]: { 'a.txt': hashText(ORIGINAL) } }
}

/** 一份各项都成立的输入，用例只改需要打歪的那一项。 */
function verdict(overrides = {}) {
  return judgeAdoption({
    head: ORIGINAL,
    current: PATCHED,
    snapshot: null,
    declaredHash: hashText(ORIGINAL),
    headCommit: HEAD_COMMIT,
    manifestCommit: HEAD_COMMIT,
    variants: replaceVariantsByPath(patchSet()).get('a.txt') ?? [],
    ...overrides,
  })
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-rebuild-'))
}

function write(root, rel, content) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

test('无快照时，盘上内容等于原文加本方声明即采纳，来源记为 git HEAD', () => {
  const adopted = verdict()

  assert.equal(adopted.accepted, true)
  assert.equal(adopted.source, 'head')
  assert.equal(adopted.before, hashText(ORIGINAL))
  assert.equal(adopted.after, hashText(PATCHED))
  // 记录里的 before 就是回退时要写进宿主的字节，必须是声明的那一版原文。
  assert.equal(adopted.snapshot, ORIGINAL)
})

test('盘上内容含声明之外的改动时拒绝采纳', () => {
  const rejected = verdict({ current: `${PATCHED}EXTRA = 1\n` })

  assert.equal(rejected.accepted, false)
  assert.match(rejected.reason, /还含有其他改动/)
})

test('哈希表不认 HEAD 这份原文时拒绝采纳', () => {
  const rejected = verdict({ declaredHash: hashText('OTHER = 1\n') })

  assert.equal(rejected.accepted, false)
  assert.match(rejected.reason, /预哈希与 HEAD 内容不符/)
})

test('哈希表采自另一个提交时，git 来源拒绝采纳', () => {
  const rejected = verdict({ manifestCommit: 'deadbee' })

  assert.equal(rejected.accepted, false)
  assert.match(rejected.reason, /哈希表记录的是 commit deadbee/)
})

test('快照自身等于原文时照采纳，不受哈希表提交号影响', () => {
  // 快照就是应用前的原文，它的存在本身就是证据；commit 只是没有快照时的兜底判据。
  const adopted = verdict({ snapshot: { text: ORIGINAL, from: 'txn-1' }, manifestCommit: 'deadbee' })

  assert.equal(adopted.accepted, true)
  assert.equal(adopted.source, 'snapshot')
})

test('重建之后预检认成 applied，apply 不再写盘，revert 还原成原文', (t) => {
  if (!gitAvailable()) {
    t.skip('这台机器上没有可用的 git，重建链路无法端到端验证')
    return
  }

  const root = tempDir()
  const home = tempDir()
  write(root, 'a.txt', ORIGINAL)
  initRepo(root, ['a.txt'])

  // 宿主上已经是本方写入的内容，记录与快照都不在。
  write(root, 'a.txt', PATCHED)

  // 重建前的处境，就是界面报「11 处和补丁预期对不上」那一个：盘上明明是本方写的，
  // 没有记录就没法证明，预检整批阻断。
  const blocked = preflight({
    root,
    patches: patchSet(),
    readFile: readTextOrNull,
    hashes: hashTable(),
    appliedRecords: {},
    variantsByPath: replaceVariantsByPath(patchSet()),
  })
  assert.equal(blocked.ok, false, '没有记录时必须阻断，这是要修的那个症状')
  assert.match(blocked.blocked[0].reason, /整文件预哈希不符/)

  const result = rebuildState({
    hostRoot: root,
    home,
    patches: patchSet(),
    hashes: hashTable(),
    manifest: { dsh: { commit: headCommit(root) } },
  })

  assert.deepEqual(Object.keys(result.accepted), ['a.txt'])
  assert.equal(result.headCount, 1)
  assert.equal(result.snapshotCount, 0)

  const persisted = readState(home)
  assert.equal(persisted.kind, 'ok', '重建必须留下可读的清单')
  assert.equal(persisted.state.files['a.txt'].before, hashText(ORIGINAL))
  assert.equal(
    fs.readFileSync(path.join(persisted.state.transaction, 'files', 'a.txt'), 'utf8'),
    ORIGINAL,
    '快照必须是声明的那一版原文',
  )

  // 预检：重建前这里报「整文件预哈希不符」，重建后必须认成本方写入。
  const appliedRecords = {}
  for (const [file, record] of Object.entries(persisted.state.files)) {
    appliedRecords[file] = { before: record.before, after: record.after }
  }
  const check = preflight({
    root,
    patches: patchSet(),
    readFile: readTextOrNull,
    hashes: hashTable(),
    appliedRecords,
    variantsByPath: replaceVariantsByPath(patchSet()),
  })
  assert.equal(check.ok, true, '重建后预检不该再阻断')
  assert.equal(check.findings[0].state, 'applied')
  assert.equal(check.changes.size, 0, '已是目标状态，不该有待写入的文件')

  const again = applyPatches({ root, home, patches: patchSet(), lock: createLock(), hashes: hashTable() })
  assert.equal(again.code, 'already_applied')
  assert.deepEqual(again.written, [])
  assert.equal(read(root, 'a.txt'), PATCHED, 'apply 不得改动已验证的内容')

  const back = revertPatches({ root, home, lock: createLock() })
  assert.equal(back.code, 'reverted')
  assert.equal(read(root, 'a.txt'), ORIGINAL, '重建出来的记录必须让 revert 真的还原成原文')
})

function gitAvailable() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}

function initRepo(root, files) {
  git(root, ['init'])
  for (const file of files) git(root, ['add', file])
  git(root, ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base'])
}

function headCommit(root) {
  return git(root, ['rev-parse', 'HEAD']).trim()
}
