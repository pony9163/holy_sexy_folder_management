// 应用主界面：
// - 顶部：标题 + "分析" / "选择文件夹" / ⚙️ 设置按钮
// - 选中文件夹后：显示当前路径、条目数和文件列表表格
// - 点「分析」：把文件清单发给 Kimi 生成分类方案，结果以预览卡片展示（可排除文件后确认）
// - ⚙️ 设置：填写/管理 Moonshot API Key（加密存储在主进程侧）
import { useEffect, useState } from 'react'
import FileTable from './components/FileTable'
import ApiKeyModal from './components/ApiKeyModal'
import PlanPreview from './components/PlanPreview'

export default function App() {
  const [folderPath, setFolderPath] = useState(null) // 当前选中的文件夹路径
  const [files, setFiles] = useState([])             // 第一层文件/文件夹列表
  const [loading, setLoading] = useState(false)      // 是否正在读取文件夹
  const [analyzing, setAnalyzing] = useState(false)  // 是否正在调用 Kimi 分析
  const [progress, setProgress] = useState(0)        // 流式输出已接收的字符数（仅分析中有意义）
  const [analyzeStatus, setAnalyzeStatus] = useState(null) // 分析结果提示 { ok, message }
  const [showSettings, setShowSettings] = useState(false)  // 是否打开 API Key 设置弹窗
  const [keyStatus, setKeyStatus] = useState(null)   // 密钥状态（只含掩码等元信息）
  const [plans, setPlans] = useState(null)            // 分析得到的整理方案数组（null = 不显示预览）

  // 启动时查一次密钥状态，用于在界面上给出引导提示
  useEffect(() => {
    window.api.apiKey.getStatus().then(setKeyStatus)
  }, [])

  // 订阅分析进度事件（主进程流式接收 Kimi 回复时持续推送），卸载时取消订阅
  useEffect(() => window.api.onAnalyzeProgress(setProgress), [])

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
      }
    } finally {
      setLoading(false)
    }
  }

  // 点击「分析」：把文件清单发给主进程 → Kimi API → 返回分类方案
  async function handleAnalyze() {
    setAnalyzing(true)
    setAnalyzeStatus(null)
    setProgress(0)
    setPlans(null) // 先卸载旧预览，重新分析后排除状态从零开始
    try {
      const result = await window.api.analyzeFiles(files)
      if (result.ok) {
        // 按"方案数组"包装，为未来多套方案预留结构（当前 AI 只返回一套）
        setPlans([{ name: '方案一', folders: result.plan.folders }])
        setAnalyzeStatus({ ok: true, message: `分析完成：共 ${result.plan.folders.length} 个分类，请在下方预览确认` })
      } else {
        setAnalyzeStatus({ ok: false, message: result.error })
      }
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="mx-auto max-w-4xl">
        {/* 标题栏与操作按钮 */}
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-gray-800">📂 holy_sexy_folder_management</h1>
          <div className="flex gap-3">
            {/* 分析按钮：选了文件夹且列表非空才可点 */}
            <button
              onClick={handleAnalyze}
              disabled={analyzing || files.length === 0}
              className="rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white shadow transition hover:bg-emerald-700 disabled:opacity-50"
            >
              {analyzing ? (progress > 0 ? `分析中…已接收 ${progress} 字` : '分析中…') : '✨ 分析'}
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

        {/* 分析结果提示条：成功为绿色，失败为红色 */}
        {analyzeStatus && (
          <p
            className={`mb-4 rounded-lg px-4 py-2.5 text-sm ${
              analyzeStatus.ok
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-red-50 text-red-700'
            }`}
          >
            {analyzeStatus.message}
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
              <PlanPreview plans={plans} files={files} onCancel={() => setPlans(null)} />
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
