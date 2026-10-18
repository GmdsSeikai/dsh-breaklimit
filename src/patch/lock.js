// 单飞保护：进程内一层，跨进程一层。
//
// 两层各管一段，都必要。
//
// 进程内那层挡的是同一进程里的并发入口（HTTP 接口、命令、模型工具），开销为零。
// 它挡不住另一个进程——而这个项目自己就公开了独立 CLI，用户完全可以在宿主运行
// 期间跑 `--apply`：两个进程各自持有一把进程内锁，都会通过预检，然后写同一批
// 文件、互相覆盖状态清单。跨进程那层用 $DSH_HOME/breaklimit/operation.lock 补上。
//
// 获取顺序固定：先进程内，再文件。反过来的话，进程内获取失败时要回退一个刚创建的
// 文件锁，而回退本身也可能失败，多出一条只在并发下才走到的错误路径。
//
// 不做排队：并发请求立即拿到冲突结果，由调用方回 409 operation_in_progress。
// 排队会把"等待"伪装成"进行中"，而等待者手上没有任何可用的进度信息。
//
// 陈旧的锁文件必须有出路，否则一次崩溃会把插件永久锁死。回收要两条证据同时成立：
// 持有者证明不了自己还活着（内容读不出，或记录里的 pid 不在了），**并且**文件确实
// 不再变化（mtime 已过创建宽限期）。缺第一条，另一个进程正在写的那把锁会被当成
// 崩溃残留；缺第二条，一个刚崩掉、文件还没凉透的持有者会被下一个进程立刻接管。
// 两种都会走到同一个结果：两个进程各自拿到成功凭证，磁盘上的持有者是后一个，
// 前一个的写入落进一具已经没人认领的 inode。
//
// 代价写在明处：判活只看 pid，拿不到进程启动时间。所以 pid 被新进程挪用之后，
// 那份记录会一直挡住后续操作，直到有人按冲突信息里的路径手工删掉它。

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { readTextOrNull } from './fsx.js'
import { breaklimitDir } from './state.js'

const LOCK_FILE = 'operation.lock'

// 锁文件的创建宽限期。
//
// open('wx') 返回与 writeSync 完成之间有一个窗口：文件已经存在，内容还是空的。
// 另一个进程在这个窗口里读到的磁盘形态，与"创建它的进程崩在写入之前"完全一样
// ——只凭内容分不开这两件事，mtime 是唯一的时间证据。所以宽限期之内一律按
// "正在创建"处理：返回冲突，不删文件。过了宽限期仍是空的，才说明写入根本没发生。
//
// 窗口本身是微秒级，5 秒是它的上万倍；代价只是一次崩溃之后最多多等 5 秒。
const CREATION_GRACE_MS = 5 * 1000

export function createLock() {
  let holder = null

  return {
    /** 当前是否被占用。 */
    get busy() {
      return holder !== null
    },

    /** 当前持有者的事务 id，空闲时为 null。 */
    get operationId() {
      return holder === null ? null : holder.id
    },

    /**
     * 尝试获取锁。成功返回持有凭证，失败返回 null——不阻塞、不等待。
     * @param {string} id - 调用方生成的事务 id，用于释放时的归属校验。
     */
    acquire(id) {
      if (holder !== null) return null
      holder = { id, startedAt: Date.now() }
      return holder
    },

    /**
     * 释放锁。只有持有者本人能释放：别的事务误释放会让真正的持有者在
     * 半途失去保护，这类错误比拒绝释放危险得多，所以归属不符时保持原样。
     * @param {string} id - 申请时使用的同一个事务 id。
     */
    release(id) {
      if (holder !== null && holder.id === id) holder = null
    },

    /**
     * 以同步回调的形式持锁运行，无论成功或抛出都释放。
     * 回调必须是同步的：异步回调会在第一个 await 处让出锁，
     * 而调用方会以为整个流程仍在保护之下。
     * @param {string} id - 事务 id。
     * @param {() => unknown} run - 同步执行的临界区。
     */
    run(id, run) {
      const token = this.acquire(id)
      if (token === null) return undefined
      try {
        return run()
      } finally {
        this.release(id)
      }
    },
  }
}

/** 跨进程锁文件的绝对路径。状态里要报出来，人工判断该不该删时用得上。 */
export function lockFilePath(home) {
  return path.join(breaklimitDir(home), LOCK_FILE)
}

function parseHolder(raw) {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    // 半写完的锁文件（进程在 writeSync 之前被杀）读不出内容。
    return null
  }
}

function readHolder(file) {
  return parseHolder(readTextOrNull(file))
}

/**
 * 锁文件此刻的样子。
 *
 * 先 stat 再读内容：身份指纹里的 mtime 与 size 必须和这一次读到的正文对得上，
 * 删除前靠它确认路径上还是同一份文件。
 *
 * @returns {{ holder: object | null, ageMs: number, identity: string } | null} 文件不在时为 null。
 */
function inspect(file) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return null
  }
  return {
    holder: parseHolder(readTextOrNull(file)),
    ageMs: Date.now() - stat.mtimeMs,
    identity: `${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}`,
  }
}

