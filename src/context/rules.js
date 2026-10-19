// 规则服务：可切换的多套指令集。
//
// 一条规则是一份提示词正文加一个写入文件（AGENTS.md 或 CLAUDE.md）。激活做两件事：
// 把正文写进 `$DSH_HOME/<写入文件>`，并让 systemPrompt 段实时读到它。
//
// 两条通道都要，因为作用方式不同：写盘那一路会被宿主当用户全局指令加载，但受字节
// 预算限制；直接注入是无条件的，但只作用于提示词层。
//
// 存储（v2）：
//   breaklimit/rules.json           清单：规则元数据、激活态、落点快照、版本号
//   breaklimit/bodies/<id>.md       规则正文
//   breaklimit/landings/<target>.txt 激活前的原文（仅当那个文件本来就有内容）
//
// 落点的处置一律基于**激活那一刻的快照**，不基于当前元数据。快照记两件事：这个
// 文件是插件创建的（created），还是本来就有内容（原文存进 landings）。由此三种终态：
// 被外部改过就原样保留；我们创建的就删掉；本来就有的就写回原内容。
//
// 写序与互斥（#4 #6）：
//   落点正文可能被外部改动，而清单只有一个入口。所以写落点之前先把激活意图写进
//   清单（active/landing + pendingActivation 标记），落点写成功再清掉标记；任何一步
//   失败都回滚，绝不留下「落点已换、清单说没激活」。五个写入口都在同一把跨进程锁内
//   完成「读清单 → 改 → 写清单」，清单另有 revision 递增做第二道版本校验。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { atomicWrite, hashText, readTextOrNull } from '../patch/fsx.js'
import { acquireFileLock, releaseFileLock } from '../patch/lock.js'
import { breaklimitDir } from '../patch/state.js'

export const RULE_TARGETS = ['AGENTS.md', 'CLAUDE.md']
export const MAX_RULE_BYTES = 512 * 1024
export const INDEX_VERSION = 2

// 规则 id 同时是磁盘上的文件名，字符集因此收得比较窄：首字符字母或数字，其余只允许
// 字母、数字、点、下划线、连字符。这里写成显式判断而不是一条把长度编进量词的正则，
// 是为了让「长度上限」和「字符集」分成两件事读——它们约束的来源本来就不同。
const RULE_ID_MAX = 64
const RULE_ID_CHARS_RE = /^[a-zA-Z0-9._-]*$/

// 名字是给人看的展示文本，不落成文件名，所以不和 id 共用上限：id 受文件名约束，
// 名字只受展示约束，这里给得更宽。截断按码点计数而不是按 UTF-16 单元，否则 emoji
// 这类非 BMP 字符会被 slice 切成半个代理对，写进清单就是一个坏字符。
const NAME_LIMIT = 96

// 锁事务 id 与临时文件名的去重计数：同一毫秒内的连续调用不能撞名。
let lockSequence = 0
let writeSequence = 0

export function rulesIndexPath(home) {
  return path.join(breaklimitDir(home), 'rules.json')
}

/** 兼容旧名：激活态现在存在 rules.json 里。 */
export function rulesStatePath(home) {
  return rulesIndexPath(home)
}

export function bodiesDir(home) {
  return path.join(breaklimitDir(home), 'bodies')
}

export function landingsDir(home) {
  return path.join(breaklimitDir(home), 'landings')
}

export function ruleTextPath(home, id) {
  return path.join(bodiesDir(home), `${id}.md`)
}

export function landingPath(home, target) {
  if (!isValidTarget(target)) throw new Error(`目标文件名非法：${String(target)}`)
  return path.join(landingsDir(home), target)
}

/** 规则 id 同时是文件名，只允许字母开头的一小段安全字符。 */
export function isValidRuleId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > RULE_ID_MAX) return false
  if (!/[a-zA-Z0-9]/.test(id[0])) return false
  return RULE_ID_CHARS_RE.test(id.slice(1))
}

export function isValidTarget(target) {
  return typeof target === 'string' && RULE_TARGETS.includes(target)
}

/** 写入文件：`$DSH_HOME/<target>`。 */
export function targetPath(home, target) {
  if (!isValidTarget(target)) throw new Error(`目标文件名非法：${String(target)}`)
  return path.join(home, target)
}

function messageOf(error) {
  return String(error?.message ?? error)
}

/**
 * 结构化失败。`reason` 与 `message` 同值：HTTP 路由与宿主命令都读 `reason`，
 * 新调用方读 `code` 分流。
 */
function failure(code, message, extra = {}) {
  return { ok: false, code, message, reason: message, ...extra }
}

function corruptIndexFailure() {
  return failure('index_corrupt', '规则清单已损坏，插件已停止写入以保护原数据')
}

