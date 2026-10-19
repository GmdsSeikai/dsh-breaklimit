// CLI --doctor 纯只读环境诊断测试：验证诊断项、就地排查指引与退出码。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { run } from '../src/cli.js'

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function runCapture(argv, env, deps) {
  let stdoutText = ''
  let stderrText = ''
  const origStdout = process.stdout.write
  const origStderr = process.stderr.write
  process.stdout.write = (chunk) => {
    stdoutText += String(chunk)
    return true
  }
  process.stderr.write = (chunk) => {
    stderrText += String(chunk)
    return true
  }
  try {
    const code = run(argv, env, deps)
    return { code, stdout: stdoutText, stderr: stderrText }
  } finally {
    process.stdout.write = origStdout
    process.stderr.write = origStderr
  }
}

test('--help 包含 --doctor 说明', () => {
  const { code, stdout } = runCapture(['--help'], {})
  assert.equal(code, 0)
  assert.match(stdout, /--doctor\s+检查运行环境与依赖/)
})

test('--doctor 在未配置宿主根或缺少 profile 时返回 1 并给出修复指引', () => {
  const home = tempDir('bkl-doctor-test-')
  const { code, stdout } = runCapture(['--doctor'], { DSH_HOME: home })
  assert.equal(code, 1)
  assert.match(stdout, /\[FAIL\].*宿主源码根/)
  assert.match(stdout, /修复指引/)
  assert.match(stdout, /\[FAIL\].*DSH 数据目录.*web-breaklimit/)
})

test('--doctor 在完备的虚拟环境下全部 PASS 返回 0', () => {
  const home = tempDir('bkl-doctor-pass-home-')
  const hostRoot = tempDir('bkl-doctor-pass-host-')

  // 构造有效的宿主根结构（包含 package.json 与 apps/cli/src 标记）
  fs.mkdirSync(path.join(hostRoot, 'apps', 'cli', 'src'), { recursive: true })
  fs.mkdirSync(path.join(hostRoot, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ name: 'deepseek-harness' }), 'utf8')

  // 构造有效的 DSH_HOME 与 profile 结构
  const profileDir = path.join(home, 'profiles', 'web-breaklimit')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'web-breaklimit',
    dependencies: {
      'rumo-dsh-breaklimit': 'file:../../../dsh-breaklimit',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }), 'utf8')

  // pnpm 与 git 用桩：CI 的 runner 上没有 pnpm，走真实 PATH 这条用例必红。
  const probe = (bin, args) => {
    if (bin === 'pnpm') return '9.15.0'
    if (bin === 'git') return args.includes('rev-parse') ? '687f282e' : 'git version 2.45.0'
    return null
  }
  const { code, stdout } = runCapture(['--doctor', '--host-root', hostRoot], { DSH_HOME: home }, { probe })
  assert.equal(code, 0)
  assert.match(stdout, /\[PASS\] Node\.js 运行时/)
  assert.match(stdout, /\[PASS\] pnpm 包管理器：v9\.15\.0/)
  assert.match(stdout, /\[PASS\] git 版本控制：git version 2\.45\.0/)
  assert.match(stdout, /\[PASS\] 宿主源码根.*HEAD: 687f282e/)
  assert.match(stdout, /\[PASS\] 宿主依赖：已安装 node_modules/)
  assert.match(stdout, /\[PASS\] DSH 数据目录/)
  assert.match(stdout, /\[PASS\] Web 组合：profile 的 bundles 含 @deepseek-ai\/dsh-web-app/)
  assert.match(stdout, /\[PASS\] 插件注册状态/)
  assert.match(stdout, /诊断完成：全部检查项通过/)
})

test('--doctor 在 pnpm 与 git 都缺失时判失败，与 runner 实际安装无关', () => {
  const home = tempDir('bkl-doctor-nodeps-home-')
  const hostRoot = tempDir('bkl-doctor-nodeps-host-')
  fs.mkdirSync(path.join(hostRoot, 'apps', 'cli', 'src'), { recursive: true })
  fs.mkdirSync(path.join(hostRoot, 'node_modules'), { recursive: true })
  fs.mkdirSync(path.join(home, 'profiles', 'web-breaklimit'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'web-breaklimit', 'package.json'), JSON.stringify({
    name: 'web-breaklimit',
    dependencies: { 'rumo-dsh-breaklimit': 'file:x' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }), 'utf8')

  const { code, stdout } = runCapture(
    ['--doctor', '--host-root', hostRoot],
    { DSH_HOME: home },
    { probe: () => null },
  )
  assert.equal(code, 1)
  assert.match(stdout, /\[FAIL\] pnpm 包管理器：未找到 pnpm 命令/)
  assert.match(stdout, /\[FAIL\] git 版本控制：未找到 git 命令/)
  assert.match(stdout, /发现 2 处环境问题/)
})
