import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { maskText, normalizeEntries } from '../src/host/masks.js'

const CLIENT = new URL('../src/client.js', import.meta.url)

// 最小宿主桩：把 client.js 按宿主的方式加载起来，取到导出的纯函数与组件。
// 组件是纯函数，直接调用再把函数子组件展开成普通节点树，就能断言真实渲染结果。
function loadClient(sandboxExtras = {}, reactExtras = {}) {
  let registration
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
    useCallback: fn => fn,
    useRef: current => ({ current }),
    ...reactExtras,
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document: { head: null, documentElement: { lang: 'en' }, getElementById() { return null } },
    navigator: { language: 'en' },
    ...sandboxExtras,
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  return { exported, registration }
}

function mount(node) {
  if (Array.isArray(node)) return node.flatMap(mount)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return mount(node.type({ ...node.props, children: node.children }))
  return { ...node, children: node.children.map(mount) }
}

function findAll(node, pred, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, pred, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  for (const child of node.children) findAll(child, pred, out)
  return out
}

const textOf = (node) => {
  const parts = []
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (value !== null && typeof value === 'object') return value.children.forEach(walk)
    parts.push(String(value))
  }
  walk(node.children)
  return parts.join('')
}

test('设置页五页导航方向键同步移动键盘焦点', () => {
  let registration
  let component
  let dock
  let focused
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
    useCallback: fn => fn,
    useRef: current => ({ current }),
  }
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    document: {
      head: null,
      documentElement: { lang: 'en' },
      getElementById(id) { return { focus() { focused = id } } },
    },
    navigator: { language: 'en' },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  exported.apply({
    effect(fn) { fn() },
    slots: {
      inject(_name, fn) { fn() },
      register(metadata, value) {
        // 一个 factory 现在会注册两个落点：设置分区与输入框下方的词表行。
        // 按 name 取，不靠注册顺序，否则后注册的那个会把前一个顶掉。
        if (metadata?.name === 'settings.section') component = value
        else if (metadata?.name === 'conversation.input.dock') dock = value
      },
    },
  })
  const tabs = []
  function visit(node) {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    if (node.props?.role === 'tab') tabs.push(node)
    visit(node.children)
  }
  visit(component())
  assert.equal(tabs.length, 5)
  assert.deepEqual(tabs.map(tab => tab.props.id), [
    'bkl-tab-overview', 'bkl-tab-patches', 'bkl-tab-prompt', 'bkl-tab-rules', 'bkl-tab-words',
  ])
  function key(index, value, expected) {
    let prevented = false
    tabs[index].props.onKeyDown({ key: value, preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(focused, `bkl-tab-${expected}`)
  }
  key(0, 'ArrowRight', 'patches')
  key(0, 'ArrowLeft', 'words')
  key(1, 'Home', 'overview')
  key(1, 'End', 'words')
  key(4, 'ArrowRight', 'overview')

  // 输入框下方的词表行必须真的注册出去，否则设置里看得到、对话里找不到入口。
  assert.equal(typeof dock, 'function')
})

test('草稿脏判定覆盖改动与未改动，beforeunload 守卫在无草稿时不拦截', () => {
  let registration
  let beforeunloadHandler = null
  const listeners = {}
  const react = {
    createElement: (type, props, ...children) => {
      if (typeof type === 'function') {
        return type({ ...(props ?? {}), children })
      }
      return { type, props: props ?? {}, children }
    },
    useState: initial => [initial, () => {}],
    useEffect(fn) { fn() },
    useCallback: fn => fn,
    useRef: current => ({ current }),
  }
  const sandbox = {
    setInterval: () => 123,
    clearInterval: () => {},
    setTimeout: () => 456,
    clearTimeout: () => {},
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      addEventListener(type, fn) { listeners[type] = fn; if (type === 'beforeunload') beforeunloadHandler = fn },
      removeEventListener(type) { delete listeners[type] },
    },
    document: {
      head: null,
      documentElement: { lang: 'zh' },
      getElementById() { return null },
    },
    navigator: { language: 'zh' },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)
  let component
  exported.apply({
    effect(fn) { fn() },
    slots: {
      inject(_name, fn) { fn() },
      register(metadata, value) {
        if (metadata?.name === 'settings.section') component = value
      },
    },
  })

  // 渲染组件并确保 beforeunload 守卫已被注册
  component()
  assert.equal(typeof beforeunloadHandler, 'function')

  // 脏判定本身在这里直接测：桩里的 useState 恒返回初始值，ruleEdit 永远是 null，
  // 靠渲染逼不出脏草稿。判定是纯函数，测它比测 React 生命周期可靠。
  const isDirty = exported.isRuleEditDirty
  assert.equal(typeof isDirty, 'function')
  assert.equal(isDirty(null), false)

  const fresh = { isNew: true, id: "", name: "", target: "AGENTS.md", text: "" }
  assert.equal(isDirty({ ...fresh, baseline: fresh }), false)
  assert.equal(isDirty({ ...fresh, id: "abc", baseline: fresh }), true)
  assert.equal(isDirty({ ...fresh, name: "名字", baseline: fresh }), true)
  assert.equal(isDirty({ ...fresh, text: "正文", baseline: fresh }), true)

  const loaded = { isNew: false, id: "abc", name: "", target: "AGENTS.md", text: "body" }
  assert.equal(isDirty({ ...loaded, baseline: loaded }), false)
  assert.equal(isDirty({ ...loaded, text: "body2", baseline: loaded }), true)
  assert.equal(isDirty({ ...loaded, target: "CLAUDE.md", baseline: loaded }), true)
  assert.equal(isDirty({ ...loaded, name: "N", baseline: loaded }), true)

  // 验证 beforeunload 拦截逻辑
  let prevented = false
  const dummyEvent = {
    preventDefault() { prevented = true },
    returnValue: null,
  }
  beforeunloadHandler(dummyEvent)
  // 无草稿时默认不拦截
  assert.equal(prevented, false)
})

