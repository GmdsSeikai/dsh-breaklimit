import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkSource, extractRelease, packRelease, resolveCandidate, verifyRelease } from '../tools/release.mjs'
import { prepareDraft, requireDraft } from '../tools/github-release.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-release-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, 'source with spaces')
  fs.mkdirSync(path.join(repo, 'src', 'patch'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version: '0.9.2', dshTarget: '0.2.1-rc.2' }))
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '# Changes\n\n## 0.9.2 · 2026-10-19\n\nFix rules.\n')
  fs.writeFileSync(path.join(repo, 'src', 'patch', 'hashes.json'), JSON.stringify({ dsh: { version: '0.2.1-rc.2', commit: 'a'.repeat(40) } }))
  fs.writeFileSync(path.join(repo, 'README.md'), '# Plugin\n')
  for (const name of ['LICENSE', 'src/plugin.js', 'src/client.js', 'src/cli.js', 'src/bundle.yml', 'src/context/inject.md', 'test/cli.test.js']) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), 'fixture\n')
  }
  const git = args => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 10000 })
  git(['init', '--quiet'])
  git(['config', 'core.autocrlf', 'false'])
  git(['config', 'user.name', 'Release test'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['add', '.'])
  git(['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Fixture'])
  git(['tag', '-a', 'v0.9.2', '-m', 'Test', '--', 'HEAD'])
  const sha = git(['rev-parse', 'HEAD']).trim()
  git(['update-ref', 'refs/remotes/origin/main', sha])
  return { root, repo, sha, out: path.join(root, 'release output'), git }
}

test('发布源检查接受匹配版本，拒绝缺失变更记录和错误宿主声明', t => {
  const { repo } = fixture(t)
  assert.equal(checkSource(repo).version, '0.9.2')
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '## 0.9.1\n')
  assert.throws(() => checkSource(repo), /CHANGELOG/)
  fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), '## 0.9.2\n')
  fs.writeFileSync(path.join(repo, 'src/patch/hashes.json'), JSON.stringify({ dsh: { version: 'wrong', commit: 'a'.repeat(40) } }))
  assert.throws(() => checkSource(repo), /dshTarget/)
  fs.writeFileSync(path.join(repo, 'src/patch/hashes.json'), '{broken')
  assert.throws(() => checkSource(repo), /hashes/)
})

test('候选标签必须与完整 SHA、包版本相符，缺失标签不得自动创建', t => {
  const { repo, sha, git } = fixture(t)
  assert.equal(resolveCandidate(repo, 'v0.9.2', sha).sourceSha, sha)
  assert.throws(() => resolveCandidate(repo, 'v0.9.2', 'b'.repeat(40)), /SHA/)
  assert.throws(() => resolveCandidate(repo, 'v0.9.2', sha.slice(0, 7)), /SHA/)
  git(['tag', 'v0.9.3'])
  assert.throws(() => resolveCandidate(repo, 'v0.9.3', sha), /version|版本/)
  assert.throws(() => resolveCandidate(repo, 'v0.9.4', sha), /tag|标签/)
  git(['commit', '--quiet', '--allow-empty', '-m', 'Unlanded candidate'])
  git(['tag', '-f', 'v0.9.2'])
  assert.throws(() => resolveCandidate(repo, 'v0.9.2', git(['rev-parse', 'HEAD']).trim()), /origin\/main/)
})

test('打包只包含提交内容，可重复执行且不读取未提交的私人文件', t => {
  const { repo, sha, out } = fixture(t)
  fs.writeFileSync(path.join(repo, 'private.txt'), 'must not be shipped')
  fs.writeFileSync(path.join(repo, 'README.md'), 'uncommitted content')
  packRelease(repo, 'v0.9.2', sha, out)
  const before = fs.readdirSync(out).map(name => [name, fs.readFileSync(path.join(out, name))])
  assert.equal(verifyRelease(repo, 'v0.9.2', sha, out).sourceSha, sha)
  packRelease(repo, 'v0.9.2', sha, out)
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(out, name)), bytes)
  assert.deepEqual(fs.readdirSync(out).sort(), ['SHA256SUMS.txt', 'dsh-breaklimit-0.9.2.zip', 'release-metadata.json'].sort())
  const extracted = extractRelease(repo, 'v0.9.2', sha, out, path.join(path.dirname(out), 'unpacked'))
  assert.equal(fs.readFileSync(path.join(extracted, 'README.md'), 'utf8'), '# Plugin\n')
  assert.equal(fs.existsSync(path.join(extracted, 'private.txt')), false)
})

test('附件缺失、多余文件、来源改写、损坏 ZIP 均拒绝，打包不覆盖已有产物', t => {
  const { repo, sha, out } = fixture(t)
  packRelease(repo, 'v0.9.2', sha, out)
  const archive = path.join(out, 'dsh-breaklimit-0.9.2.zip')
  const original = fs.readFileSync(archive)
  fs.appendFileSync(archive, 'tamper')
  assert.throws(() => verifyRelease(repo, 'v0.9.2', sha, out), /hash|哈希|ZIP/)
  assert.throws(() => packRelease(repo, 'v0.9.2', sha, out), /hash|哈希|ZIP/)
  assert.deepEqual(fs.readFileSync(archive), Buffer.concat([original, Buffer.from('tamper')]))
  fs.writeFileSync(archive, original)
  fs.writeFileSync(path.join(out, 'extra.txt'), 'unexpected')
  assert.throws(() => verifyRelease(repo, 'v0.9.2', sha, out), /附件/)
  fs.unlinkSync(path.join(out, 'extra.txt'))
  fs.writeFileSync(path.join(out, 'release-metadata.json'), '{}')
  assert.throws(() => verifyRelease(repo, 'v0.9.2', sha, out), /metadata|来源|哈希/)
  fs.unlinkSync(archive)
  assert.throws(() => verifyRelease(repo, 'v0.9.2', sha, out), /附件/)
})

