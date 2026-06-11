// 整理预览界面：
// - 顶部一排方案 Tab（数据结构是"方案数组"，为未来多套方案预留；当前 AI 只返回一套）
// - 每个方案用卡片树展示：每个新文件夹一张卡片，列出将移入的文件和 AI 给的 reason
// - 每个文件可"排除/恢复"，排除状态按方案独立保存
// - 已有子文件夹不参与整理，单独显示为底部灰色提示行
// - "确认整理"此阶段不做实际移动，只弹窗显示将移动的文件数
import { useMemo, useState } from 'react'
import { formatSize } from '../utils/format'

// 单个方案卡片：一个新文件夹 + 其下将移入的文件列表
function FolderCard({ folder, fileMap, excludedSet, onToggle }) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      {/* 卡片头：文件夹名 + 文件计数 */}
      <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 px-4 py-3">
        <span className="font-medium text-gray-800">
          <span className="mr-2">📁</span>
          {folder.name}
        </span>
        <span className="text-sm text-gray-400">{folder.validNames.length} 个文件</span>
      </div>
      {/* AI 给出的分类理由 */}
      <p className="px-4 py-2 text-sm text-gray-500">{folder.reason}</p>
      {/* 将移入该文件夹的文件列表 */}
      <ul className="divide-y divide-gray-100">
        {folder.validNames.map((name) => {
          const excluded = excludedSet.has(name)
          return (
            <li key={name} className="flex items-center justify-between px-4 py-2.5 text-sm">
              <span className={excluded ? 'text-gray-400 line-through' : 'text-gray-800'}>
                <span className="mr-2">📄</span>
                {name}
              </span>
              <span className="flex items-center gap-3">
                <span className="text-gray-400">{formatSize(fileMap.get(name).size)}</span>
                {/* 排除/恢复开关：误点可挽回 */}
                <button
                  onClick={() => onToggle(name)}
                  className={`rounded border px-2 py-0.5 text-xs transition ${
                    excluded
                      ? 'border-gray-300 text-gray-600 hover:bg-gray-50'
                      : 'border-red-200 text-red-600 hover:bg-red-50'
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

export default function PlanPreview({ plans, files, onCancel }) {
  const [activeIndex, setActiveIndex] = useState(0) // 当前选中的方案 Tab
  // 每个方案各自的排除集合（下标与 plans 对齐）：Set<文件名>
  const [excluded, setExcluded] = useState(() => plans.map(() => new Set()))
  const [showConfirm, setShowConfirm] = useState(false) // 是否显示"确认整理"弹窗

  // 文件名 → 文件对象索引，用于校验 AI 返回的文件名并取 size/isDirectory
  const fileMap = useMemo(() => new Map(files.map((f) => [f.name, f])), [files])

  // 已有子文件夹：不参与整理，只在底部灰条里提示
  const existingDirs = useMemo(() => files.filter((f) => f.isDirectory), [files])

  // 当前方案的卡片数据：过滤掉 AI 幻觉的文件名和已有子文件夹，无有效文件的卡片整张剔除
  const resolvedFolders = useMemo(
    () =>
      plans[activeIndex].folders
        .map((folder) => ({
          ...folder,
          validNames: folder.files.filter(
            (name) => fileMap.has(name) && !fileMap.get(name).isDirectory,
          ),
        }))
        .filter((folder) => folder.validNames.length > 0),
    [plans, activeIndex, fileMap],
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

  return (
    <div>
      {/* 方案切换 Tab：当前只有一套方案，但按数组渲染、支持多个 */}
      <div className="mb-4 flex gap-2">
        {plans.map((plan, i) => (
          <button
            key={plan.name}
            onClick={() => setActiveIndex(i)}
            className={`rounded-lg px-4 py-2 text-sm transition ${
              i === activeIndex
                ? 'bg-blue-600 font-medium text-white'
                : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
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

      {/* 已有子文件夹提示：不出现在任何方案卡片里 */}
      {existingDirs.length > 0 && (
        <p className="mt-4 rounded-lg bg-gray-100 px-4 py-2.5 text-sm text-gray-500">
          📁 已有文件夹不参与整理：{existingDirs.map((d) => d.name).join('、')}
        </p>
      )}

      {/* 底部操作按钮 */}
      <div className="mt-4 flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="rounded-lg border border-gray-300 bg-white px-5 py-2.5 text-gray-700 shadow-sm transition hover:bg-gray-50"
        >
          取消
        </button>
        <button
          onClick={() => setShowConfirm(true)}
          disabled={moveCount === 0}
          title={moveCount === 0 ? '没有可整理的文件' : undefined}
          className="rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-emerald-700 disabled:opacity-50"
        >
          确认整理
        </button>
      </div>

      {/* 确认弹窗：此阶段不做实际移动，只显示将移动的文件数 */}
      {showConfirm && (
        <div
          onClick={() => setShowConfirm(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
          >
            <p className="text-gray-800">将移动 {moveCount} 个文件</p>
            <div className="mt-5 flex justify-end">
              <button
                onClick={() => setShowConfirm(false)}
                className="rounded-lg bg-blue-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-blue-700"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
