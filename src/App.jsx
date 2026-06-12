// 应用主界面：
// - 顶部：标题 + "分析" / "选择文件夹" / ⚙️ 设置按钮
// - 选中文件夹后：显示当前路径、条目数和文件列表表格
// - 点「分析」：把文件清单发给 DeepSeek 生成分类方案，结果以预览卡片展示（可排除文件后确认）
// - ⚙️ 设置：填写/管理 DeepSeek API Key（加密存储在主进程侧）
import { useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  FolderOpen,
  FolderSearch,
  FolderMinus,
  Sparkles,
  Settings,
  History,
  Undo2,
  Sun,
  Moon,
  Monitor,
  Loader2,
} from 'lucide-react'
import FileTable from './components/FileTable'
import ApiKeyModal from './components/ApiKeyModal'
import PlanPreview from './components/PlanPreview'
import HistoryModal from './components/HistoryModal'
import WindowControls from './components/WindowControls'

// 平台标识在应用生命周期内不变，模块级取一次即可。
// 无边框窗口下 header 即标题栏：mac 给原生红绿灯留白，其他平台渲染自绘控制按钮
const isMac = window.api.platform === 'darwin'
const isLinux = window.api.platform === 'linux'

// 主题持久化 key：'system' | 'light' | 'dark'，默认跟随系统明暗（KDE/mac 等切配色实时跟随）
const THEME_KEY = 'ui-theme'

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

// iOS 风格拨动开关：纯样式封装，语义仍是 checkbox（约束栏使用）
function Switch({ checked, disabled, onChange }) {
  return (
    <span className="relative inline-flex h-5 w-9 shrink-0">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="peer absolute inset-0 cursor-pointer appearance-none rounded-full bg-ink-3/35 transition-colors duration-200 checked:bg-accent disabled:cursor-not-allowed"
      />
      {/* 圆钮：checked 时右移；pointer-events 穿透给下面的 checkbox */}
      <span className="pointer-events-none absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 peer-checked:translate-x-4" />
    </span>
  )
}

