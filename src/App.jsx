// 应用主界面：
// - 顶部：标题 + "分析" / "选择文件夹" / ⚙️ 设置按钮
// - 选中文件夹后：显示当前路径、条目数和文件列表表格
// - 点「分析」：把文件清单发给 Kimi 生成分类方案，结果以预览卡片展示（可排除文件后确认）
// - ⚙️ 设置：填写/管理 Moonshot API Key（加密存储在主进程侧）
import { useEffect, useMemo, useState } from 'react'
import FileTable from './components/FileTable'
import ApiKeyModal from './components/ApiKeyModal'
import PlanPreview from './components/PlanPreview'
import HistoryModal from './components/HistoryModal'

// 约束开关的持久化 key 与默认值（跨会话记住用户习惯）
const CONSTRAINTS_KEY = 'organize-constraints-v1'
const DEFAULT_CONSTRAINTS = {
  skipDirs: true,           // 不整理已有文件夹（默认开启）
  skipRecent: false,        // 不动最近 7 天修改的文件
  excludeExtsEnabled: false, // 是否启用按扩展名排除
  excludeExts: '',          // 逗号分隔的扩展名，如 "exe,dmg"
}

function loadConstraints() {
  try {
    return { ...DEFAULT_CONSTRAINTS, ...JSON.parse(localStorage.getItem(CONSTRAINTS_KEY)) }
  } catch {
    return DEFAULT_CONSTRAINTS
  }
}