/** 清单版本冲突：读写之间有人改过 rules.json。 */
function conflictError() {
  const error = new Error('规则清单在读写之间被改动，本次写入已取消')
  error.code = 'conflict'
  return error
}

/**
 * 在规则锁内跑一段同步临界区。锁被占用时立即返回结构化失败，不排队。
 *
 * 锁文件与补丁事务共用 `$DSH_HOME/breaklimit/operation.lock`：两边改的是同一个
 * DSH_HOME，互相排斥本来就是对的。
 *
 * @param {string} home - $DSH_HOME。
 * @param {string} operation - 操作名，进事务 id 便于排查。
 * @param {() => object} run - 同步临界区。
 */
function withRulesLock(home, operation, run) {
  lockSequence += 1
  const operationId = `rules-${operation}-${process.pid.toString(36)}-${String(lockSequence)}`
  let handle
  try {
    handle = acquireFileLock(home, operationId)
  } catch (error) {
    return failure('locked', `获取规则锁失败：${messageOf(error)}`)
  }
  if (handle === null || typeof handle !== 'object' || handle.conflict !== undefined) {
    const holder = handle?.conflict?.holder ?? null
    const who = holder === null
      ? '另一个操作'
      : `另一个操作（${String(holder.operationId ?? '未知事务')}，pid ${String(holder.pid ?? '未知')}）`
    return failure('locked', `规则正在被${who}占用，本次操作已取消`)
  }
  try {
    return run()
  } finally {
    releaseFileLock(handle)
  }
}

/**
 * 元数据归一，**只服务读取路径**：非法 target 回落到 `RULE_TARGETS[0]`，一份带坏字段的
 * 旧清单仍能读出来（见 `readIndex`）。
 *
 * 写入路径不许靠这里兜底：`saveRule` / `activateRule` 用 `hasInvalidTarget` 拒绝，否则
 * 调用方以为写到了 `CLAUDE.md` 或某个指定文件，实际被静默改写成 `AGENTS.md`。
 */
function normalizeMeta(id, meta) {
  const rawName = meta?.name
  const name = typeof rawName === 'string' && rawName.trim() !== ''
    ? [...rawName.trim()].slice(0, NAME_LIMIT).join('')
    : id
  const target = isValidTarget(meta?.target) ? meta.target : RULE_TARGETS[0]
  return { name, target }
}

/** 写入路径的判定：没给 target 不算非法（沿用旧值或回落），给了但不是允许的文件才算。 */
function hasInvalidTarget(meta) {
  return meta !== null
    && typeof meta === 'object'
    && meta.target !== undefined
    && !isValidTarget(meta.target)
}

/** 写入路径遇到非法 target 的结构化失败；读取路径不返回它。 */
function invalidTargetFailure(target) {
  return failure(
    'invalid_target',
    `非法 target：${String(target)}；只能是 ${RULE_TARGETS.join(' / ')}。`,
  )
}

/** 落点快照。字段不全或类型不对时返回 null——读不出来就当没有，保守处理。 */
function normalizeLanding(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isValidTarget(raw.target)) return null
  if (typeof raw.created !== 'boolean') return null
  return { target: raw.target, created: raw.created }
}

/**
 * 未提交的激活意图。字段不全就返回 null——读不出意图时按「没有未完成激活」处理，
 * 落点处置仍然只看 landings 快照，不靠意图推断。
 */
function normalizePending(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!isValidRuleId(raw.id) || !isValidTarget(raw.target)) return null
  const previous = raw.previous !== null && typeof raw.previous === 'object'
    ? { id: raw.previous.id ?? null, landing: normalizeLanding(raw.previous.landing) }
    : null
  return {
    id: raw.id,
    target: raw.target,
    created: raw.created === true,
    snapshot: raw.snapshot === true,
    previous,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
  }
}

function emptyIndex() {
  return { version: INDEX_VERSION, revision: 0, rules: [], active: null, landing: null, pendingActivation: null }
}

/**
 * 读清单。文件缺失、损坏、版本不符一律退回空清单：偏好坏了不该让插件不可用。
 *
 * `revision` 是写入版本号，缺省按 0 读；`pendingActivation` 是未提交的激活意图，
 * 只用于诊断与恢复，处置落点时不用它。
 *
 * `invalidTargets` 是读取期的诊断，不进清单：记录 target 非法、被回落成 `AGENTS.md`
 * 的那些规则。列表照常展示（清单坏了不该让插件不可用），但 `activateRule` 拿它拒绝
 * 激活——按回落值写盘就是静默改写。
 *
 * @param {string} home - $DSH_HOME。
 * @returns {{ version: number, revision: number,
 *   rules: Array<{id:string,name:string,target:string,activatedAt:string|null}>,
 *   active: string | null, landing: object | null, pendingActivation: object | null,
 *   invalidTargets: Array<{ id: string, target: unknown }>,
 *   kind: 'ok' | 'absent' | 'corrupt' }}
 */
