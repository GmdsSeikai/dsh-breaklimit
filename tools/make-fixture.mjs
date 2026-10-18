// 从目标宿主的 HEAD 生成固定版本夹具。
//
// 夹具是补丁目标的干净副本：全部内容经 git 读取提交里的那一版，不读工作树。
// 这一点是关键——工作树可能已经带着别的插件的改动，拿它当基准，预检会一路
// 通过而实际宿主早已偏离，那比没有基准更危险。
//
// 用法: node tools/make-fixture.mjs <宿主根> <夹具目录>

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { targetPaths } from '../src/patch/index.js'

const [hostRoot, outDir] = process.argv.slice(2)
if (hostRoot === undefined || outDir === undefined) {
  console.error('用法: node tools/make-fixture.mjs <宿主根> <夹具目录>')
  process.exit(2)
}

function git(args) {
  return execFileSync('git', ['-C', hostRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

// 先确认这是一个 git 仓库，且指定的修订确实存在。
try {
  git(['rev-parse', '--verify', 'HEAD'])
} catch (error) {
  console.error(`无法读取 ${hostRoot} 的 HEAD：${String(error?.message ?? error)}`)
  process.exit(2)
}

const written = []
for (const relative of targetPaths()) {
  let content
  try {
    content = git(['show', `HEAD:${relative}`])
  } catch {
    console.error(`跳过（HEAD 中不存在）：${relative}`)
    continue
  }
  const destination = path.join(outDir, ...relative.split('/'))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  // 原样写入并统一为 LF：git show 已按文本输出，不再做行尾转换。
  fs.writeFileSync(destination, content, 'utf8')
  written.push(relative)
}

console.log(`已导出 ${String(written.length)} 个文件到 ${outDir}`)
for (const relative of written) console.log(`  ${relative}`)
