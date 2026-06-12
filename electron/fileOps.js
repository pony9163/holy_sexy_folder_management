// 文件整理与撤销的核心逻辑（仅主进程使用，CommonJS）
//
// 安全不变量（改动本模块必须维持）：
// 1. 绝不删除用户数据：映射表撤销后只改写 JSON 标记 undone，文件本体永不删除。
//    唯一例外是 cleanEmptyCreatedFolders（用户主动点击清理按钮触发）：
//    只对应用自己创建（记录在映射表 createdFolders）且已空的分类文件夹做
//    非递归 fs.rmdir——该调用天然拒绝非空目录，不可能触碰任何用户文件
// 2. 移动只用 fs.rename（同盘原子移动），EXDEV 跨设备时直接报错跳过，
//    绝不退化为「复制后删除」
// 3. 所有路径拼接一律 path.join / path.resolve，不手写分隔符
// 4. 第一次 rename 之前完整映射表必须已落盘，之后每步都同步改写，
//    保证任意时刻崩溃后撤销仍能正确工作
const path = require('path')
const fs = require('fs/promises')
const os = require('os')

// ===== 硬性安全检查（必须写在所有业务逻辑之前）=====

// 系统目录黑名单：选中目录等于或位于这些目录之下时直接拒绝整理
const FORBIDDEN_PREFIXES = {
  linux: ['/usr', '/etc', '/boot', '/bin', '/sbin', '/var', '/lib', '/opt'],
  darwin: ['/System', '/Library', '/usr', '/bin', '/private'],
  win32: ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'],
}

/**
 * 路径边界前缀匹配：target 等于 dir 本身，或位于 dir 之下。
 * 用 path.sep 做边界，防止 /usr2 被误判为 /usr 的子路径；
 * macOS / Windows 文件系统默认大小写不敏感，比较前统一转小写。
 */
function isUnderDir(target, dir) {
  const caseInsensitive = process.platform !== 'linux'
  const t = caseInsensitive ? target.toLowerCase() : target
  const d = caseInsensitive ? dir.toLowerCase() : dir
  return t === d || t.startsWith(d + path.sep)
}

/**
 * 检查目录是否允许整理：返回 null 表示通过，否则返回中文错误消息。
 * 拒绝四类目录：文件系统根目录、系统目录黑名单、用户主文件夹本身、
 * 隐藏文件夹（路径中任一段以 . 开头，如 ~/.config 及其子目录）。
 * 调用方应先用 fs.realpath 消解符号链接再传入，防止链接指向受保护目录绕过检查。
 */
function checkFolderSafety(folderPath) {
  const resolved = path.resolve(folderPath)
  // 文件系统根目录本身（/ 或 C:\）绝不允许整理
  if (resolved === path.parse(resolved).root) {
    return '不允许整理文件系统根目录'
  }
  const prefixes = FORBIDDEN_PREFIXES[process.platform] || []
  for (const prefix of prefixes) {
    if (isUnderDir(resolved, prefix)) {
      return `该目录位于系统目录 ${prefix} 内，为安全起见禁止整理`
    }
  }
  // 用户主文件夹本身不允许整理（第一层混着配置文件，整理会破坏环境）；
  // 其子文件夹（如 ~/下载）仍允许。大小写规则与 isUnderDir 一致：非 Linux 不敏感
  const home = path.resolve(os.homedir())
  const caseInsensitive = process.platform !== 'linux'
  if ((caseInsensitive ? resolved.toLowerCase() : resolved) ===
      (caseInsensitive ? home.toLowerCase() : home)) {
    return '不允许直接整理用户主文件夹，请选择其中的具体子文件夹（如「下载」）'
  }
  // 隐藏文件夹不允许整理：选中目录本身是隐藏目录，或位于隐藏目录之下
  // （resolved 已规范化，路径段不会有 . / .. 残留，length > 1 只是双保险）
  if (resolved.split(path.sep).some((seg) => seg.startsWith('.') && seg.length > 1)) {
    return '不允许整理隐藏文件夹（名称以 . 开头）：这类文件夹通常存放程序配置数据'
  }
  return null
}

