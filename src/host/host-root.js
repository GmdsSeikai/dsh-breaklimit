// 宿主根解析。插件允许从进程入口推导，独立 CLI 使用显式配置。
import fs from 'node:fs'
import path from 'node:path'

const HOST_ROOT_MARKERS = [
  'packages/bundle/base/cordis.patch.yml',
  'packages/boot/app-boot/src/profile.ts',
  'packages/bundle/web-app/presets',
]
// 从宿主进程入口向上最多走这么多层。源码树模式下的入口是
// apps/cli/src/bin.ts，向上三层即仓库根。
const HOST_ROOT_SEARCH_DEPTH = 6

/** 这个目录是不是宿主源码树根。 */
function isHostRoot(dir) {
  return HOST_ROOT_MARKERS.every(rel => fs.existsSync(path.join(dir, rel)))
}

/**
 * 从宿主进程的启动参数推导宿主源码树根。
 *
 * 这不是猜。三个标记路径同时存在，才说明这个目录就是补丁目标所在的那棵树；
 * 任何一项缺失就返回 null，让上层照旧报 host_root_unconfigured，而不是对着
 * 错误的树做判定。全局安装的宿主入口在 node_modules 之下，向上走不会命中标记，
 * 自然推不出源码树——那时确实没有树可补，报未配置就是正确结果。
 */
export function deriveHostRoot() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return null
  let dir = path.dirname(path.resolve(entry))
  for (let depth = 0; depth < HOST_ROOT_SEARCH_DEPTH; depth += 1) {
    if (isHostRoot(dir)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 宿主根及其来源。
 *
 * 来源必须能报出来：手填的根与推导出的根，出问题时排查路径完全不同，
 * 而 status 的每一项都要能被追到依据上。
 */
export function resolveHostRootInfo(config) {
  const configured = typeof config?.hostRoot === 'string' ? config.hostRoot.trim() : ''
  if (configured !== '') return { root: configured, source: 'config' }
  const fromEnv = process.env.DSH_BREAKLIMIT_HOST_ROOT
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return { root: fromEnv.trim(), source: 'env' }
  const derived = deriveHostRoot()
  return derived === null ? { root: null, source: 'none' } : { root: derived, source: 'derived' }
}

/** 宿主根。取不到返回 null，调用方照旧报未配置。 */
export function resolveHostRoot(config) {
  return resolveHostRootInfo(config).root
}
