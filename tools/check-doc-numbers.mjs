// 文档数字守卫。
//
// verify.md 里写死了测试数、pass 数、扫描文件数和语言检查计数。这类数字每次增补
// 代码都会变，靠人盯着必然漂移——实际上它已经漂过好几轮（140/163/166/170、
// 28/32/33），而验收文档里的数字是判据：写错的判据会把正常状态读成异常。
//
// 这个工具实际跑一遍门禁，拿真实计数去比对文档，对不上就失败。它自己跑，
// 不依赖上游脚本传参——npm 脚本之间传不了值，重跑一遍是最诚实的做法。
//
// 一条规则在当前文档上一处也匹配不到，同样算失败：空转的规则永远不可能报错，
// 等于这条检查不存在。加规则时先确认它在今天的文档上真的命中。
//
// 退出码: 0 一致；1 不一致或规则空转；2 读不到真实计数或文档。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(args) {
  try {
    return execFileSync(process.execPath, args, {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (error) {
    // 门禁失败时 stdout 里仍有计数行，返回它，让这里的报错指向文档而不是测试本身。
    return String(error?.stdout ?? '')
  }
}

const testOutput = run(['--test', '--test-reporter=spec'])
const testMatch = testOutput.match(/\nℹ tests (\d+)/)
const passMatch = testOutput.match(/\nℹ pass (\d+)/)
if (testMatch === null || passMatch === null) {
  console.error('读不到测试计数：`node --test` 的输出里没有 `ℹ tests N` / `ℹ pass N`。')
  process.exit(2)
}
const tests = Number(testMatch[1])
const passes = Number(passMatch[1])

const lintOutput = run(['tools/lint-exports.mjs'])
const lintMatch = lintOutput.match(/接口一致性检查通过（(\d+) 个文件）/)
if (lintMatch === null) {
  console.error('读不到接口一致性文件数：`tools/lint-exports.mjs` 的输出不符合预期。')
  process.exit(2)
}
const scannedFiles = Number(lintMatch[1])

const clientOutput = run(['tools/check-client.mjs'])
const clientMatch = clientOutput.match(/界面文案检查通过（(\d+) 个语言键，(\d+) 处引用）/)
if (clientMatch === null) {
  console.error('读不到界面文案计数：`tools/check-client.mjs` 的输出不符合预期。')
  process.exit(2)
}
const clientKeys = Number(clientMatch[1])
const clientRefs = Number(clientMatch[2])

const problems = []

/**
 * 一条规则可以带多个捕获组：expected 与 label 写成数组，按顺序对应第 1、2…组。
 * 单个捕获组直接用标量。匹配 0 次不是通过，是规则空转，记一条问题。
 */
function checkFile(relative, rules) {
  const file = path.join(PACKAGE_ROOT, relative)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    problems.push(`${relative} 读不出来。`)
    return
  }
  for (const { pattern, expected, label } of rules) {
    const expectedList = Array.isArray(expected) ? expected : [expected]
    const labels = Array.isArray(label) ? label : [label]
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    let matches = 0
    for (const match of text.matchAll(global)) {
      matches += 1
      const line = text.slice(0, match.index).split('\n').length
      expectedList.forEach((want, index) => {
        const actual = Number(match[index + 1])
        if (actual !== want) {
          problems.push(`${relative}:${String(line)} 写着 ${labels[index]} ${String(actual)}，实际是 ${String(want)}。`)
        }
      })
    }
    if (matches === 0) {
      problems.push(`${relative} 里「${labels.join(' / ')}」的规则一处也没匹配到（模式 ${pattern.source}）——空转的规则永远报不了错，先修正模式或删掉它。`)
    }
  }
}

// README 已经不写测试数了（原来的「N 项测试」一句不在文档里），那条规则在当前
// README 上一处也匹配不到，属于空转，已删除。要在这里重新挂规则，先确认它能命中。
checkFile('docs/verify.md', [
  { pattern: /^(\d+) 项，覆盖/gm, expected: tests, label: '测试数' },
  { pattern: /tests (\d+) \/ pass/g, expected: tests, label: 'tests 计数' },
  { pattern: /pass (\d+) \/ fail/g, expected: passes, label: 'pass 计数' },
  { pattern: /接口一致性检查通过（(\d+) 个文件）/g, expected: scannedFiles, label: '扫描文件数' },
  {
    pattern: /语言检查验证 (\d+) 个语言键及 (\d+) 处引用/g,
    expected: [clientKeys, clientRefs],
    label: ['语言键数', '语言引用数'],
  },
])

if (problems.length === 0) {
  console.log(`文档数字一致：测试 ${String(tests)}，通过 ${String(passes)}，扫描文件 ${String(scannedFiles)}，语言键 ${String(clientKeys)}，引用 ${String(clientRefs)}。`)
  process.exit(0)
}

console.error('文档数字与实测不符：')
for (const problem of problems) console.error(`  ${problem}`)
process.exit(1)
