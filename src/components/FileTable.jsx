// 文件列表表格组件：展示名称、类型、大小、修改日期四列
import { formatSize, formatDate } from '../utils/format'

export default function FileTable({ files }) {
  // 排序规则：文件夹排在前面，组内按名称排序（按本地语言规则，中文也能正确排）
  const sorted = [...files].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'zh')
  })

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 text-gray-600">
          <tr>
            <th className="px-4 py-3 font-medium">名称</th>
            <th className="px-4 py-3 font-medium">类型</th>
            <th className="px-4 py-3 font-medium">大小</th>
            <th className="px-4 py-3 font-medium">修改日期</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {sorted.map((file) => (
            <tr key={file.name} className="hover:bg-gray-50">
              {/* 名称：文件夹用 📁 图标，文件用 📄 */}
              <td className="px-4 py-2.5 text-gray-800">
                <span className="mr-2">{file.isDirectory ? '📁' : '📄'}</span>
                {file.name}
              </td>
              <td className="px-4 py-2.5 text-gray-500">{file.type}</td>
              {/* 大小：文件夹的 stat size 没有实际意义，显示「—」 */}
              <td className="px-4 py-2.5 text-gray-500">
                {file.isDirectory ? '—' : formatSize(file.size)}
              </td>
              <td className="px-4 py-2.5 text-gray-500">{formatDate(file.mtime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
