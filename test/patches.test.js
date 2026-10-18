// 补丁清单测试。
//
// 清单是给人看的，所以这里守的是「别把话漏了」：每条声明都要有中英说明、
// 统计数字必须与声明一致、过长的原文必须真的被截断。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXCERPT_LIMIT, PATCHES, PATCH_HUMAN, describePatches, patchesForMode, resolvedAfter,
} from '../src/patch/index.js'

test('清单统计与声明一致（推荐模式）', () => {
  const active = patchesForMode('recommended')
  const list = describePatches()
  assert.equal(list.mode, 'recommended')
  assert.equal(list.total, active.length)
  assert.equal(list.replacing + list.verifying, list.total)
  assert.equal(list.replacing, active.filter(item => item.kind === 'replace').length)
  assert.equal(list.verifying, active.filter(item => item.kind === 'verify').length)
  assert.equal(list.targetEntries, active.reduce((sum, item) => sum + item.targets.length, 0))

  const paths = new Set()
  for (const patch of active) {
    for (const target of patch.targets) paths.add(target.path)
  }
  assert.equal(list.files, paths.size)
})

test('完全解放模式多出只在它存在的补丁', () => {
  const recommended = describePatches([], 'recommended')
  const unrestricted = describePatches([], 'unrestricted')
  assert.equal(unrestricted.mode, 'unrestricted')
  assert.equal(unrestricted.total, PATCHES.length)
  assert.ok(unrestricted.total > recommended.total)
  assert.equal(unrestricted.patches.some(item => item.id === 'minimal.unfreeze'), true)
  assert.equal(recommended.patches.some(item => item.id === 'minimal.unfreeze'), false)
})

test('同一条补丁在不同模式里取不同的改后文本', () => {
  const patch = PATCHES.find(item => item.id === 'output.trim')
  const target = patch.targets[0]
  const rec = resolvedAfter(target, 'recommended')
  const unr = resolvedAfter(target, 'unrestricted')
  assert.match(rec, /thresholdChars: 262144/)
  assert.match(unr, /thresholdChars: 9007199254740991/)
})

test('human 表与声明一一对应，不多不少', () => {
  assert.deepEqual(Object.keys(PATCH_HUMAN).sort(), PATCHES.map(item => item.id).sort())
})

test('每条都有中英说明，且各自不同', () => {
  const seen = new Set()
  for (const patch of describePatches([], 'unrestricted').patches) {
    assert.ok(patch.human.zh.trim().length > 10, `${patch.id} 缺中文说明`)
    assert.ok(patch.human.en.trim().length > 10, `${patch.id} 缺英文说明`)
    assert.equal(seen.has(patch.human.zh), false, `${patch.id} 与前面的条目重复用了同一段说明`)
    seen.add(patch.human.zh)
  }
})

test('每条都有中英标题与技术依据，英文段不含中文', () => {
  // 注入到界面的英文段落里混进全角标点或汉字，是这一版真实修过的缺陷，这里守住。
  const cjk = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/
  for (const patch of describePatches().patches) {
    assert.ok(patch.titles.zh.trim().length > 0, `${patch.id} 缺中文标题`)
    assert.ok(patch.titles.en.trim().length > 0, `${patch.id} 缺英文标题`)
    assert.ok(patch.notes.zh.trim().length > 10, `${patch.id} 缺中文技术依据`)
    assert.ok(patch.notes.en.trim().length > 10, `${patch.id} 缺英文技术依据`)
    assert.equal(cjk.test(patch.titles.en), false, `${patch.id} 的英文标题混进了中文或全角标点`)
    assert.equal(cjk.test(patch.notes.en), false, `${patch.id} 的英文技术依据混进了中文或全角标点`)
    assert.notEqual(patch.titles.en, patch.titles.zh, `${patch.id} 的英文标题与中文原样相同`)
  }
})

test('清单顺序与声明一致，id 不重复', () => {
  const list = describePatches([], 'unrestricted')
  assert.deepEqual(list.patches.map(item => item.id), PATCHES.map(item => item.id))
  assert.equal(new Set(list.patches.map(item => item.id)).size, list.patches.length)
})

test('过长的原文被截断，且确实发生过截断', () => {
  let truncated = 0
  for (const patch of describePatches().patches) {
    for (const target of patch.targets) {
      for (const text of [target.before, target.after]) {
        if (text === null) continue
        assert.ok(text.length <= EXCERPT_LIMIT + 1, `${patch.id} 的摘要超长`)
        if (text.length === EXCERPT_LIMIT + 1) {
          assert.ok(text.endsWith('…'), `${patch.id} 的截断没有省略号`)
          truncated += 1
        }
      }
    }
  }
  assert.ok(truncated > 0, '一条都没被截断，说明上限设得比所有原文都长')
})

test('每条都有改后文本', () => {
  for (const mode of ['recommended', 'unrestricted']) {
    for (const patch of describePatches([], mode).patches) {
      for (const target of patch.targets) {
        assert.equal(target.replaces, true, `${patch.id} 不是改写型`)
        assert.equal(typeof target.after, 'string', patch.id)
        assert.equal(typeof target.before, 'string', patch.id)
      }
    }
  }
})

test('未传禁用集时全部为启用', () => {
  const list = describePatches()
  assert.equal(list.enabledCount, list.total)
  assert.equal(list.disabledCount, 0)
  assert.equal(list.patches.every(patch => patch.enabled === true), true)
})

test('禁用集只改 enabled 与计数，不动声明的固有统计', () => {
  const base = describePatches()
  const list = describePatches(['output.trim', 'web.framing'])
  assert.equal(list.enabledCount, list.total - 2)
  assert.equal(list.disabledCount, 2)
  assert.equal(list.patches.find(patch => patch.id === 'output.trim').enabled, false)
  assert.equal(list.patches.find(patch => patch.id === 'read.limits').enabled, true)
  // 「涉及几个文件、几条改写」是声明的属性，不会因为关掉某条就变小。
  assert.equal(list.replacing, base.replacing)
  assert.equal(list.verifying, base.verifying)
  assert.equal(list.targetEntries, base.targetEntries)
  assert.equal(list.files, base.files)
})

test('禁用集里的未知 id 不会把启用数算少', () => {
  const list = describePatches(['P-99', null, 7])
  assert.equal(list.enabledCount, list.total)
  assert.equal(list.disabledCount, 0)
})
