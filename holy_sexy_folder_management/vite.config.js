// Vite 构建配置
// - react()    ：支持 JSX 和 React 热更新
// - tailwindcss()：Tailwind CSS v4 官方 Vite 插件，无需额外的 tailwind.config 文件
// - base: './' ：生产构建用相对路径，这样 Electron 用 file:// 协议加载 dist/index.html 时资源能正确找到
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  server: {
    port: 5173,        // 固定端口，与 package.json 中 wait-on 等待的端口保持一致
    strictPort: true,  // 端口被占用时直接报错，避免 Electron 连到错误端口
  },
})
