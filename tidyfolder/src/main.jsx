// React 应用入口：把 <App /> 挂载到 index.html 中的 #root 节点
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css' // 引入 Tailwind 样式

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