test('正文读取失败时不显示空正文或内置正文，也不许覆盖', () => {
  const { exported } = loadClient()
  let saved = 0
  let reset = 0
  const promptError = { tone: 'error', title: 'x', next: 'y' }
  const tree = mount(exported.PromptBlock({
    override: null,
    promptError,
    draft: null,
    setDraft() {},
    busy: false,
    onSave() { saved += 1 },
    onReset() { reset += 1 },
    onDiscard() {},
    onCopy() {},
    onRetry() {},
    noticeView: null,
  }))
  const textarea = findAll(tree, node => node.type === 'textarea')[0]
  assert.equal(textarea.props.value, '')
  assert.equal(textarea.props.readOnly, true)
  assert.equal(textarea.props['aria-invalid'], 'true')
  const buttons = findAll(tree, node => node.type === 'button')
  const save = buttons.find(button => textOf(button).includes('Save'))
  const resetButton = buttons.find(button => textOf(button).includes('Restore built-in'))
  assert.equal(save.props['aria-disabled'], 'true')
  assert.equal(resetButton.props['aria-disabled'], 'true')
  // 按钮即便被点到也不执行动作（Button 用 off 拦截）。
  save.props.onClick({ preventDefault() {} })
  resetButton.props.onClick({ preventDefault() {} })
  assert.equal(saved, 0)
  assert.equal(reset, 0)
  // 读取失败横幅带「重新读取」动作，而不是给一个空编辑器让人保存。
  const retry = buttons.find(button => textOf(button).includes('Read the prompt again'))
  assert.equal(retry !== undefined, true)
})

test('正文读取成功后才允许编辑与保存，草稿优先于已保存正文', () => {
  const { exported } = loadClient()
  let received = null
  let saved = 0
  const tree = mount(exported.PromptBlock({
    override: { text: 'builtin text', userFileExists: true, bytes: 12, effective: { ok: true } },
    promptError: null,
    draft: 'my draft',
    setDraft(value) { received = value },
    busy: false,
    onSave() { saved += 1 },
    onReset() {},
    onDiscard() {},
    onCopy() {},
    onRetry() {},
    noticeView: null,
  }))
  const textarea = findAll(tree, node => node.type === 'textarea')[0]
  assert.equal(textarea.props.value, 'my draft')
  assert.equal(textarea.props.readOnly, undefined)
  textarea.props.onChange({ target: { value: 'typed later' } })
  assert.equal(received, 'typed later')
  const save = findAll(tree, node => node.type === 'button').find(button => textOf(button).includes('Save'))
  assert.equal(save.props['aria-disabled'], undefined)
  save.props.onClick({ preventDefault() {} })
  assert.equal(saved, 1)
})

