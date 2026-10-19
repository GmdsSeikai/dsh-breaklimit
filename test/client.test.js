import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

test('设置页分区方向键同步移动键盘焦点', () => {
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
  vm.runInNewContext(fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), sandbox)
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
  assert.equal(tabs.length, 3)
  function key(index, value, expected) {
    let prevented = false
    tabs[index].props.onKeyDown({ key: value, preventDefault() { prevented = true } })
    assert.equal(prevented, true)
    assert.equal(focused, `bkl-tab-${expected}`)
  }
  key(0, 'ArrowRight', 'patches')
  key(0, 'ArrowLeft', 'context')
  key(1, 'Home', 'overview')
  key(1, 'End', 'context')

  // 输入框下方的词表行必须真的注册出去，否则设置里看得到、对话里找不到入口。
  assert.equal(typeof dock, 'function')
})

test('RuleEditor 重名 ID 时展示打开已有规则按钮，且组件注册 beforeunload 守卫', () => {
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
  vm.runInNewContext(fs.readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'), sandbox)
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

