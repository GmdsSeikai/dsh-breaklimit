// 诊断类操作：宿主升级向导、提示词差异、规则导入。
//
// 三件事都只有两个动作——读文件、调领域模块，不直接碰宿主源码，也不写规则以外
// 的任何位置。输出给人看，所以每条结论都带可复核的依据（文件、行号、字节）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readTextOrNull } from '../patch/fsx.js'
import { readTier } from '../context/tiers.js'
import { promptMode, readModeExtension } from '../context/prompt.js'
import * as rules from '../context/rules.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_INJECT = path.join(HERE, '..', 'context', 'inject.md')

/** 在宿主文件里找一段原文，找不到时给出「最近的替代位置」提示。 */
function locate(text, before) {
  if (text.includes(before)) return { found: true }
  const firstLine = before.split('\n')[0].trim()
  const anchor = firstLine.slice(0, 48)
  const index = anchor.length > 8 ? text.indexOf(anchor) : -1
  if (index < 0) return { found: false, hint: `连片段 ${JSON.stringify(anchor)} 也找不到` }
  const line = text.slice(0, index).split('\n').length
  const actual = text.split('\n')[line - 1].trim()
  return { found: false, hint: `第 ${String(line)} 行现在是 ${JSON.stringify(actual.slice(0, 80))}` }
}

/**
 * 宿主升级向导：逐条核对声明的原文是否还在。
 *
 * @param {string} root - 宿主源码树。
 * @param {ReadonlyArray<object>} patches - 当前模式下的补丁声明。
 * @returns {{ ok: boolean, checked: number, missing: Array<{ id: string, path: string, hint: string }> }}
 */
export function upgradeReport(root, patches) {
  const missing = []
  let checked = 0
  for (const patch of patches) {
    for (const target of patch.targets) {
      checked += 1
      const absolute = path.join(root, ...target.path.split('/'))
      const text = readTextOrNull(absolute)
      if (text === null) {
        missing.push({ id: patch.id, path: target.path, hint: '文件不存在' })
        continue
      }
      const verdict = locate(text, target.before ?? target.needle ?? '')
      if (!verdict.found) missing.push({ id: patch.id, path: target.path, hint: verdict.hint ?? '原文不在了' })
    }
  }
  return { ok: missing.length === 0, checked, missing }
}

/** 升级向导的人读输出。 */
export function formatUpgrade(report) {
  const lines = [`核对 ${String(report.checked)} 个目标，失配 ${String(report.missing.length)} 个`]
  for (const item of report.missing.slice(0, 20)) {
    lines.push(`  ${item.id}  ${item.path}`)
    lines.push(`    ${item.hint}`)
  }
  if (report.missing.length > 20) lines.push(`  其余 ${String(report.missing.length - 20)} 条省略`)
  if (!report.ok) lines.push('修复：先确认宿主里那句话变成了什么，再决定改声明还是重采哈希；不要只重采哈希。')
  return lines.join('\n')
}

/**
 * 当前头部正文与包内默认正文的差异。
 *
 * @param {string} current - 当前生效的头部文本。
 * @param {string} [baseline] - 对照文本，默认包内 inject.md。
 */
export function diffPrompt(current, baseline = readTextOrNull(DEFAULT_INJECT) ?? '') {
  const a = baseline.split('\n')
  const b = String(current ?? '').split('\n')
  const setA = new Set(a)
  const setB = new Set(b)
  const added = b.filter(line => line.trim() !== '' && !setA.has(line))
  const removed = a.filter(line => line.trim() !== '' && !setB.has(line))
  return {
    baselineLines: a.length,
    currentLines: b.length,
    baselineBytes: Buffer.byteLength(baseline, 'utf8'),
    currentBytes: Buffer.byteLength(String(current ?? ''), 'utf8'),
    added,
    removed,
  }
}

/** 差异的人读输出。 */
export function formatDiff(report) {
  const lines = [
    `默认正文   ${String(report.baselineLines)} 行 / ${String(report.baselineBytes)} 字节`,
    `当前正文   ${String(report.currentLines)} 行 / ${String(report.currentBytes)} 字节`,
    `新增行 ${String(report.added.length)}，删除行 ${String(report.removed.length)}`,
  ]
  for (const line of report.added.slice(0, 8)) lines.push(`  + ${line.slice(0, 120)}`)
  for (const line of report.removed.slice(0, 8)) lines.push(`  - ${line.slice(0, 120)}`)
  if (report.added.length + report.removed.length > 16) lines.push('  （只显示前 16 行差异）')
  return lines.join('\n')
}

/** 从文件名推出一个合法规则 id。 */
export function ruleIdFromPath(source) {
  const base = path.basename(String(source)).replace(/\.md$/iu, '')
  const id = base.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64)
  return id === '' || !/^[a-z0-9]/u.test(id) ? 'imported' : id
}

/**
 * 把一份现成的 AGENTS.md 导入成规则，不激活。
 *
 * @param {string} home - $DSH_HOME。
 * @param {string} source - 源文件路径。
 * @param {object} [options] - id 与落点覆盖。
 * @returns {{ ok: boolean, id?: string, bytes?: number, reason?: string }}
 */
export function importRule(home, source, options = {}) {
  const absolute = path.resolve(String(source ?? ''))
  const text = readTextOrNull(absolute)
  if (text === null) return { ok: false, reason: `读不到 ${absolute}` }
  if (text.trim() === '') return { ok: false, reason: `${absolute} 是空文件` }
  const id = options.id ?? ruleIdFromPath(absolute)
  if (!rules.isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  const target = options.target ?? 'AGENTS.md'
  if (!rules.isValidTarget(target)) return { ok: false, reason: `非法落点：${target}` }
  const saved = rules.saveRule(home, id, text, { name: path.basename(absolute), target })
  if (!saved.ok) return { ok: false, reason: saved.reason ?? '保存失败' }
  return { ok: true, id, bytes: Buffer.byteLength(text, 'utf8') }
}

/** 当前模式的附加段字节数，供 diff 与诊断共用。 */
export function extensionBytes(home) {
  const mode = promptMode(readTier(home).tier)
  return Buffer.byteLength(readModeExtension(mode), 'utf8')
}

/** 目录是否存在，供命令做前置判断。 */
export function fileExists(target) {
  try {
    fs.accessSync(target, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}
