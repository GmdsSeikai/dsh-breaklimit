// 跨进程锁测试。
//
// 这一层存在的理由是一条被项目自己打破的假设：早期注释写着"同一 DSH_HOME 不会被
// 两个进程同时管理"，而项目同时公开了独立 CLI 与插件内的 Apply/Revert 入口。
// 两者并发时各自持有一把进程内锁，都会通过预检，然后写同一批文件、互相覆盖状态
// 清单。文件锁是唯一的交点。
//
// 另一头同样要测：陈旧的锁文件必须有出路。一次崩溃把插件永久锁死，比并发本身更糟。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { hashText } from '../src/patch/fsx.js'
import { acquireFileLock, createLock, lockFilePath, releaseFileLock } from '../src/patch/lock.js'
import { applyPatches } from '../src/patch/transaction.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-lock-'))
}

function writeLock(home, holder) {
  const file = lockFilePath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(holder)}\n`, 'utf8')
  return file
}

function readLock(home) {
  return JSON.parse(fs.readFileSync(lockFilePath(home), 'utf8'))
}

/** 把锁文件的 mtime 拨到 ageMs 毫秒之前：回收判定看的是文件不再变化，不是记录里写了什么。 */
function ageFile(file, ageMs) {
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(file, when, when)
  return file
}

/**
 * 找一个确定不存在的 pid。
 *
 * 不写死一个数字：那个数字可能恰好被某个进程占着，测试就会从"陈旧锁"变成"活锁"，
 * 而失败原因看上去会像是锁坏了。这里逐个探测到 ESRCH 为止。
 */
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

function patchSet() {
  return {
    patches: [{
      id: 'T-01',
      title: '测试补丁',
      kind: 'replace',
      targets: [{ path: 'a.txt', before: 'VALUE = 2000', after: 'VALUE = 20000', expectHits: 1 }],
    }],
    hashes: { 'T-01': { 'a.txt': hashText('VALUE = 2000\n') } },
  }
}

test('持有进程仍在时拒绝获取，并报出持有者', () => {
  const home = tempDir()
  writeLock(home, { operationId: 'other-op', pid: process.pid, startedAt: new Date().toISOString() })

  const result = acquireFileLock(home, 'my-op')

  assert.ok(result.conflict !== undefined)
  assert.equal(result.conflict.holder.operationId, 'other-op')
  assert.equal(result.conflict.holder.pid, process.pid)
  assert.equal(result.conflict.path, lockFilePath(home))
})

test('持有进程已消失、且文件早已停写的锁被判定为陈旧并接管', () => {
  const home = tempDir()
  const file = writeLock(home, { operationId: 'dead-op', pid: unusedPid(), startedAt: new Date().toISOString() })
  // 回收要两条证据：持有者不在了，且文件不再变化。刚写完的那一份只满足第一条，
  // 另一条要等 mtime 超过创建宽限期——这里直接把 mtime 拨过去，不等真实时间。
  ageFile(file, 6000)

  const result = acquireFileLock(home, 'my-op')

  assert.equal(result.operationId, 'my-op')
  const holder = readLock(home)
  assert.equal(holder.operationId, 'my-op')
  assert.equal(holder.pid, process.pid)
})

test('持有进程还活着时，再旧的锁也不回收', () => {
  const home = tempDir()
  // 旧实现里 startedAt 超过 30 分钟可以单方面判陈旧，哪怕 pid 还在。
  // 现在时间不是证据：一个活着的持有者可以是挂起后被唤醒，也可以是操作本身就长。
  const file = writeLock(home, {
    operationId: 'old-op',
    pid: process.pid,
    startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  })
  ageFile(file, 31 * 60 * 1000)

  const result = acquireFileLock(home, 'my-op')

  assert.ok(result.conflict !== undefined)
  assert.equal(result.conflict.holder.operationId, 'old-op')
  assert.equal(readLock(home).operationId, 'old-op')
})

test('内容读不出来的锁文件：宽限期内按正在创建处理，过期后才回收', () => {
  const home = tempDir()
  const file = lockFilePath(home)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // 进程在 writeSync 之前被杀是这个形态：文件建了，内容是空的。
  // 正在写的那一刻也是这个形态——两者在磁盘上没有区别，只有 mtime 能分开。
  fs.writeFileSync(file, '', 'utf8')

  const early = acquireFileLock(home, 'my-op')
  assert.ok(early.conflict !== undefined, '宽限期内不能把它当陈旧锁删掉')
  assert.equal(fs.existsSync(file), true)

  ageFile(file, 6000)
  assert.equal(acquireFileLock(home, 'my-op').operationId, 'my-op')
})

test('释放只动自己那一把', () => {
  const home = tempDir()
  const handle = acquireFileLock(home, 'my-op')
  assert.equal(fs.existsSync(lockFilePath(home)), true)

  releaseFileLock(handle)
  assert.equal(fs.existsSync(lockFilePath(home)), false)

  // 锁被别的进程接管后，原持有者无权删除——那等于替对方解锁。
  writeLock(home, { operationId: 'other-op', pid: process.pid, startedAt: new Date().toISOString() })
  releaseFileLock(handle)
  assert.equal(fs.existsSync(lockFilePath(home)), true)
})

test('Apply 遇到另一进程的锁时拒绝执行，磁盘不动', () => {
  const root = tempDir()
  const home = tempDir()
  fs.writeFileSync(path.join(root, 'a.txt'), 'VALUE = 2000\n', 'utf8')
  writeLock(home, { operationId: 'other-op', pid: process.pid, startedAt: new Date().toISOString() })

  const result = applyPatches({ root, home, lock: createLock(), ...patchSet() })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'operation_in_progress')
  assert.equal(result.holder.operationId, 'other-op')
  assert.match(result.message, /另一个进程/)
  assert.match(result.message, new RegExp(String(process.pid)))
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'VALUE = 2000\n')
})

test('Apply 完成后跨进程锁被释放', () => {
  const root = tempDir()
  const home = tempDir()
  fs.writeFileSync(path.join(root, 'a.txt'), 'VALUE = 2000\n', 'utf8')

  const result = applyPatches({ root, home, lock: createLock(), ...patchSet() })

  assert.equal(result.code, 'applied')
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'VALUE = 20000\n')
  assert.equal(fs.existsSync(lockFilePath(home)), false)
})

test('Apply 中途失败时锁也会释放', () => {
  const root = tempDir()
  const home = tempDir()
  fs.writeFileSync(path.join(root, 'a.txt'), 'VALUE = 2000\n', 'utf8')

  const result = applyPatches({
    root,
    home,
    lock: createLock(),
    ...patchSet(),
    writeFile: () => {
      throw new Error('模拟写入失败')
    },
  })

  assert.equal(result.code, 'apply_failed')
  // 锁没释放的话，下一次操作会被一个已经结束的事务永久挡住。
  assert.equal(fs.existsSync(lockFilePath(home)), false)
})
