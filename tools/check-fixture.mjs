// 在固定版本夹具上跑全量预检。
//
// 夹具是目标宿主 HEAD 的目标文件副本，放在临时目录。本脚本只读夹具，
// 不触碰宿主，也不写任何文件——它回答的是"这批补丁声明在当前版本上
// 会命中还是会被拒绝"，而不是"打上去之后会怎样"。
//
// 用法: node tools/check-fixture.mjs <夹具根目录>

import fs from 'node:fs'
import { PATCHES, DSH_TARGET } from '../src/patch/index.js'
import { PATCH_HASHES } from '../src/patch/hashes.js'
import { preflight } from '../src/patch/preflight.js'

const root = process.argv[2]
if (root === undefined || root === '') {
  console.error('用法: node tools/check-fixture.mjs <夹具根目录>')
  process.exit(2)
}

const LABELS = {
  applied: '已应用',
  pending: '待应用',
  conflict: '冲突',
  missing: '缺失',
  satisfied: '已满足',
  unsatisfied: '未满足',
}

const readFile = (file) => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

const result = preflight({ root, patches: PATCHES, readFile, hashes: PATCH_HASHES })

console.log(`目标宿主 ${DSH_TARGET.version} @ ${DSH_TARGET.commit.slice(0, 12)}`)
console.log(`预检 ${result.ok ? '通过' : '阻断'}`)
for (const finding of result.findings) {
  const label = LABELS[finding.state] ?? finding.state
  console.log(`  ${finding.patchId}  ${label}  ${finding.hits}/${finding.expected}  ${finding.path}`)
}
for (const item of result.blocked) {
  console.log(`  阻断 ${item.patchId}  ${item.path}  ${item.reason}`)
}
console.log(`待写入 ${result.changes.size} 个文件`)

process.exit(result.ok ? 0 : 1)
