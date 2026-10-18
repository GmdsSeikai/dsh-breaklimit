// 危险操作预检：给一个路径，回它会造成多大的动静。
//
// 只读：不删、不写、不改权限。目的是让「删除 / 覆盖 / 强制推送」这类动作在发生前
// 有一次可看的数字——命中多少文件、多大、在不在 git 仓库里、有没有未提交改动。
//
// 每一项都设上限：文件遍历最多数到 5000 个，git 命令 4 秒超时。预检本身不该变成
// 新的风险来源。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const MAX_FILES = 5000
const GIT_TIMEOUT_MS = 4000

function runGit(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function walk(target) {
  const stat = fs.statSync(target)
  if (stat.isFile()) return { files: 1, bytes: stat.size, capped: false }
  let files = 0
  let bytes = 0
  let capped = false
  const stack = [target]
  while (stack.length > 0 && files < MAX_FILES) {
    const dir = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      try {
        bytes += fs.statSync(full).size
      } catch {
        // 读不到就跳过：预检不该因为一个坏链接整体失败
      }
      files += 1
      if (files >= MAX_FILES) { capped = true; break }
    }
  }
  return { files, bytes, capped }
}

/**
 * 预检一个路径。
 *
 * @param {object} input
 * @param {string} input.target - 文件或目录；相对路径按 cwd 解析。
 * @param {string} [input.cwd] - 判定「是否越出工作区」的基准，默认 process.cwd()。
 * @returns {{ ok: boolean, target: string, inside: boolean, isDir: boolean,
 *   files: number, bytes: number, capped: boolean, gitRepo: boolean|null,
 *   dirty: number|null, reason?: string }}
 */
export function inspectTarget({ target, cwd = process.cwd() }) {
  const absolute = path.resolve(cwd, String(target ?? ''))
  const base = {
    ok: false, target: absolute, inside: absolute === cwd || absolute.startsWith(`${cwd}${path.sep}`),
    isDir: false, files: 0, bytes: 0, capped: false, gitRepo: null, dirty: null,
  }
  let stat
  try {
    stat = fs.statSync(absolute)
  } catch (error) {
    return { ...base, reason: `路径不可读：${String(error?.message ?? error)}` }
  }
  const counts = walk(absolute)
  const probe = stat.isDirectory() ? absolute : path.dirname(absolute)
  const insideWorkTree = runGit(probe, ['rev-parse', '--is-inside-work-tree'])
  const gitRepo = insideWorkTree === 'true'
  let dirty = null
  if (gitRepo) {
    const status = runGit(probe, ['status', '--porcelain', '--', absolute])
    dirty = status === null ? null : status === '' ? 0 : status.split('\n').length
  }
  return {
    ...base,
    ok: true,
    isDir: stat.isDirectory(),
    files: counts.files,
    bytes: counts.bytes,
    capped: counts.capped,
    gitRepo,
    dirty,
  }
}

/** 人读的预检报告。 */
export function formatGuard(report) {
  if (!report.ok) return `预检失败  ${report.target}\n  ${report.reason ?? ''}`.trimEnd()
  const lines = [
    `目标      ${report.target}`,
    `类型      ${report.isDir ? '目录' : '文件'}`,
    `规模      ${String(report.files)} 个文件${report.capped ? `（已数到上限 ${String(MAX_FILES)}，真实数量更多）` : ''}，${String(report.bytes)} 字节`,
    `工作区    ${report.inside ? '在内' : '在工作区外'}`,
    `git       ${report.gitRepo === null ? '不可判定' : report.gitRepo ? '是仓库' : '不是仓库'}`,
  ]
  if (report.dirty !== null) lines.push(`未提交    ${String(report.dirty)} 项`)
  return lines.join('\n')
}