// ===== 工具函数 =====

/** fs.access 探测路径是否存在（不区分文件/目录） */
async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/**
 * 在 dir 内为 name 生成不冲突的名字：a.txt → a (1).txt → a (2).txt …
 * 上限 9999 次防止极端情况下死循环。
 */
async function uniqueName(dir, name) {
  if (!(await exists(path.join(dir, name)))) return name
  const { name: base, ext } = path.parse(name)
  for (let i = 1; i <= 9999; i++) {
    const candidate = `${base} (${i})${ext}`
    if (!(await exists(path.join(dir, candidate)))) return candidate
  }
  throw new Error(`无法为「${name}」生成不重复的文件名`)
}

/** 把 fs 错误翻译成用户可读的中文消息 */
function translateFsError(err) {
  switch (err.code) {
    case 'EXDEV':
      return '目标位置位于其他磁盘或挂载点，为安全起见本工具不做「复制后删除」，已跳过'
    case 'EACCES':
    case 'EPERM':
      return '没有权限移动该文件'
    case 'ENOENT':
      return '文件已不存在'
    case 'EBUSY':
      return '文件正被其他程序占用'
    default:
      return err.message || '移动失败'
  }
}

// ===== 整理 =====

/**
 * 执行整理：在 folderPath 内创建分类子文件夹，并把文件 rename 进去。
 *
 * @param {string} folderPath 已通过安全检查的目标文件夹（绝对路径）
 * @param {Array<{folderName: string, fileNames: string[]}>} groups 分类方案（名字已经过主进程校验）
 * @param {string} logDir 映射表存放目录（userData 下）
 * @param {(current: number, total: number) => void} [onProgress] 每移动一个文件回调一次
 * @param {{allowDirs?: boolean}} [options] allowDirs=true 时允许移动文件夹
 *   （来自前端「不整理已有文件夹」约束开关的显式放行）；默认 false 维持拒绝移动文件夹的安全行为
 * @returns {Promise<{moved: number, total: number, errors: Array<{name, error}>}>}
 *
 * 单文件失败策略：跳过并记录，不中止——每次移动相互独立，
 * 「恢复」统一交给显式撤销；映射表逐条标记 done/failed，
 * 部分失败不破坏撤销的正确性。
 */