test('篡改 ZIP 后即使重写哈希仍被独立的源提交核验拒绝', t => {
  const { repo, sha, out } = fixture(t)
  packRelease(repo, 'v0.9.2', sha, out)
  const archive = path.join(out, 'dsh-breaklimit-0.9.2.zip')
  const original = fs.readFileSync(archive)
  fs.writeFileSync(archive, Buffer.concat([original, Buffer.from('forged')]))
  // 来源核验不能仅信任随包提供的哈希文件。
  const files = ['dsh-breaklimit-0.9.2.zip', 'release-metadata.json']
  fs.writeFileSync(path.join(out, 'SHA256SUMS.txt'), files.map(name => `${createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex')}  ${name}\n`).join(''))
  assert.throws(() => verifyRelease(repo, 'v0.9.2', sha, out), /hash|哈希|ZIP/)
})

test('草稿校验拒绝已发布版本、错误 SHA 和漏标的内测版', () => {
  const valid = { draft: true, prerelease: true, tag_name: 'v0.9.2', target_commitish: 'a'.repeat(40) }
  assert.doesNotThrow(() => requireDraft(valid, 'v0.9.2', 'a'.repeat(40)))
  assert.throws(() => requireDraft({ ...valid, draft: false }, 'v0.9.2', 'a'.repeat(40)), /published/)
  assert.throws(() => requireDraft(valid, 'v0.9.2', 'b'.repeat(40)), /SHA/)
  assert.throws(() => requireDraft({ ...valid, prerelease: false }, 'v0.9.2', 'a'.repeat(40)), /prerelease/)
})

function remoteFixture(t) {
  const fixtureData = fixture(t)
  const { root, repo, sha, out } = fixtureData
  packRelease(repo, 'v0.9.2', sha, out)
  const notes = path.join(root, 'notes.md')
  fs.writeFileSync(notes, '# Release notes\n')
  const stored = path.join(root, 'remote assets')
  fs.mkdirSync(stored)
  const state = { release: null, writes: [] }
  const call = args => {
    if (args[0] === 'api') {
      if (args[1].includes('/commits/')) return sha
      if (state.release === null) throw Object.assign(new Error('not found'), { stderr: 'HTTP 404' })
      return JSON.stringify({ ...state.release, assets: fs.readdirSync(stored).map((name, id) => ({ name, id, size: fs.statSync(path.join(stored, name)).size, updated_at: 'fixed' })) })
    }
    if (args[1] === 'download') {
      const destination = args[args.indexOf('--dir') + 1]
      for (const name of fs.readdirSync(stored)) fs.copyFileSync(path.join(stored, name), path.join(destination, name))
      return ''
    }
    state.writes.push(args)
    if (args[1] === 'create') {
      assert.ok(args.includes('--draft'))
      assert.ok(args.includes('--prerelease'))
      assert.ok(args.includes('--verify-tag'))
      state.release = { draft: true, prerelease: true, tag_name: 'v0.9.2', target_commitish: sha, id: 42, html_url: 'https://example.invalid/draft' }
    } else if (args[1] === 'upload') {
      for (const file of args.slice(3, args.indexOf('--repo'))) fs.copyFileSync(file, path.join(stored, path.basename(file)))
    } else if (args[1] !== 'edit') throw new Error(`unexpected command: ${args.join(' ')}`)
    return ''
  }
  return { ...fixtureData, notes, stored, state, call }
}

test('准备草稿真实核对已有字节，重复执行不重复上传', t => {
  const { repo, sha, out, notes, stored, state, call } = remoteFixture(t)
  assert.equal(prepareDraft(repo, 'v0.9.2', sha, out, notes, call).uploaded.length, 3)
  assert.equal(prepareDraft(repo, 'v0.9.2', sha, out, notes, call).uploaded.length, 0)
  assert.equal(state.writes.filter(args => args[1] === 'create').length, 1)
  assert.equal(state.writes.filter(args => args[1] === 'upload').length, 1)
  fs.unlinkSync(path.join(stored, 'SHA256SUMS.txt'))
  assert.deepEqual(prepareDraft(repo, 'v0.9.2', sha, out, notes, call).uploaded, ['SHA256SUMS.txt'])
})

test('已有草稿附件不符或已发布时，拒绝任何覆盖操作', t => {
  const { repo, sha, out, notes, stored, state, call } = remoteFixture(t)
  assert.throws(() => prepareDraft(repo, 'v0.9.2', sha, out, notes, args => args[1].includes('/commits/') ? 'b'.repeat(40) : call(args)), /SHA mismatch/)
  assert.equal(state.writes.length, 0)
  prepareDraft(repo, 'v0.9.2', sha, out, notes, call)
  fs.appendFileSync(path.join(stored, 'dsh-breaklimit-0.9.2.zip'), 'tamper')
  const writes = state.writes.length
  assert.throws(() => prepareDraft(repo, 'v0.9.2', sha, out, notes, call), /refusing to overwrite/)
  assert.equal(state.writes.length, writes)
  state.release.draft = false
  assert.throws(() => prepareDraft(repo, 'v0.9.2', sha, out, notes, call), /published/)
  assert.equal(state.writes.length, writes)
})

test('网络或认证失败不得被当成 Release 不存在而创建新草稿', t => {
  const { repo, sha, out, notes } = remoteFixture(t)
  let attempts = 0
  assert.throws(() => prepareDraft(repo, 'v0.9.2', sha, out, notes, () => {
    attempts += 1
    throw Object.assign(new Error('network unavailable'), { stderr: 'HTTP 403' })
  }), /network unavailable/)
  assert.equal(attempts, 1)
})
