import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

test('设置页分区方向键同步移动键盘焦点', () => {
  let registration
  let component
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
      register(_metadata, value) { component = value },
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
})