async function organize(folderPath, groups, logDir, onProgress, options = {}) {
  const allowDirs = options.allowDirs === true
  const errors = []
  const createdFolders = []
  const moves = []

  // 1) 创建分类子文件夹，并为每个文件计算移动计划
  for (const group of groups) {
    const targetDir = path.join(folderPath, group.folderName)
    let dirStat = null
    try {
      dirStat = await fs.lstat(targetDir)
    } catch {
      // 不存在 → 下面新建
    }
    if (dirStat && !dirStat.isDirectory()) {
      // 同名条目已存在且是文件：整组跳过（不能覆盖用户文件）
      for (const name of group.fileNames) {
        errors.push({ name, error: `分类文件夹「${group.folderName}」与现有文件同名，该组已跳过` })
      }
      continue
    }
    if (!dirStat) {
      await fs.mkdir(targetDir, { recursive: true })
      createdFolders.push(targetDir)
    }

    for (const name of group.fileNames) {
      const from = path.join(folderPath, name)
      let fileStat = null
      try {
        fileStat = await fs.lstat(from)
      } catch {
        // 源文件已不存在
      }
      if (!fileStat) {
        errors.push({ name, error: '文件已不存在，跳过' })
        continue
      }
      if (fileStat.isDirectory() && !allowDirs) {
        errors.push({ name, error: '是文件夹，不参与整理' })
        continue
      }
      if (fileStat.isDirectory() && path.resolve(from) === path.resolve(targetDir)) {
        // 分类名与被移动文件夹同名：移动等于把文件夹塞进它自身，明确拒绝
        //（更深的嵌套情况由 OS 的 rename 报错，走下面的 errors 流程）
        errors.push({ name, error: '不能把文件夹移入它自身' })
        continue
      }
      // 目标位置已有同名文件时加 (1)、(2)…
      const targetName = await uniqueName(targetDir, name)
      moves.push({
        from,
        to: path.join(targetDir, targetName),
        status: 'pending', // pending | done | failed
        error: null,
        undoStatus: null, // 撤销后填 restored | renamed | skipped | failed
      })
    }
  }

  // 2) 映射表先落盘——必须在第一次 rename 之前完成
  await fs.mkdir(logDir, { recursive: true })
  const record = {
    version: 1,
    createdAt: new Date().toISOString(),
    folderPath,
    createdFolders,
    undone: false,
    undoneAt: null,
    moves,
  }
  // 文件名带时间戳（: 和 . 替换为 -，兼容 Windows；保留毫秒避免同秒覆盖）
  const logFile = path.join(logDir, `organize-${record.createdAt.replace(/[:.]/g, '-')}.json`)
  const saveRecord = () => fs.writeFile(logFile, JSON.stringify(record, null, 2), { mode: 0o600 })
  await saveRecord()

  // 3) 逐条执行 rename，每步成功/失败都立刻改写映射表
  const total = moves.length
  let current = 0
  let moved = 0
  for (const move of moves) {
    try {
      // 复核：计划落盘到执行之间目标可能被外部进程占用，
      // 而 POSIX rename 会静默覆盖目标——必须重算名字并先改写映射表再移动
      if (await exists(move.to)) {
        const dir = path.dirname(move.to)
        const retryName = await uniqueName(dir, path.basename(move.from))
        move.to = path.join(dir, retryName)
        await saveRecord()
      }
      await fs.rename(move.from, move.to)
      move.status = 'done'
      moved++
    } catch (err) {
      move.status = 'failed'
      move.error = translateFsError(err)
      errors.push({ name: path.basename(move.from), error: move.error })
    }
    await saveRecord()
    current++
    if (onProgress) onProgress(current, total)
  }

  return { moved, total, errors }
}

// ===== 撤销 =====

/**
 * 读取 logDir 内全部整理记录，按文件名倒序（= 时间倒序，ISO 时间戳零填充保证字典序）。
 * 解析失败或结构非法（folderPath/moves 缺失）的文件跳过，绝不删除。
 * @returns {Promise<Array<{ fileName, filePath, record }>>}
 */
async function readAllRecords(logDir) {
  let names
  try {
    names = await fs.readdir(logDir)
  } catch {
    return [] // 目录还不存在 = 从未整理过
  }
  const out = []
  for (const n of names.filter((x) => /^organize-.*\.json$/.test(x)).sort().reverse()) {
    const filePath = path.join(logDir, n)
    try {
      const record = JSON.parse(await fs.readFile(filePath, 'utf-8'))
      if (record && typeof record.folderPath === 'string' && Array.isArray(record.moves)) {
        out.push({ fileName: n, filePath, record })
      }
    } catch {
      // 损坏的记录文件：跳过，不删除
    }
  }
  return out
}

/**
 * 找最近一次未撤销的整理记录，没有则返回 null。
 * 传入 folderPath 时只看该文件夹的记录（严格字符串比对，落盘前已 realpath 规范化，
 * 调用方需先 realpath 入参——与 restoreTo 的链条语义一致）；不传保持全局行为。
 */
async function findLatestUndoable(logDir, folderPath) {
  for (const { record, filePath } of await readAllRecords(logDir)) {
    if (record.undone !== true && (!folderPath || record.folderPath === folderPath)) {
      return { record, filePath }
    }
  }
  return null
}

/**
 * 历史快照摘要列表（时间倒序），供历史弹窗展示。
 * 只返回摘要不含 moves 明细（可能上千条，弹窗用不到）；
 * fileName 作为恢复操作的标识参数（前端原样回传，主进程再校验）。
 */
