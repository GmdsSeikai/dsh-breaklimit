// 接口一致性检查器的自测。
//
// 一个从不报错的检查等于没写。这里给检查器喂进三种人为构造的源码，验证它确实
// 抓得住——检查器本身的失效是这次事故的根源，所以它必须先能证明自己会失败。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkSources, checkTree, collectExports, stripCommentsAndStrings } from '../tools/lint-exports.mjs'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-lint-'))
}

/** 在临时目录里写一对文件并检查。 */
function check(files) {
  const dir = tempDir()
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, 'utf8')
  }
  const sources = new Map()
  for (const name of Object.keys(files)) {
    const file = path.join(dir, name)
    sources.set(file, fs.readFileSync(file, 'utf8'))
  }
  return checkSources(sources, dir)
}

test('collectExports 认得各种导出形态', () => {
  const names = collectExports([
    'export function alpha() {}',
    'export async function beta() {}',
    'export const gamma = 1',
    'export class Delta {}',
    'export { epsilon, zeta as eta }',
  ].join('\n'))
  assert.deepEqual([...names].sort(), ['Delta', 'alpha', 'beta', 'epsilon', 'eta', 'gamma'])
})

test('stripCommentsAndStrings 去掉注释与字符串，避免读出假符号', () => {
  const clean = stripCommentsAndStrings("const a = 'ghost()'\n// phantom()\nconst b = 1 /* spectre() */")
  assert.equal(clean.includes('ghost'), false)
  assert.equal(clean.includes('phantom'), false)
  assert.equal(clean.includes('spectre'), false)
})

test('抓出导入不存在的导出', () => {
  const problems = check({
    'a.js': 'export function alpha() {}\n',
    'b.js': "import { alpha, beta } from './a.js'\nalpha()\n",
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /beta/)
})

test('抓出访问不存在的命名空间成员', () => {
  const problems = check({
    'a.js': 'export function alpha() {}\n',
    'b.js': "import * as a from './a.js'\nconst x = a.gamma\n",
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /gamma/)
})

test('注释里的假 import 不参与检查', () => {
  const problems = check({
    'a.js': 'export function alpha() {}\n',
    'b.js': "// import { ghost } from './a.js'\nexport function ok() {}\n",
  })
  assert.deepEqual(problems, [])
})

test('干净的一对文件不报问题', () => {
  const problems = check({
    'a.js': 'export function alpha() {}\nexport const beta = 1\n',
    'b.js': "import { alpha, beta } from './a.js'\nexport const use = alpha(beta)\n",
  })
  assert.deepEqual(problems, [])
})

test('再导出形式也被认作导出', () => {
  const problems = check({
    'a.js': 'export function alpha() {}\n',
    'b.js': "export { alpha } from './a.js'\n",
    'c.js': "import { alpha } from './b.js'\nalpha()\n",
  })
  assert.deepEqual(problems, [])
})

test('检查真实仓库时通过', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname.slice(1)), '..')
  const { problems } = checkTree(root)
  assert.deepEqual(problems, [], `仓库自身有接口不一致：\n${problems.join('\n')}`)
})
