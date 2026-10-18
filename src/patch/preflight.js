// 全量预检：在写下任何字节之前，判定每条补丁每个目标的处境。
//
// Apply 的第一原则是零写入：只要有一个目标缺失、冲突或校验不过，整批补丁
// 一条都不落盘。预检与写入因此是两个独立阶段，预检不产生副作用。
//
// 判定顺序是三层，逐层收窄：
//   1. 文件是否等于本方写下的那一版，且那一版是不是按当前声明写的 → 已应用。
//   2. 整文件预哈希是否等于声明的目标版本 → 不是就冲突。
//   3. 原文命中数是否精确等于声明值 → 不是就冲突。
//
// 第 1 层里「按哪份声明写的」不能靠 after 哈希回答：应用记录存的是整文件哈希，
// 声明里写的是被替换的那一段，两者永远不等。判断依据是记录里的声明指纹，见
// declarationFingerprint。
//
// 没有指纹的旧记录不能一律按已应用放过——那会让档位切换静默失效：真实宿主上正躺
// 着这样一批记录，切到完全解放后磁盘仍是旧档取值，预检却报「全部补丁均已是目标
// 状态」。替代判据是反推：把当前内容里本档的 after 换回 before，还原出的文件哈希
// 若等于声明的前置哈希，这一版就是本档写的；否则判 needs_reapply，由写入阶段按当前
// 档重写，而不是假装已经到位。
//
// 第 1 层必须先判。一个文件可能同时被 replace 与 verify 两类补丁命中（同一份
// preset 既有工具修剪器行又有 fetch 行），而 verify 的目标往往正是被 replace
// 改过的那个文件。此时「当前哈希 ≠ 原始预哈希」不是异常，是正常状态——它说明
// 本方已经动过这个文件。少了这层，一次成功的 Apply 之后 status 会立刻显示冲突、
// 第二次 Apply 会被自己的改动阻断。
//
// 预哈希缺失不是可降级的处境。没有它，判定就退回纯字符串比对，而重复应用的
// 痕迹与初次应用长得一模一样。所以哈希表缺失、或某个目标没有哈希记录，都直接
// 判为阻断——宁可停下，也不用弱判定去动宿主文件。
//
// 两份内容分开持有，这是本模块最容易写错的地方：
//   - original 是磁盘上此刻的真实内容，只读一次。整文件预哈希只对它判定。
//   - working 是同批次内演进后的内容，供字符串替换与命中数使用。

import { hashText } from './fsx.js'

