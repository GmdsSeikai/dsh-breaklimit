// 预哈希清单的加载器。
//
// hashes.json 由 tools/collect-hashes.mjs 从目标宿主的 HEAD 生成，记录每个补丁
// 每个目标文件的整文件 sha256。独立成模块是为了让 patches/index.js 保持纯声明：
// 补丁声明回答"改什么"，这里回答"改之前它应当是什么样"。
//
// 读不到或解析失败时返回空表。空表意味着预检退回命中数判定，那比在加载阶段
// 抛错要好——一个坏掉的哈希文件不该让整个插件起不来，但它会让主路径失去严格性，
// 所以状态报告里会显示每条判定的哈希是否参与过。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HASHES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hashes.json')

/** @returns {Record<string, Record<string, string>> | null} 补丁 id → 路径 → 哈希。 */
export function loadPatchHashes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    const files = parsed.files
    if (files === null || typeof files !== 'object') return null
    return files
  } catch {
    return null
  }
}

/** 进程内加载一次。哈希文件在运行期不会变，重读只会带来不一致。 */
export const PATCH_HASHES = loadPatchHashes()