test('保存期间继续输入的新内容不被成功回调清除', () => {
  const { exported } = loadClient()
  assert.equal(exported.draftAfterSave('submitted', 'submitted'), null)
  assert.equal(exported.draftAfterSave('submitted plus more', 'submitted'), 'submitted plus more')
  assert.equal(exported.draftAfterSave(null, 'submitted'), null)
})

test('规则保存只邀请激活，绝不自动激活；外部修改时不邀请', () => {
  const { exported } = loadClient()
  const edit = { id: 'r1', name: 'n', target: 'AGENTS.md', text: 't' }
  const inactive = exported.ruleSaveNotice({}, null, edit)
  assert.equal(inactive.activateRule, 'r1')
  assert.equal(inactive.tone, 'ok')
  const active = exported.ruleSaveNotice({}, 'r1', edit)
  assert.equal(active.activateRule, null)
  const stale = exported.ruleSaveNotice({ landingStale: true, target: 'AGENTS.md' }, null, edit)
  assert.equal(stale.activateRule, null)
  assert.equal(stale.tone, 'warn')
  const moved = exported.ruleSaveNotice({ landingMoved: true, target: 'CLAUDE.md' }, null, edit)
  assert.equal(moved.activateRule, null)
})

test('词条校验：去空白后判空、同词、64/65 边界与 100 条上限', () => {
  const { exported } = loadClient()
  const errors = exported.wordEntryErrors
  assert.deepEqual(
    [errors('  a  ', '  b  ').from, errors('  a  ', '  b  ').to, errors('  a  ', '  b  ').limit],
    ['', '', ''],
  )
  assert.notEqual(errors('', 'b').from, '')
  assert.notEqual(errors('a', '').to, '')
  assert.notEqual(errors('same', ' same ').to, '')
  assert.equal(errors('x'.repeat(64), 'b').from, '')
  assert.notEqual(errors('x'.repeat(65), 'b').from, '')
  assert.equal(errors('a', 'y'.repeat(64)).to, '')
  assert.notEqual(errors('a', 'y'.repeat(65)).to, '')
  const full = Array.from({ length: 100 }, (_, index) => ({ from: `w${String(index)}`, to: `t${String(index)}` }))
  // 到达上限：新增被挡，但编辑或用相同原词覆盖仍然放行。
  assert.notEqual(errors('brand-new', 'b', { entries: full }).limit, '')
  assert.equal(errors('w5', 'b', { entries: full }).limit, '')
  assert.equal(errors('w5', 'b', { entries: full, originalFrom: 'w5' }).limit, '')
  assert.equal(errors('brand-new', 'b', { entries: full.slice(0, 99) }).limit, '')
})

test('词条整表计算：覆盖与合并的最终保留记录都可预测', () => {
  const { exported } = loadClient()
  const entries = [
    { from: 'old', to: 'new' },
    { from: 'dup', to: 'x' },
    { from: 'tail', to: 'z' },
  ]
  const save = (originalFrom, entry) => ({ type: 'save', originalFrom, entry })
  // 新增撞原词 → overwrite；目标那条换成新值，位置不变。
  assert.equal(exported.aliasChangeKind(entries, save(null, { from: 'dup', to: 'y' })), 'overwrite')
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.aliasNextEntries(entries, save(null, { from: 'dup', to: 'y' })))),
    [{ from: 'old', to: 'new' }, { from: 'dup', to: 'y' }, { from: 'tail', to: 'z' }],
  )
  // 编辑改名撞原词 → merge；原记录消失，最终只留同名词条那条。
  assert.equal(exported.aliasChangeKind(entries, save('old', { from: 'dup', to: 'y' })), 'merge')
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.aliasNextEntries(entries, save('old', { from: 'dup', to: 'y' })))),
    [{ from: 'dup', to: 'y' }, { from: 'tail', to: 'z' }],
  )
  // 改名到新原词 → 无冲突，原位替换。
  assert.equal(exported.aliasChangeKind(entries, save('old', { from: 'fresh', to: 'q' })), null)
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.aliasNextEntries(entries, save('old', { from: 'fresh', to: 'q' })))),
    [{ from: 'fresh', to: 'q' }, { from: 'dup', to: 'x' }, { from: 'tail', to: 'z' }],
  )
  // 原词原地换替换词 → 无冲突。
  assert.equal(exported.aliasChangeKind(entries, save('dup', { from: 'dup', to: 'y' })), null)
  // 删除按原词整条移除。
  assert.deepEqual(
    JSON.parse(JSON.stringify(exported.aliasNextEntries(entries, { type: 'delete', from: 'dup' }))),
    [{ from: 'old', to: 'new' }, { from: 'tail', to: 'z' }],
  )
})