async function listHistory(logDir) {
  return (await readAllRecords(logDir)).map(({ fileName, record }) => ({
    fileName,
    createdAt: record.createdAt,
    folderPath: record.folderPath,
    moveCount: record.moves.length,
    failedCount: record.moves.filter((m) => m.status === 'failed').length,
    undone: record.undone === true,
    undoneAt: record.undoneAt || null,
  }))
}

/**
 * 撤销一份指定的整理记录：按映射表倒序把文件 rename 回原位。
 * - 文件已不在整理后的位置（含「rename 成功但映射表改写前崩溃」的 pending 条目）→ 跳过
 * - 原位置已被占用 → 加 (1) 后移回原目录（撤销的承诺是回到原文件夹、零数据丢失）
 * 完成后改写 JSON 标记 undone——映射表文件本身永不删除；
 * 整理时创建的分类文件夹即使空了也保留（本工具无删除操作），由前端提示用户。
 */
async function undoRecord(record, filePath, onProgress) {
  // 双保险：历史记录里的目录同样过一遍安全检查（链式恢复时逐份都查）
  const unsafe = checkFolderSafety(record.folderPath)
  if (unsafe) throw new Error(unsafe)

  const saveRecord = () => fs.writeFile(filePath, JSON.stringify(record, null, 2), { mode: 0o600 })
  const reversed = [...record.moves].reverse()
  const total = reversed.length
  let current = 0
  let restored = 0
  const skipped = [] // [{ name, reason }]
  const renamed = [] // [{ name, newName }]

  for (const move of reversed) {
    const name = path.basename(move.from)
    try {
      if (!(await exists(move.to))) {
        // 从未移动成功，或用户已把它挪走/改名
        move.undoStatus = 'skipped'
        skipped.push({ name, reason: '文件已不在整理后的位置' })
      } else if (await exists(move.from)) {
        // 原位置已有同名文件：加 (1) 移回原目录
        const dir = path.dirname(move.from)
        const newName = await uniqueName(dir, name)
        await fs.rename(move.to, path.join(dir, newName))
        move.undoStatus = 'renamed'
        renamed.push({ name, newName })
        restored++
      } else {
        await fs.rename(move.to, move.from)
        move.undoStatus = 'restored'
        restored++
      }
    } catch (err) {
      move.undoStatus = 'failed'
      skipped.push({ name, reason: translateFsError(err) })
    }
    await saveRecord()
    current++
    if (onProgress) onProgress(current, total)
  }

  // 标记已撤销（改写 JSON，不删除文件）
  record.undone = true
  record.undoneAt = new Date().toISOString()
  await saveRecord()

  return {
    restored,
    total,
    skipped,
    renamed,
    folderPath: record.folderPath,
    // 返回文件夹名（非完整路径）供前端提示「已保留未删除」
    keptFolders: (record.createdFolders || []).map((p) => path.basename(p)),
  }
}

/** 撤销最近一次未撤销的整理（undoRecord 的薄壳）；folderPath 限定只撤销该文件夹的 */
async function undoOrganize(logDir, folderPath, onProgress) {
  const found = await findLatestUndoable(logDir, folderPath)
  if (!found) {
    throw new Error(folderPath ? '该文件夹没有可撤销的整理记录' : '没有可撤销的整理记录')
  }
  return undoRecord(found.record, found.filePath, onProgress)
}

/**
 * 顺序回滚：恢复到 logFileName 这次整理之前的状态。
 * 链条 = 与目标记录 folderPath 相同（字符串严格相等——organize:run 落盘前已经过
 * fs.realpath 规范化，这里不再 realpath，目录可能已不存在）、createdAt 不早于目标、
 * 且尚未撤销的全部记录，按时间倒序逐份 undoRecord。
 * 已手动撤销的记录天然被过滤掉；其他文件夹的记录不受影响。
 * 进度聚合：grandTotal = 链条内所有 moves 之和，把每份记录的内部进度换算为全局进度。
 */
