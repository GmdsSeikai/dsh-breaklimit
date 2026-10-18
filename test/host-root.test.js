// 宿主根解析测试。
//
// 宿主根留空是「装上了却没生效」的头号原因：补丁预检整体跳过，用户看到插件在跑
// 就以为成了。所以解析多了一层从宿主进程推导，但推导必须是带校验的——认错树的
// 后果比认不出更糟，预检会对着别人的文件做判定。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { deriveHostRoot, resolveHostRootInfo } from '../src/plugin.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-root-'))
}

/** 按标记清单造一棵（假的）宿主源码树，返回它的根。 */
function fakeHostRoot(markers = HOST_MARKERS) {
  const root = tempDir()
  for (const rel of markers) {
    const file = path.join(root, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // 目录标记建成目录，文件标记建成文件：isHostRoot 只问存在性。
    if (path.extname(rel) === '') fs.mkdirSync(file, { recursive: true })
    else fs.writeFileSync(file, 'x', 'utf8')
  }
  return root
}

const HOST_MARKERS = [
  'packages/bundle/base/cordis.patch.yml',
  'packages/boot/app-boot/src/profile.ts',
  'packages/bundle/web-app/presets',
]

/** 临时把宿主进程入口指到某处，跑完恢复。 */
function withArgvEntry(entry, run) {
  const saved = process.argv[1]
  try {
    process.argv[1] = entry
    return run()
  } finally {
    process.argv[1] = saved
  }
}

/** 临时清空配置与环境，只测某一层。 */
function withCleanEnv(run) {
  const saved = process.env.DSH_BREAKLIMIT_HOST_ROOT
  try {
    delete process.env.DSH_BREAKLIMIT_HOST_ROOT
    return run()
  } finally {
    if (saved === undefined) delete process.env.DSH_BREAKLIMIT_HOST_ROOT
    else process.env.DSH_BREAKLIMIT_HOST_ROOT = saved
  }
}

test('推导：入口在 apps/cli/src 下时向上找到带标记的根', () => {
  const root = fakeHostRoot()
  const entry = path.join(root, 'apps', 'cli', 'src', 'bin.ts')
  assert.equal(withArgvEntry(entry, deriveHostRoot), root)
})

test('推导：少一个标记就不认，宁可报未配置', () => {
  const root = fakeHostRoot(HOST_MARKERS.slice(0, 2))
  const entry = path.join(root, 'apps', 'cli', 'src', 'bin.ts')
  assert.equal(withArgvEntry(entry, deriveHostRoot), null)
})

test('推导：入口缺失或为空时不做任何判断', () => {
  assert.equal(withArgvEntry(undefined, deriveHostRoot), null)
  assert.equal(withArgvEntry('', deriveHostRoot), null)
})

test('推导：目录树里没有标记时返回 null', () => {
  const stray = tempDir()
  const entry = path.join(stray, 'a', 'b', 'bin.ts')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  assert.equal(withArgvEntry(entry, deriveHostRoot), null)
})

test('解析优先级：配置胜过环境变量与推导', () => {
  const root = fakeHostRoot()
  const entry = path.join(root, 'apps', 'cli', 'src', 'bin.ts')
  withCleanEnv(() => {
    process.env.DSH_BREAKLIMIT_HOST_ROOT = 'D:/from-env'
    try {
      withArgvEntry(entry, () => {
        assert.deepEqual(resolveHostRootInfo({ hostRoot: 'D:/from-config' }), {
          root: 'D:/from-config',
          source: 'config',
        })
      })
    } finally {
      delete process.env.DSH_BREAKLIMIT_HOST_ROOT
    }
  })
})

test('解析优先级：环境变量胜过推导', () => {
  const root = fakeHostRoot()
  const entry = path.join(root, 'apps', 'cli', 'src', 'bin.ts')
  withCleanEnv(() => {
    process.env.DSH_BREAKLIMIT_HOST_ROOT = 'D:/from-env'
    try {
      withArgvEntry(entry, () => {
        assert.deepEqual(resolveHostRootInfo({}), { root: 'D:/from-env', source: 'env' })
      })
    } finally {
      delete process.env.DSH_BREAKLIMIT_HOST_ROOT
    }
  })
})

test('解析优先级：都没有时用推导，并如实标出来源', () => {
  const root = fakeHostRoot()
  const entry = path.join(root, 'apps', 'cli', 'src', 'bin.ts')
  withCleanEnv(() => {
    withArgvEntry(entry, () => {
      assert.deepEqual(resolveHostRootInfo({}), { root, source: 'derived' })
    })
  })
})

test('解析优先级：都取不到时来源是 none，而不是编一个根', () => {
  withCleanEnv(() => {
    withArgvEntry(path.join(tempDir(), 'bin.ts'), () => {
      assert.deepEqual(resolveHostRootInfo({}), { root: null, source: 'none' })
    })
  })
})
