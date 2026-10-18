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

// ---------------------------------------------------------------- 声明方向
//
// 夹具自证的另一种形态：把一条声明的 before 与 after 对调，整套测试仍然全绿。
// 原因是别处的夹具大多由声明本身派生——声明怎么写，夹具跟着怎么造，方向永远对得上。
//
// 这里给每条 replace 补丁配一条**方向规则**。规则不读声明里的字面原文，只读这条补丁
// 想达成的事：把哪个上限放大了、解除了哪个冻结、去掉了哪个禁止式。方向反了，规则拒绝。
//
// 它证明不了「这段原文真的在宿主文件里」——那要拿宿主副本对账，属于
// tools/check-fixture.mjs 与 `npm run check:host` 那一层。两层各说各的话。

const MODES = ['recommended', 'unrestricted']

/** 取 `name: 8192` 形式的取值。 */
function fieldNumber(text, name) {
  const match = new RegExp(`${name}:\\s*(\\d+)`).exec(text)
  return match === null ? null : Number(match[1])
}

/** 取 `= 2000`、`= 50 * 1024` 这类数值表达式的值；不是纯数字表达式就返回 null。 */
function assignedValue(text) {
  const tail = text.slice(text.lastIndexOf('=') + 1).trim()
  if (/^[\d\s*]+$/.test(tail) === false) return null
  return tail.split('*').reduce((product, part) => product * Number(part.trim()), 1)
}

/** 每条补丁的方向：改后必须比改前更宽，不能更窄。 */
const DIRECTIONS = {
  'output.trim': (target) => {
    const before = fieldNumber(target.before, 'thresholdChars')
    return MODES
      .map(mode => fieldNumber(resolvedAfter(target, mode), 'thresholdChars'))
      .every(after => before !== null && after !== null && after > before)
  },
  'read.limits': (target) => {
    const before = assignedValue(target.before)
    return MODES
      .map(mode => assignedValue(resolvedAfter(target, mode)))
      .every(after => before !== null && after !== null && after > before)
  },
  'minimal.unfreeze': target => /true\s*$/.test(target.before) && /false\s*$/.test(target.after),
  'web.framing': (target) => {
    const prohibition = /untrusted|never/i
    return prohibition.test(target.before)
      && MODES.every(mode => prohibition.test(resolvedAfter(target, mode)) === false)
  },
  'workspace.authority': (target) => {
    const advisory = /may be relevant|do not override/i
    return advisory.test(target.before)
      && MODES.every((mode) => {
        const after = resolvedAfter(target, mode)
        return /take precedence/i.test(after) && advisory.test(after) === false
      })
  },
}

test('每条 replace 声明的方向由独立判据守着', () => {
  for (const patch of PATCHES) {
    assert.equal(
      typeof DIRECTIONS[patch.id],
      'function',
      `${patch.id} 没有方向规则：新增补丁必须说明它把什么往哪个方向改`,
    )
    for (const target of patch.targets) {
      assert.equal(DIRECTIONS[patch.id](target), true, `${patch.id} 的声明方向不对：${target.path}`)
    }
  }
})

test('方向判据拒绝对调后的声明（负向对照）', () => {
  for (const patch of PATCHES) {
    const swapped = patch.targets.map(target => ({
      ...target,
      before: target.after,
      after: target.before,
      afterByMode: undefined,
    }))
    const accepted = swapped.filter(target => DIRECTIONS[patch.id](target) === true)
    assert.equal(
      accepted.length,
      0,
      `${patch.id} 对调 before/after 之后仍被判为正确方向，这条判据等于没写`,
    )
  }
})
