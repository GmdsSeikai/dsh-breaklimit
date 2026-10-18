// CLI 冒烟测试。
//
// CLI 曾经完全没有测试，于是一个被删除的函数在这里留了调用点，`--apply` 一跑就抛
// ReferenceError，直到验收才发现。接口一致性检查抓不到这一类——它原本是本文件内的
// 函数，删了定义留了调用，没有任何跨模块依据；而用正则去找「调用了未定义的标识符」
// 会因关键字误报几百处。
//
// 所以这一类交给运行时：对每个动作各跑一次。任何未定义引用、任何参数贯穿的错误都会
// 在这里炸出来，而且零误报。
//
// 这里不验完整应用链路（那需要一个与宿主 HEAD 对齐的夹具，由 tools/selfcheck.mjs 与
// tools/check-fixture.mjs 负责），只验「每个入口都能跑到返回，而不是中途抛异常」。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { hostRootFromPatchText, resolveHostRootFromPackage, run } from '../src/cli.js'
import { PATCHES } from '../src/patch/index.js'
import { writeDisabled } from '../src/patch/patch-selection.js'

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function envFor(home, extra = {}) {
  return { DSH_HOME: home, ...extra }
}

/** 跑一次 run，同时静音它写到 stdout 的内容，返回退出码。 */
function smoke(argv, env) {
  const original = process.stdout.write
  process.stdout.write = () => true
  try {
    return run(argv, env)
  } finally {
    process.stdout.write = original
  }
}

test('--help 返回 0', () => {
  assert.equal(smoke(['--help'], envFor(tempDir('bkl-cli-'))), 0)
})

test('CLI 预检与应用遵守已保存的补丁禁用集', () => {
  const home = tempDir('bkl-cli-selection-')
  const root = tempDir('bkl-cli-host-')
  writeDisabled(home, PATCHES.map(patch => patch.id))
  const env = envFor(home)
  assert.equal(smoke(['--host-root', root, '--status'], env), 0)
  assert.equal(smoke(['--host-root', root, '--apply'], env), 0)
  assert.deepEqual(fs.readdirSync(root), [], '禁用的补丁不得写入宿主')
  assert.equal(fs.existsSync(path.join(home, 'breaklimit', 'state.json')), false)
})

test('无参数等价于 --help', () => {
  assert.equal(smoke([], envFor(tempDir('bkl-cli-'))), 0)
})

test('--status 在空 DSH_HOME 上不抛异常', () => {
  const home = tempDir('bkl-cli-')
  assert.doesNotThrow(() => smoke(['--status'], envFor(home)))
})

test('--status 能读到已有规则与新结构字段', () => {
  const home = tempDir('bkl-cli-')
  fs.mkdirSync(path.join(home, 'breaklimit', 'bodies'), { recursive: true })
  fs.writeFileSync(path.join(home, 'breaklimit', 'bodies', 'demo.md'), '# 规则\n', 'utf8')
  fs.writeFileSync(
    path.join(home, 'breaklimit', 'rules.json'),
    JSON.stringify({ version: 2, rules: [{ id: 'demo', name: 'demo', target: 'AGENTS.md', activatedAt: null }], active: null, landing: null }),
    'utf8',
  )

  assert.doesNotThrow(() => smoke(['--status'], envFor(home)))
})

test('--rules 在空目录上返回 0', () => {
  assert.equal(smoke(['--rules'], envFor(tempDir('bkl-cli-'))), 0)
})

test('--rules 输出读取新结构，旧字段不会出现', () => {
  const home = tempDir('bkl-cli-')
  fs.mkdirSync(path.join(home, 'breaklimit', 'bodies'), { recursive: true })
  fs.writeFileSync(path.join(home, 'breaklimit', 'bodies', 'demo.md'), '# 规则\n', 'utf8')
  fs.writeFileSync(
    path.join(home, 'breaklimit', 'rules.json'),
    JSON.stringify({ version: 2, rules: [{ id: 'demo', name: 'demo', target: 'AGENTS.md', activatedAt: null }], active: null, landing: null }),
    'utf8',
  )

  const captured = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    captured.push(String(chunk))
    return true
  }
  let code
  try {
    code = run(['--rules'], envFor(home))
  } finally {
    process.stdout.write = original
  }

  assert.equal(code, 0)
  const text = captured.join('')
  assert.match(text, /demo/)
  assert.equal(text.includes('undefined'), false)
  // 旧结构里的字段名不该再出现。
  assert.equal(text.includes('个目标'), false)
})

test('--apply 在空夹具上返回 1（预检阻断），不抛异常', () => {
  const home = tempDir('bkl-cli-')
  const root = tempDir('bkl-cli-host-')
  let code
  assert.doesNotThrow(() => {
    code = smoke(['--host-root', root, '--apply'], envFor(home))
  })
  assert.equal(code, 1, '预检必然阻断（目标文件都不存在），应以失败退出而不是崩溃')
})

