// 文件系统基础工具：内容哈希与原子写入。
//
// 原子写入用同目录临时文件加改名。改名在同一文件系统上是原子的，所以任何
// 时刻读到的要么是完整旧内容，要么是完整新内容——不会出现被截断的目标文件。
// 直接覆写会留下一个中间态窗口，而写坏的正是一个正在被宿主加载的文件。

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 内容的 sha256 摘要。用于状态清单里的前后哈希比对。 */
export function hashText(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * 原子写入。临时文件与目标同目录，保证改名不跨设备。
 * @param {string} file - 目标绝对路径。
 * @param {string} content - 完整内容。
 */
export function atomicWrite(file, content) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(file)}.bkl-${process.pid.toString(36)}-${Date.now().toString(36)}.tmp`)
  try {
    fs.writeFileSync(temp, content, 'utf8')
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // 清理失败不影响原始错误：原始错误才是调用方需要看到的那一个。
    }
    throw error
  }
}

/** 读文本，不存在或不可读时返回 null，让调用方区分"空文件"与"没有文件"。 */
export function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 文件大小，不存在时为 0。 */
export function sizeOf(file) {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

/** 目录是否存在。 */
export function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}