test('本地预览与 host/masks.js 的 maskText 逐例一致', () => {
  const { exported } = loadClient()
  const cases = [
    ['百度贴吧和百度都行', [{ from: '百度', to: 'X' }, { from: '百度贴吧', to: 'Y' }]],
    ['Hello hello HELLO', [{ from: 'hello', to: 'hi' }]],
    // 后面的词条会继续匹配前面替换产生的文本。
    ['aaabbb', [{ from: 'a', to: 'aa' }, { from: 'aa', to: 'z' }]],
    ['', [{ from: 'a', to: 'b' }]],
    ['一段普通文本', [{ from: '', to: 'x' }, { from: 'same', to: 'same' }, { from: '普通', to: '一般' }]],
    ['dup dup dup', [{ from: 'dup', to: '1' }, { from: 'dup', to: '2' }]],
    ['long and short', [{ from: 'long and', to: 'L' }, { from: 'short', to: 'S' }, { from: 'and', to: 'A' }]],
  ]
  for (const [text, entries] of cases) {
    assert.equal(
      JSON.stringify(exported.maskPreview(text, entries)),
      JSON.stringify(maskText(text, entries)),
      `预览与 maskText 不一致：${JSON.stringify([text, entries])}`,
    )
  }
  // 超过 100 条同样按 host/masks.js 的口径截断。
  const many = Array.from({ length: 120 }, (_, index) => ({ from: `w${String(index)}`, to: `t${String(index)}` }))
  assert.equal(
    JSON.stringify(exported.maskPreview('w0 w119', many)),
    JSON.stringify(maskText('w0 w119', many)),
  )
  assert.equal(JSON.stringify(exported.normalizeAliasEntries(many)), JSON.stringify(normalizeEntries(many)))
})

test('词条编辑弹窗：覆盖与合并写明最终保留的记录，取消回到编辑保留输入', () => {
  const { exported } = loadClient()
  const entries = [{ from: 'old', to: 'new' }, { from: 'dup', to: 'x' }]
  let backed = 0
  let overwrote = 0
  const mergeEditor = {
    phase: 'merge', originalFrom: 'old', from: 'dup', to: 'y',
    baselineFrom: 'old', baselineTo: 'new', touched: true,
  }
  const mergeSpec = exported.WordEditor({
    editor: mergeEditor,
    entries,
    limits: { maxEntries: 100, maxTerm: 64 },
    saving: false,
    error: null,
    onField() {},
    onSave() {},
    onCancel() {},
    onBack() { backed += 1 },
    onConfirmOverwrite() { overwrote += 1 },
    onConfirmDiscard() {},
  })
  const merge = mount([mergeSpec.body, mergeSpec.foot])
  const mergePairs = findAll(merge, node => node.type === 'div' && node.props?.style?.gridTemplateColumns !== undefined)
    .map(pair => textOf(pair))
  // 三段：正在编辑的原记录、将被覆盖的记录、最终保留一条。
  assert.equal(mergePairs.some(text => text.includes('old') && text.includes('new')), true)
  assert.equal(mergePairs.some(text => text.includes('dup') && text.includes('x')), true)
  assert.equal(mergePairs.some(text => text.includes('dup') && text.includes('y')), true)
  const mergeButtons = findAll(merge, node => node.type === 'button')
  const back = mergeButtons.find(button => textOf(button).includes('Back to editing'))
  const yes = mergeButtons.find(button => textOf(button).includes('Merge and overwrite'))
  assert.equal(back !== undefined, true)
  assert.equal(yes !== undefined, true)
  back.props.onClick({ preventDefault() {} })
  yes.props.onClick({ preventDefault() {} })
  assert.equal(backed, 1)
  assert.equal(overwrote, 1)

  // 编辑态：输入值来自草稿，64 字符边界报在字段上，取消与保存按钮都接好线。
  let closed = 0
  let saved = 0
  const editSpec = exported.WordEditor({
    editor: {
      phase: 'edit', originalFrom: 'old', from: 'x'.repeat(65), to: 'y',
      baselineFrom: 'old', baselineTo: 'new', touched: true,
    },
    entries,
    limits: { maxEntries: 100, maxTerm: 64 },
    saving: false,
    error: null,
    onField() {},
    onSave() { saved += 1 },
    onCancel() { closed += 1 },
    onBack() {},
    onConfirmOverwrite() {},
    onConfirmDiscard() {},
  })
  const edit = mount([editSpec.body, editSpec.foot])
  const inputs = findAll(edit, node => node.type === 'input')
  assert.equal(inputs[0].props.value, 'x'.repeat(65))
  const fieldError = findAll(edit, node => node.type === 'span' && node.props?.id === 'bkl-word-from-error')[0]
  assert.notEqual(textOf(fieldError), '')
  const editButtons = findAll(edit, node => node.type === 'button')
  const saveButton = editButtons.find(button => textOf(button).includes('Save entry'))
  assert.equal(saveButton.props['aria-disabled'], 'true')
  const cancel = editButtons.find(button => textOf(button).includes('Cancel'))
  cancel.props.onClick({ preventDefault() {} })
  assert.equal(closed, 1)
})

