// 界面文案守卫。
//
// 这个文件存在的理由是一次真实缺陷：英文界面里夹着中文全角标点，补丁标题与
// 技术说明也只有中文。改之前 `client.js` 不在任何测试的覆盖范围里——它是宿主
// 直接加载的浏览器模块，靠 `window.__ModuleLoader__.load` 注册，`node --test`
// 摸不到它。于是那类问题只能靠重启宿主后的目视发现，而目视既不会在提交前跑，
// 也不会在下次改动时重跑。
//
// 这里不改 `client.js` 的结构（它必须保持单文件，宿主按文件 URL 取），而是用
// vm 桩一个最小宿主环境把它加载起来，取到语言包，再把四类能机器判的事情变成
// 检查：
//
//   1. 模块外壳还能加载：注册 id、factory 返回值、name 导出一致。
//   2. 两套语言包的键集合相同——少一个键，界面上那处就是 undefined。
//   3. 英文包里没有中文与全角标点，包括函数体里的字面量。
//   4. 源码里每一处 `T.<键>` 与 `T["<键>"]` 都能在语言包里找到——改了文案漏了键，
//      这里报错；`T[` 后面不是字符串字面量的（动态拼出来的键）也直接报错，那种
//      写法在源码里没有键名，语言包缺不缺键、英文包混没混进中文都验不到。
//
// 第 4 条与 `lint-exports.mjs` 防的是同一类事故：一个名字被引用，却已经不存在。
// 区别是那边查跨模块导入，这边查一张文案表。
//
// 退出码: 0 通过；1 有问题；2 加载不了模块或读不到源码。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(PACKAGE_ROOT, 'src', 'client.js')
const EXPECTED_ID = 'rumo-dsh-breaklimit'

