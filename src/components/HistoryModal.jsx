// 整理历史弹窗：
// - 列出所有整理快照（时间、文件夹、文件数、状态徽标），时间倒序
// - 每条可「恢复」：顺序回滚——连带撤销同文件夹该时间点之后的所有未撤销整理
// - 四个阶段：列表（phase=null）→ confirm（确认连带范围）→ running（进度）→ done（结果）
import { useEffect, useState } from 'react'

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl"
      >
        {/* ===== 列表阶段 ===== */}
        {phase === null && (
          <>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-800">📜 整理历史</h2>
              <button
                onClick={onClose}
                className="rounded-lg px-2 py-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
              >
                ✕
              </button>
            </div>

            {error && (
              <p className="mb-3 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</p>
            )}

            {history === null ? (
              <p className="py-8 text-center text-gray-400">读取中…</p>
            ) : history.length === 0 ? (
              <p className="py-8 text-center text-gray-400">还没有整理记录</p>
            ) : (
              <ul className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
                {history.map((item) => {
                  const restorable = chainFor(item).length > 0
                  return (
                    <li
                      key={item.fileName}
                      className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="flex items-center gap-2 text-sm text-gray-800">
                          {fmt(item.createdAt)}
                          {item.undone && (
                            <span
                              title={item.undoneAt ? `撤销于 ${fmt(item.undoneAt)}` : undefined}
                              className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500"
                            >
                              已撤销
                            </span>
                          )}
                          {item.failedCount > 0 && (
                            <span className="rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-600">
                              {item.failedCount} 个失败
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-gray-500" title={item.folderPath}>
                          {item.folderPath} · {item.moveCount} 个文件
                        </p>
                      </div>
                      <button
                        onClick={() => askRestore(item)}
                        disabled={!restorable}
                        title={restorable ? '恢复到这次整理之前' : '该时间点之后的整理都已撤销'}
                        className="shrink-0 rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-700 transition hover:bg-amber-100 disabled:opacity-40"
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
              <p className="text-gray-800">
                将撤销 {fmt(pending.item.createdAt)} 的这次整理，把{' '}
                {pending.chain[0].moveCount} 个文件移回原位。
              </p>
            ) : (
              <>
                <p className="text-gray-800">
                  恢复到 {fmt(pending.item.createdAt)} 这次整理之前，需要按时间倒序连带撤销该文件夹之后的整理，共{' '}
                  {pending.chain.length} 次整理、
                  {pending.chain.reduce((s, h) => s + h.moveCount, 0)} 个文件将移回原位：
                </p>
                <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
                  {pending.chain.map((h) => (
                    <li key={h.fileName}>
                      {fmt(h.createdAt)} · {h.moveCount} 个文件
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="mt-2 text-xs text-gray-400">
              已手动撤销过的整理会自动跳过；其他文件夹的整理记录不受影响。
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => {
                  setPhase(null)
                  setPending(null)
                }}
                className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-gray-700 shadow-sm transition hover:bg-gray-50"
              >
                取消
              </button>
              <button
                onClick={handleRestore}
                className="rounded-lg bg-amber-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-amber-700"
              >
                开始恢复{pending.chain.length > 1 ? `（连带撤销 ${pending.chain.length} 次）` : ''}
              </button>
            </div>
          </>
        )}

        {/* ===== 恢复中：进度条，遮罩不可关 ===== */}
        {phase === 'running' && (
          <>
            <p className="text-gray-800">
              正在恢复…
              {restoreProgress ? ` ${restoreProgress.current}/${restoreProgress.total}` : ''}
            </p>
            <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-amber-500 transition-all"
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
                <p className="text-gray-800">
                  ✅ 恢复完成：已连带撤销 {result.restoredRecords} 次整理，移回 {result.restored}{' '}
                  个文件
                </p>
                {(result.skipped.length > 0 ||
                  result.renamed.length > 0 ||
                  result.keptFolders.length > 0) && (
                  <ul className="mt-3 space-y-1 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-600">
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
              <p className="text-red-700">恢复失败：{result.error}</p>
            )}
            <div className="mt-5 flex justify-end">
              <button
                onClick={finishRestore}
                className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-blue-700"
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