test('词库共享 store：串行整表写入、过期响应作废、失败保留旧数据', async () => {
  const { exported } = loadClient()
  const calls = []
  let disk = [{ from: 'a', to: 'b' }]
  let failMode = null
  let pendingGet = null
  const requests = {
    get: async () => {
      calls.push(['get'])
      if (failMode === 'slow') {
        return new Promise((resolve) => { pendingGet = resolve })
      }
      if (failMode === 'get') {
        const error = new Error('offline')
        error.code = 'network'
        throw error
      }
      return { ok: true, code: 'ok', message: '', data: { entries: disk.map(entry => ({ ...entry })), limits: { maxEntries: 100, maxTerm: 64 }, lastHits: 1 } }
    },
    put: async (_path, body) => {
      calls.push(['put', JSON.parse(JSON.stringify(body))])
      if (failMode === 'timeout') {
        const error = new Error('slow')
        error.code = 'timeout'
        throw error
      }
      if (failMode === 'write') {
        const error = new Error('disk')
        error.code = 'write_failed'
        throw error
      }
      disk = body.entries.map(entry => ({ ...entry }))
      return { ok: true, code: 'saved', data: { entries: disk.map(entry => ({ ...entry })) } }
    },
  }
  const store = exported.createAliasStore(requests)
  await store.read()
  assert.equal(store.state.phase, 'ready')
  assert.equal(store.state.entries.length, 1)

  // 两个挂载点各自提交：写入串行，后一笔基于最新列表整表写，不丢前一笔。
  const first = store.commit({ type: 'save', originalFrom: null, entry: { from: 'c', to: 'd' } })
  const second = store.commit({ type: 'save', originalFrom: null, entry: { from: 'e', to: 'f' } })
  const [r1, r2] = await Promise.all([first, second])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  const puts = calls.filter(call => call[0] === 'put')
  assert.deepEqual(puts[0][1].entries.map(entry => entry.from), ['a', 'c'])
  assert.deepEqual(puts[1][1].entries.map(entry => entry.from), ['a', 'c', 'e'])
  assert.equal(store.state.entries.length, 3)

  // 过期读取响应不能覆盖写入后的新状态。
  failMode = 'slow'
  const slow = store.read()
  await store.commit({ type: 'delete', from: 'c' })
  pendingGet({ ok: true, code: 'ok', message: '', data: { entries: [{ from: 'stale', to: 'x' }] } })
  await slow
  assert.deepEqual(store.state.entries.map(entry => entry.from), ['a', 'e'])
  failMode = null

  // 写失败：已保存列表不动，草稿逻辑在调用方；明确失败不是「结果未知」。
  failMode = 'write'
  const failed = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'g', to: 'h' } })
  assert.equal(failed.ok, false)
  assert.equal(failed.unknown, false)
  assert.deepEqual(store.state.entries.map(entry => entry.from), ['a', 'e'])

  // 超时/断网是「结果未知」，不能宣称未生效。
  failMode = 'timeout'
  const unknown = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'g', to: 'h' } })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.unknown, true)

  // 读取失败：已有数据保留并标旧，写入被拒绝。
  failMode = 'get'
  await store.read()
  assert.equal(store.state.phase, 'failed')
  assert.equal(store.state.stale, true)
  assert.deepEqual(store.state.entries.map(entry => entry.from), ['a', 'e'])
  const refused = await store.commit({ type: 'delete', from: 'a' })
  assert.equal(refused.ok, false)
  assert.equal(refused.refused, true)
  assert.deepEqual(store.state.entries.map(entry => entry.from), ['a', 'e'])

  // 重新读取成功后恢复写入。
  failMode = null
  await store.read()
  assert.equal(store.state.phase, 'ready')
  assert.equal(store.state.stale, false)
  const recovered = await store.commit({ type: 'delete', from: 'a' })
  assert.equal(recovered.ok, true)
  assert.deepEqual(store.state.entries.map(entry => entry.from), ['e'])
})

