// 整理预览界面：
// - 顶部一排方案 Tab：AI 一次返回三套思路不同的方案，点 Tab 切换
// - 每个方案用卡片树展示：每个新文件夹一张卡片，列出将移入的文件和 AI 给的 reason
// - 每个文件可"排除/恢复"，排除状态按方案独立保存
// - 聊天面板：用自然语言让 AI 改写当前选中的方案，对话历史按方案独立保存
// - 被约束开关跳过的条目（已有文件夹/最近修改/排除类型）显示为底部灰色提示区
// - "确认整理"：弹窗确认 → 调主进程真正移动文件（显示进度）→ 显示"已整理 XX 个文件"
import { useEffect, useMemo, useRef, useState } from 'react'
import { Folder, FileText, MessageSquareText, Send, Loader2, CheckCircle2 } from 'lucide-react'
import { formatSize } from '../utils/format'

// 单个方案卡片：一个新文件夹 + 其下将移入的文件列表
function FolderCard({ folder, fileMap, excludedSet, onToggle }) {
  return (
    <div className="animate-fade-in overflow-hidden rounded-2xl border border-line bg-surface">
      {/* 卡片头：文件夹名 + 文件计数 */}
      <div className="flex items-center justify-between border-b border-line bg-sunken px-4 py-3">
        <span className="inline-flex items-center gap-2 font-medium text-ink">
          <Folder size={16} className="text-accent" />
          {folder.name}
        </span>
        <span className="text-sm text-ink-3">{folder.validNames.length} 个文件</span>
      </div>
      {/* AI 给出的分类理由 */}
      <p className="px-4 py-2 text-sm text-ink-2">{folder.reason}</p>
      {/* 将移入该文件夹的条目列表（约束放行时可能含整个文件夹） */}
      <ul className="divide-y divide-line">
        {folder.validNames.map((name) => {
          const excluded = excludedSet.has(name)
          const entry = fileMap.get(name)
          return (
            <li key={name} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span
                className={`inline-flex items-center gap-2 ${
                  excluded ? 'text-ink-3 line-through' : 'text-ink'
                }`}
              >
                {entry.isDirectory ? (
                  <Folder size={15} className="shrink-0 text-accent/70" />
                ) : (
                  <FileText size={15} className="shrink-0 text-ink-3" />
                )}
                {name}
              </span>
              <span className="flex items-center gap-3">
                {/* 文件夹的大小列与 FileTable 一致显示 — */}
                <span className="text-ink-3">{entry.isDirectory ? '—' : formatSize(entry.size)}</span>
                {/* 排除/恢复开关：误点可挽回 */}
                <button
                  onClick={() => onToggle(name)}
                  className={`rounded border px-2 py-0.5 text-xs transition active:scale-[0.97] ${
                    excluded
                      ? 'border-line text-ink-2 hover:bg-sunken'
                      : 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-400/30 dark:text-red-300 dark:hover:bg-red-400/10'
                  }`}
                >
                  {excluded ? '恢复' : '排除'}
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default function PlanPreview({
  plans,
  files, // 已经过 App 约束过滤的「参与整理」条目（skipDirs 关闭时可能含文件夹）
  skipped = [], // 被约束跳过的条目 [{ name, reason }]，仅灰色展示
  allowDirs = false, // 是否允许移动文件夹（「不整理已有文件夹」关闭时为 true）
  folderPath,
  onCancel,
  onOrganized,
}) {
  // 方案数组提升为本地 state：对话调整会改写当前方案的 folders
  //（App 每次重新分析前会先 setPlans(null) 卸载本组件，用 props 初始化是安全的）
  const [localPlans, setLocalPlans] = useState(plans)
  const [activeIndex, setActiveIndex] = useState(0) // 当前选中的方案 Tab
  // 每个方案各自的排除集合（下标与方案对齐）：Set<文件名>
  const [excluded, setExcluded] = useState(() => plans.map(() => new Set()))
  // 整理弹窗的阶段：null（关闭）→ confirm（待确认）→ running（移动中）→ done（完成）
  const [phase, setPhase] = useState(null)
  const [moveProgress, setMoveProgress] = useState(null) // { current, total }
  const [result, setResult] = useState(null) // organize:run 的返回值
  // 每个方案各自的对话历史：[{ role: 'user'|'assistant', content: 展示文本, raw?: 原始 JSON }]
  // assistant 消息的 raw 是模型上一轮的原始回复，发历史时用它让模型看到自己的输出
  const [chats, setChats] = useState(() => plans.map(() => []))
  const [chatInput, setChatInput] = useState('')        // 聊天输入框内容
  const [adjusting, setAdjusting] = useState(false)     // 是否正在请求 AI 调整
  const [adjustProgress, setAdjustProgress] = useState(0) // 调整流式输出已接收字符数
  const [adjustSeconds, setAdjustSeconds] = useState(0)  // 调整已等待秒数（首响应前的反馈）
  const [adjustError, setAdjustError] = useState(null)  // 调整失败的错误信息
  const chatBottomRef = useRef(null) // 聊天列表底部锚点，用于新消息后自动滚到底

  // 订阅移动进度（主进程每移动一个文件推送一次），卸载时取消订阅
  useEffect(() => window.api.organize.onProgress(setMoveProgress), [])

  // 订阅调整进度（独立于分析进度的 channel，避免和 App 的分析按钮串台）
  useEffect(() => window.api.onAdjustProgress(setAdjustProgress), [])

  // 调整期间每秒计时：首响应到达前气泡显示已等待秒数，让用户知道没卡死
  useEffect(() => {
    if (!adjusting) return
    setAdjustSeconds(0)
    const timer = setInterval(() => setAdjustSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [adjusting])

  // 新消息或进入调整中状态时，把聊天列表滚到底部
  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chats, adjusting])

  // 文件名 → 文件对象索引，用于校验 AI 返回的文件名并取 size/isDirectory
  const fileMap = useMemo(() => new Map(files.map((f) => [f.name, f])), [files])

  // 当前方案的卡片数据：过滤掉 AI 幻觉/被约束跳过的名字（都不在 fileMap 里），
  // 无有效文件的卡片整张剔除；目录是否参与由 App 的约束过滤决定，这里不再特判
  const resolvedFolders = useMemo(
    () =>
      localPlans[activeIndex].folders
        .map((folder) => ({
          ...folder,
          validNames: folder.files.filter((name) => fileMap.has(name)),
        }))
        .filter((folder) => folder.validNames.length > 0),
    [localPlans, activeIndex, fileMap],
  )

  // 将移动的文件数 = 当前方案有效文件中未被排除的数量
  const moveCount = useMemo(
    () =>
      resolvedFolders.reduce(
        (sum, folder) =>
          sum + folder.validNames.filter((name) => !excluded[activeIndex].has(name)).length,
        0,
      ),
    [resolvedFolders, excluded, activeIndex],
  )

  // 切换某文件的排除状态（只改当前方案的集合，保持不可变更新）
  function toggleExclude(name) {
    setExcluded((prev) =>
      prev.map((set, i) => {
        if (i !== activeIndex) return set
        const next = new Set(set)
        if (next.has(name)) {
          next.delete(name)
        } else {
          next.add(name)
        }
        return next
      }),
    )
  }

  // 发送聊天消息：让 AI 按要求改写当前选中的方案
  async function handleSendChat(e) {
    e.preventDefault()
    const message = chatInput.trim()
    if (!message || adjusting) return

    // 先把用户消息上屏（只追加到当前方案的历史）
    const userMsg = { role: 'user', content: message }
    setChats((prev) => prev.map((list, i) => (i === activeIndex ? [...list, userMsg] : list)))
    setChatInput('')
    setAdjusting(true)
    setAdjustProgress(0)
    setAdjustError(null)
    try {
      // 历史里 assistant 消息发 raw（模型上一轮的原始 JSON），user 消息发原文
      const history = [...chats[activeIndex], userMsg].map((m) => ({
        role: m.role,
        content: m.role === 'assistant' ? m.raw : m.content,
      }))
      const res = await window.api.adjustPlan({
        files,
        plan: localPlans[activeIndex].folders,
        history,
      })
      if (res.ok) {
        // 模型有时声称"已调整"但返回的方案和原来一模一样，诚实告知用户，避免看起来像没反应
        const unchanged =
          JSON.stringify(res.folders) === JSON.stringify(localPlans[activeIndex].folders)
        // 用调整后的 folders 替换当前方案（其他方案不动）
        setLocalPlans((prev) =>
          prev.map((plan, i) => (i === activeIndex ? { ...plan, folders: res.folders } : plan)),
        )
        // 文件归属已变，当前方案的旧排除集合语义失效，清空
        setExcluded((prev) => prev.map((set, i) => (i === activeIndex ? new Set() : set)))
        // AI 回复上屏（content 展示 reply，raw 留给下一轮历史）
        setChats((prev) =>
          prev.map((list, i) =>
            i === activeIndex
              ? [
                  ...list,
                  {
                    role: 'assistant',
                    content: unchanged ? `${res.reply}（方案内容与调整前相同）` : res.reply,
                    raw: res.raw,
                  },
                ]
              : list,
          ),
        )
      } else {
        setAdjustError(res.error)
      }
    } finally {
      setAdjusting(false)
    }
  }

  // 点击弹窗里的"开始整理"：把当前方案（去掉被排除的文件）发给主进程执行移动
  async function handleOrganize() {
    setPhase('running')
    setMoveProgress(null)
    // 分组数据直接来自预览界面的计算结果：只含有效文件名，再过滤排除项
    const groups = resolvedFolders
      .map((folder) => ({
        folderName: folder.name,
        fileNames: folder.validNames.filter((name) => !excluded[activeIndex].has(name)),
      }))
      .filter((group) => group.fileNames.length > 0)
    // allowDirs：「不整理已有文件夹」关闭时显式放行移动文件夹（主进程默认拒绝）
    const res = await window.api.organize.run({ folderPath, groups, allowDirs })
    setResult(res)
    setPhase('done')
  }

  return (
    <div>
      {/* 方案切换：macOS segmented control 风格（凹槽容器 + 选中段浮起白块） */}
      <div className="mb-4 inline-flex rounded-xl bg-sunken p-1">
        {localPlans.map((plan, i) => (
          <button
            key={plan.name}
            onClick={() => {
              setActiveIndex(i)
              setAdjustError(null) // 错误提示只属于发消息时的方案，切 Tab 即清
            }}
            className={`rounded-lg px-4 py-1.5 text-sm transition-all active:scale-[0.98] ${
              i === activeIndex
                ? 'bg-surface font-medium text-ink shadow-sm'
                : 'text-ink-2 hover:text-ink'
            }`}
          >
            {plan.name}
          </button>
        ))}
      </div>

      {/* 卡片树：每个新文件夹一张卡片 */}
      <div className="space-y-4">
        {resolvedFolders.map((folder) => (
          <FolderCard
            key={folder.name}
            folder={folder}
            fileMap={fileMap}
            excludedSet={excluded[activeIndex]}
            onToggle={toggleExclude}
          />
        ))}
      </div>

      {/* 被约束跳过的条目：灰色列出名字和原因，不出现在任何方案卡片里 */}
      {skipped.length > 0 && (
        <div className="mt-4 max-h-40 overflow-y-auto rounded-xl bg-sunken px-4 py-2.5 text-sm text-ink-3">
          <p className="mb-1">以下 {skipped.length} 项按约束跳过，不参与整理：</p>
          <ul className="space-y-0.5">
            {skipped.map((s) => (
              <li key={s.name}>
                {s.name} —— {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 聊天面板：用自然语言让 AI 改写当前选中的方案 */}
      <div className="mt-4 rounded-2xl border border-line bg-surface">
        <p className="inline-flex w-full items-center gap-2 border-b border-line bg-sunken px-4 py-2.5 text-sm font-medium text-ink-2">
          <MessageSquareText size={15} className="text-accent" />
          对「{localPlans[activeIndex].name}」提调整要求
        </p>
        {/* 消息列表：用户右侧主色、AI 左侧灰；为空时显示引导文案 */}
        <div className="max-h-64 space-y-2 overflow-y-auto px-4 py-3">
          {chats[activeIndex].length === 0 && !adjusting && (
            <p className="text-sm text-ink-3">
              例如："把截图和照片合并成一个分类"、"新建一个叫 2024 报销 的分类"
            </p>
          )}
          {chats[activeIndex].map((msg, i) => (
            <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <p
                className={`max-w-[80%] animate-fade-in rounded-2xl px-3.5 py-2 text-sm ${
                  msg.role === 'user' ? 'bg-accent text-white' : 'bg-sunken text-ink'
                }`}
              >
                {msg.content}
              </p>
            </div>
          ))}
          {/* 调整中提示：流式接收进度 */}
          {adjusting && (
            <div className="flex justify-start">
              <p className="inline-flex max-w-[80%] animate-fade-in items-center gap-1.5 rounded-2xl bg-sunken px-3.5 py-2 text-sm text-ink-2">
                <Loader2 size={14} className="animate-spin" />
                {adjustProgress > 0
                  ? `调整中…已接收 ${adjustProgress} 字`
                  : `等待 DeepSeek 响应…${adjustSeconds}s`}
              </p>
            </div>
          )}
          {/* 调整失败：面板内显示错误行，不打断已有对话 */}
          {adjustError && (
            <p className="text-sm text-red-600 dark:text-red-300">调整失败：{adjustError}</p>
          )}
          <div ref={chatBottomRef} />
        </div>
        {/* 输入区：调整中禁用 */}
        <form onSubmit={handleSendChat} className="flex gap-2 border-t border-line px-4 py-3">
          <input
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            disabled={adjusting}
            placeholder="告诉 AI 你想怎么调整当前方案…"
            className="flex-1 rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent disabled:bg-sunken"
          />
          <button
            type="submit"
            disabled={adjusting || chatInput.trim() === ''}
            className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-hi active:scale-[0.98] disabled:opacity-50"
          >
            <Send size={14} />
            发送
          </button>
        </form>
      </div>

      {/* 底部操作按钮 */}
      <div className="mt-4 flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="rounded-full border border-line bg-surface px-5 py-2 text-sm text-ink-2 transition hover:bg-sunken active:scale-[0.98]"
        >
          取消
        </button>
        <button
          onClick={() => setPhase('confirm')}
          disabled={moveCount === 0}
          title={moveCount === 0 ? '没有可整理的文件' : undefined}
          className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 active:scale-[0.98] disabled:opacity-50"
        >
          确认整理
        </button>
      </div>

      {/* 整理弹窗：confirm（待确认）→ running（移动中，遮罩不可关）→ done（结果） */}
      {phase && (
        <div
          onClick={() => phase === 'confirm' && setPhase(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm animate-pop-in rounded-2xl border border-line bg-surface p-6 shadow-xl"
          >
            {phase === 'confirm' && (
              <>
                <p className="text-ink">
                  将在 <span className="font-medium">{folderPath}</span> 内创建分类文件夹并移动{' '}
                  {moveCount} 个文件
                </p>
                <p className="mt-2 text-sm text-ink-2">
                  移动前会保存完整的位置记录，整理后可一键撤销
                </p>
                <div className="mt-5 flex justify-end gap-3">
                  <button
                    onClick={() => setPhase(null)}
                    className="rounded-full border border-line bg-surface px-5 py-2 text-sm text-ink-2 transition hover:bg-sunken active:scale-[0.98]"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleOrganize}
                    className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 active:scale-[0.98]"
                  >
                    开始整理
                  </button>
                </div>
              </>
            )}

            {phase === 'running' && (
              <>
                <p className="inline-flex items-center gap-2 text-ink">
                  <Loader2 size={16} className="animate-spin text-emerald-500" />
                  正在移动文件…
                  {moveProgress ? ` ${moveProgress.current}/${moveProgress.total}` : ''}
                </p>
                {/* 进度条：按已移动数量填充 */}
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-sunken">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all"
                    style={{
                      width: moveProgress
                        ? `${Math.round((moveProgress.current / moveProgress.total) * 100)}%`
                        : '0%',
                    }}
                  />
                </div>
              </>
            )}

            {phase === 'done' && result && (
              <>
                {result.ok ? (
                  <>
                    <p className="inline-flex items-center gap-2 text-ink">
                      <CheckCircle2 size={18} className="text-emerald-500" />
                      已整理 {result.moved} 个文件
                    </p>
                    {/* 部分文件失败时列出原因 */}
                    {result.errors.length > 0 && (
                      <div className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-400/10 dark:text-red-300">
                        <p className="mb-1">以下 {result.errors.length} 个文件未能移动：</p>
                        <ul className="space-y-0.5">
                          {result.errors.map((e) => (
                            <li key={e.name}>
                              {e.name} —— {e.error}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-red-700 dark:text-red-300">整理失败：{result.error}</p>
                )}
                <div className="mt-5 flex justify-end">
                  <button
                    onClick={() => {
                      setPhase(null)
                      if (result.ok) onOrganized(result)
                    }}
                    className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-hi active:scale-[0.98]"
                  >
                    完成
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
