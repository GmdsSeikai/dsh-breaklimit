// 补丁选择状态测试。
//
// 这里守的是「坏配置不许把补丁全关掉」：配置缺失、损坏、字段类型不对、出现未知
// id，四种情况都必须退回安全的一侧。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SELECTION_VERSION, knownPatchIds, readDisabled, resolvePatches, selectionPath, setPatchEnabled, writeDisabled,
} from '../src/patch/patch-selection.js'
import { PATCHES, patchesForMode } from '../src/patch/index.js'

const RECOMMENDED = patchesForMode('recommended')

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-selection-'))
}

function seed(home, content) {
  fs.mkdirSync(path.dirname(selectionPath(home)), { recursive: true })
  fs.writeFileSync(selectionPath(home), content, 'utf8')
}

test('配置缺失时全部启用', () => {
  const home = tempHome()
  const result = readDisabled(home)
  assert.equal(result.kind, 'default')
  assert.deepEqual(result.disabled, [])
  assert.equal(resolvePatches(home).length, RECOMMENDED.length)
})

test('读写往返，且结果总是排序去重', () => {
  const home = tempHome()
  writeDisabled(home, ['web.framing', 'output.trim', 'web.framing'])
  const result = readDisabled(home)
  assert.equal(result.kind, 'ok')
  assert.deepEqual(result.disabled, ['output.trim', 'web.framing'])
  assert.equal(resolvePatches(home).length, RECOMMENDED.length - 2)
})

test('JSON 损坏时退回全部启用', () => {
  const home = tempHome()
  seed(home, '{ this is not json')
  assert.equal(readDisabled(home).kind, 'corrupt')
  assert.deepEqual(readDisabled(home).disabled, [])
  assert.equal(resolvePatches(home).length, RECOMMENDED.length)
})

test('disabled 不是数组时退回全部启用', () => {
  const home = tempHome()
  seed(home, JSON.stringify({ disabled: 'output.trim' }))
  assert.equal(readDisabled(home).kind, 'corrupt')
  assert.deepEqual(readDisabled(home).disabled, [])
})

test('未知 id 与非字符串被丢掉，写回时也不留', () => {
  const home = tempHome()
  seed(home, JSON.stringify({ disabled: ['output.trim', 'P-99', 42, null] }))
  assert.deepEqual(readDisabled(home).disabled, ['output.trim'])
  assert.deepEqual(writeDisabled(home, ['P-99', 'read.limits', 7]).disabled, ['read.limits'])
})

test('全部禁用时返回空集', () => {
  const home = tempHome()
  writeDisabled(home, knownPatchIds())
  assert.equal(resolvePatches(home).length, 0)
})

test('resolvePatches 保持声明顺序', () => {
  const home = tempHome()
  writeDisabled(home, ['output.trim', 'web.framing'])
  const ids = resolvePatches(home).map(patch => patch.id)
  assert.deepEqual(ids, RECOMMENDED.map(patch => patch.id).filter(id => id !== 'output.trim' && id !== 'web.framing'))
})

test('完全解放模式包含只在它存在的补丁', () => {
  const home = tempHome()
  const ids = resolvePatches(home, 'unrestricted').map(patch => patch.id)
  assert.equal(ids.length, PATCHES.length)
  assert.equal(ids.includes('minimal.unfreeze'), true)
  assert.equal(resolvePatches(home, 'recommended').map(patch => patch.id).includes('minimal.unfreeze'), false)
})

test('resolvePatches 按模式给出对应的改后文本', () => {
  const home = tempHome()
  const patch = resolvePatches(home, 'unrestricted').find(item => item.id === 'output.trim')
  assert.match(patch.targets[0].after, /9007199254740991/u)
  const rec = resolvePatches(home, 'recommended').find(item => item.id === 'output.trim')
  assert.match(rec.targets[0].after, /262144/u)
})

test('setPatchEnabled 幂等，并拒绝未知 id', () => {
  const home = tempHome()
  setPatchEnabled(home, 'read.limits', false)
  assert.deepEqual(readDisabled(home).disabled, ['read.limits'])
  setPatchEnabled(home, 'read.limits', false)
  assert.deepEqual(readDisabled(home).disabled, ['read.limits'])
  setPatchEnabled(home, 'read.limits', true)
  assert.deepEqual(readDisabled(home).disabled, [])
  assert.throws(() => setPatchEnabled(home, 'P-99', false), /Unknown patch id/u)
})

test('写出的配置带当前版本号', () => {
  const home = tempHome()
  writeDisabled(home, ['read.limits'])
  const raw = JSON.parse(fs.readFileSync(selectionPath(home), 'utf8'))
  assert.equal(raw.version, SELECTION_VERSION)
  assert.equal(readDisabled(home).kind, 'ok')
})

test('没有版本字段的旧配置按当前版本接受', () => {
  const home = tempHome()
  seed(home, JSON.stringify({ disabled: ['output.trim'] }))
  const result = readDisabled(home)
  assert.equal(result.kind, 'ok')
  assert.deepEqual(result.disabled, ['output.trim'])
})

test('版本不符时退回全部启用，并报 version_mismatch', () => {
  const home = tempHome()
  seed(home, JSON.stringify({ version: SELECTION_VERSION + 1, disabled: ['output.trim'] }))
  const result = readDisabled(home)
  assert.equal(result.kind, 'version_mismatch')
  assert.deepEqual(result.disabled, [])
  assert.equal(resolvePatches(home).length, RECOMMENDED.length)
})