test('浮窗「管理词库」直达词库页，拿不到宿主能力时退回提示', () => {
  let registration
  const sent = []
  let navHandler = null
  const opened = []
  class CustomEventStub {
    constructor(type, init) {
      this.type = type
      this.detail = init?.detail
    }
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: initial => [initial, () => {}],
    useEffect() {},
    useCallback: fn => fn,
    useRef: current => ({ current }),
  }
  const sandbox = {
    CustomEvent: CustomEventStub,
    window: {
      __ModuleLoader__: { load(value) { registration = value } },
      dispatchEvent(event) {
        sent.push({ type: event.type, detail: event.detail })
        if (event.type === 'bkl:navigate' && navHandler !== null) navHandler(event.detail)
        return true
      },
      addEventListener() {},
      removeEventListener() {},
    },
    document: { head: null, documentElement: { lang: 'zh' }, getElementById() { return null } },
    navigator: { language: 'zh' },
  }
  vm.runInNewContext(fs.readFileSync(CLIENT, 'utf8'), sandbox)
  const exported = registration.factory(() => react)

  // 没有宿主设置能力时：事件照发，返回 false 由浮窗给提示。
  exported.apply({ effect(fn) { fn() }, slots: { inject(_name, fn) { fn() }, register() {} } })
  assert.equal(exported.openWordsFromDock(), false)
  assert.equal(sent[0].type, 'bkl:navigate')
  assert.equal(sent[0].detail.tab, 'words')
  assert.equal(sent[0].detail.handled, false)

  // 宿主提供设置分区导航时：直达 breaklimit 分区（词库页由待落地页签接手）。
  exported.apply({
    effect(fn) { fn() },
    slots: {
      inject(_name, fn) { fn() },
      register() {},
      entries(key) {
        if (key !== 'sidebar.settings') return []
        return [{ store: { create: () => ({ actions: { openSection: (id) => opened.push(id) } }) } }]
      },
    },
  })
  assert.equal(exported.openWordsFromDock(), true)
  assert.deepEqual(opened, ['breaklimit'])

  // 设置分区已挂载（事件被认领）时：直接切页，不再去开设置面板。
  opened.length = 0
  navHandler = (detail) => { detail.handled = true }
  assert.equal(exported.openWordsFromDock(), true)
  assert.deepEqual(opened, [])
  assert.equal(sent.at(-1).detail.handled, true)

  // 词库写完后通知另一处挂载点重拉。
  exported.notifyStateChanged()
  assert.equal(sent.at(-1).type, 'bkl:state-changed')
})

test('词库读取告警随 200 返回时按读取失败处理，不当成空词库', async () => {
  const { exported } = loadClient()
  const store = exported.createAliasStore({
    get: async () => ({ ok: true, code: 'ok', message: '词表文件不是合法 JSON，已按空表处理。', data: { entries: [] } }),
    put: async () => ({ ok: true, code: 'saved', data: { entries: [] } }),
  })
  await store.read()
  assert.equal(store.state.phase, 'failed')
  assert.equal(store.state.stale, true)
  const refused = await store.commit({ type: 'save', originalFrom: null, entry: { from: 'a', to: 'b' } })
  assert.equal(refused.refused, true)
})
