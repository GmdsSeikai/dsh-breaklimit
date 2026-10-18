// 锁的两个缺陷各自的回归用例：空锁的创建窗口，以及建立锁的过程中途失败。
//
// 缺陷一：读到空锁就判陈旧。A 在 open('wx') 与 writeSync 之间，B 读到空文件，
// 删掉 A 的锁再自己建一把——两个进程都拿到成功凭证，磁盘上的持有者是 B，
// A 的写入落进一个已经被删除的 inode。修复后的规矩是"回收要两条证据同时成立"：
// 持有者证明不了自己还活着，**并且** mtime 已经超过创建宽限期。
//
// 缺陷二：acquireFileLock 抛异常时，调用方的进程内锁停在 busy，之后所有操作都是
// operation_in_progress，只能重启宿主。lock.js 这一侧的责任是：抛之前把自己建出来的
// 东西清干净，让下一次获取面对的是一个干净的现场。
//
// 创建宽限期在 src/patch/lock.js 里是 5 秒。这里的 6000 毫秒是"明确超过"它；
// 常量改了而这里没跟着改，用例会红并指回 lock.js——那正是想要的效果。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { acquireFileLock, lockFilePath, releaseFileLock } from '../src/patch/lock.js'

const PAST_GRACE_MS = 6000

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-lock-recovery-'))
}

/** 建一个只有目录、没有锁文件的 DSH_HOME。 */
function emptyHome() {
  const home = tempDir()
  fs.mkdirSync(path.join(home, 'breaklimit'), { recursive: true })
  return home
}

function writeLock(home, content) {
  const file = lockFilePath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return file
}

/** 把 mtime 拨到 ageMs 毫秒之前——回收判定看文件停写多久，不看记录里写的 startedAt。 */
function ageFile(file, ageMs) {
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(file, when, when)
  return file
}

function readLock(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 找一个确定不存在的 pid，理由同 lock.test.js：写死一个数字会碰上恰好存在的进程。 */
function unusedPid() {
  for (let pid = 2147483600; pid > 2147483500; pid -= 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') return pid
    }
  }
  throw new Error('找不到空闲 pid，无法构造陈旧锁')
}

test('空锁在宽限期内视为正在创建：返回冲突，且不删除该文件', () => {
  const home = emptyHome()
  // 正是 A 刚 open('wx') 成功、writeSync 还没发生的那一刻。
  const file = writeLock(home, '')

  const result = acquireFileLock(home, 'my-op')

  assert.equal(result.operationId, undefined, '空锁不能给出成功凭证')
  assert.ok(result.conflict !== undefined, '空锁必须走冲突分支')
  assert.equal(result.conflict.holder, null)
  assert.equal(result.conflict.path, file)
  assert.equal(fs.existsSync(file), true, '别人的空锁一个字节都不能动')
  assert.equal(fs.readFileSync(file, 'utf8'), '')
})

test('空锁超过宽限期、没有可识别持有者：回收并获取成功', () => {
  const home = emptyHome()
  // 崩在 writeSync 之前：文件建了，内容永远没写进来，mtime 停在那里。
  const file = ageFile(writeLock(home, ''), PAST_GRACE_MS)

  const result = acquireFileLock(home, 'my-op')

  assert.equal(result.operationId, 'my-op')
  assert.equal(result.path, file)
  assert.equal(readLock(file).operationId, 'my-op')
  assert.equal(readLock(file).pid, process.pid)
})

test('半截内容按同一规则处理：宽限期内不回收，过期后才回收', () => {
  const home = emptyHome()
  // 进程写到一半被杀：内容不是合法 JSON，也就没有可用的 pid。
  const file = writeLock(home, '{"operationId":"half-written"')

  const early = acquireFileLock(home, 'my-op')
  assert.ok(early.conflict !== undefined, '写了一半的锁不能立刻被删')
  assert.equal(fs.existsSync(file), true)

  ageFile(file, PAST_GRACE_MS)
  assert.equal(acquireFileLock(home, 'my-op').operationId, 'my-op')
  assert.equal(readLock(file).operationId, 'my-op')
})

test('持有者 pid 存活但 mtime 很旧：仍然占用，不回收', () => {
  const home = emptyHome()
  // 活进程不该被时间夺走锁：它可能是挂起后被唤醒，也可能操作本身就很长。
  const file = ageFile(writeLock(home, `${JSON.stringify({
    operationId: 'live-op',
    pid: process.pid,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  })}\n`), 60 * 60 * 1000)

  const result = acquireFileLock(home, 'my-op')

  assert.ok(result.conflict !== undefined)
  assert.equal(result.conflict.holder.operationId, 'live-op')
  assert.equal(readLock(file).operationId, 'live-op', '活锁必须原样留在磁盘上')
})

test('持有者 pid 刚消失但文件刚写完：仍按占用处理，过了宽限期才接管', () => {
  const home = emptyHome()
  const file = writeLock(home, `${JSON.stringify({
    operationId: 'dead-op',
    pid: unusedPid(),
    startedAt: new Date().toISOString(),
  })}\n`)

  const early = acquireFileLock(home, 'my-op')
  assert.ok(early.conflict !== undefined, '还没凉透的锁不能被下一个进程立刻接管')

  ageFile(file, PAST_GRACE_MS)
  assert.equal(acquireFileLock(home, 'my-op').operationId, 'my-op')
})

test('home 的父级是文件（ENOTDIR）时抛错，之后用正常 home 仍能获取', () => {
  const parent = tempDir()
  const blocker = path.join(parent, 'blocker')
  fs.writeFileSync(blocker, 'not a directory\n', 'utf8')
  // breaklimit/ 的父级是文件：mkdirSync 会以 ENOTDIR 失败。
  const badHome = path.join(blocker, 'home')

  assert.throws(
    () => acquireFileLock(badHome, 'my-op'),
    (error) => {
      assert.equal(error.code, 'ENOTDIR')
      assert.match(error.message, /跨进程锁/)
      assert.equal(error.lockPath, lockFilePath(badHome))
      assert.ok(error.cause instanceof Error, '原始错误必须挂在 cause 上')
      return true
    },
  )

  // 上一次失败没有留下任何占用：同一个进程里换正常 home，立刻能拿到锁。
  const goodHome = emptyHome()
  const handle = acquireFileLock(goodHome, 'my-op')
  assert.equal(handle.operationId, 'my-op')
  assert.equal(readLock(lockFilePath(goodHome)).operationId, 'my-op')

  releaseFileLock(handle)
  assert.equal(fs.existsSync(lockFilePath(goodHome)), false)
})