/** 计数子串出现次数。空串返回 0：空原文会命中无限多次，不能当成有效匹配。 */
export function countOccurrences(content, needle) {
  if (needle === '') return 0
  let count = 0
  let index = content.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = content.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * 声明指纹：补丁 id 与它此刻声明的原文、改后文本一起取摘要。
 *
 * 应用记录里存下它，预检才能回答第二个问题：磁盘上这份内容确实是本方写的不假，
 * 但它是不是**当前**声明要的那一版？模式切换时 afterByMode 给出另一段改后文本，
 * 指纹随之改变；宿主文件被外部改动不该改变它，所以宿主内容不参与。
 *
 * 调用方传入的 target 必须是按当前模式解析过的那一份（resolvePatches 的产物）。
 * 拿原始 PATCHES 去算会漏掉 afterByMode，指纹对不上就等于把正常状态报成冲突。
 *
 * @param {string} patchId - 补丁 id。
 * @param {object} target - 目标声明，after 已按当前模式解析。
 * @returns {string} 摘要。
 */
export function declarationFingerprint(patchId, target) {
  return hashText([patchId, target.before ?? '', target.after ?? ''].join('\u0000'))
}

/**
 * 把当前内容里的 after 换回 before，还原成「尚未应用」的样子。
 *
 * 这是给没有指纹的旧记录用的判据。一个文件可能被多条 replace 目标命中（同一份
 * preset 的修剪器行与读取上限行），所以要整体还原再比对哈希，不能只还原当前这一条
 * ——只还原一条得到的是半应用状态，哈希必然对不上前置哈希，会把正常状态误判。
 *
 * 导出是为了让 tools/rebuild-state.mjs 用同一条规则判断「盘上这份内容是不是只按
 * 本方声明改过」。两份各自实现的还原逻辑迟早会分叉，而分叉的代价是重建出一份
 * revert 兑现不了的记录。
 *
 * @param {string} content - 磁盘上的内容。
 * @param {Array<{ before?: string, after?: string }>} siblings - 该路径下全部档位的 replace 变体。
 * @returns {string} 还原后的内容。
 */
export function revertSnippets(content, siblings) {
  let text = content
  for (const sibling of siblings) {
    const after = sibling.after
    if (typeof after !== 'string' || after === '') continue
    text = text.split(after).join(sibling.before ?? '')
  }
  return text
}

/** 反向操作：把还原出的内容按本档再应用一次，得到本档应有的磁盘内容。 */
function applySnippets(content, siblings) {
  let text = content
  for (const sibling of siblings) {
    if (typeof sibling.after !== 'string') continue
    text = text.split(sibling.before ?? '').join(sibling.after)
  }
  return text
}

/**
 * replace 的判定。
 * @param {object} target - 目标声明。
 * @param {string} original - 磁盘上的原始内容。
 * @param {string} current - 同批次内演进后的内容。
 * @param {string} expectedHash - 声明的预哈希（宿主未被本插件改动时的整文件哈希）。
 * @param {{ before?: string, after?: string, declarations?: string[] }} applied - 应用记录：应用前的整文件哈希、本方写下的整文件哈希，以及写下时那份声明的指纹集合。
 * @param {string} declaredFingerprint - 当前声明算出的指纹。
 * @param {Array<{ before?: string, after?: string }>} variants - 该路径下**全部档位**的 replace 变体，用于还原原文。
 * @param {Array<{ before?: string, after?: string }>} forwardTargets - 该路径下当前档的 replace 目标，用于正推。
 */
function judgeReplace(target, original, current, expectedHash, applied, declaredFingerprint, variants, forwardTargets) {
  const expected = target.expectHits
  const originalHash = hashText(original)

  if (applied.after !== undefined && originalHash === applied.after) {
    if (applied.declarations !== undefined) {
      // 同一文件可能被多条 replace 目标命中，每条的指纹都记下来；只要当前声明在集合
      // 里，就说明磁盘这一版正是本档写的。只存一条会让同文件的第二个目标永远对不上。
      if (!applied.declarations.includes(declaredFingerprint)) {
        return {
          state: 'applied_other',
          hits: 0,
          expected,
          reason: '已应用的是上一次声明的版本（可能是另一档），需先回退再应用',
        }
      }
      return { state: 'applied', hits: 0, expected, reason: '内容等于本方写入的版本' }
    }

    // 旧记录没有指纹：两条都要成立才算已应用。还原出的内容必须真的是声明的那份原文
    // （整文件预哈希对账，与 tools/rebuild-state.mjs 的采纳判据同一条），按当前档正推
    // 必须逐字节等于磁盘这一版。只看后者不够——声明漂移、正推又恰好是空操作时，它自己
    // 等于自己，等于把「没有证据」当成证据。
    const rebuilt = revertSnippets(original, variants)
    const forward = applySnippets(rebuilt, forwardTargets)
    if (hashText(rebuilt) === expectedHash && forward === original) {
      return { state: 'applied', hits: 0, expected, reason: '内容等于本方写入的版本' }
    }
    return {
      state: 'needs_reapply',
      hits: 0,
      expected,
      reason: '记录里没有声明指纹，磁盘内容与当前声明的版本不符，按当前档重写',
      forward,
    }
  }

  if (originalHash !== expectedHash) {
    return {
      state: 'conflict',
      hits: countOccurrences(current, target.before),
      expected,
      reason: '整文件预哈希不符，宿主已偏离声明的版本。'
        + '若这份内容确是本插件写的而应用记录已丢失，跑 node tools/rebuild-state.mjs <宿主根> 重建记录。',
    }
  }

  const hits = countOccurrences(current, target.before)
  return hits === expected
    ? { state: 'pending', hits, expected, reason: '' }
    : {
      state: 'conflict',
      hits,
      expected,
      reason: `预哈希通过但原文命中 ${String(hits)} 次，期望 ${String(expected)} 次`,
    }
}

/**
 * verify 的判定：只断言目标状态存在，不改文件。
 *
 * 与 replace 一样先认「本方写下的版本」：verify 的目标常常正是被 replace 补丁改过的
 * 文件，用原始预哈希去卡它必然不符。
 *
 * 指纹也照 replace 的口径判。verify 目标没有 after，指纹只由补丁 id 决定，同一档
 * 里恒定；真出现记录指纹与当前不符，说明这条断言在不同档里换了含义，同样要回退。
 */
function judgeVerify(target, original, current, expectedHash, applied, declaredFingerprint) {
  const expected = target.minHits
  const originalHash = hashText(original)

  if (applied.after !== undefined && originalHash === applied.after) {
    // verify 不写正文，只断言目标状态存在；同一个文件可能由另一条 replace 补丁
    // 写入，拿 verify 自己的指纹去比必然不等，所以这里不做档位判定。
    const hits = countOccurrences(current, target.needle)
    return {
      state: hits >= expected ? 'satisfied' : 'unsatisfied',
      hits,
      expected,
      reason: hits >= expected ? '' : `文件由本方写入，但前置状态命中 ${String(hits)} 次，至少需要 ${String(expected)} 次`,
    }
  }

  if (originalHash !== expectedHash) {
    return { state: 'unsatisfied', hits: 0, expected, reason: '整文件预哈希不符' }
  }

  const hits = countOccurrences(current, target.needle)
  return {
    state: hits >= expected ? 'satisfied' : 'unsatisfied',
    hits,
    expected,
    reason: hits >= expected ? '' : `前置状态命中 ${String(hits)} 次，至少需要 ${String(expected)} 次`,
  }
}

/**
 * 逐条判定，不写盘。
 *
 * @param {object} options
 * @param {string} options.root - 宿主根目录的绝对路径。
 * @param {Array} options.patches - 补丁声明。
 * @param {(file: string) => string | null} options.readFile - 读文件；不存在返回 null。
 * @param {Record<string, Record<string, string>>} options.hashes - 预哈希表，必填。
 * @param {Record<string, { after?: string, declaration?: string }>} [options.appliedRecords] - 状态清单的应用记录。
 * @param {Record<string, string>} [options.appliedHashes] - 旧形态：只有应用后哈希。
 * @returns {{ ok: boolean, findings: Array, changes: Map<string, object>, blocked: Array }}
 */
export function preflight({ root, patches, readFile, hashes, appliedHashes = {}, appliedRecords, variantsByPath }) {
  // 哈希表缺失是配置错误，不是可降级的处境。
  if (hashes === null || hashes === undefined) {
    return {
      ok: false,
      findings: [],
      changes: new Map(),
      blocked: [{
        patchId: '-',
        path: '-',
        reason: '预哈希清单缺失，拒绝在弱判定下继续。跑 tools/collect-hashes.mjs 重新生成。',
      }],
    }
  }

  const records = appliedRecords !== null && typeof appliedRecords === 'object' ? appliedRecords : null
  const legacyHashes = appliedHashes !== null && typeof appliedHashes === 'object' ? appliedHashes : {}

  // 两种入参形状在这里归一。新形态带着指纹集合，旧的单指纹形态当作只有一个元素的
  // 集合；完全没有指纹的旧记录留空，交给反推判定，而不是乱猜或直接放过。
  const declarationsOf = (record) => {
    if (Array.isArray(record.declarations)) {
      const list = record.declarations.filter(item => typeof item === 'string')
      return list.length > 0 ? list : undefined
    }
    return typeof record.declaration === 'string' ? [record.declaration] : undefined
  }

  const appliedOf = (path) => {
    const record = records === null ? undefined : records[path]
    if (record !== null && typeof record === 'object') {
      return {
        before: typeof record.before === 'string' ? record.before : undefined,
        after: typeof record.after === 'string' ? record.after : undefined,
        declarations: declarationsOf(record),
      }
    }
    const legacy = legacyHashes[path]
    return { after: typeof legacy === 'string' ? legacy : undefined, declarations: undefined }
  }

  // 同一路径可能被多条 replace 目标命中：判「这一版是哪份声明写的」要整体还原，所以
  // 每条目标都需要看到同路径下的全部变体。当前档的兄弟目标负责正推，全档变体负责还原。
  const replaceTargetsByPath = new Map()
  for (const patch of patches) {
    if (patch.kind === 'verify') continue
    for (const target of patch.targets) {
      const list = replaceTargetsByPath.get(target.path)
      if (list === undefined) replaceTargetsByPath.set(target.path, [target])
      else list.push(target)
    }
  }
  const revertVariantsByPath = variantsByPath instanceof Map ? variantsByPath : replaceTargetsByPath

  const findings = []
  const blocked = []
  const originals = new Map()
  const working = new Map()

  const originalOf = (target) => {
    if (!originals.has(target)) originals.set(target, readFile(`${root}/${target}`))
    return originals.get(target)
  }
  const currentOf = (target) => (working.has(target) ? working.get(target) : originalOf(target))

  for (const patch of patches) {
    for (const target of patch.targets) {
      const original = originalOf(target.path)
      if (original === null || original === undefined) {
        findings.push({ patchId: patch.id, path: target.path, state: 'missing' })
        blocked.push({ patchId: patch.id, path: target.path, reason: '意图目标文件不存在' })
        continue
      }

      const expectedHash = hashes[patch.id] === undefined ? undefined : hashes[patch.id][target.path]
      if (expectedHash === undefined) {
        findings.push({ patchId: patch.id, path: target.path, state: 'missing' })
        blocked.push({
          patchId: patch.id,
          path: target.path,
          reason: '该目标没有预哈希记录，拒绝在弱判定下继续',
        })
        continue
      }

      const current = currentOf(target.path)
      const applied = appliedOf(target.path)
      const fingerprint = declarationFingerprint(patch.id, target)
      const forwardTargets = replaceTargetsByPath.get(target.path) ?? []
      const variants = revertVariantsByPath.get(target.path) ?? forwardTargets

      const verdict = patch.kind === 'verify'
        ? judgeVerify(target, original, current, expectedHash, applied, fingerprint)
        : judgeReplace(target, original, current, expectedHash, applied, fingerprint, variants, forwardTargets)

      if (verdict.state === 'needs_reapply') {
        // 正推结果已经算出。写之前还要确认它自洽：每条当前档目标的 after 命中数都必须
        // 等于声明值。不满足就宁可阻断，不拿一份半对的文本去覆盖宿主。
        const forward = verdict.forward
        const inconsistent = forwardTargets.find(sibling => sibling.expectHits !== undefined
          && countOccurrences(forward, sibling.after ?? '') !== sibling.expectHits)
        if (inconsistent === undefined) {
          working.set(target.path, forward)
          findings.push({
            patchId: patch.id,
            path: target.path,
            state: verdict.state,
            hits: verdict.hits,
            expected: verdict.expected,
            reason: verdict.reason,
          })
        } else {
          const reason = '记录里没有声明指纹，且按当前声明重写得不到自洽结果，需先回退再应用'
          findings.push({
            patchId: patch.id,
            path: target.path,
            state: 'conflict',
            hits: verdict.hits,
            expected: verdict.expected,
            reason,
          })
          blocked.push({ patchId: patch.id, path: target.path, reason })
        }
        continue
      }

      findings.push({
        patchId: patch.id,
        path: target.path,
        state: verdict.state,
        hits: verdict.hits,
        expected: verdict.expected,
        reason: verdict.reason,
      })

      if (verdict.state === 'pending') {
        working.set(target.path, current.split(target.before).join(target.after))
      } else if (verdict.state === 'conflict' || verdict.state === 'unsatisfied' || verdict.state === 'applied_other') {
        // applied_other 按阻塞处理：磁盘上那一版是本方写的，但不是当前声明要的。
        // 这里必须并进 blocked——写入阶段只认 blocked，漏掉它整批就会被当成
        // 「已经是目标状态」，档位停在旧取值上。
        blocked.push({
          patchId: patch.id,
          path: target.path,
          reason: verdict.reason === '' ? '判定未通过' : verdict.reason,
        })
      }
    }
  }

  // 只有真正发生变化的文件才进入写入集。
  const changes = new Map()
  for (const [target, content] of working) {
    const original = originalOf(target)
    if (original !== null && original !== undefined && original !== content) {
      changes.set(target, { before: original, after: content })
    }
  }

  return { ok: blocked.length === 0, findings, changes, blocked }
}
