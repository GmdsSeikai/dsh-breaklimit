// 提示词装配里兜底段落的落点。
//
// 宿主的顺序是「按 order 排序 → 跑 system-prompt/assemble 瀑布 → 之后不再排序」，
// renderPrompt 直接按数组顺序拼接：
//   deepseek-harness/packages/core/system-prompt/src/index.ts:652  sections.sort(comparePromptSections)
//   deepseek-harness/packages/core/system-prompt/src/index.ts:677  waterfall('system-prompt/assemble', ...)
//   deepseek-harness/packages/core/system-prompt/src/index.ts:291  renderPrompt 按数组顺序 join
// 所以瀑布里插进来的段落没有第二次排序机会，声明的 order 只在宿主排序时生效，
// 插入位置只由下标决定。兜底分支曾经用 push，段落一路掉到 order=20000 的
// tools:sdk 之后；更早的一版还把它定成尾部 order - 1（8998），于是 persona 前缀段
// 缺失时整段注入（身份 + 正文）落在提示词末尾。
//
// 兜底要复现的是正常分支的位置语义：身份在最前。正常分支折进宿主 order 0 的
// deployment:persona-prefix；兜底段用 order 1，落在宿主身份段（-1000）之后、
// 其余各段之前。
//
// 驱动的假东西只有 ctx：registerSeams 本体、注入通道、档位读取都走真实代码。
// DSH_HOME 指向临时目录，不碰真实的 ~/.dsh。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { registerSeams } from '../src/host/seams.js'
import { buildStatus, formatStatusText } from '../src/host/status.js'

const TAIL_ORDER = 8999
const HEAD_FALLBACK_ORDER = 1
const INJECT_TEXT = 'INJECT-HEAD'

/** 假 ctx：只记录监听器，并吞掉段落注册。 */
function fakeCtx() {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(event, handler) {
        handlers.set(event, handler)
      },
      get() {
        return undefined
      },
      systemPrompt: { section() {} },
    },
  }
}

function fakeRuntime() {
  return {
    enabled: true,
    counters: {
      approval: 0,
      escalation: 0,
      escalationRejected: 0,
      toolGate: 0,
      editIntent: 0,
      assemble: 0,
      preStep: 0,
      hardenHits: 0,
      hardenMisses: 0,
    },
  }
}

/** 目录由本文件自己建，删除前确认前缀与位置，避免落到真实 home 上。 */
function removeTempDir(dir) {
  if (!dir.includes('bkl-seams-') || !dir.startsWith(os.tmpdir())) return
  fs.rmSync(dir, { recursive: true, force: true })
}

/** 在临时 DSH_HOME 里跑一次真实装配，返回装配结果。 */
async function assemble(sections) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-seams-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  // 注入文件写死，兜底段落的文本就不依赖包的 inject.md 是否为空。
  fs.writeFileSync(path.join(home, 'breaklimit-inject.md'), INJECT_TEXT, 'utf8')
  try {
    const { ctx, handlers } = fakeCtx()
    registerSeams(ctx, {}, fakeRuntime(), TAIL_ORDER)
    const handler = handlers.get('system-prompt/assemble')
    assert.equal(typeof handler, 'function', 'system-prompt/assemble 监听器未注册')
    const assembly = { sections, contexts: [], tools: [], variables: {} }
    return await handler(assembly, {}, async () => assembly)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    removeTempDir(home)
  }
}

const named = sections => sections.map(section => section.name)

const PERSONA_TEXT = 'You are a helpful software engineer assistant.'
const OBSERVED_INJECT = 'BREAKLIMIT-INJECTION-MARKER-0123456789'

/** 宿主的 renderPrompt：按数组顺序拼接非空段（system-prompt/src/index.ts:290-295）。 */
const renderedByHost = out => out.sections
  .map(section => section.text)
  .filter(text => text.length > 0)
  .join('\n\n')

/**
 * 真实装配 + 一次宿主落盘观测。
 *
 * `finalPrompt` 模拟宿主在瀑布之后的行为：存在 complete 段时整份 sections 被换成
 * 装配前抓到的快照（system-prompt/src/index.ts:653-686），没有时按数组顺序拼接。
 * 结果作为 `system/message` 正文喂给真实的 session/event 监听器，状态由真实的
 * buildStatus 产出，不手写字段。`finalPrompt` 为 null 时不发事件。
 */