async function restoreTo(logDir, logFileName, onProgress) {
  const all = await readAllRecords(logDir)
  const target = all.find((x) => x.fileName === logFileName)
  if (!target) throw new Error('整理记录不存在或已损坏')

  // 双保险：动文件前先查目标文件夹安全性（undoRecord 内部还会逐份再查）
  const unsafe = checkFolderSafety(target.record.folderPath)
  if (unsafe) throw new Error(unsafe)

  // readAllRecords 已按时间倒序，filter 保序 = 链条天然从最新撤到目标那一次
  const chain = all.filter(
    (x) =>
      x.record.folderPath === target.record.folderPath &&
      x.record.createdAt >= target.record.createdAt && // ISO 字符串比较即时间比较
      x.record.undone !== true,
  )
  if (chain.length === 0) throw new Error('该次整理及其之后的记录都已撤销，无需恢复')

  const grandTotal = chain.reduce((sum, x) => sum + x.record.moves.length, 0)
  let base = 0
  let restored = 0
  const skipped = []
  const renamed = []
  const keptFolderSet = new Set()

  for (const { record, filePath } of chain) {
    const r = await undoRecord(record, filePath, (current) => {
      if (onProgress) onProgress(base + current, grandTotal)
    })
    base += record.moves.length
    restored += r.restored
    skipped.push(...r.skipped)
    renamed.push(...r.renamed)
    for (const f of r.keptFolders) keptFolderSet.add(f)
  }

  return {
    restoredRecords: chain.length, // 实际连带撤销的整理次数
    restored,
    total: grandTotal,
    skipped,
    renamed,
    keptFolders: [...keptFolderSet],
    folderPath: target.record.folderPath,
  }
}

/**
 * 清理整理产生的空分类文件夹（用户在撤销/恢复后主动点击清理按钮触发）。
 * 候选集只来自映射表：folderPath 匹配且已撤销（undone）的记录里的 createdFolders
 * ——即应用自己创建过的文件夹，渲染进程无法指定任意路径。
 * 删除只用非递归 fs.rmdir：目录非空必然抛错（保留并说明），绝不可能删到用户文件。
 * @returns {Promise<{removed: string[], kept: Array<{name, reason}>, folderPath: string}>}
 */
async function cleanEmptyCreatedFolders(logDir, folderPath) {
  const unsafe = checkFolderSafety(folderPath)
  if (unsafe) throw new Error(unsafe)

  // 收集候选：已撤销记录的 createdFolders，且必须直接位于 folderPath 之下（防御历史数据异常）
  const candidates = new Set()
  for (const { record } of await readAllRecords(logDir)) {
    if (record.folderPath === folderPath && record.undone === true) {
      for (const p of record.createdFolders || []) {
        if (typeof p === 'string' && path.dirname(path.resolve(p)) === path.resolve(folderPath)) {
          candidates.add(path.resolve(p))
        }
      }
    }
  }

  const removed = []
  const kept = []
  for (const dir of candidates) {
    const name = path.basename(dir)
    try {
      const st = await fs.lstat(dir)
      if (!st.isDirectory()) continue // 同名条目已变成文件/链接：不动
      await fs.rmdir(dir) // 非递归：只能删空文件夹
      removed.push(name)
    } catch (err) {
      if (err.code === 'ENOENT') continue // 已不存在（用户手动删过）
      kept.push({
        name,
        reason:
          err.code === 'ENOTEMPTY' || err.code === 'EEXIST'
            ? '文件夹非空，已保留'
            : translateFsError(err),
      })
    }
  }
  return { removed, kept, folderPath }
}

module.exports = {
  checkFolderSafety,
  uniqueName,
  organize,
  cleanEmptyCreatedFolders,
  readAllRecords,
  findLatestUndoable,
  listHistory,
  undoRecord,
  undoOrganize,
  restoreTo,
}
