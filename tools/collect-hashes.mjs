// 从目标宿主的 HEAD 采集补丁目标的整文件哈希，写进 patches/hashes.json。
//
// 预哈希把「宿主的这一版」钉进声明里：Apply 之前拿它比对实时文件，不符即拒绝。
// 它换来的是两件事——升级或外部改动导致的失配变成一次显式失败，而不是打歪；
// 重复应用被识别为「已应用」而不是「再打一次」。代价是宿主每次升级都要重采。
//
// 采集源固定是 HEAD，不是工作树。工作树可能已经带着别的改动，拿它当基准会让
// 预检对着一个已经偏离的版本宣称通过。
//
// 用法: node tools/collect-hashes.mjs <宿主根>

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { DSH_TARGET, PATCHES } from '../src/patch/index.js'

const hostRoot = process.argv[2]
if (hostRoot === undefined || hostRoot === '') {
  console.error('用法: node tools/collect-hashes.mjs <宿主根>')
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

const files = {}
let collected = 0
let skipped = 0

for (const patch of PATCHES) {
  for (const target of patch.targets) {
    let content
    try {
      content = git(['show', `HEAD:${target.path}`])
    } catch {
      console.error(`跳过（HEAD 中不存在）：${target.path}`)
      skipped += 1
      continue
    }
    const hash = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
    if (files[patch.id] === undefined) files[patch.id] = {}
    files[patch.id][target.path] = hash
    collected += 1
  }
}

const destination = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'patch', 'hashes.json')
const payload = {
  dsh: DSH_TARGET,
  generatedAt: new Date().toISOString(),
  note: '由 tools/collect-hashes.mjs 从宿主 HEAD 生成。手工编辑会让预检与目标版本脱节。',
  files,
}
fs.writeFileSync(destination, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

console.log(`已写入 ${destination}`)
console.log(`采集 ${String(collected)} 条，跳过 ${String(skipped)} 条`)