/** 进程是否还活着。EPERM 说明进程存在但没有信号权限，那也是活着。 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 锁文件是否可以回收。
 *
 * 两个条件同时成立才算陈旧，缺一个都不回收：
 *   1. 持有者证明不了自己还活着——内容读不出，或记录里的 pid 已经不在了；
 *   2. 文件不再变化——距 mtime 已过创建宽限期。
 *
 * 只看第一条会删掉另一个进程正在建的锁；只看第二条会把活着的持有者赶走
 * （机器挂起、时钟跳变、操作本身很长，都会让活锁看起来过期）。
 *
 * @param {{ holder: object | null, ageMs: number }} view - `inspect` 的结果。
 */
function isStale(view) {
  if (view.ageMs <= CREATION_GRACE_MS) return false
  if (view.holder === null) return true
  return !processAlive(view.holder.pid)
}

/**
 * 把文件系统错误包成调用方能读懂的那一种：路径、原始 code 与 cause 都带上。
 *
 * 不吞掉错误——建不起跨进程锁就不能继续，否则两个进程会各自以为自己独占宿主。
 * code 保留原值（ENOTDIR、EACCES…），调用方仍能按 errno 分支。
 */
function setupError(file, error) {
  const wrapped = new Error(`无法建立跨进程锁 ${file}：${String(error?.message ?? error)}`, { cause: error })
  wrapped.code = typeof error?.code === 'string' ? error.code : 'lock_setup_failed'
  wrapped.lockPath = file
  return wrapped
}

function closeQuietly(fd) {
  try {
    fs.closeSync(fd)
  } catch {
    // 关不掉也没有别的补救；文件留不留由调用方那一步决定。
  }
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // 删不掉时，下一个进程会在宽限期之后把它收走。
  }
}

/**
 * 用 'wx' 建锁并写入持有者记录。
 *
 * 'wx' 是唯一能证明"这个文件是我建的"的原语：它要么原子地创建成功，要么因为
 * 路径已被占用而失败。写入失败时，本次建出来的那份必须清掉——留着它，下一个
 * 进程会在宽限期里把它当成"正在创建"而空等，或者读到一份没有持有者的记录。
 *
 * @returns {boolean} true 建成；false 表示路径上已经有锁。
 * @throws 建不了锁时抛 `setupError`，抛出前已 close 并删除本次创建的文件。
 */
function createHolder(file, operationId) {
  let fd
  try {
    fd = fs.openSync(file, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw setupError(file, error)
  }

  try {
    fs.writeSync(fd, `${JSON.stringify({
      operationId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    })}\n`)
  } catch (error) {
    closeQuietly(fd)
    removeQuietly(file)
    throw setupError(file, error)
  }
  closeQuietly(fd)
  return true
}

/**
 * 获取跨进程锁。
 *
 * 只有成功、冲突、抛出三种结局，且三种都不留下本次调用建立的东西：
 * 成功时留下的是自己那份带持有者记录的锁，冲突时磁盘一个字节都不动，
 * 抛出时本次建出的文件已被删除（见 `createHolder`）。
 *
 * @param {string} home - DSH_HOME。
 * @param {string} operationId - 本次操作的事务 id。
 * @returns {{ path: string, operationId: string } | { conflict: { path: string, holder: object | null } }}
 *   成功时返回可用于释放的凭证；被占用时返回冲突信息，含持有者，供调用方报出去。
 * @throws {Error} 锁文件或它的目录建不出来时抛出，`code` 保留原始 errno。
 */
export function acquireFileLock(home, operationId) {
  const file = lockFilePath(home)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch (error) {
    // 连目录都建不出来（home 的某一级是文件 → ENOTDIR，权限不足 → EACCES…）。
    // 没有锁文件可清，直接把原因抛给调用方：让它带着错误失败，而不是在没有
    // 跨进程保护的情况下继续写宿主。
    throw setupError(file, error)
  }

  // 最多两轮：第一轮撞上可回收的旧锁就清掉，第二轮仍撞上说明有人刚好抢到，
  // 交给调用方报冲突。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createHolder(file, operationId)) return { path: file, operationId }

    const seen = inspect(file)
    // 拿到 EEXIST 之后、读它之前，锁被别人收走了：路径已经空出来，再建一次。
    if (seen === null) continue
    if (!isStale(seen)) return { conflict: { path: file, holder: seen.holder } }

    // 删除之前再确认一次路径上还是判定过的那一份。判定与删除之间，另一个进程
    // 可能已经收走旧锁并建了自己的——照着旧判定删下去，删掉的是一个活锁。
    const now = inspect(file)
    if (now === null || now.identity !== seen.identity) continue
    try {
      fs.rmSync(file, { force: true })
    } catch {
      // 删不掉就交给下一轮判定，不在这里抛。
    }
  }

  const left = inspect(file)
  return { conflict: { path: file, holder: left === null ? null : left.holder } }
}

/**
 * 释放跨进程锁。
 *
 * 只释放自己持有的那一把：文件被别的进程接管后，删除它就等于替对方解锁。
 * 释放失败不在这里抛——它会盖住真正的操作结果，而陈旧检测能在下次获取时收掉它。
 */
export function releaseFileLock(handle) {
  if (handle === null || handle === undefined) return
  try {
    const holder = readHolder(handle.path)
    if (holder !== null && holder.operationId !== handle.operationId) return
    fs.rmSync(handle.path, { force: true })
  } catch {
    // 见上。
  }
}
