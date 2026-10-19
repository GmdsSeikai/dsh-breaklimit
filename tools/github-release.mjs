import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { REPOSITORY, extractRelease, resolveCandidate, run, sha256, verifyRelease } from './release.mjs'

function gh(args) { return run('gh', args) }

function requireRemoteTag(tag, sha, call) {
  const actual = call(['api', `repos/${REPOSITORY}/commits/${tag}`, '--jq', '.sha']).trim()
  if (actual !== sha) throw new Error('GitHub tag SHA mismatch; fetch and inspect the remote tag')
}

export function requireDraft(release, tag, sha) {
  if (!release.draft) throw new Error('Release is already published; refusing to change it')
  if (release.tag_name !== tag || release.target_commitish !== sha) throw new Error('Draft tag or source SHA mismatch')
  if (!release.prerelease && tag.startsWith('v0.9.')) throw new Error('0.9 releases must be marked prerelease')
}

function findRelease(tag, call) {
  try { return JSON.parse(call(['api', `repos/${REPOSITORY}/releases/tags/${tag}`])) } catch (error) {
    if (/HTTP 404/u.test(String(error.stderr))) return null
    throw error
  }
}

export function prepareDraft(repo, tag, sha, directory, notesFile, call = gh) {
  const metadata = verifyRelease(repo, tag, sha, directory)
  if (!fs.readFileSync(notesFile, 'utf8').trim()) throw new Error('Release notes are empty')
  requireRemoteTag(tag, sha, call)
  let release = findRelease(tag, call)
  if (release === null) {
    const args = ['release', 'create', tag, '--repo', REPOSITORY, '--verify-tag', '--target', sha,
      '--draft', '--title', `dsh-breaklimit ${tag}${metadata.version.startsWith('0.9.') ? ' 内测版' : ''}`, '--notes-file', notesFile]
    if (metadata.version.startsWith('0.9.') || metadata.version.includes('-')) args.push('--prerelease')
    call(args)
    release = findRelease(tag, call)
    if (release === null) throw new Error('Draft creation is uncertain; inspect GitHub before retrying')
  }
  requireDraft(release, tag, sha)
  const expected = fs.readdirSync(directory)
  const existing = release.assets.map(asset => asset.name)
  if (new Set(existing).size !== existing.length || existing.some(name => !expected.includes(name))) throw new Error('Draft contains unexpected or duplicate assets')
  // Resume interrupted uploads only when every existing asset still matches local bytes.
  const downloaded = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-existing-assets-'))
  try {
    if (existing.length > 0) {
      call(['release', 'download', tag, '--repo', REPOSITORY, '--dir', downloaded])
      for (const name of existing) {
        if (!fs.readFileSync(path.join(downloaded, name)).equals(fs.readFileSync(path.join(directory, name)))) {
          throw new Error(`Existing draft asset differs: ${name}; refusing to overwrite`)
        }
      }
    }
    const missing = expected.filter(name => !existing.includes(name))
    if (missing.length > 0) call(['release', 'upload', tag, ...missing.map(name => path.resolve(directory, name)), '--repo', REPOSITORY])
    // Notes can change without rebuilding assets. Never mark a release ready from upload success.
    call(['release', 'edit', tag, '--repo', REPOSITORY, '--notes-file', notesFile])
    return { tag, sourceSha: sha, draftId: release.id, uploaded: missing, url: release.html_url }
  } finally { fs.rmSync(downloaded, { recursive: true, force: true }) }
}

export function verifyDraft(repo, tag, sha, hostRoot, outputFile, call = gh) {
  const metadata = resolveCandidate(repo, tag, sha)
  requireRemoteTag(tag, sha, call)
  const release = findRelease(tag, call)
  if (release === null) throw new Error('Draft release not found')
  requireDraft(release, tag, sha)
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-draft-verification-'))
  try {
    const directory = path.join(temp, 'assets')
    fs.mkdirSync(directory)
    call(['release', 'download', tag, '--repo', REPOSITORY, '--dir', directory])
    const extracted = extractRelease(repo, tag, sha, directory, path.join(temp, 'extracted'))
    const env = { ...process.env, DSH_HOME: path.join(temp, 'home'), DSH_BREAKLIMIT_HOST_ROOT: path.resolve(hostRoot) }
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
    const checks = [
      [process.execPath, ['tools/lint-exports.mjs']],
      [process.execPath, ['tools/check-client.mjs']],
      [process.execPath, ['--test']],
      [process.execPath, ['tools/check-doc-numbers.mjs']],
      [process.execPath, ['tools/reconcile.mjs', path.resolve(hostRoot)]],
      [process.execPath, ['tools/selfcheck.mjs', path.resolve(hostRoot)]],
    ]
    for (const [file, args] of checks) process.stdout.write(run(file, args, { cwd: extracted, env, timeout: 300000 }))
    const assets = fs.readdirSync(directory).sort().map(name => ({ name, sha256: sha256(fs.readFileSync(path.join(directory, name))) }))
    const latest = findRelease(tag, call)
    if (latest === null) throw new Error('Draft disappeared during verification')
    requireDraft(latest, tag, sha)
    requireRemoteTag(tag, sha, call)
    const identity = value => value.assets.map(asset => [asset.id, asset.name, asset.size, asset.updated_at]).sort()
    if (JSON.stringify(identity(release)) !== JSON.stringify(identity(latest))) throw new Error('Draft assets changed during verification; rerun verification')
    const report = { ...metadata, draftId: release.id, assets, checks: checks.map(([, args]) => args.join(' ')), verifiedAt: new Date().toISOString(),
      boundaries: ['Source and downloaded-archive checks only; real host installation, browser and sandbox acceptance are recorded separately.'] }
    fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true })
    fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'prepare' && args.length === 5) console.log(JSON.stringify(prepareDraft(...args), null, 2))
    else if (command === 'verify' && args.length === 5) console.log(JSON.stringify(verifyDraft(...args), null, 2))
    else throw new Error('Usage: github-release.mjs prepare <repo> <tag> <full-sha> <assets-dir> <notes-file> | verify <repo> <tag> <full-sha> <host-root> <report-file>')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
