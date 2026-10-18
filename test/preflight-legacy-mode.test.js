// 旧记录（没有声明指纹）的档位判定。
//
// 真实形态：`state.json` 的 9 条记录只有 before/after，没有指纹。此时如果只比哈希，
// 磁盘上是另一档写下的内容也会被判「已应用」，切档静默失效——状态页说「全部补丁均
// 已是目标状态」，实际修剪器还停在旧取值上。
//
// 判据：把磁盘内容按**全部档位的变体**还原成原文，再按**当前档**正推一次。正推结果
// 与磁盘逐字节相等，说明这一版正是当前档写的；不等说明是另一档写的，判 needs_reapply
// 并把重写内容交给写入阶段。
//
// 全部在临时目录跑合成文件，不读写真实宿主；声明用真实的那一份。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { hashText } from '../src/patch/fsx.js'
import { PATCHES, replaceVariantsByPath, resolvedAfter } from '../src/patch/index.js'
import { declarationFingerprint, preflight } from '../src/patch/preflight.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-legacy-'))
}

function write(root, rel, content) {
  const file = path.join(root, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 有真实档位差异的那条补丁：output.trim 的 afterByMode 就是切档对象。 */
function trimCase() {
  const patch = PATCHES.find(item => item.id === 'output.trim')
  const [raw] = patch.targets
  return {
    id: patch.id,
    path: raw.path,
    before: raw.before,
    after: mode => resolvedAfter(raw, mode),
    patch: mode => ({ ...patch, targets: [{ ...raw, after: resolvedAfter(raw, mode) }] }),
  }
}

test('旧记录无指纹、档位已切：判 needs_reapply 并把当前档的重写内容交给写入阶段', () => {
  const root = tempDir()
  const trim = trimCase()
  const pristine = `head\n${trim.before}\ntail\n`
  const recommendedText = pristine.split(trim.before).join(trim.after('recommended'))
  write(root, trim.path, recommendedText)

  const result = preflight({
    root,
    patches: [trim.patch('unrestricted')],
    readFile: readOrNull,
    hashes: { [trim.id]: { [trim.path]: hashText(pristine) } },
    appliedRecords: { [trim.path]: { after: hashText(recommendedText) } },
    variantsByPath: replaceVariantsByPath(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings[0].state, 'needs_reapply')
  assert.equal(result.changes.size, 1)
  assert.equal(
    result.changes.get(trim.path).after,
    pristine.split(trim.before).join(trim.after('unrestricted')),
  )
  // 记录的应用后哈希与磁盘一致，它确实是本方写的——只是写成了另一档。
  assert.equal(result.changes.get(trim.path).before, recommendedText)
})

test('旧记录无指纹、档位未变：正推结果等于磁盘，判已应用且不重写', () => {
  const root = tempDir()
  const trim = trimCase()
  const pristine = `head\n${trim.before}\ntail\n`
  const recommendedText = pristine.split(trim.before).join(trim.after('recommended'))
  write(root, trim.path, recommendedText)

  const result = preflight({
    root,
    patches: [trim.patch('recommended')],
    readFile: readOrNull,
    hashes: { [trim.id]: { [trim.path]: hashText(pristine) } },
    appliedRecords: { [trim.path]: { after: hashText(recommendedText) } },
    variantsByPath: replaceVariantsByPath(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.findings[0].state, 'applied')
  assert.equal(result.changes.size, 0)
})

test('同一文件两条 replace 目标：指纹记成集合，两条都判已应用', () => {
  const patch = PATCHES.find(item => item.id === 'read.limits')
  const targets = patch.targets.filter(item => item.path === targetsPathOfReadRender())
  assert.equal(targets.length, 2, '这条补丁在同一文件上有两个目标，用例前提变了要重写')

  const root = tempDir()
  const pristine = targets.map(item => `${item.before}\n`).join('')
  write(root, targets[0].path, pristine)
  let applied = pristine
  for (const item of targets) applied = applied.split(item.before).join(item.after)
  write(root, targets[0].path, applied)

  const declarations = targets.map(item => declarationFingerprint(patch.id, item))
  const result = preflight({
    root,
    patches: [{ ...patch, targets }],
    readFile: readOrNull,
    hashes: { [patch.id]: { [targets[0].path]: hashText(pristine) } },
    appliedRecords: { [targets[0].path]: { after: hashText(applied), declarations } },
    variantsByPath: replaceVariantsByPath(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.blocked.length, 0)
  assert.deepEqual([...new Set(result.findings.map(item => item.state))], ['applied'])
  assert.equal(result.changes.size, 0)
})

test('同一文件两条 replace 目标：旧记录只有 after 时靠反推整体还原，不误判', () => {
  const patch = PATCHES.find(item => item.id === 'read.limits')
  const targets = patch.targets.filter(item => item.path === targetsPathOfReadRender())

  const root = tempDir()
  const pristine = targets.map(item => `${item.before}\n`).join('')
  let applied = pristine
  for (const item of targets) applied = applied.split(item.before).join(item.after)
  write(root, targets[0].path, applied)

  const result = preflight({
    root,
    patches: [{ ...patch, targets }],
    readFile: readOrNull,
    hashes: { [patch.id]: { [targets[0].path]: hashText(pristine) } },
    appliedRecords: { [targets[0].path]: { after: hashText(applied) } },
    variantsByPath: replaceVariantsByPath(),
  })

  assert.equal(result.ok, true)
  assert.equal(result.blocked.length, 0)
  assert.deepEqual([...new Set(result.findings.map(item => item.state))], ['applied'])
})

test('指纹集合里没有当前声明：仍判 applied_other 并阻断', () => {
  const root = tempDir()
  const trim = trimCase()
  const pristine = `head\n${trim.before}\ntail\n`
  const appliedText = pristine.split(trim.before).join(trim.after('recommended'))
  write(root, trim.path, appliedText)

  const result = preflight({
    root,
    patches: [trim.patch('unrestricted')],
    readFile: readOrNull,
    hashes: { [trim.id]: { [trim.path]: hashText(pristine) } },
    appliedRecords: {
      [trim.path]: {
        after: hashText(appliedText),
        declarations: [declarationFingerprint(trim.id, { ...trim.patch('recommended').targets[0] })],
      },
    },
    variantsByPath: replaceVariantsByPath(),
  })

  assert.equal(result.ok, false)
  assert.equal(result.findings[0].state, 'applied_other')
})

test('旧记录无指纹、声明已漂移：还原结果对不上预哈希，不放行', () => {
  const root = tempDir()
  write(root, 'a.txt', 'KEPT\n')

  // 记录说这份内容确实是本方写的（应用后哈希相符），但当前声明里的两段文本在磁盘上
  // 都不存在：还原撤不出声明的原文，正推也改不动任何字节。只看「正推等于原文」的话，
  // 它自己等于自己，声明漂移就被当成「已应用」放过去了。
  const target = { path: 'a.txt', before: 'OLDLINE', after: 'NEWLINE', expectHits: 1 }
  const result = preflight({
    root,
    patches: [{ id: 'T-A', title: '测试补丁', kind: 'replace', targets: [target] }],
    readFile: readOrNull,
    hashes: { 'T-A': { 'a.txt': hashText('PRISTINE\n') } },
    appliedRecords: { 'a.txt': { after: hashText('KEPT\n') } },
    variantsByPath: new Map([['a.txt', [{ before: 'OLDLINE', after: 'NEWLINE' }]]]),
  })

  assert.equal(result.ok, false)
  assert.notEqual(result.findings[0].state, 'applied')
  assert.equal(result.changes.size, 0)
  assert.equal(result.blocked.length, 1)
})

/** read-render.ts 的路径，从声明里取，避免把宿主路径写死在测试里。 */
function targetsPathOfReadRender() {
  const patch = PATCHES.find(item => item.id === 'read.limits')
  const counts = new Map()
  for (const target of patch.targets) counts.set(target.path, (counts.get(target.path) ?? 0) + 1)
  for (const [file, count] of counts) if (count > 1) return file
  throw new Error('read.limits 不再有同文件双目标，用例前提变了')
}