export default function App() {
  const [folderPath, setFolderPath] = useState(null) // 当前选中的文件夹路径
  const [files, setFiles] = useState([])             // 第一层文件/文件夹列表
  const [loading, setLoading] = useState(false)      // 是否正在读取文件夹
  const [analyzing, setAnalyzing] = useState(false)  // 是否正在调用 DeepSeek 分析
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
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'system') // 界面主题（system=跟随系统）
  // 系统当前是否暗色：matchMedia 实时反映 nativeTheme/桌面配色（Plasma 6 走 freedesktop portal）
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  // 订阅系统明暗切换（仅「跟随系统」态会用到，常驻订阅开销可忽略）
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const listener = (e) => setSystemDark(e.matches)
    mq.addEventListener('change', listener)
    return () => mq.removeEventListener('change', listener)
  }, [])

  // 实际生效的明暗：手动锁定优先，「跟随系统」时由 systemDark 决定
  const isDark = theme === 'dark' || (theme === 'system' && systemDark)

  // 主题切换：html 上挂/摘 .dark 类（index.css 的 @custom-variant 据此生效）并持久化
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme, isDark])

  // 主题三态循环 + 圆形扩散动效：明暗实际变化时用 View Transitions 从按钮位置揭开新主题；
  // API 不存在或明暗不变（如 暗→跟随系统 且系统也是暗）时直接切换。
  // 注意 .dark 类必须在 startViewTransition 回调内同步切换（useEffect 在快照之后才跑），
  // 回调里手动 toggle 一次，随后 effect 重放同值是无害的幂等操作
  function cycleTheme(e) {
    const next = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system'
    const nextDark = next === 'dark' || (next === 'system' && systemDark)
    if (!document.startViewTransition || nextDark === isDark) {
      setTheme(next)
      return
    }
    // 键盘触发时 clientX/Y 为 0，退回按钮中心
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX || rect.left + rect.width / 2
    const y = e.clientY || rect.top + rect.height / 2
    const vt = document.startViewTransition(() => {
      document.documentElement.classList.toggle('dark', nextDark)
      flushSync(() => setTheme(next))
    })
    vt.ready.then(() => {
      const r = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      )
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        {
          duration: 420,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          pseudoElement: '::view-transition-new(root)',
        },
      )
    })
  }

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

  // 订阅分析进度事件（主进程流式接收 DeepSeek 回复时持续推送），卸载时取消订阅
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

  // 查询某文件夹是否有可撤销的整理记录（按当前文件夹作用域；整理/撤销/恢复完成后也刷新）
  async function refreshUndoable(path) {
    if (!path) {
      setUndoable(null) // 未选择文件夹时不显示撤销按钮
      return
    }
    const res = await window.api.organize.getUndoable(path)
    if (res.ok) setUndoable(res)
  }
  // 启动（folderPath 为空→隐藏）和每次切换文件夹时查询该文件夹的可撤销状态
  useEffect(() => {
    refreshUndoable(folderPath)
  }, [folderPath])

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

  // 真正执行分析：把文件清单发给主进程 → DeepSeek API → 返回分类方案
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
    refreshUndoable(folderPath)
  }

  // 点击「撤销上次整理」：按当前文件夹最近的映射表把文件移回原位
  async function handleUndo() {
    setUndoing(true)
    setUndoProgress(null)
    try {
      const res = await window.api.organize.undo(folderPath)
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
      refreshUndoable(folderPath)
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
    refreshUndoable(folderPath)
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

  // 仅 Linux 需要 JS 兜底双击标题栏最大化（mac/Windows 由系统原生处理，再绑会双重切换）；
  // 双击落在按钮/输入框等交互元素上时不触发
  function handleTitlebarDoubleClick(e) {
    if (e.target.closest('button, input, a')) return
    window.api.win.maximizeToggle()
  }

  return (
    <div className="min-h-screen text-ink transition-colors">
      {/* 科技感背景：网格缓慢漂移 + 顶部 accent 光晕，z-index:-1 垫在 html 底色与内容之间 */}
      <div className="bg-tech-grid" aria-hidden="true" />
      {/* 毛玻璃顶栏 = 无边框窗口的标题栏：app-drag 整体可拖拽移动窗口，
          交互元素套 app-no-drag；sticky 通栏，内容滚动时从玻璃下穿过（macOS 质感的关键） */}
      <header
        onDoubleClick={isLinux ? handleTitlebarDoubleClick : undefined}
        className="app-drag sticky top-0 z-40 border-b border-line bg-canvas/70 backdrop-blur-xl"
      >
        <div
          className={`flex h-13 items-center justify-between gap-4 ${
            isMac ? 'pl-20 pr-5' : 'pl-5 pr-[150px]'
          }`}
        >
          {/* 选中文件夹后左上角显示路径；默认窗宽 900 放不下两者，<lg 时隐藏应用名把空间让给路径 */}
          <h1 className="flex min-w-0 select-none items-center gap-2.5 text-[15px] font-semibold text-ink">
            <FolderOpen size={20} className="shrink-0 text-accent" />
            {/* min-w-0 + truncate：空间不足时标题截断，绝不挤压右侧按钮 */}
            <span className={folderPath ? 'hidden shrink-0 lg:block' : 'truncate'}>
              holy_sexy_folder_management
            </span>
            {folderPath && (
              <span className="min-w-0 truncate text-[13px] font-normal text-ink-3" title={folderPath}>
                {folderPath}
              </span>
            )}
          </h1>
          {/* 按钮全部 nowrap：宁可标题截断，也不能让按钮文字竖排 */}
          <div className="app-no-drag flex shrink-0 gap-2 whitespace-nowrap">
            {/* 撤销按钮：只在当前文件夹有可撤销记录时显示，悬停可见上次整理的时间 */}
            {undoable?.undoable && (
              <button
                onClick={handleUndo}
                disabled={undoing}
                title={`上次整理：${new Date(
                  undoable.info.createdAt,
                ).toLocaleString()}，${undoable.info.moveCount} 个文件`}
                className="inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/10 px-4 py-2 text-sm font-medium tabular-nums text-warning transition hover:bg-warning/20 hover:shadow-[0_0_10px_rgba(255,159,10,0.3)] active:scale-[0.98] disabled:opacity-50"
              >
                <Undo2 size={15} />
                {undoing
                  ? undoProgress
                    ? `撤销中 ${undoProgress.current}/${undoProgress.total}`
                    : '撤销中…'
                  : '撤销上次整理'}
              </button>
            )}
            {/* 整理历史按钮：始终显示（历史全是已撤销记录时仍可查看） */}
            <button
              onClick={() => setShowHistory(true)}
              title="查看整理历史并恢复"
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink-2 transition hover:bg-sunken hover:shadow-glow-sm active:scale-[0.98]"
            >
              <History size={15} />
              整理历史
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
              className={`inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium tabular-nums text-white transition hover:bg-accent-hi hover:shadow-glow-md active:scale-[0.98] disabled:opacity-50 ${
                analyzing ? 'shimmer animate-glow-pulse' : ''
              }`}
            >
              {analyzing ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {analyzing
                ? progress > 0
                  ? `分析中…已接收 ${progress} 字`
                  : `等待 DeepSeek 响应…${analyzeSeconds}s`
                : '分析'}
            </button>
            <button
              onClick={handleSelectFolder}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:bg-sunken hover:shadow-glow-sm active:scale-[0.98] disabled:opacity-50"
            >
              <FolderSearch size={15} />
              {loading ? '读取中…' : '选择文件夹'}
            </button>
            {/* 设置按钮：打开 API Key 设置弹窗 */}
            <button
              onClick={() => setShowSettings(true)}
              title="API Key 设置"
              className="inline-flex items-center rounded-full border border-line bg-surface px-3 py-2 text-ink-2 transition hover:bg-sunken hover:shadow-glow-sm active:scale-[0.98]"
            >
              <Settings size={16} />
            </button>
            {/* 主题切换：跟随系统→亮→暗 三态循环，图标显示当前态；明暗变化时圆形扩散揭开 */}
            <button
              onClick={cycleTheme}
              title={
                theme === 'system'
                  ? '主题：跟随系统（点击切换到亮色）'
                  : theme === 'light'
                    ? '主题：亮色（点击切换到暗色）'
                    : '主题：暗色（点击切换到跟随系统）'
              }
              className="inline-flex items-center rounded-full border border-line bg-surface px-3 py-2 text-ink-2 transition hover:bg-sunken hover:shadow-glow-sm active:scale-[0.98]"
            >
              {theme === 'system' ? (
                <Monitor size={16} />
              ) : theme === 'light' ? (
                <Sun size={16} />
              ) : (
                <Moon size={16} />
              )}
            </button>
          </div>
        </div>
        {/* 非 mac：自绘窗口控制按钮（api.win 存在性兜底：preload 未更新的旧会话不渲染） */}
        {!isMac && window.api.win && <WindowControls />}
        {/* AI 分析中：header 底边扫描线（sticky 即定位元素，absolute 直接锚定在 header 上） */}
        {analyzing && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-px overflow-hidden">
            <div className="scan-bar" />
          </div>
        )}
      </header>

      {/* 主内容区：全宽自适应，宽屏下表格/预览随窗口拉伸（文件管理类应用惯例） */}
      <div className="px-8 py-6">
        {/* 约束开关栏：分析前声明哪些条目不参与整理（分析中/预览打开时锁定） */}
        {folderPath && (
          <div
            title={constraintsLocked ? '分析中或预览打开时不可修改，返回文件列表后再调整' : undefined}
            className={`mb-4 flex flex-wrap items-center gap-x-6 gap-y-2.5 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2 shadow-card transition ${
              constraintsLocked ? 'opacity-60' : ''
            }`}
          >
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
                checked={constraints.skipDirs}
                disabled={constraintsLocked}
                onChange={(e) => setConstraints((c) => ({ ...c, skipDirs: e.target.checked }))}
              />
              不整理已有文件夹
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
                checked={constraints.skipRecent}
                disabled={constraintsLocked}
                onChange={(e) => setConstraints((c) => ({ ...c, skipRecent: e.target.checked }))}
              />
              不动最近 7 天修改的文件
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
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
                className="w-28 rounded-lg border border-line bg-surface px-2.5 py-1 text-xs text-ink outline-none transition focus:border-accent disabled:bg-sunken"
              />
            </label>
            {/* 实时统计被跳过的条目数 */}
            {skippedEntries.length > 0 && (
              <span className="text-xs tabular-nums text-ink-3">已跳过 {skippedEntries.length} 项</span>
            )}
          </div>
        )}

        {/* 未配置密钥时的引导提示 */}
        {keyStatus && !keyStatus.configured && (
          <p className="mb-4 animate-fade-in rounded-xl bg-warning/10 px-4 py-2.5 text-sm text-warning shadow-raised">
            尚未设置 API Key，「分析」功能需要先在
            <button onClick={() => setShowSettings(true)} className="mx-1 underline">
              设置
            </button>
            中填写你的 DeepSeek API Key
          </p>
        )}

        {/* 分析结果提示条：成功为绿色，失败为红色；撤销后留有空分类文件夹时附清理按钮 */}
        {analyzeStatus && (
          <p
            className={`mb-4 animate-fade-in rounded-xl px-4 py-2.5 text-sm shadow-raised ${
              analyzeStatus.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
            }`}
          >
            {analyzeStatus.message}
            {cleanable && (
              <button
                onClick={handleCleanFolders}
                disabled={cleaning}
                title="只删除整理时创建且现在为空的分类文件夹，里面有内容的会保留"
                className="ml-2 inline-flex items-center gap-1 underline disabled:opacity-50"
              >
                <FolderMinus size={14} />
                {cleaning ? '清理中…' : '清理空分类文件夹'}
              </button>
            )}
          </p>
        )}

        {folderPath ? (
          <>
            {/* 当前路径和条目统计 */}
            <p className="mb-3 text-sm text-ink-3">
              <span className="font-medium text-ink-2">{folderPath}</span>
              <span className="ml-2 tabular-nums">共 {files.length} 项（仅第一层）</span>
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
          /* 空状态：图标→标题→描述分阶段入场（fade-in fill both，延迟期间不可见） */
          <div className="flex flex-col items-center gap-5 py-28 text-center">
            <div className="flex h-16 w-16 animate-spring-pop items-center justify-center rounded-2xl border border-line bg-surface shadow-card">
              <FolderOpen size={28} className="text-ink-3" />
            </div>
            <div>
              <p className="animate-fade-in text-base font-medium text-ink [animation-delay:120ms]">
                选择一个文件夹开始
              </p>
              <p className="mt-1.5 animate-fade-in text-sm text-ink-3 [animation-delay:220ms]">
                AI 会为第一层文件生成三套分类方案，确认后才会移动文件
              </p>
            </div>
          </div>
        )}
      </div>

      {/* 文件数量保护确认框：参与分析的文件超过阈值时让用户知情后再继续 */}
      {confirmLarge && (
        <div
          onClick={() => setConfirmLarge(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="border-flow w-full max-w-sm animate-spring-pop rounded-2xl border border-line bg-surface p-6 shadow-modal"
          >
            <p className="text-ink">
              文件较多（{eligibleFiles.length} 个），AI
              分析可能不完整或较慢，建议先勾选约束条件减少范围，或分批整理。仍要继续吗？
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setConfirmLarge(false)}
                className="rounded-full border border-line bg-surface px-5 py-2 text-sm text-ink-2 transition hover:bg-sunken active:scale-[0.98]"
              >
                取消
              </button>
              <button
                onClick={() => {
                  setConfirmLarge(false)
                  doAnalyze()
                }}
                className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-hi active:scale-[0.98]"
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