// 取小写扩展名（无扩展名或 dotfile 如 .bashrc 返回空串，空串不会命中排除集合）
function extOf(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

// 参与分析的文件数超过该值时先弹确认框（输出 JSON 过长可能变慢或截断）
const LARGE_FILE_THRESHOLD = 300

export default function App() {
  const [folderPath, setFolderPath] = useState(null) // 当前选中的文件夹路径
  const [files, setFiles] = useState([])             // 第一层文件/文件夹列表
  const [loading, setLoading] = useState(false)      // 是否正在读取文件夹
  const [analyzing, setAnalyzing] = useState(false)  // 是否正在调用 Kimi 分析
  const [progress, setProgress] = useState(0)        // 流式输出已接收的字符数（仅分析中有意义）
  const [analyzeSeconds, setAnalyzeSeconds] = useState(0) // 分析已等待秒数（首响应前的反馈）
  const [analyzeStatus, setAnalyzeStatus] = useState(null) // 分析结果提示 { ok, message }
  const [showSettings, setShowSettings] = useState(false)  // 是否打开 API Key 设置弹窗
  const [keyStatus, setKeyStatus] = useState(null)   // 密钥状态（只含掩码等元信息）
  const [plans, setPlans] = useState(null)            // 分析得到的整理方案数组（null = 不显示预览）
  const [undoable, setUndoable] = useState(null)      // 可撤销记录 { undoable, info }（null = 未查询）
  const [undoing, setUndoing] = useState(false)       // 是否正在撤销
  const [undoProgress, setUndoProgress] = useState(null) // 撤销进度 { current, total }
  const [showHistory, setShowHistory] = useState(false)  // 是否打开整理历史弹窗
  const [constraints, setConstraints] = useState(loadConstraints) // 分析前的约束开关
  const [confirmLarge, setConfirmLarge] = useState(false) // 文件数超阈值的分析确认框
  const [cleanable, setCleanable] = useState(null)    // 可清理空分类文件夹 { folderPath }（撤销/恢复后设置）
  const [cleaning, setCleaning] = useState(false)     // 是否正在清理空文件夹

  // 约束变更即写回 localStorage
  useEffect(() => {
    localStorage.setItem(CONSTRAINTS_KEY, JSON.stringify(constraints))
  }, [constraints])

  // 按约束开关把条目分成「参与整理」和「跳过」两组：
  // 跳过的不发给 AI、不进方案、永远不会被移动；预览里灰色列出跳过原因
  const { eligibleFiles, skippedEntries } = useMemo(() => {
    const excludeSet = new Set(
      constraints.excludeExtsEnabled
        ? constraints.excludeExts
            .split(',')
            .map((s) => s.trim().replace(/^\./, '').toLowerCase())
            .filter(Boolean)
        : [],
    )
    const recentLimit = Date.now() - 7 * 24 * 3600 * 1000
    const eligible = []
    const skipped = []
    for (const f of files) {
      if (constraints.skipDirs && f.isDirectory) {
        skipped.push({ name: f.name, reason: '已有文件夹，不参与整理' })
      } else if (constraints.skipRecent && f.mtime >= recentLimit) {
        skipped.push({ name: f.name, reason: '最近 7 天有修改，已跳过' })
      } else if (!f.isDirectory && excludeSet.has(extOf(f.name))) {
        skipped.push({ name: f.name, reason: `类型已排除（${extOf(f.name)}），已跳过` })
      } else {
        eligible.push(f)
      }
    }
    return { eligibleFiles: eligible, skippedEntries: skipped }
  }, [files, constraints])

  // 分析中或预览打开时锁定约束开关，避免方案与约束不一致
  const constraintsLocked = analyzing || plans !== null

  // 启动时查一次密钥状态，用于在界面上给出引导提示
  useEffect(() => {
    window.api.apiKey.getStatus().then(setKeyStatus)
  }, [])

  // 订阅分析进度事件（主进程流式接收 Kimi 回复时持续推送），卸载时取消订阅
  useEffect(() => window.api.onAnalyzeProgress(setProgress), [])

  // 分析期间每秒计时：首响应到达前（progress 为 0）按钮显示已等待秒数，让用户知道没卡死
  useEffect(() => {
    if (!analyzing) return
    setAnalyzeSeconds(0)
    const timer = setInterval(() => setAnalyzeSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [analyzing])

  // 订阅撤销进度事件（主进程每移回一个文件推送一次）
  useEffect(() => window.api.organize.onUndoProgress(setUndoProgress), [])

  // 查询是否有可撤销的整理记录（启动时 + 每次整理/撤销完成后刷新）
  async function refreshUndoable() {
    const res = await window.api.organize.getUndoable()
    if (res.ok) setUndoable(res)
  }
  useEffect(() => {
    refreshUndoable()
  }, [])

  // 点击按钮：通过 preload 暴露的 window.api 让主进程弹出对话框并读取目录
  async function handleSelectFolder() {
    setLoading(true)
    try {
      const result = await window.api.selectFolder()
      // result 为 null 表示用户在对话框里点了「取消」，保持界面原状
      if (result) {
        setFolderPath(result.folderPath)
        setFiles(result.files)
        setAnalyzeStatus(null) // 换了文件夹，清掉旧的分析提示
        setPlans(null)         // 旧文件夹的整理预览也一并清掉
        setCleanable(null)     // 旧提示条没了，清理按钮一并撤掉
      }
    } finally {
      setLoading(false)
    }
  }

  // 点击「分析」：文件数超阈值先弹确认框，否则直接分析
  function handleAnalyze() {
    if (eligibleFiles.length > LARGE_FILE_THRESHOLD) {
      setConfirmLarge(true)
    } else {
      doAnalyze()
    }
  }

  // 真正执行分析：把文件清单发给主进程 → Kimi API → 返回分类方案
  async function doAnalyze() {
    setAnalyzing(true)
    setAnalyzeStatus(null)
    setProgress(0)
    setPlans(null) // 先卸载旧预览，重新分析后排除状态从零开始
    try {
      const result = await window.api.analyzeFiles(eligibleFiles)
      if (result.ok) {
        // 主进程返回多套思路不同的方案，直接交给 PlanPreview 按 Tab 渲染
        setPlans(result.plans)
        setAnalyzeStatus({ ok: true, message: `分析完成：生成 ${result.plans.length} 套方案，请在下方切换预览` })
      } else {
        setAnalyzeStatus({ ok: false, message: result.error })
      }
    } finally {
      setAnalyzing(false)
    }
  }

  // 整理完成（PlanPreview 弹窗里点"完成"）：刷新列表、回到文件表格视图、显示结果提示
  function handleOrganized(result) {
    if (result.files) setFiles(result.files)
    setPlans(null)
    setAnalyzeStatus({
      ok: true,
      message: `已整理 ${result.moved} 个文件${
        result.errors.length > 0 ? `，${result.errors.length} 个未能移动` : ''
      }`,
    })
    refreshUndoable()
  }

  // 点击「撤销上次整理」：按最近的映射表把文件移回原位
  async function handleUndo() {
    setUndoing(true)
    setUndoProgress(null)
    try {
      const res = await window.api.organize.undo()
      if (res.ok) {
        // 撤销的是当前展示的文件夹时才刷新列表
        if (res.files && res.folderPath === folderPath) {
          setFiles(res.files)
          setPlans(null) // 文件已变动，旧预览作废
        }
        const extra = []
        if (res.skipped.length > 0) extra.push(`${res.skipped.length} 个文件已不在原处，已跳过`)
        if (res.renamed.length > 0)
          extra.push(`${res.renamed.length} 个文件因原位置被占用，已加 (1) 后缀恢复`)
        if (res.keptFolders.length > 0) {
          extra.push('整理时创建的分类文件夹已保留')
          setCleanable({ folderPath: res.folderPath }) // 显示一键清理按钮
        }
        setAnalyzeStatus({
          ok: true,
          message: `撤销完成：已移回 ${res.restored} 个文件${extra.length > 0 ? '；' + extra.join('；') : ''}`,
        })
      } else {
        setAnalyzeStatus({ ok: false, message: res.error })
      }
    } finally {
      setUndoing(false)
      refreshUndoable()
    }
  }

  // 历史弹窗里恢复完成：刷新列表（仅当恢复的是当前展示的文件夹）、提示结果、刷新可撤销状态
  function handleRestored(result) {
    if (result.files && result.folderPath === folderPath) {
      setFiles(result.files)
      setPlans(null) // 文件已变动，旧预览作废
    }
    const extra = []
    if (result.skipped.length > 0) extra.push(`${result.skipped.length} 个文件已不在原处，已跳过`)
    if (result.renamed.length > 0)
      extra.push(`${result.renamed.length} 个文件因原位置被占用，已加 (1) 后缀恢复`)
    if (result.keptFolders.length > 0) {
      extra.push('整理时创建的分类文件夹已保留')
      setCleanable({ folderPath: result.folderPath }) // 显示一键清理按钮
    }
    setAnalyzeStatus({
      ok: true,
      message: `恢复完成：已连带撤销 ${result.restoredRecords} 次整理，移回 ${result.restored} 个文件${
        extra.length > 0 ? '；' + extra.join('；') : ''
      }`,
    })
    refreshUndoable()
  }

  // 点击「清理空分类文件夹」：删掉撤销后留下的、应用自己创建且已空的分类文件夹
  async function handleCleanFolders() {
    setCleaning(true)
    try {
      const res = await window.api.organize.cleanFolders(cleanable.folderPath)
      if (res.ok) {
        // 清理的是当前展示的文件夹时刷新列表
        if (res.files && res.folderPath === folderPath) setFiles(res.files)
        const parts = [`已清理 ${res.removed.length} 个空分类文件夹`]
        if (res.kept.length > 0)
          parts.push(`${res.kept.length} 个未清理：${res.kept.map((k) => `${k.name}（${k.reason}）`).join('、')}`)
        setAnalyzeStatus({ ok: true, message: parts.join('；') })
        setCleanable(null) // 清理完按钮收起
      } else {
        setAnalyzeStatus({ ok: false, message: res.error })
      }
    } finally {
      setCleaning(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-4xl">
        {/* 标题栏与操作按钮 */}
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">📂 holy_sexy_folder_management</h1>
          <div className="flex gap-3">
            {/* 撤销按钮：只在有可撤销记录时显示，悬停可见上次整理的文件夹和时间 */}
            {undoable?.undoable && (
              <button
                onClick={handleUndo}
                disabled={undoing}
                title={`上次整理：${undoable.info.folderPath}（${new Date(
                  undoable.info.createdAt,
                ).toLocaleString()}，${undoable.info.moveCount} 个文件）`}
                className="rounded-lg border border-amber-300 bg-amber-50 px-5 py-2.5 font-medium text-amber-700 shadow-sm transition hover:bg-amber-100 disabled:opacity-50"
              >
                {undoing
                  ? undoProgress
                    ? `撤销中 ${undoProgress.current}/${undoProgress.total}`
                    : '撤销中…'
                  : '↩️ 撤销上次整理'}
              </button>
            )}
            {/* 整理历史按钮：始终显示（历史全是已撤销记录时仍可查看） */}
            <button
              onClick={() => setShowHistory(true)}
              title="查看整理历史并恢复"
              className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 font-medium text-gray-700 shadow-sm transition hover:bg-gray-50"
            >
              📜 整理历史
            </button>
            {/* 分析按钮：选了文件夹且约束过滤后仍有条目才可点 */}
            <button
              onClick={handleAnalyze}
              disabled={analyzing || eligibleFiles.length === 0}
              title={
                files.length > 0 && eligibleFiles.length === 0
                  ? '所有条目都被约束开关跳过，没有可分析的文件'
                  : undefined
              }
              className="rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {analyzing
                ? progress > 0
                  ? `分析中…已接收 ${progress} 字`
                  : `等待 Kimi 响应…${analyzeSeconds}s`
                : '✨ 分析'}
            </button>
            <button
              onClick={handleSelectFolder}
              disabled={loading}
              className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? '读取中…' : '选择文件夹'}
            </button>
            {/* 设置按钮：打开 API Key 设置弹窗 */}
            <button
              onClick={() => setShowSettings(true)}
              title="API Key 设置"
              className="rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-lg shadow-sm transition hover:bg-gray-50"
            >
              ⚙️
            </button>
          </div>
        </header>

        {/* 约束开关栏：分析前声明哪些条目不参与整理（分析中/预览打开时锁定） */}
        {folderPath && (
          <div
            title={constraintsLocked ? '分析中或预览打开时不可修改，返回文件列表后再调整' : undefined}
            className={`mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-700 shadow-sm ${
              constraintsLocked ? 'opacity-60' : ''
            }`}
          >
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={constraints.skipDirs}
                disabled={constraintsLocked}
                onChange={(e) => setConstraints((c) => ({ ...c, skipDirs: e.target.checked }))}
              />
              不整理已有文件夹
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={constraints.skipRecent}
                disabled={constraintsLocked}
                onChange={(e) => setConstraints((c) => ({ ...c, skipRecent: e.target.checked }))}
              />
              不动最近 7 天修改的文件
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={constraints.excludeExtsEnabled}
                disabled={constraintsLocked}
                onChange={(e) =>
                  setConstraints((c) => ({ ...c, excludeExtsEnabled: e.target.checked }))
                }
              />
              排除文件类型
              <input
                type="text"
                value={constraints.excludeExts}
                disabled={constraintsLocked || !constraints.excludeExtsEnabled}
                onChange={(e) => setConstraints((c) => ({ ...c, excludeExts: e.target.value }))}
                placeholder="如 exe,dmg"
                className="w-28 rounded border border-gray-300 px-2 py-1 text-xs outline-none transition focus:border-blue-400 disabled:bg-gray-100"
              />
            </label>
            {/* 实时统计被跳过的条目数 */}
            {skippedEntries.length > 0 && (
              <span className="text-xs text-gray-400">已跳过 {skippedEntries.length} 项</span>
            )}
          </div>
        )}

        {/* 未配置密钥时的引导提示 */}
        {keyStatus && !keyStatus.configured && (
          <p className="mb-4 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-700">
            尚未设置 API Key，「分析」功能需要先在
            <button onClick={() => setShowSettings(true)} className="mx-1 underline">
              ⚙️ 设置
            </button>
            中填写你的 Moonshot API Key
          </p>
        )}

        {/* 分析结果提示条：成功为绿色，失败为红色；撤销后留有空分类文件夹时附清理按钮 */}
        {analyzeStatus && (
          <p
            className={`mb-4 rounded-lg px-4 py-2.5 text-sm ${
              analyzeStatus.ok
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-red-50 text-red-700'
            }`}
          >
            {analyzeStatus.message}
            {cleanable && (
              <button
                onClick={handleCleanFolders}
                disabled={cleaning}
                title="只删除整理时创建且现在为空的分类文件夹，里面有内容的会保留"
                className="ml-2 underline disabled:opacity-50"
              >
                {cleaning ? '清理中…' : '🧹 清理空分类文件夹'}
              </button>
            )}
          </p>
        )}

        {folderPath ? (
          <>
            {/* 当前路径和条目统计 */}
            <p className="mb-3 text-sm text-gray-500">
              <span className="font-medium text-gray-700">{folderPath}</span>
              <span className="ml-2">共 {files.length} 项（仅第一层）</span>
            </p>
            {/* 有整理方案时显示预览界面，否则显示原始文件列表 */}
            {plans ? (
              <PlanPreview
                plans={plans}
                files={eligibleFiles}
                skipped={skippedEntries}
                allowDirs={!constraints.skipDirs}
                folderPath={folderPath}
                onCancel={() => setPlans(null)}
                onOrganized={handleOrganized}
              />
            ) : (
              <FileTable files={files} />
            )}
          </>
        ) : (
          /* 空状态：还没有选择文件夹时的提示 */
          <div className="rounded-lg border-2 border-dashed border-gray-300 py-24 text-center text-gray-400">
            点击右上角「选择文件夹」按钮，查看文件夹内容
          </div>
        )}
      </div>

      {/* 文件数量保护确认框：参与分析的文件超过阈值时让用户知情后再继续 */}
      {confirmLarge && (
        <div
          onClick={() => setConfirmLarge(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
          >
            <p className="text-gray-800">
              文件较多（{eligibleFiles.length} 个），AI
              分析可能不完整或较慢，建议先勾选约束条件减少范围，或分批整理。仍要继续吗？
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setConfirmLarge(false)}
                className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-gray-700 shadow-sm transition hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setConfirmLarge(false)
                  doAnalyze()
                }}
                className="rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-emerald-700"
              >
                仍要继续
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 整理历史弹窗 */}
      {showHistory && (
        <HistoryModal onClose={() => setShowHistory(false)} onRestored={handleRestored} />
      )}

      {/* API Key 设置弹窗 */}
      {showSettings && (
        <ApiKeyModal
          onClose={() => setShowSettings(false)}
          onStatusChange={setKeyStatus}
        />
      )}
    </div>
  )
}
