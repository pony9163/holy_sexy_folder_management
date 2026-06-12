// 整理历史弹窗：
// - 列出所有整理快照（时间、文件夹、文件数、状态徽标），时间倒序
// - 每条可「恢复」：顺序回滚——连带撤销同文件夹该时间点之后的所有未撤销整理
// - 四个阶段：列表（phase=null）→ confirm（确认连带范围）→ running（进度）→ done（结果）
import { useEffect, useState } from 'react'
import { History, X, CheckCircle2, Loader2 } from 'lucide-react'

export default function HistoryModal({ onClose, onRestored }) {
  const [history, setHistory] = useState(null) // null = 加载中
  const [error, setError] = useState(null)
  const [phase, setPhase] = useState(null) // null | 'confirm' | 'running' | 'done'
  const [pending, setPending] = useState(null) // { item, chain } 待恢复的目标和链条
  const [restoreProgress, setRestoreProgress] = useState(null) // { current, total }
  const [result, setResult] = useState(null) // organize:restore 返回值

  async function refreshHistory() {
    const res = await window.api.organize.getHistory()
    if (res.ok) {
      setHistory(res.history)
      setError(null)
    } else {
      setError(res.error)
    }
  }

  // 打开时拉取历史；订阅恢复进度（独立 channel，与撤销按钮互不干扰）
  useEffect(() => {
    refreshHistory()
  }, [])
  useEffect(() => window.api.organize.onRestoreProgress(setRestoreProgress), [])

  // 某条记录的回滚链条：同文件夹、不早于它、未撤销（history 已时间倒序，filter 保序）
  function chainFor(item) {
    return history.filter(
      (h) => h.folderPath === item.folderPath && h.createdAt >= item.createdAt && !h.undone,
    )
  }

  // 点击某条的「恢复」：先展示连带范围让用户确认
  function askRestore(item) {
    setPending({ item, chain: chainFor(item) })
    setPhase('confirm')
  }

  // 确认后真正执行恢复
  async function handleRestore() {
    setPhase('running')
    setRestoreProgress(null)
    const res = await window.api.organize.restore(pending.item.fileName)
    setResult(res)
    setPhase('done')
  }

  // done 阶段点「完成」：通知 App 刷新，弹窗回到列表（不自动关）
  function finishRestore() {
    if (result.ok) onRestored(result)
    setPhase(null)
    setPending(null)
    refreshHistory()
  }

  const fmt = (iso) => new Date(iso).toLocaleString()

  return (
    <div
      onClick={() => phase === null && onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="border-flow w-full max-w-lg animate-spring-pop rounded-2xl border border-line bg-surface p-6 shadow-modal"
      >
        {/* ===== 列表阶段 ===== */}
        {phase === null && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="inline-flex items-center gap-2 text-lg font-bold text-ink">
                <History size={18} className="text-accent" />
                整理历史
              </h2>
              <button
                onClick={onClose}
                className="rounded-lg px-2 py-1 text-ink-3 transition hover:bg-sunken hover:text-ink-2"
              >
                <X size={16} />
              </button>
            </div>

            {error && (
              <p className="mb-3 rounded-lg bg-danger/10 px-4 py-2.5 text-sm text-danger">
                {error}
              </p>
            )}

            {history === null ? (
              <p className="py-8 text-center text-ink-3">读取中…</p>
            ) : history.length === 0 ? (
              <p className="py-8 text-center text-ink-3">还没有整理记录</p>
            ) : (
              <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
                {history.map((item) => {
                  const restorable = chainFor(item).length > 0
                  return (
                    <li
                      key={item.fileName}
                      className="flex items-center justify-between gap-3 rounded-lg border border-line px-4 py-3 transition-colors hover:bg-sunken/60"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm tabular-nums text-ink">
                          {fmt(item.createdAt)}
                          {item.undone && (
                            <span
                              title={item.undoneAt ? `撤销于 ${fmt(item.undoneAt)}` : undefined}
                              className="rounded-md bg-sunken px-2 py-0.5 text-xs text-ink-3"
                            >
                              已撤销
                            </span>
                          )}
                          {item.failedCount > 0 && (
                            <span className="rounded-md bg-danger/10 px-2 py-0.5 text-xs tabular-nums text-danger">
                              {item.failedCount} 个失败
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs tabular-nums text-ink-3" title={item.folderPath}>
                          {item.folderPath} · {item.moveCount} 个文件
                        </p>
                      </div>
                      <button
                        onClick={() => askRestore(item)}
                        disabled={!restorable}
                        title={restorable ? '恢复到这次整理之前' : '该时间点之后的整理都已撤销'}
                        className="shrink-0 rounded-full border border-warning/30 bg-warning/10 px-3.5 py-1.5 text-sm text-warning transition hover:bg-warning/20 active:scale-[0.98] disabled:opacity-40"
                      >
                        恢复
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {/* ===== 确认阶段：说清连带撤销范围 ===== */}
        {phase === 'confirm' && pending && (
          <>
            {pending.chain.length === 1 ? (
              <p className="text-ink">
                将撤销 {fmt(pending.item.createdAt)} 的这次整理，把{' '}
                {pending.chain[0].moveCount} 个文件移回原位。
              </p>
            ) : (
              <>
                <p className="text-ink">
                  恢复到 {fmt(pending.item.createdAt)} 这次整理之前，需要按时间倒序连带撤销该文件夹之后的整理，共{' '}
                  {pending.chain.length} 次整理、
                  {pending.chain.reduce((s, h) => s + h.moveCount, 0)} 个文件将移回原位：
                </p>
                <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg bg-sunken px-3 py-2 text-sm tabular-nums text-ink-2">
                  {pending.chain.map((h) => (
                    <li key={h.fileName}>
                      {fmt(h.createdAt)} · {h.moveCount} 个文件
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-2 text-xs text-ink-3">
              已手动撤销过的整理会自动跳过；其他文件夹的整理记录不受影响。
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => {
                  setPhase(null)
                  setPending(null)
                }}
                className="rounded-full border border-line bg-surface px-5 py-2 text-sm text-ink-2 transition hover:bg-sunken active:scale-[0.98]"
              >
                取消
              </button>
              <button
                onClick={handleRestore}
                className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-hi hover:shadow-glow-md active:scale-[0.98]"
              >
                开始恢复{pending.chain.length > 1 ? `（连带撤销 ${pending.chain.length} 次）` : ''}
              </button>
            </div>
          </>
        )}

        {/* ===== 恢复中：进度条，遮罩不可关 ===== */}
        {phase === 'running' && (
          <>
            <p className="inline-flex items-center gap-2 tabular-nums text-ink">
              <Loader2 size={16} className="animate-spin text-accent" />
              正在恢复…
              {restoreProgress ? ` ${restoreProgress.current}/${restoreProgress.total}` : ''}
            </p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-sunken">
              <div
                className="shimmer h-full rounded-full bg-accent shadow-glow-sm transition-all"
                style={{
                  width: restoreProgress
                    ? `${Math.round((restoreProgress.current / restoreProgress.total) * 100)}%`
                    : '0%',
                }}
              />
            </div>
          </>
        )}

        {/* ===== 结果阶段 ===== */}
        {phase === 'done' && result && (
          <>
            {result.ok ? (
              <>
                <p className="inline-flex items-center gap-2 tabular-nums text-ink">
                  <CheckCircle2 size={18} className="text-success" />
                  恢复完成：已连带撤销 {result.restoredRecords} 次整理，移回 {result.restored}{' '}
                  个文件
                </p>
                {(result.skipped.length > 0 ||
                  result.renamed.length > 0 ||
                  result.keptFolders.length > 0) && (
                  <ul className="mt-3 space-y-1 rounded-lg bg-sunken px-3 py-2 text-sm text-ink-2">
                    {result.skipped.length > 0 && (
                      <li>{result.skipped.length} 个文件已不在原处，已跳过</li>
                    )}
                    {result.renamed.length > 0 && (
                      <li>{result.renamed.length} 个文件因原位置被占用，已加 (1) 后缀恢复</li>
                    )}
                    {result.keptFolders.length > 0 && (
                      <li>为安全起见，整理时创建的分类文件夹已保留，如不需要可手动删除</li>
                    )}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-danger">恢复失败：{result.error}</p>
            )}
            <div className="mt-5 flex justify-end">
              <button
                onClick={finishRestore}
                className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-white transition hover:bg-accent-hi hover:shadow-glow-md active:scale-[0.98]"
              >
                完成
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