/** 中文（含扩展 A 区 U+3400-4DBF）、CJK 标点、全角形式，合起来就是「英文段里不该出现」的字符。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/

/** 块注释换成等长空白，行号才对得上原文；行注释删掉文字但保留换行，行号同样不变。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

function fail(message) {
  console.error(message)
  process.exit(2)
}

let source
try {
  source = fs.readFileSync(CLIENT, 'utf8')
} catch (error) {
  fail(`读不到 client.js：${String(error?.message ?? error)}`)
}

// 语言包是 factory 内的局部常量。把它挂到 sandbox 的全局上再执行，是不改磁盘
// 文件的唯一办法：一次性改写这段源码文本，命中次数必须是 1。
const MARKER = '  const TEXT = {'
const injection = '  const TEXT = globalThis.__BKL_TEXT__ = {'
const occurrences = source.split(MARKER).length - 1
if (occurrences !== 1) fail(`语言包起点在 client.js 里出现 ${String(occurrences)} 次，期望 1 次`)
const patched = source.split(MARKER).join(injection)

const problems = []

let registration = null
const react = {
  createElement: () => ({}),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => { registration = value } } },
  document: { documentElement: { lang: 'en' }, head: null, getElementById: () => null },
  navigator: { language: 'en' },
  console,
}
vm.createContext(sandbox)

try {
  vm.runInContext(patched, sandbox, { filename: 'client.js' })
} catch (error) {
  fail(`client.js 在桩环境里执行失败：${String(error?.message ?? error)}`)
}

if (registration === null) fail('client.js 没有调用 window.__ModuleLoader__.load')
if (registration.id !== EXPECTED_ID) {
  problems.push(`注册 id 是 ${JSON.stringify(registration.id)}，期望 ${JSON.stringify(EXPECTED_ID)}`)
}

let exported
try {
  exported = registration.factory((specifier) => {
    if (specifier !== 'react') throw new Error(`未知的 require：${specifier}`)
    return react
  })
} catch (error) {
  fail(`factory 执行失败：${String(error?.message ?? error)}`)
}

for (const key of ['name', 'inject', 'apply']) {
  if (!(key in exported)) problems.push(`模块没有导出 ${key}`)
}
if (exported.name !== EXPECTED_ID) {
  problems.push(`导出的 name 是 ${JSON.stringify(exported.name)}，期望 ${JSON.stringify(EXPECTED_ID)}`)
}

const TEXT = sandbox.__BKL_TEXT__
if (TEXT === undefined || TEXT === null || typeof TEXT !== 'object') fail('没有取到语言包')
if (!TEXT.zh || !TEXT.en) fail('语言包缺少 zh 或 en')

const zhKeys = new Set(Object.keys(TEXT.zh))
const enKeys = new Set(Object.keys(TEXT.en))
for (const key of zhKeys) {
  if (!enKeys.has(key)) problems.push(`语言包缺英文键 ${key}`)
}
for (const key of enKeys) {
  if (!zhKeys.has(key)) problems.push(`语言包缺中文键 ${key}`)
}

// 英文包的值：字符串直接看，函数调用后再看，避免把函数值当成空。
for (const [key, value] of enKeys.size === 0 ? [] : Object.entries(TEXT.en)) {
  const rendered = typeof value === 'function' ? safeCall(value) : value
  if (typeof rendered !== 'string') continue
  if (CJK.test(rendered)) {
    problems.push(`英文包的 ${key} 里混进了中文或全角标点`)
  }
}
function safeCall(fn) {
  try {
    return String(fn('x', 'y', 'z', 'w'))
  } catch {
    return ''
  }
}

// 英文包整段的字符串字面量：函数体里写死的字面量在上一步扫不到，这里补一刀。
const enStart = source.indexOf('    en: {')
if (enStart < 0) {
  problems.push('找不到英文语言包的起点')
} else {
  const enBlock = stripComments(source.slice(enStart))
  for (const match of enBlock.matchAll(/(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
    const literal = match[2]
    if (CJK.test(literal) && !/^https?:/.test(literal)) {
      const line = source.slice(0, enStart).split('\n').length
      problems.push(`英文语言包里出现全角或中文字面量：${JSON.stringify(literal.slice(0, 40))}（自第 ${String(line)} 行起算的段落内）`)
    }
  }
}

// 源码里每一处 `T.<键>` 都必须在语言包里。先去掉注释，免得说明文字里提到
// 的键名被当成引用。
const cleaned = stripComments(source)
const referenced = new Set()
for (const match of cleaned.matchAll(/\bT\.([A-Za-z_$][\w$]*)/g)) referenced.add(match[1])

// `T[...]` 只认「一个字符串字面量 + 右括号」这一种形态。`T["err" + "MissingNext"]`
// 这类拼接在源码里没有完整键名，语言包比对和英文包扫描都绕过去了，所以这里不是
// 跳过而是报错；字面量后面不是右括号的同样算动态键。
for (const match of cleaned.matchAll(/\bT\[/g)) {
  const after = cleaned.slice(match.index + match[0].length)
  const line = cleaned.slice(0, match.index).split('\n').length
  const literal = /^(["'])((?:(?!\1)[^\\\n]|\\.)*)\1/.exec(after)
  if (literal === null) {
    problems.push(`第 ${String(line)} 行的 T[...] 不是字符串字面量取键（${JSON.stringify(after.slice(0, 40))}），动态键逃过了语言包检查，改成 T.<键> 或字面量键`)
    continue
  }
  if (!/^\s*\]/.test(after.slice(literal[0].length))) {
    problems.push(`第 ${String(line)} 行的 T[...] 用表达式拼键（${JSON.stringify(after.slice(0, 40))}），动态键逃过了语言包检查，改成 T.<键> 或字面量键`)
    continue
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(literal[2])) {
    problems.push(`第 ${String(line)} 行的 T[...] 键名 ${JSON.stringify(literal[2])} 不是普通标识符，无法与语言包比对`)
    continue
  }
  referenced.add(literal[2])
}
for (const key of [...referenced].sort()) {
  if (!zhKeys.has(key)) problems.push(`源码引用了语言包里不存在的键 T.${key}`)
}

if (problems.length > 0) {
  console.error(`界面文案检查未通过，${String(problems.length)} 处问题：`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`界面文案检查通过（${String(zhKeys.size)} 个语言键，${String(referenced.size)} 处引用）`)
