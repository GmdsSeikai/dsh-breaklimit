// 一步到位的自检：建临时夹具、跑全量预检、报告结论、清理现场。
//
// 宿主根取参数或环境变量；取不到时明确报出来并退出（码 2），而不是猜一个根然后
// 对着错误的树宣称通过。这里不做「从进程入口推导」那一级：本进程的 argv[1] 是
// 自检脚本自己，推不出宿主树，硬加一级只会把未配置伪装成已配置。脚本没有宿主根
// 时可走的路径只有这一条——`npm run check:host -- <宿主根>`，npm 需要 `--` 才会
// 把参数交给脚本。
//
// 夹具从宿主 HEAD 导出，全程只读宿主、只写临时目录。它回答的是"这批补丁声明与
// 目标版本是否对齐"，不是"打上去之后会怎样"——后者需要真实装载。
//
// 用法: node tools/selfcheck.mjs [宿主根]

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { DSH_TARGET, PATCHES, targetPaths } from '../src/patch/index.js'
import { PATCH_HASHES } from '../src/patch/hashes.js'
import { preflight } from '../src/patch/preflight.js'

const hostRoot = (process.argv[2] ?? process.env.DSH_BREAKLIMIT_HOST_ROOT ?? '').trim()
if (hostRoot === '') {
  console.error('用法: node tools/selfcheck.mjs <宿主根>')
  console.error('      npm run check:host -- <宿主根>   # npm 需要 -- 才会把参数交给脚本')
  console.error('或设置环境变量 DSH_BREAKLIMIT_HOST_ROOT。')
  process.exit(2)
}

function git(args) {
  return execFileSync('git', ['-C', hostRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

try {
  git(['rev-parse', '--verify', 'HEAD'])
} catch (error) {
  console.error(`无法读取 ${hostRoot} 的 HEAD：${String(error?.message ?? error)}`)
  process.exit(2)
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-selfcheck-'))
let exitCode = 0

try {
  let exported = 0
  for (const relative of targetPaths()) {
    let content
    try {
      content = git(['show', `HEAD:${relative}`])
    } catch {
      console.error(`HEAD 中不存在：${relative}`)
      continue
    }
    const destination = path.join(fixture, ...relative.split('/'))
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, content, 'utf8')
    exported += 1
  }

  // 宿主能力断言：这些条目只校验、不改文件，所以不占补丁位。
  // 少一项就说明这批声明所依赖的宿主形态变了，预检通过也不代表能用。
  const capabilities = [
    ['packages/bundle/base/cordis.patch.yml', 'fetchProvider: http', 'base 未启用 fetch'],
    ['packages/bundle/base/cordis.patch.yml', '- id: web-fetch-http', 'base 缺 web-fetch-http 行'],
    ['packages/bundle/base/package.json', '"@deepseek-ai/dsh-web-fetch-http": "workspace:*",', '依赖清单缺 web-fetch 包'],
    ['packages/bundle/web-app/presets/cordis.patch.yml', 'fetch: true', 'cordis preset 未启用 fetch'],
    ['packages/bundle/web-app/presets/standard.patch.yml', 'fetch: true', 'standard preset 未启用 fetch'],
    ['packages/bundle/web-app/presets/ptc.patch.yml', 'fetch: true', 'ptc preset 未启用 fetch'],
    ['packages/bundle/sdk-minimal/cordis.patch.yml', 'includeHarnessIdentity: false', 'sdk-minimal 仍带宿主身份'],
    ['packages/bundle/sdk-minimal/cordis.patch.yml', 'includeRuntimeContext: false', 'sdk-minimal 仍带运行时自述'],
  ]
  const missingCapabilities = []
  for (const [relative, needle, message] of capabilities) {
    let content = ''
    try {
      content = git(['show', `HEAD:${relative}`])
    } catch {
      missingCapabilities.push(`${message}（HEAD 中读不到 ${relative}）`)
      continue
    }
    if (!content.includes(needle)) missingCapabilities.push(`${message}（缺 ${needle}）`)
  }

  const readFile = (file) => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }

  const result = preflight({
    root: fixture,
    patches: PATCHES,
    readFile,
    hashes: PATCH_HASHES,
  })

  console.log(`目标宿主 ${DSH_TARGET.version} @ ${DSH_TARGET.commit.slice(0, 12)}`)
  console.log(`夹具      ${String(exported)} 个文件（从 HEAD 导出，宿主未被写入）`)
  console.log(`预检      ${result.ok ? '通过' : '阻断'}`)
  console.log(`目标      ${String(result.findings.length)} 条，待写入 ${String(result.changes.size)} 个文件`)

  if (PATCH_HASHES === null) {
    console.log('预哈希    缺失：预检会阻断全部目标。跑 tools/collect-hashes.mjs 重新生成。')
  }

  for (const item of result.blocked) {
    console.log(`  阻断 ${item.patchId}  ${item.path}  ${item.reason}`)
  }

  if (missingCapabilities.length > 0) {
    console.log(`能力断言  ${String(missingCapabilities.length)} 项未通过：`)
    for (const item of missingCapabilities) console.log(`  ${item}`)
  } else {
    console.log('能力断言  通过')
  }

  exitCode = result.ok && missingCapabilities.length === 0 ? 0 : 1
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}

process.exit(exitCode)
