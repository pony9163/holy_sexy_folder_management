// Electron preload 脚本
// 在页面加载前运行于一个隔离的、可访问部分 Electron API 的环境中。
// 通过 contextBridge 把"安全的、最小化的"接口挂到页面的 window.api 上，
// 页面只能调用这里明确暴露的方法，无法触碰 Node.js 或 Electron 的其他能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 让主进程弹出文件夹选择对话框并返回文件列表
  // 对应 main.js 中的 ipcMain.handle('select-folder')
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // 把文件清单发给主进程，由主进程调用 Kimi API 生成分类方案
  // 对应 main.js 中的 ipcMain.handle('analyze-files')
  analyzeFiles: (files) => ipcRenderer.invoke('analyze-files', files),

  // 订阅分析进度（流式输出已接收的字符数），返回取消订阅函数
  // 对应 main.js 在分析过程中持续 send 的 'analyze-progress' 事件
  onAnalyzeProgress: (callback) => {
    const listener = (_event, received) => callback(received)
    ipcRenderer.on('analyze-progress', listener)
    return () => ipcRenderer.removeListener('analyze-progress', listener)
  },

  // API 密钥管理（密钥只单向传入主进程，状态查询绝不返回完整密钥）
  apiKey: {
    getStatus: () => ipcRenderer.invoke('api-key:get-status'),
    save: (key) => ipcRenderer.invoke('api-key:save', key),
    test: (key) => ipcRenderer.invoke('api-key:test', key),
    remove: () => ipcRenderer.invoke('api-key:delete'),
  },
})
