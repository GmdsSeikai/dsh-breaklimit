// 诊断类操作的纯函数部分：预检、升级核对、提示词差异、规则导入。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { diffPrompt, formatUpgrade, importRule, ruleIdFromPath, upgradeReport } from '../src/host/inspect.js'
import { formatGuard as fmt, inspectTarget } from '../src/host/guard.js'

function tempDir(prefix = 'bkl-inspect-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('预检统计文件数与字节数，并判定是否在工作区内', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), '0123456789')
  const report = inspectTarget({ target: dir, cwd: dir })
  assert.equal(report.ok, true)
  assert.equal(report.isDir, true)
  assert.equal(report.files, 2)
  assert.equal(report.bytes, 15)
  assert.equal(report.inside, true)
  assert.equal(report.gitRepo, false, '临时目录不是 git 仓库')
  assert.equal(report.dirty, null)
})

test('预检报告写清规模与工作区位置', () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x')
  const text = fmt(inspectTarget({ target: dir, cwd: dir }))
  assert.match(text, /目录/u)
  assert.match(text, /1 个文件/u)
  assert.match(text, /在内/u)
})

test('路径不可读时返回失败而不是抛错', () => {
  const report = inspectTarget({ target: path.join(tempDir(), 'nope'), cwd: tempDir() })
  assert.equal(report.ok, false)
  assert.match(report.reason, /不可读/u)
  assert.match(fmt(report), /预检失败/u)
})

test('升级核对：原文还在就通过，不在就指出位置', () => {
  const root = tempDir()
  fs.mkdirSync(path.join(root, 'a'), { recursive: true })
  fs.writeFileSync(path.join(root, 'a', 'keep.txt'), 'const LIMIT = 1\n')
  fs.writeFileSync(path.join(root, 'a', 'moved.txt'), 'something else entirely\n')
  const patches = [
    { id: 'ok', targets: [{ path: 'a/keep.txt', before: 'const LIMIT = 1' }] },
    { id: 'gone', targets: [{ path: 'a/moved.txt', before: 'const LIMIT = 2' }] },
    { id: 'absent', targets: [{ path: 'a/missing.txt', before: 'x' }] },
  ]
  const report = upgradeReport(root, patches)
  assert.equal(report.checked, 3)
  assert.equal(report.ok, false)
  assert.deepEqual(report.missing.map(item => item.id).sort(), ['absent', 'gone'])
  assert.match(formatUpgrade(report), /失配 2 个/u)
})

test('提示词差异只数非空行，并给出新增与删除', () => {
  const diff = diffPrompt('alpha\nbeta\n', 'alpha\ngamma\n')
  assert.deepEqual(diff.added, ['beta'])
  assert.deepEqual(diff.removed, ['gamma'])
  assert.equal(diff.currentLines, 3)
})

test('规则 id 从文件名推导，非法字符被收敛', () => {
  assert.equal(ruleIdFromPath('/x/My Rules.md'), 'my-rules')
  assert.equal(ruleIdFromPath('/x/中文.md'), 'imported')
})

test('导入规则：写入成功，空文件与非 md 之外的情况分别报错', () => {
  const home = tempDir()
  const source = path.join(tempDir(), 'imported-rule.md')
  fs.writeFileSync(source, '# Rule\n\nbody text\n')
  const ok = importRule(home, source)
  assert.equal(ok.ok, true)
  assert.equal(ok.id, 'imported-rule')
  assert.ok(ok.bytes > 0)

  const empty = path.join(tempDir(), 'empty.md')
  fs.writeFileSync(empty, '   \n')
  assert.equal(importRule(home, empty).ok, false)

  assert.equal(importRule(home, path.join(home, 'nope.md')).ok, false)
})