export function readIndex(home) {
  const raw = readTextOrNull(rulesIndexPath(home))
  if (raw === null) return { ...emptyIndex(), invalidTargets: [], kind: 'absent' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...emptyIndex(), invalidTargets: [], kind: 'corrupt' }
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.version !== INDEX_VERSION) {
    return { ...emptyIndex(), invalidTargets: [], kind: 'corrupt' }
  }
  const revision = Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0
  const seen = new Set()
  const invalidTargets = []
  const rules = []
  for (const entry of Array.isArray(parsed.rules) ? parsed.rules : []) {
    const id = entry?.id
    if (!isValidRuleId(id) || seen.has(id)) continue
    seen.add(id)
    const meta = normalizeMeta(id, entry)
    if (hasInvalidTarget(entry)) invalidTargets.push({ id, target: entry.target })
    rules.push({
      id,
      name: meta.name,
      target: meta.target,
      activatedAt: typeof entry?.activatedAt === 'string' ? entry.activatedAt : null,
    })
  }
  const active = isValidRuleId(parsed.active) && seen.has(parsed.active) ? parsed.active : null
  return {
    version: INDEX_VERSION,
    revision,
    rules,
    active,
    landing: normalizeLanding(parsed.landing),
    pendingActivation: normalizePending(parsed.pendingActivation),
    invalidTargets,
    kind: 'ok',
  }
}

/**
 * 写清单，带版本校验。
 *
 * 期望版本与实际不符时抛 `code='conflict'`，一个字节都不写。校验发生在临时文件
 * 落盘之后、改名之前：窗口尽量窄。这不是原子的比较交换，同进程并发靠锁挡住；
 * 这一层挡的是不守锁的写者（手工编辑、另一个版本的工具）。
 *
 * @param {string} home - $DSH_HOME。
 * @param {object} index - 新清单内容。
 * @param {number} [expectedRevision] - 读到的版本号；缺省时按当前版本自增。
 * @param {object} [options] - 写入选项。
 * @param {boolean} [options.allowCorruptOverwrite] - 是否允许覆写损坏的清单（仅恢复流程可用）。
 * @returns {number} 写入后的版本号。
 */
