// 文件列表表格组件：展示名称、类型、大小、修改日期四列
import { Folder, FileText } from 'lucide-react'
import { formatSize, formatDate } from '../utils/format'

export default function FileTable({ files }) {
  // 排序规则：文件夹排在前面，组内按名称排序（按本地语言规则，中文也能正确排）
  const sorted = [...files].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })

  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-line shadow-card">
      <table className="w-full text-left text-sm">
        {/* 表头用 sunken 半透明与表体分离（不再同色），文字小一号弱化 */}
        <thead className="border-b border-line bg-sunken/60 text-xs text-ink-3">
          <tr>
            <th className="px-4 py-2.5 font-medium">名称</th>
            <th className="px-4 py-2.5 font-medium">类型</th>
            <th className="px-4 py-2.5 font-medium">大小</th>
            <th className="px-4 py-2.5 font-medium">修改日期</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line bg-surface">
          {sorted.map((file, i) => (
            <tr
              key={file.name}
              className="animate-fade-in transition-[background-color,box-shadow] hover:bg-sunken/60 hover:shadow-[inset_2.5px_0_0_0_var(--accent)]"
              /* 行级错峰入场：第 15 行后封顶，长列表不拖沓 */
              style={{ animationDelay: `${Math.min(i, 15) * 25}ms` }}
            >
              {/* 名称：文件夹用 Folder 图标（强调色），文件用 FileText */}
              <td className="px-4 py-2.5 text-ink">
                <span className="inline-flex items-center gap-2">
                  {file.isDirectory ? (
                    <Folder size={16} className="shrink-0 text-accent" />
                  ) : (
                    <FileText size={16} className="shrink-0 text-ink-3" />
                  )}
                  {file.name}
                </span>
              </td>
              <td className="px-4 py-2.5 text-ink-2">{file.type}</td>
              {/* 大小：文件夹的 stat size 没有实际意义，显示「—」；数字列等宽对齐 */}
              <td className="px-4 py-2.5 tabular-nums text-ink-2">
                {file.isDirectory ? '—' : formatSize(file.size)}
              </td>
              <td className="px-4 py-2.5 tabular-nums text-ink-2">{formatDate(file.mtime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