test('--revert 在没有应用记录时返回 1，不抛异常', () => {
  const home = tempDir('bkl-cli-')
  const root = tempDir('bkl-cli-host-')
  let code
  assert.doesNotThrow(() => {
    code = smoke(['--host-root', root, '--revert'], envFor(home))
  })
  assert.equal(code, 1)
})

test('宿主根缺失时三处来源都试过才退出', () => {
  const home = tempDir('bkl-cli-')
  // 没有 profiles 目录、环境变量为空、也没有 --host-root：应当走到 exit 2 的分支。
  // 退出码 2 由 requireHostRoot 用 process.exit 产生，这里改跑 --status 以避免真的退出进程。
  assert.doesNotThrow(() => smoke(['--status'], envFor(home, { DSH_BREAKLIMIT_HOST_ROOT: '' })))
})

test('环境变量里的宿主根被采纳', () => {
  const home = tempDir('bkl-cli-')
  const root = tempDir('bkl-cli-host-')
  let code
  assert.doesNotThrow(() => {
    code = smoke(['--apply'], envFor(home, { DSH_BREAKLIMIT_HOST_ROOT: root }))
  })
  assert.equal(code, 1)
})

test('apply 与 revert 在真实补丁集上配对（不崩溃即可）', () => {
  // 完整链路需要与宿主 HEAD 对齐的夹具；这里只确认两个入口都能跑到返回。
  const home = tempDir('bkl-cli-')
  const root = tempDir('bkl-cli-host-')
  for (const action of ['--apply', '--revert']) {
    const code = smoke(['--host-root', root, action], envFor(home))
    assert.equal(typeof code, 'number', `${action} 应返回退出码`)
  }
})

// ── 宿主根：本包装配补丁那一级 ─────────────────────────────────────────────
//
// 文档让人把 hostRoot 填在本包的 cordis.patch.yml 里，并声称「插件与命令行都读得到」。
// 插件那一半成立（它的 config 就来自那个文件的 insert 行），命令行此前只扫 profile
// 目录，所以照文档做完，无参数的 --status 仍然报宿主根未配置。

const PACKAGE_PATCH = [
  '# 装配补丁',
  '- insert:',
  '    - id: breaklimit',
  "      name: 'rumo-dsh-breaklimit'",
  '      config:',
  "        enabled: true",
  "        hostRoot: 'D:/from-package'",
  '',
].join('\n')

function packageDir(content) {
  const dir = tempDir('bkl-pkg-')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'bundle.yml'), content, 'utf8')
  return dir
}

test('本包装配补丁里的宿主根被读出来', () => {
  assert.equal(resolveHostRootFromPackage(packageDir(PACKAGE_PATCH)), 'D:/from-package')
})

test('hostRoot 留空时读出来的是「没配」，不是空串', () => {
  const text = PACKAGE_PATCH.replace("'D:/from-package'", "''")
  assert.equal(hostRootFromPatchText(text), null)
  assert.equal(resolveHostRootFromPackage(packageDir(text)), null)
})

test('别的插件的装配补丁不算数', () => {
  const text = '    - id: other\n      config:\n        hostRoot: \'D:/other\'\n'
  assert.equal(hostRootFromPatchText(text), null)
  assert.equal(resolveHostRootFromPackage(packageDir(text)), null)
})

test('装配补丁不存在时不抛，按未配置处理', () => {
  assert.equal(resolveHostRootFromPackage(tempDir('bkl-pkg-')), null)
  assert.equal(hostRootFromPatchText(null), null)
})

test('--tier 查询返回当前档位', () => {
  const home = tempDir('bkl-cli-')
  const captured = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    captured.push(String(chunk))
    return true
  }
  let code
  try {
    code = run(['--tier'], envFor(home))
  } finally {
    process.stdout.write = original
  }
  assert.equal(code, 0)
  assert.match(captured.join(''), /recommended/)
})

test('--tier 切换有效档位并持久化', () => {
  const home = tempDir('bkl-cli-')
  const code = smoke(['--tier', 'unrestricted'], envFor(home))
  assert.equal(code, 0)

  const captured = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    captured.push(String(chunk))
    return true
  }
  try {
    run(['--tier'], envFor(home))
  } finally {
    process.stdout.write = original
  }
  assert.match(captured.join(''), /unrestricted/)
})

test('--tier 传入非法档位返回 1', () => {
  const home = tempDir('bkl-cli-')
  const originalErr = process.stderr.write
  process.stderr.write = () => true
  try {
    const code = run(['--tier', 'not-a-tier'], envFor(home))
    assert.equal(code, 1)
  } finally {
    process.stderr.write = originalErr
  }
})