function writeIndex(home, index, expectedRevision, { allowCorruptOverwrite = false } = {}) {
  const current = readIndex(home)
  if (current.kind === 'corrupt' && !allowCorruptOverwrite) {
    const error = new Error('规则清单已损坏，插件已停止写入以保护原数据')
    error.code = 'index_corrupt'
    throw error
  }
  const file = rulesIndexPath(home)
  const revision = expectedRevision === undefined
    ? current.revision + 1
    : expectedRevision + 1
  const payload = {
    version: INDEX_VERSION,
    revision,
    rules: index.rules,
    active: index.active ?? null,
    // 落点归属不跟 active 绑定：删除激活中的规则时落点可能没法处置，此时 active 已清空
    // 而 landing 要留着，否则 `landings/<target>.txt` 失去唯一入口（#5 同类问题）。
    // 需要清空归属的入口（取消激活、正常删除、重置）显式写 null。
    landing: index.landing ?? null,
    pendingActivation: index.pendingActivation ?? null,
  }
  writeSequence += 1
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.bkl-${process.pid.toString(36)}-${Date.now().toString(36)}-${String(writeSequence)}.tmp`,
  )
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    if (expectedRevision !== undefined && readIndex(home).revision !== expectedRevision) {
      throw conflictError()
    }
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // 清理失败不盖住原始错误。
    }
    throw error
  }
  return revision
}

/** 把 writeIndex 的抛出翻成调用方读的失败形状。 */
function indexWriteFailure(error, what, extra = {}) {
  if (error?.code === 'conflict') {
    return failure('conflict', `${what}失败：${messageOf(error)}`, extra)
  }
  return failure('index_write_failed', `${what}失败：${messageOf(error)}`, extra)
}

/**
 * 读激活态。
 *
 * `landing` 是激活那一刻的落点快照；没有它时必须选择「不动落点」，而不是按元数据
 * 推断——推断正是这一整类问题的来源。
 *
 * `id` 为 null 时 `landing` 仍可能非空：删除激活中的规则、落点又没被处置时，归属留在
 * 清单里，快照还能从这里找到（`landingPath(home, landing.target)`）。
 */
export function readActiveState(home) {
  const index = readIndex(home)
  return { id: index.active, landing: index.landing }
}

/** 当前激活的规则 id；没有或读不出则为 null。 */
export function readActive(home) {
  return readIndex(home).active
}

export function readRuleMeta(home, id) {
  const entry = readIndex(home).rules.find(rule => rule.id === id)
  return normalizeMeta(id, entry ?? {})
}

/** 列出全部规则，含大小与激活态。 */
export function listRules(home) {
  const index = readIndex(home)
  return index.rules
    .map((rule) => {
      let bytes = 0
      try {
        bytes = fs.statSync(ruleTextPath(home, rule.id)).size
      } catch {
        // 正文缺失时 size 记 0，规则仍然列出，便于用户看到并修。
      }
      return { id: rule.id, name: rule.name, target: rule.target, bytes, active: index.active === rule.id }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function readRule(home, id) {
  if (!isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  const text = readTextOrNull(ruleTextPath(home, id))
  if (text === null) return { ok: false, reason: `规则不存在：${id}` }
  return { ok: true, text }
}

/** 当前激活规则的正文；没有则为空串。 */
export function activeRuleText(home) {
  const id = readActive(home)
  if (id === null) return ''
  const loaded = readRule(home, id)
  return loaded.ok ? loaded.text : ''
}

/**
 * 当前激活规则的正文；读不到则为 `null`。
 *
 * 与 `activeRuleText` 的差别是这里区分「正文是空串」和「正文看不到」：`settleLanding`
 * 收到 `null` 表示无法确认落点里的内容归谁，收到空串表示我们写进去的就是空文件。
 * 判定用 `readRule().ok`，不看字符串真假值。
 */
function activeRuleTextOrNull(home) {
  const id = readActive(home)
  if (id === null) return null
  const loaded = readRule(home, id)
  return loaded.ok ? loaded.text : null
}

/**
 * 保存（新建或覆盖）一条规则。
 *
 * 正在激活的规则同步落点之前先读落点当前内容，与**上一次写进去的正文**（保存前的
 * 旧正文）比较：一致才同步（`landingSynced`）；不一致说明落点被外部改过，跳过同步、
 * 保留外部内容（`landingStale`）。旧正文读不出来（没有正文文件）时同样按不确定处理，
 * 不覆盖落点。
 *
 * @returns {{ ok: true, id: string, meta: { name: string, target: string },
 *   landingSynced: boolean, landingStale: boolean, landingMoved: boolean, revision: number }
 *   | { ok: false, code: string, message: string, reason: string }}
 */
export function saveRule(home, id, text, meta) {
  if (!isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  if (typeof text !== 'string') return { ok: false, reason: '正文必须是字符串' }
  if (Buffer.byteLength(text, 'utf8') > MAX_RULE_BYTES) {
    return { ok: false, reason: `正文超过上限 ${String(MAX_RULE_BYTES)} 字节，未做截断` }
  }
  if (hasInvalidTarget(meta)) return invalidTargetFailure(meta.target)
  return withRulesLock(home, 'save', () => saveRuleLocked(home, id, text, meta))
}

function saveRuleLocked(home, id, text, meta) {
  const index = readIndex(home)
  if (index.kind === 'corrupt') return corruptIndexFailure()
  const existing = index.rules.find(rule => rule.id === id)
  const normalized = normalizeMeta(id, meta ?? existing ?? {})
  const previousBody = readRule(home, id)
  const previousText = previousBody.ok ? previousBody.text : null

  try {
    fs.mkdirSync(bodiesDir(home), { recursive: true })
    atomicWrite(ruleTextPath(home, id), text)
  } catch (error) {
    return failure('body_write_failed', `写入正文失败：${messageOf(error)}`, {
      bodyWritten: false,
      indexWritten: false,
      landingSynced: false,
    })
  }

  const entry = {
    id,
    name: normalized.name,
    target: normalized.target,
    activatedAt: existing?.activatedAt ?? null,
  }
  const rules = existing === undefined
    ? [...index.rules, entry]
    : index.rules.map(rule => (rule.id === id ? entry : rule))
  let revision
  try {
    revision = writeIndex(home, { ...index, rules }, index.revision)
  } catch (error) {
    return indexWriteFailure(error, '写入清单', {
      bodyWritten: true,
      indexWritten: false,
      landingSynced: false,
    })
  }

  // 正在激活的规则被改正文时，同步落点；顺序是「清单 → 落点」，因为这一步失败留下
  // 的是「清单已记新正文、落点仍是旧的」，下一次保存或取消激活能看到并处理。
  let landingSynced = false
  let landingStale = false
  if (index.active === id) {
    const target = index.landing?.target ?? normalized.target
    const current = readTarget(home, target)
    if (previousText !== null && current === previousText) {
      try {
        atomicWrite(targetPath(home, target), text)
        landingSynced = true
      } catch (error) {
        return failure('landing_write_failed', `同步写入文件失败：${messageOf(error)}`, {
          bodyWritten: true,
          indexWritten: true,
          landingSynced: false,
        })
      }
    } else {
      landingStale = true
    }
  }
  return {
    ok: true,
    id,
    meta: { name: normalized.name, target: normalized.target },
    landingSynced,
    landingStale,
    landingMoved: false,
    revision,
  }
}

/** 读写入文件当前内容。 */
function readTarget(home, target) {
  return readTextOrNull(targetPath(home, target))
}

/**
 * 落点内容指纹（sha256 前 16 位）。用于告诉用户「被改动」到底差在哪：
 * `expected` 是插件认为该文件应当有的内容，`actual` 是它现在的内容。
 * 文本拿不到就记 null，不编一个哈希出来。
 */
function fingerprint(text) {
  if (typeof text !== 'string') return null
  // hashText 统一返回 `sha256:<64 位十六进制>`；这里只要十六进制那段的前 16 位。
  return hashText(text).replace(/^sha256:/u, '').slice(0, 16)
}

/** 一条跳过记录。原因与两侧指纹一起报，用户据此判断是不是自己改的。 */
function skipEntry(file, reason, expected, actual) {
  return { path: file, reason, expected: fingerprint(expected), actual: fingerprint(actual) }
}

/**
 * 处置一个落点快照。
 *
 * @param {string} home - $DSH_HOME。
 * @param {{ target: string, created: boolean } | null} landing - 快照。
 * @param {string | null} ourText - 我们当前认为落点里应当是的那份正文。
 * @returns {{ removed: boolean, restored: boolean,
 *   skipped: Array<{ path: string, reason: string, expected: string | null, actual: string | null }> }}
 */
function settleLanding(home, landing, ourText) {
  const result = { removed: false, restored: false, skipped: [] }
  if (landing === null) return result
  const file = targetPath(home, landing.target)
  const current = readTarget(home, landing.target)

  if (current === null) {
    // 落点已经不在了：插件创建的视为达成，别人删的不认领。
    if (landing.created) result.removed = true
    return result
  }
  if (ourText === null || current !== ourText) {
    // 两侧都记：用户能看到插件写进去的是什么、现在是什么。
    result.skipped.push(skipEntry(file, '内容已被改动，保留原样', ourText, current))
    return result
  }
  if (landing.created) {
    try {
      fs.rmSync(file, { force: true })
      result.removed = true
    } catch {
      // 删除失败与内容无关：没有「应当是什么」可比，只报现状。
      result.skipped.push(skipEntry(file, '删除失败', null, current))
    }
    return result
  }
  const before = readTextOrNull(landingPath(home, landing.target))
  if (before === null) {
    // 原文丢了就绝不覆盖，报出来让人处理。
    result.skipped.push(skipEntry(file, '找不到激活前的原文，保留现状', null, current))
    return result
  }
  try {
    atomicWrite(file, before)
    fs.rmSync(landingPath(home, landing.target), { force: true })
    result.restored = true
  } catch {
    // 写回失败：expected 是没写成功的那份原文，actual 是落点当前内容。
    result.skipped.push(skipEntry(file, '写回原文失败', before, current))
  }
  return result
}

/** 删除本次刚写的落点快照；没写就什么都不做。 */
function discardSnapshot(home, target, written) {
  if (!written) return
  try {
    fs.rmSync(landingPath(home, target), { force: true })
  } catch {
    // 删不掉就留着：它记的正是落点原来的内容，多一份不是丢失。
  }
}

/** 把落点恢复成写之前的内容：原来没有文件就删掉，有就写回。 */
function restoreLanding(home, target, existing) {
  try {
    const file = targetPath(home, target)
    if (existing === null) fs.rmSync(file, { force: true })
    else atomicWrite(file, existing)
    return true
  } catch {
    return false
  }
}

/** 回滚清单。失败时调用方要如实报出来，不能装作回滚成功。 */
function rollbackIndex(home, previousIndex, expectedRevision) {
  try {
    writeIndex(home, previousIndex, expectedRevision)
    return true
  } catch {
    return false
  }
}

/**
 * 激活一条规则：写激活意图 → 写落点 → 提交意图。
 *
 * 顺序不能倒。落点先写，清单写失败时落点已是新正文而 active 是 null，
 * `landings/<target>.txt` 就失去唯一入口，用户原文永久不可恢复（#4）。先写意图，
 * 任何一步失败都能回滚到「落点原样、清单原样」；进程在中间被杀也留得下
 * `active`/`landing` 与 `pendingActivation`，恢复入口不丢。
 *
 * 接管新落点之前先处置上一条激活规则的落点，否则 A@AGENTS 切到 B@CLAUDE 会把 A 的
 * 正文永久留在 AGENTS.md 里。
 *
 * 同落点切换时，`landings/<target>.txt` 保存的是**插件第一次接管该落点时的原文**：
 * 只要这份快照还在就沿用，不拿当前落点内容覆盖它。返回值里的 `snapshotKept` 说明
 * 本次是否沿用了已有快照，供上层把提示语说准。
 */
export function activateRule(home, id) {
  if (!isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  return withRulesLock(home, 'activate', () => activateRuleLocked(home, id))
}

function activateRuleLocked(home, id) {
  const index = readIndex(home)
  if (index.kind === 'corrupt') return corruptIndexFailure()
  const loaded = readRule(home, id)
  if (!loaded.ok) return loaded
  // 清单里这条的 target 非法、读取时回落成 AGENTS.md：按回落值激活就是静默改写。
  const badTarget = index.invalidTargets.find(item => item.id === id)
  if (badTarget !== undefined) return invalidTargetFailure(badTarget.target)
  const entry = index.rules.find(rule => rule.id === id)
  const meta = normalizeMeta(id, entry ?? {})
  const file = targetPath(home, meta.target)
  const previous = index.active === null ? null : { id: index.active, landing: index.landing }

  // 同一条规则、同一个落点：保留最初的快照。若在这里重新记一次，取消激活就会把
  // 我们刚写进去的正文当成「用户原有内容」恢复回去。
  const sameRuleSameTarget = index.active === id
    && index.landing !== null
    && index.landing.target === meta.target

  let previousLanding = { removed: false, restored: false, skipped: [] }
  if (!sameRuleSameTarget && index.active !== null) {
    // 同一条规则换落点时正文刚从磁盘读出来，直接用它；否则读激活中那条的正文。
    const previousText = index.active === id ? loaded.text : activeRuleTextOrNull(home)
    previousLanding = settleLanding(home, index.landing, previousText)
  }

  const existing = readTarget(home, meta.target)

  // 落点仍归插件管、快照也还在：这份快照记的是插件第一次接管该落点时的原文。
  // 此时不能拿当前落点内容覆盖它——用户手改过落点，再激活另一条到同一落点，就会把
  // 第一次激活前的原文从插件目录里彻底冲掉。正常切换走到这里时 settleLanding 已经把
  // 原文写回落点并删掉快照，读不到快照，仍按下面的流程记新的。
  //
  // `active` 为 null 但 `landing` 还在，是「删除激活规则时落点没被处置」留下的归属：
  // 快照归这个落点，重新激活到同一落点时同样不能覆盖它。
  const slotOwned = !sameRuleSameTarget
    && index.landing !== null
    && index.landing.target === meta.target
  const snapshotKept = slotOwned && readTextOrNull(landingPath(home, meta.target)) !== null
  const landing = sameRuleSameTarget || snapshotKept
    ? index.landing
    : { target: meta.target, created: existing === null }
  let snapshotWritten = false
  if (!sameRuleSameTarget && !snapshotKept && existing !== null) {
    try {
      fs.mkdirSync(landingsDir(home), { recursive: true })
      atomicWrite(landingPath(home, meta.target), existing)
      snapshotWritten = true
    } catch (error) {
      return failure('snapshot_failed', `保存激活前原文失败：${messageOf(error)}`)
    }
  }

  const rules = index.rules.map(rule => (rule.id === id
    ? { ...rule, activatedAt: new Date().toISOString() }
    : rule))
  const intent = {
    ...index,
    rules,
    active: id,
    landing,
    pendingActivation: {
      id,
      target: meta.target,
      created: landing.created,
      snapshot: snapshotWritten,
      previous,
      startedAt: new Date().toISOString(),
    },
  }

  let intentRevision
  try {
    intentRevision = writeIndex(home, intent, index.revision)
  } catch (error) {
    // 意图没落盘，落点还没动。本次快照没有主人，删掉。
    discardSnapshot(home, meta.target, snapshotWritten)
    return indexWriteFailure(error, '写入激活意图')
  }

  try {
    atomicWrite(file, loaded.text)
  } catch (error) {
    const rolledBack = rollbackIndex(home, index, intentRevision)
    discardSnapshot(home, meta.target, snapshotWritten)
    const note = rolledBack ? '' : '；清单回滚失败，激活意图仍留在 pendingActivation'
    return failure('landing_write_failed', `写入 ${file} 失败：${messageOf(error)}${note}`, { rolledBack })
  }

  let revision
  try {
    revision = writeIndex(home, { ...intent, pendingActivation: null }, intentRevision)
  } catch (error) {
    // 落点已经是新正文。先恢复落点，再决定动不动清单：顺序反了就会留下
    // 「落点已改、清单说没激活」，这正是 #4 要消灭的状态。
    const landingRestored = restoreLanding(home, meta.target, existing)
    if (error?.code === 'conflict') {
      // 外部改过清单：不覆盖它，落点恢复后如实报冲突。
      return failure('conflict', `提交激活失败：${messageOf(error)}`, { landingRestored })
    }
    const rolledBack = landingRestored && rollbackIndex(home, index, intentRevision)
    const note = rolledBack ? '' : '；清单回滚失败，激活意图仍留在 pendingActivation'
    return failure(
      'index_write_failed',
      `提交激活失败：${messageOf(error)}${note}`,
      { landingRestored, rolledBack },
    )
  }

  return {
    ok: true,
    id,
    name: meta.name,
    target: meta.target,
    file,
    bytes: Buffer.byteLength(loaded.text, 'utf8'),
    created: landing.created,
    previousLanding,
    snapshotKept,
    revision,
  }
}

/**
 * 取消激活：按快照把落点还原到激活前的样子。
 *
 * 落点内容被改过（`settleLanding` 报了 skipped）时不注销记录：快照与所有权都留着，
 * 否则 `landings/<target>.txt` 失去入口，用户原文再没有恢复路径（#5）。返回值里的
 * `kept` 说明记录是否保留，`active` 是操作后的真实状态。
 *
 * 没有激活规则、清单里却还留着落点归属（删除时落点没被处置）时，取消激活也不清它：
 * 这时没有激活态可注销，清掉归属只会让快照重新变成孤儿。
 */
export function deactivateRule(home) {
  return withRulesLock(home, 'deactivate', () => {
    const index = readIndex(home)
    if (index.kind === 'corrupt') return corruptIndexFailure()
    const skipped = []
    let settlement = { removed: false, restored: false, skipped: [] }
    if (index.active !== null) {
      settlement = settleLanding(home, index.landing, activeRuleTextOrNull(home))
      skipped.push(...settlement.skipped)
    }
    const kept = index.active !== null && skipped.length > 0
    const landingKept = kept || index.active === null ? index.landing : null
    let revision
    try {
      revision = writeIndex(home, {
        ...index,
        active: kept ? index.active : null,
        landing: landingKept,
        pendingActivation: null,
      }, index.revision)
    } catch (error) {
      return indexWriteFailure(error, '取消激活')
    }
    return {
      ok: true,
      active: kept,
      kept,
      previous: index.active,
      landingKept,
      removed: settlement.removed,
      restored: settlement.restored,
      skipped,
      revision,
    }
  })
}

/**
 * 删除一条规则；删的是激活中的那条时先按快照处置落点。
 *
 * 落点没被处置（被外部改过、找不到原文、删不掉）时，规则照删，但 `landing` 归属留在
 * 清单里（此时 `active` 已是 null）：否则 `landings/<target>.txt` 留在盘上却没有任何
 * 入口读得到它。这与取消激活的 `kept` 是同一套语义：`kept` 说明归属是否保留，
 * `skipped` 原样报出，`landingKept` 是仍记在清单里的那份归属。
 */
export function deleteRule(home, id) {
  if (!isValidRuleId(id)) return { ok: false, reason: `非法规则 id：${id}` }
  return withRulesLock(home, 'delete', () => {
    const index = readIndex(home)
    if (index.kind === 'corrupt') return corruptIndexFailure()
    const wasActive = index.active === id
    const settlement = wasActive
      ? settleLanding(home, index.landing, activeRuleTextOrNull(home))
      : { removed: false, restored: false, skipped: [] }
    const kept = wasActive && settlement.skipped.length > 0
    const landingKept = kept ? index.landing : null
    const rules = index.rules.filter(rule => rule.id !== id)
    let revision
    try {
      // 先改清单再删正文：正文删掉、清单没写进去才是孤儿文件。
      revision = writeIndex(home, {
        ...index,
        rules,
        active: wasActive ? null : index.active,
        // 没处置掉就保留归属；其余照旧：删的是激活规则则清空，不是激活规则就不动。
        landing: wasActive && !kept ? null : index.landing,
        pendingActivation: index.pendingActivation?.id === id ? null : (index.pendingActivation ?? null),
      }, index.revision)
    } catch (error) {
      return indexWriteFailure(error, '删除规则')
    }
    try {
      fs.rmSync(ruleTextPath(home, id), { force: true })
    } catch (error) {
      return failure('body_remove_failed', `清单已更新，但正文删除失败：${messageOf(error)}`, { revision })
    }
    return {
      ok: true,
      id,
      kept,
      landing: wasActive ? settlement : null,
      landingKept,
      skipped: settlement.skipped,
      removed: settlement.removed,
      restored: settlement.restored,
      revision,
    }
  })
}

/**
 * 清空全部规则。激活中的那条先按快照处置落点，再写空清单、删正文。
 *
 * 这里不保留激活记录：规则本身要全删掉，留下一条指向已删规则的记录没有恢复意义。
 * 被改过的落点快照仍然留在 landings/ 里，文件本身也保持原样。
 */
export function resetRules(home) {
  return withRulesLock(home, 'reset', () => {
    const index = readIndex(home)
    if (index.kind === 'corrupt') return corruptIndexFailure()
    const skipped = []
    if (index.active !== null) {
      const settlement = settleLanding(home, index.landing, activeRuleTextOrNull(home))
      skipped.push(...settlement.skipped)
    }
    try {
      writeIndex(home, emptyIndex(), index.revision)
    } catch (error) {
      return indexWriteFailure(error, '清空规则')
    }
    let removed = 0
    for (const rule of index.rules) {
      try {
        fs.rmSync(ruleTextPath(home, rule.id), { force: true })
        removed += 1
      } catch {
        // 删不掉就留着，清单已经清空，下次保存会覆盖。
      }
    }
    return { ok: true, removed, skipped, active: null }
  })
}

/**
 * 首轮收拢。
 *
 * 写入文件里已有内容、却还没有任何规则时，把它导入成 default 并激活：一份已经存在的
 * AGENTS.md 不该因为装了插件就失去作用。只读写入文件、只写插件自己的目录。
 */
export function ensureInitialState(home) {
  const index = readIndex(home)
  if (index.kind === 'corrupt') return { active: null, imported: null, corrupt: true }
  if (index.rules.length > 0) return { active: index.active, imported: null }
  for (const target of RULE_TARGETS) {
    const text = readTarget(home, target)
    if (text === null || text.trim() === '') continue
    const id = 'default'
    const saved = saveRule(home, id, text, { name: '默认规则', target })
    if (!saved.ok) return { active: null, imported: null, error: saved.reason }
    const activated = activateRule(home, id)
    return { active: activated.ok ? id : null, imported: id }
  }
  return { active: null, imported: null }
}

/**
 * 恢复损坏的规则清单：将损坏的 rules.json 备份到 $DSH_HOME/dsh-breaklimit-backup/<时间戳>/rules.json，
 * 校验字节一致后，重置为空清单结构。
 *
 * @param {string} home - $DSH_HOME。
 * @returns {{ ok: true, backupPath: string, backupBytes: number, rulesIndex: 'ok' }
 *   | { ok: false, code: string, message: string, reason: string }}
 */
export function recoverCorruptIndex(home) {
  return withRulesLock(home, 'recover', () => {
    const current = readIndex(home)
    if (current.kind !== 'corrupt') {
      return failure('index_not_corrupt', '规则清单未损坏，无需恢复')
    }
    const file = rulesIndexPath(home)
    if (!fs.existsSync(file)) {
      return failure('index_missing', '规则清单文件不存在')
    }
    let original
    try {
      original = fs.readFileSync(file)
    } catch (error) {
      return failure('stat_failed', `读取原清单信息失败：${messageOf(error)}`)
    }

    // 目录名用本地时间：用户是照着自己看到的时间去磁盘上找的，UTC 会差一个时区，
    // 明明刚点完却看到一个几小时前的目录名。日期与时刻之间留一个连字符，8 位数字
    // 和 6 位数字连写会读不出切分点。
    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
      + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const backupRoot = path.join(home, 'dsh-breaklimit-backup')
    let backupDir = null
    let backupFile

    try {
      fs.mkdirSync(backupRoot, { recursive: true })
      const preferred = path.join(backupRoot, stamp)
      try {
        fs.mkdirSync(preferred)
        backupDir = preferred
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        backupDir = fs.mkdtempSync(`${preferred}-`)
      }
      backupFile = path.join(backupDir, 'rules.json')
      fs.copyFileSync(file, backupFile, fs.constants.COPYFILE_EXCL)
      if (!fs.readFileSync(backupFile).equals(original)) {
        throw new Error('备份字节与原清单不符')
      }
      if (!fs.readFileSync(file).equals(original)) {
        throw new Error('原清单在备份期间被改动')
      }
    } catch (error) {
      try {
        if (backupDir !== null) fs.rmSync(backupDir, { recursive: true, force: true })
      } catch {
        // 清理失败不盖住原始错误。
      }
      return failure('backup_failed', `备份原清单失败：${messageOf(error)}`)
    }

    try {
      writeIndex(home, emptyIndex(), undefined, { allowCorruptOverwrite: true })
    } catch (error) {
      return failure('reset_failed', `重置空清单失败：${messageOf(error)}`)
    }

    return {
      ok: true,
      backupPath: backupFile,
      backupBytes: original.length,
      rulesIndex: 'ok',
    }
  })
}
