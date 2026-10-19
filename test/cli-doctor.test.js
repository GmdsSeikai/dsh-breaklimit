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

function runCapture(argv, env) {
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
    const code = run(argv, env)
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
  fs.writeFileSync(path.join(hostRoot, 'package.json'), JSON.stringify({ name: 'deepseek-harness' }), 'utf8')

  // 构造有效的 DSH_HOME 与 profile 结构
  const profileDir = path.join(home, 'profiles', 'web-breaklimit')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    name: 'web-breaklimit',
    dependencies: {
      'rumo-dsh-breaklimit': 'file:../../../dsh-breaklimit',
    },
  }), 'utf8')

  const { code, stdout } = runCapture(['--doctor', '--host-root', hostRoot], { DSH_HOME: home })
  assert.equal(code, 0)
  assert.match(stdout, /\[PASS\] Node\.js 运行时/)
  assert.match(stdout, /\[PASS\] 宿主源码根/)
  assert.match(stdout, /\[PASS\] DSH 数据目录/)
  assert.match(stdout, /\[PASS\] 插件注册状态/)
  assert.match(stdout, /诊断完成：全部检查项通过/)
})
