// 提示词模式。
//
// 只有两档：recommended（推荐）与 unrestricted（完全解放）。正文由三部分拼成：
//   inject.md          两档共用的正文（用户可覆盖）
//   recommended.md / unrestricted.md  各自的附加段
//   tail.md            两档共用的尾部（装配在 8999，见 host/seams.js）
//
// 档位配置保存在 $DSH_HOME/breaklimit/tier.json；旧值 lean / architect / autonomous
// 一律回退到默认，不迁移、不猜测。

import path from 'node:path'
import { breaklimitDir } from '../patch/state.js'
import { atomicWrite, readTextOrNull } from '../patch/fsx.js'

export const TIERS = Object.freeze(['recommended', 'unrestricted'])
export const DEFAULT_TIER = 'recommended'

export function tierConfigPath(home) {
  return path.join(breaklimitDir(home), 'tier.json')
}

export function isValidTier(tier) {
  return typeof tier === 'string' && TIERS.includes(tier)
}

/**
 * 读取当前模式。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @returns {{ kind: 'ok' | 'default' | 'corrupt', tier: string, raw?: string }}
 */
export function readTier(home) {
  const filePath = tierConfigPath(home)
  const raw = readTextOrNull(filePath)
  if (raw === null) return { kind: 'default', tier: DEFAULT_TIER }

  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed?.tier === 'string' && isValidTier(parsed.tier)) {
      return { kind: 'ok', tier: parsed.tier }
    }
    return { kind: 'corrupt', tier: DEFAULT_TIER, raw }
  } catch {
    return { kind: 'corrupt', tier: DEFAULT_TIER, raw }
  }
}

/**
 * 设置并持久化当前模式。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string} tier - 目标模式。
 * @returns {{ ok: boolean, tier: string }}
 */
export function writeTier(home, tier) {
  if (!isValidTier(tier)) {
    throw new Error(`Invalid tier: \`${String(tier)}\`. Allowed: ${TIERS.join(', ')}`)
  }
  const filePath = tierConfigPath(home)
  const payload = {
    tier,
    updatedAt: new Date().toISOString(),
  }
  atomicWrite(filePath, `${JSON.stringify(payload, null, 2)}\n`)
  return { ok: true, tier }
}

/**
 * 拼装某一档的头部正文：共用正文 + 该档附加段。
 *
 * @param {string} tier - 选定模式。
 * @param {string} baseText - inject.md 的正文。
 * @param {string} extensionText - recommended.md 或 unrestricted.md 的正文。
 * @returns {string} 实际生效的头部文本。
 */
export function buildTierPrompt(tier, baseText = '', extensionText = '') {
  const base = typeof baseText === 'string' ? baseText : ''
  const extension = typeof extensionText === 'string' ? extensionText : ''
  if (base === '') return extension
  if (extension === '') return base
  return `${base}\n\n${extension}`
}

/**
 * 解析并生成当前模式的完整信息。
 *
 * kind 一并带出：文件损坏时实际生效的是缺省档，只报档位名会让一次损坏看起来像
 * 本来就在用默认档。调用方据此把损坏报进状态。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string} baseText - 共用正文。
 * @param {string} extensionText - 该档附加段。
 * @returns {{ kind: 'ok' | 'default' | 'corrupt', tier: string, text: string, bytes: number, available: readonly string[] }}
 */
export function resolveTierInfo(home, baseText = '', extensionText = '') {
  const { kind, tier } = readTier(home)
  const text = buildTierPrompt(tier, baseText, extensionText)
  const bytes = Buffer.byteLength(text, 'utf8')
  return {
    kind,
    tier,
    text,
    bytes,
    available: TIERS,
  }
}