async function assembleObserved(sections, finalPrompt) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-seams-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'breaklimit-inject.md'), OBSERVED_INJECT, 'utf8')
  try {
    const { ctx, handlers } = fakeCtx()
    const runtime = fakeRuntime()
    registerSeams(ctx, {}, runtime, TAIL_ORDER)
    const onAssemble = handlers.get('system-prompt/assemble')
    assert.equal(typeof onAssemble, 'function', 'system-prompt/assemble 监听器未注册')
    const assembly = { sections, contexts: [], tools: [], variables: {} }
    const out = await onAssemble(assembly, {}, async () => assembly)

    if (finalPrompt !== null) {
      const onSessionEvent = handlers.get('session/event')
      assert.equal(typeof onSessionEvent, 'function', 'session/event 监听器未注册')
      onSessionEvent({}, { type: 'system/message', data: { message: { content: [{ type: 'text', text: finalPrompt(out) }] } } })
    }

    return { out, runtime, status: buildStatus(ctx, {}, runtime) }
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    removeTempDir(home)
  }
}

test('无 persona 前缀段时，兜底段插在宿主身份段之后、其余段之前', async () => {
  // -1000 那段特意不叫 harness:identity：那个名字会被 stripHostIdentity 整段剔除，
  // 剔除之后兜底段就不在它后面了，断言也就测不到真实落点。
  const sections = [
    { name: 'deployment:preamble', order: -1000, text: 'preamble' },
    { name: 'breaklimit', order: TAIL_ORDER, text: 'tail' },
    { name: 'tools:core', order: 10000, text: 'tools core' },
    { name: 'tools:sdk', order: 20000, text: 'tools sdk' },
  ]
  const out = await assemble(sections)
  const ids = named(out.sections)

  const head = out.sections.find(section => section.name === 'breaklimit:head')
  assert.ok(head, `兜底段不应丢掉，实际顺序：${ids.join(' → ')}`)
  assert.equal(head.order, HEAD_FALLBACK_ORDER)
  assert.match(head.text, /INJECT-HEAD/u)

  // 下标断言：兜底段 order=1，插入点是「第一个 order 大于 1 的段」之前，
  // 于是落在 order=-1000 的段之后、尾部段与所有工具段之前——身份在最前。
  // 旧实现 push 到末尾，这里会得到下标 4，排在 tools:sdk(20000) 之后；
  // 定成尾部 order - 1（8998）时这里是下标 2，不再垫底但已到提示词末尾。
  const at = ids.indexOf('breaklimit:head')
  assert.equal(at, 1, `兜底段下标应为 1，实际 ${String(at)}：${ids.join(' → ')}`)
  assert.deepEqual(ids, ['deployment:preamble', 'breaklimit:head', 'breaklimit', 'tools:core', 'tools:sdk'])
  assert.ok(at > ids.indexOf('deployment:preamble'), '兜底段必须在 order=-1000 的段之后')
  assert.ok(at < ids.indexOf('breaklimit'), '兜底段必须在尾部段(8999)之前')
  assert.ok(at < ids.indexOf('tools:core'), '兜底段必须在 order=10000 的段之前')
  assert.ok(at < ids.indexOf('tools:sdk'), '兜底段必须在 order=20000 的段之前')
})

test('有 persona 前缀段时走正常分支，不产生兜底段', async () => {
  const sections = [
    { name: 'deployment:persona-prefix', order: 0, text: 'Persona.' },
    { name: 'tools:core', order: 10000, text: 'tools core' },
  ]
  const out = await assemble(sections)
  const ids = named(out.sections)

  assert.deepEqual(ids, ['deployment:persona-prefix', 'tools:core'])
  assert.equal(ids.includes('breaklimit:head'), false, `不应出现兜底段：${ids.join(' → ')}`)
  assert.match(out.sections[0].text, /^INJECT-HEAD/u, '注入文本应折进 persona 前缀段的最前面')
  assert.match(out.sections[0].text, /Persona\.$/u, '原 persona 文本应保留在后面')
})

