// API 密钥设置弹窗
// 安全要点：
// - 输入框默认 type="password"（防肩窥），可手动切换显示
// - 密钥只在「保存/测试」时单向发给主进程，本组件从不接收完整密钥（状态里只有末 4 位掩码）
// - 保存成功后立即清空本地输入框 state
import { useEffect, useState } from 'react'
import { Settings, Eye, EyeOff, Lock, TriangleAlert } from 'lucide-react'

export default function ApiKeyModal({ onClose, onStatusChange }) {
  const [status, setStatus] = useState(null)   // 主进程返回的密钥状态（含掩码，不含完整密钥）
  const [input, setInput] = useState('')       // 输入框内容（仅在本组件内存中短暂存在）
  const [showKey, setShowKey] = useState(false) // 是否明文显示输入
  const [busy, setBusy] = useState(false)      // 正在保存/测试中
  const [message, setMessage] = useState(null) // 操作结果提示 { ok, text }

  // 打开弹窗时拉取当前状态
  useEffect(() => {
    refreshStatus()
  }, [])

  async function refreshStatus() {
    const s = await window.api.apiKey.getStatus()
    setStatus(s)
    onStatusChange?.(s)
  }

  // 保存：主进程做格式校验和加密存储
  async function handleSave() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.api.apiKey.save(input)
      if (result.ok) {
        setInput('') // 保存成功后立刻清掉输入框里的明文
        setStatus(result.status)
        onStatusChange?.(result.status)
        setMessage({
          ok: true,
          text: result.persisted
            ? '已保存（已用系统级加密存储在本机）'
            : '已保存，但本系统不支持加密存储，密钥仅本次运行有效',
        })
      } else {
        setMessage({ ok: false, text: result.error })
      }
    } finally {
      setBusy(false)
    }
  }

  // 测试连接：输入框有内容则测输入的，否则测已保存的（不消耗 token）
  async function handleTest() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.api.apiKey.test(input || undefined)
      setMessage(
        result.ok
          ? { ok: true, text: '连接成功，密钥有效 ✓' }
          : { ok: false, text: result.error },
      )
    } finally {
      setBusy(false)
    }
  }

  // 删除已保存的密钥
  async function handleDelete() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.api.apiKey.remove()
      setStatus(result.status)
      onStatusChange?.(result.status)
      setMessage({ ok: true, text: '密钥已删除' })
    } finally {
      setBusy(false)
    }
  }

  return (
    /* 半透明遮罩，点击遮罩关闭 */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* 弹窗主体，阻止冒泡避免误关 */}
      <div
        className="w-full max-w-md animate-pop-in rounded-2xl border border-line bg-surface p-6 shadow-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 inline-flex items-center gap-2 text-lg font-bold text-ink">
          <Settings size={18} className="text-accent" />
          API Key 设置
        </h2>

        {/* 当前状态 */}
        <div className="mb-4 rounded-lg bg-sunken px-4 py-3 text-sm text-ink-2">
          {status === null ? (
            '状态读取中…'
          ) : status.configured ? (
            <>
              当前密钥：<span className="font-mono text-ink">{status.maskedKey}</span>
              {!status.persisted && (
                <span className="ml-2 text-warning">（仅本次运行有效）</span>
              )}
            </>
          ) : (
            '尚未设置 API Key'
          )}
          {/* Linux 弱加密后端提示 */}
          {status?.weakBackend && (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-warning">
              <TriangleAlert size={12} />
              当前系统未启用密钥环（gnome-keyring/kwallet），存储加密强度较弱
            </p>
          )}
        </div>

        {/* 密钥输入框 + 显示/隐藏切换 */}
        <div className="mb-4 flex gap-2">
          <input
            type={showKey ? 'text' : 'password'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="sk-..."
            autoComplete="off"
            spellCheck={false}
            className="flex-1 rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm text-ink outline-none transition placeholder:text-ink-3 focus:border-accent"
          />
          <button
            onClick={() => setShowKey(!showKey)}
            title={showKey ? '隐藏' : '显示'}
            className="rounded-lg border border-line px-3 text-ink-3 transition hover:bg-sunken"
          >
            {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>

        {/* 操作结果提示 */}
        {message && (
          <p
            className={`mb-4 animate-fade-in rounded-lg px-3 py-2 text-sm ${
              message.ok ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'
            }`}
          >
            {message.text}
          </p>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={busy || !input.trim()}
            className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-hi active:scale-[0.98] disabled:opacity-50"
          >
            保存
          </button>
          <button
            onClick={handleTest}
            disabled={busy || (!input.trim() && !status?.configured)}
            className="rounded-lg border border-line px-4 py-2 text-sm text-ink-2 transition hover:bg-sunken active:scale-[0.98] disabled:opacity-50"
          >
            测试连接
          </button>
          {status?.configured && (
            <button
              onClick={handleDelete}
              disabled={busy}
              className="rounded-lg border border-danger/30 px-4 py-2 text-sm text-danger transition hover:bg-danger/10 active:scale-[0.98] disabled:opacity-50"
            >
              删除密钥
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded-lg px-4 py-2 text-sm text-ink-3 transition hover:bg-sunken"
          >
            关闭
          </button>
        </div>

        {/* 安全说明 */}
        <p className="mt-4 inline-flex items-start gap-1.5 text-xs text-ink-3">
          <Lock size={12} className="mt-0.5 shrink-0" />
          密钥经操作系统级加密后仅存储在本机，不会上传到任何服务器；
          调用 DeepSeek API 时由本应用直接发往 DeepSeek 官方接口。
        </p>
      </div>
    </div>
  )
}
