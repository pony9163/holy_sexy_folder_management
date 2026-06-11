// 自绘窗口控制按钮：仅非 mac 的无边框窗口渲染（mac 用 hiddenInset 保留系统原生红绿灯）。
// 绝对定位贴窗口右上角、与标题栏同高的直角热区（贴边按钮不需要圆角，鼠标甩到角落即可命中）。
import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  // 挂载时查一次初始最大化状态，之后订阅主进程推送（订阅函数返回取消订阅函数）
  useEffect(() => {
    window.api.win.isMaximized().then((r) => r.ok && setMaximized(r.maximized))
    return window.api.win.onMaximizedChange(setMaximized)
  }, [])

  const base =
    'app-no-drag inline-flex h-13 w-12 items-center justify-center text-ink-3 transition-colors'
  return (
    <div className="absolute top-0 right-0 flex">
      <button
        onClick={() => window.api.win.minimize()}
        title="最小化"
        className={`${base} hover:bg-ink/8 hover:text-ink`}
      >
        <Minus size={15} />
      </button>
      <button
        onClick={() => window.api.win.maximizeToggle()}
        title={maximized ? '还原' : '最大化'}
        className={`${base} hover:bg-ink/8 hover:text-ink`}
      >
        {/* 还原态用镜像的 Copy 图标模拟「双窗口叠放」，lucide 没有专门的 restore 图标 */}
        {maximized ? <Copy size={13} className="-scale-x-100" /> : <Square size={13} />}
      </button>
      {/* 关闭按钮 hover 红底白字是窗口控制的通用惯例（窗口语义，不走 danger 状态令牌） */}
      <button
        onClick={() => window.api.win.close()}
        title="关闭"
        className={`${base} hover:bg-[#e81123] hover:text-white`}
      >
        <X size={15} />
      </button>
    </div>
  )
}