test('兜底段插入后，原有段的相对顺序不变，传入数组不被改写', async () => {
  const sections = [
    { name: 'a', order: -1000, text: 'a' },
    { name: 'b', order: 100, text: 'b' },
    { name: 'breaklimit', order: TAIL_ORDER, text: 'tail' },
    { name: 'c', order: 15000, text: 'c' },
    { name: 'd', order: 20000, text: 'd' },
  ]
  const before = named(sections)
  const snapshot = sections.map(section => ({ ...section }))

  const out = await assemble(sections)
  const ids = named(out.sections)

  // 去掉兜底段之后，序列与输入逐项相同。
  assert.deepEqual(ids.filter(name => name !== 'breaklimit:head'), before)
  // 兜底段落 a(-1000) 之后、b(100) 与 breaklimit(8999) 之前。
  assert.equal(ids.indexOf('breaklimit:head'), 1, `实际顺序：${ids.join(' → ')}`)

  // 传入的数组本身没有被 push/splice，元素对象也没有被就地改。
  assert.equal(sections.length, snapshot.length)
  assert.deepEqual(sections.map(section => ({ ...section })), snapshot)
  assert.deepEqual(named(sections), before)
})

// ── 注入有效性 ──────────────────────────────────────────────────────────────
//
// 宿主在有 complete 段时，瀑布返回之后用装配前的快照替换整份 sections。注入文本
// 因此在推荐档 + minimal preset 下整体丢失，而装配结果本身看不出这一点。这里用
// 宿主落盘的 system/message 作为观测点：它的正文就是最终提示词。

test('非 complete 组合：注入文本仍在最终提示词里，状态不报惰性', async () => {
  const sections = [
    { name: 'harness:identity', order: -1000, text: 'host identity' },
    { name: 'deployment:persona-prefix', order: 0, text: PERSONA_TEXT },
    { name: 'breaklimit', order: TAIL_ORDER, text: 'tail text' },
    { name: 'tools:core', order: 10000, text: 'tools core' },
  ]

  const { out, status } = await assembleObserved(sections, renderedByHost)
  const prompt = renderedByHost(out)

  assert.match(prompt, /BREAKLIMIT-INJECTION-MARKER-0123456789/u, '注入文本应仍在装配结果里')
  assert.equal(status.injection.inert, false, status.injection.reason)
  assert.match(status.injection.reason, /包含/u)
  assert.equal(formatStatusText(status).includes('注入告警'), false)
})

test('complete 组合：注入被宿主丢弃时状态报惰性并给出告警行', async () => {
  const sections = [
    { name: 'harness:identity', order: -1000, text: 'host identity' },
    { name: 'deployment:persona-prefix', order: 0, text: PERSONA_TEXT },
    { name: 'breaklimit', order: TAIL_ORDER, text: 'tail text' },
    { name: 'tools:core', order: 10000, text: 'tools core' },
  ]

  // 宿主在跑瀑布之前就把 complete 段浅拷贝下来，瀑布之后用 [completeSection]
  // 替换整份 sections。最终提示词只有 persona 原文，注入与尾部段都不在。
  const { out, runtime, status } = await assembleObserved(sections, () => PERSONA_TEXT)

  // 被丢弃发生在瀑布之后，不在本插件里：瀑布内部那段确实已经折进了注入。
  const persona = out.sections.find(section => section.name === 'deployment:persona-prefix')
  assert.match(persona.text, /BREAKLIMIT-INJECTION-MARKER-0123456789/u)
  assert.equal(runtime.lastAssembly.injectionDropped, true)

  assert.equal(status.injection.inert, true, status.injection.reason)
  assert.match(status.injection.reason, /complete 段/u)

  const text = formatStatusText(status)
  assert.match(text, /注入告警/u)
  assert.match(text, /complete 段/u)
  assert.match(text, /minimal preset/u)
})

test('还没观测到落盘的 system/message 时记未知，不伪造惰性', async () => {
  const sections = [{ name: 'deployment:persona-prefix', order: 0, text: PERSONA_TEXT }]

  const { status } = await assembleObserved(sections, null)

  assert.equal(status.injection.inert, null)
  assert.match(status.injection.reason, /尚未观测到/u)
  assert.equal(formatStatusText(status).includes('注入告警'), false)
})

test('formatStatusText 在状态里没有 injection 字段时不抛错', async () => {
  const sections = [{ name: 'deployment:persona-prefix', order: 0, text: PERSONA_TEXT }]
  const { status } = await assembleObserved(sections, renderedByHost)

  const legacy = { ...status }
  delete legacy.injection

  assert.doesNotThrow(() => formatStatusText(legacy))
  assert.match(formatStatusText(legacy), /rumo-dsh-breaklimit/u)
})
