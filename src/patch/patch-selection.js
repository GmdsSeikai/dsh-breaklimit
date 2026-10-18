// 补丁的选择状态：哪些补丁参与预检与应用。
//
// 配置存在 $DSH_HOME/breaklimit/patches.json，记的是「禁用集」而不是「启用集」——
// 这样将来新增的补丁默认就是启用的，不必回头改配置。
//
// 容错口径与 readTier 一致：配置缺失、损坏、字段类型不对一律退回「全部启用」，
// 绝不因为一个坏配置文件就把所有补丁关掉。

import path from 'node:path'

import { PATCHES, normalizePatchMode, patchesForMode, resolvedAfter } from './index.js'
import { atomicWrite, readTextOrNull } from './fsx.js'
import { breaklimitDir } from './state.js'

/**
 * 选择配置的格式版本。
 *
 * 与 state.json 的策略有意不同：state.json 存的是崩溃恢复信息，版本不符意味着
 * 恢复信息不可信，必须让调用方停下来报错；这里存的是偏好，版本不符只退回默认
 * 并让人看见，不该因此让插件不可用。
 */
export const SELECTION_VERSION = 1

/** 声明里存在的全部补丁 id。 */
export function knownPatchIds() {
  return PATCHES.map(patch => patch.id)
}

/** 选择配置的文件路径。 */
export function selectionPath(home) {
  return path.join(breaklimitDir(home), 'patches.json')
}

/**
 * 读取禁用集。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @returns {{ kind: 'ok' | 'default' | 'corrupt', disabled: string[] }}
 */
export function readDisabled(home) {
  const raw = readTextOrNull(selectionPath(home))
  if (raw === null) return { kind: 'default', disabled: [] }

  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'corrupt', disabled: [] }
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.disabled)) {
    return { kind: 'corrupt', disabled: [] }
  }
  // 版本判定排在这里，而不是最前面：字段缺失要视为当前版本——加这个字段之前
  // 写出的文件就是同一格式，先比版本会把它们全部判成不匹配。
  if (parsed.version !== undefined && parsed.version !== SELECTION_VERSION) {
    return { kind: 'version_mismatch', disabled: [] }
  }

  // 未知 id 直接丢掉：它可能来自旧版本或被手工改过，留着只会让过滤变成猜测。
  const known = new Set(knownPatchIds())
  const disabled = [...new Set(parsed.disabled.filter(id => typeof id === 'string' && known.has(id)))].sort()
  return { kind: 'ok', disabled }
}

/**
 * 写入禁用集，只保留已知 id。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string[]} ids - 期望禁用的补丁 id。
 * @returns {{ disabled: string[] }}
 */
export function writeDisabled(home, ids) {
  const known = new Set(knownPatchIds())
  const filtered = Array.isArray(ids) ? ids : []
  const disabled = [...new Set(filtered.filter(id => typeof id === 'string' && known.has(id)))].sort()
  const payload = { version: SELECTION_VERSION, disabled, updatedAt: new Date().toISOString() }
  atomicWrite(selectionPath(home), `${JSON.stringify(payload, null, 2)}\n`)
  return { disabled }
}

/**
 * 按配置过滤补丁，顺序与声明一致。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @returns {ReadonlyArray<object>}
 */
export function resolvePatches(home, mode = 'recommended') {
  const active = normalizePatchMode(mode)
  const { disabled } = readDisabled(home)
  const skip = new Set(disabled)
  return patchesForMode(active)
    .filter(patch => !skip.has(patch.id))
    .map(patch => ({
      ...patch,
      targets: patch.targets.map(target => ({ ...target, after: resolvedAfter(target, active) })),
    }))
}

/**
 * 切换一条补丁的启用状态。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string} id - 补丁 id，必须是声明里存在的。
 * @param {boolean} enabled - 目标状态。
 * @returns {{ disabled: string[] }} 切换后的完整禁用集。
 */
export function setPatchEnabled(home, id, enabled) {
  if (!knownPatchIds().includes(id)) {
    throw new Error(`Unknown patch id: \`${String(id)}\``)
  }
  const { disabled } = readDisabled(home)
  const next = new Set(disabled)
  if (enabled) next.delete(id)
  else next.add(id)
  return writeDisabled(home, [...next])
}
