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
  // The tag endpoint resolves published releases; authenticated listings include drafts.
  const pages = JSON.parse(call(['api', `repos/${REPOSITORY}/releases?per_page=100`, '--paginate', '--slurp']))
  const matches = pages.flat().filter(release => release.tag_name === tag)
  if (matches.length > 1) throw new Error(`Multiple releases match ${tag}; inspect GitHub before retrying`)
  return matches[0] ?? null
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

function assetIdentity(release) {
  return release.assets.map(asset => [asset.id, asset.name, asset.size, asset.updated_at]).sort()
}

export function downloadDraft(repo, tag, sha, directory, call = gh) {
  const metadata = resolveCandidate(repo, tag, sha)
  requireRemoteTag(tag, sha, call)
  const release = findRelease(tag, call)
  if (release === null) throw new Error('Draft release not found')
  requireDraft(release, tag, sha)
  if (fs.existsSync(directory)) throw new Error('Draft download destination already exists; use a new directory')
  const assets = path.join(directory, 'assets')
  fs.mkdirSync(assets, { recursive: true })
  call(['release', 'download', tag, '--repo', REPOSITORY, '--dir', assets])
  verifyRelease(repo, tag, sha, assets)
  const snapshot = { ...metadata, draftId: release.id, identity: assetIdentity(release) }
  fs.writeFileSync(path.join(directory, 'draft-snapshot.json'), `${JSON.stringify(snapshot, null, 2)}\n`)
  checkDraft(repo, tag, sha, path.join(directory, 'draft-snapshot.json'), call)
  return snapshot
}

export function checkDraft(repo, tag, sha, snapshotFile, call = gh) {
  resolveCandidate(repo, tag, sha)
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'))
  if (snapshot.sourceSha !== sha || snapshot.tag !== tag || !Array.isArray(snapshot.identity)) throw new Error('Draft snapshot source mismatch')
  requireRemoteTag(tag, sha, call)
  const current = findRelease(tag, call)
  if (current === null) throw new Error('Draft disappeared during verification')
  requireDraft(current, tag, sha)
  if (current.id !== snapshot.draftId || JSON.stringify(assetIdentity(current)) !== JSON.stringify(snapshot.identity)) {
    throw new Error('Draft assets changed during verification; rerun verification')
  }
  return snapshot
}

export function verifyDownloaded(repo, tag, sha, hostRoot, directory, outputFile) {
  const metadata = resolveCandidate(repo, tag, sha)
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'draft-snapshot.json'), 'utf8'))
  if (snapshot.sourceSha !== sha || snapshot.tag !== tag) throw new Error('Draft snapshot source mismatch')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-draft-verification-'))
  try {
    const assetsDir = path.join(directory, 'assets')
    const extracted = extractRelease(repo, tag, sha, assetsDir, path.join(temp, 'extracted'))
    const env = { ...process.env, DSH_HOME: path.join(temp, 'home') }
    delete env.DSH_BREAKLIMIT_HOST_ROOT
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
    // Git Bash's GNU tar treats Windows drive letters as remote archive hosts.
    if (process.platform === 'win32') {
      const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
      env[pathKey] = `${path.join(process.env.SystemRoot, 'System32')}${path.delimiter}${env[pathKey] ?? ''}`
    }
    const checks = [
      [process.execPath, ['tools/lint-exports.mjs']],
      [process.execPath, ['tools/check-client.mjs']],
      [process.execPath, ['--test']],
      [process.execPath, ['tools/check-doc-numbers.mjs']],
      [process.execPath, ['tools/reconcile.mjs', path.resolve(hostRoot)]],
      [process.execPath, ['tools/selfcheck.mjs', path.resolve(hostRoot)]],
    ]
    for (const [file, args] of checks) {
      try { process.stdout.write(run(file, args, { cwd: extracted, env, timeout: 300000 })) } catch (error) {
        process.stdout.write(error.stdout ?? '')
        process.stderr.write(error.stderr ?? '')
        throw new Error(`Archive check failed: ${args.join(' ')} (exit ${String(error.status ?? error.code)})`, { cause: error })
      }
    }
    const assets = fs.readdirSync(assetsDir).sort().map(name => ({ name, sha256: sha256(fs.readFileSync(path.join(assetsDir, name))) }))
    const report = { ...metadata, draftId: snapshot.draftId, assets, checks: checks.map(([, args]) => args.join(' ')), verifiedAt: new Date().toISOString(),
      boundaries: ['Source and downloaded-archive checks only; real host installation, browser and sandbox acceptance are recorded separately.'] }
    fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true })
    fs.writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`)
    return report
  } finally { fs.rmSync(temp, { recursive: true, force: true }) }
}

export function verifyDraft(repo, tag, sha, hostRoot, outputFile, call = gh) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-download-'))
  try {
    const directory = path.join(temp, 'input')
    downloadDraft(repo, tag, sha, directory, call)
    const report = verifyDownloaded(repo, tag, sha, hostRoot, directory, path.join(temp, 'verification.json'))
    checkDraft(repo, tag, sha, path.join(directory, 'draft-snapshot.json'), call)
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
    else if (command === 'download' && args.length === 4) console.log(JSON.stringify(downloadDraft(...args), null, 2))
    else if (command === 'check-draft' && args.length === 4) console.log(JSON.stringify(checkDraft(...args), null, 2))
    else if (command === 'verify-local' && args.length === 6) console.log(JSON.stringify(verifyDownloaded(...args), null, 2))
    else throw new Error('Usage: github-release.mjs prepare <repo> <tag> <sha> <assets> <notes> | verify <repo> <tag> <sha> <host> <report> | download <repo> <tag> <sha> <new-dir> | check-draft <repo> <tag> <sha> <snapshot> | verify-local <repo> <tag> <sha> <host> <download-dir> <report>')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
