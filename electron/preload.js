// Electron preload 脚本
// 在页面加载前运行于一个隔离的、可访问部分 Electron API 的环境中。
// 通过 contextBridge 把"安全的、最小化的"接口挂到页面的 window.api 上，
// 页面只能调用这里明确暴露的方法，无法触碰 Node.js 或 Electron 的其他能力。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  // 平台标识：渲染进程据此决定标题栏布局（mac 给原生红绿灯留白 / 其他平台自绘窗口控制按钮）
  platform: process.platform,

  // 无边框窗口的控制接口（对应 main.js 的 window:* IPC）
  win: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximizeToggle: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
    // 查询初始最大化状态，返回 { ok, maximized }
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    // 订阅最大化状态变化（true/false），返回取消订阅函数
    onMaximizedChange: (callback) => {
      const listener = (_event, maximized) => callback(maximized)
      ipcRenderer.on('window:maximized-changed', listener)
      return () => ipcRenderer.removeListener('window:maximized-changed', listener)
    },
  },

  // 让主进程弹出文件夹选择对话框并返回文件列表
  // 对应 main.js 中的 ipcMain.handle('select-folder')
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  // 把文件清单发给主进程，由主进程调用 DeepSeek API 生成分类方案
  // 对应 main.js 中的 ipcMain.handle('analyze-files')
  analyzeFiles: (files) => ipcRenderer.invoke('analyze-files', files),

  // 订阅分析进度（流式输出已接收的字符数），返回取消订阅函数
  // 对应 main.js 在分析过程中持续 send 的 'analyze-progress' 事件
  onAnalyzeProgress: (callback) => {
    const listener = (_event, received) => callback(received)
    ipcRenderer.on('analyze-progress', listener)
    return () => ipcRenderer.removeListener('analyze-progress', listener)
  },

  // 按用户对话要求调整方案：{ files, plan, history }
  // 对应 main.js 中的 ipcMain.handle('adjust-plan')
  adjustPlan: (payload) => ipcRenderer.invoke('adjust-plan', payload),

  // 订阅调整进度（流式输出已接收的字符数），返回取消订阅函数
  // 独立于 analyze-progress，避免和分析按钮的进度状态串台
  onAdjustProgress: (callback) => {
    const listener = (_event, received) => callback(received)
    ipcRenderer.on('adjust-progress', listener)
    return () => ipcRenderer.removeListener('adjust-progress', listener)
  },

  // 文件整理（移动 + 撤销），对应 main.js 中的 organize:* handler
  organize: {
    // 执行整理：{ folderPath, groups: [{ folderName, fileNames }], allowDirs }
    // allowDirs=true 时允许移动文件夹（「不整理已有文件夹」开关关闭的显式放行）
    run: (payload) => ipcRenderer.invoke('organize:run', payload),
    // 撤销该文件夹最近一次整理
    undo: (folderPath) => ipcRenderer.invoke('organize:undo', folderPath),
    // 查询该文件夹是否有可撤销记录（供按钮显隐）
    getUndoable: (folderPath) => ipcRenderer.invoke('organize:get-undoable', folderPath),
    // 订阅整理进度 { current, total }，返回取消订阅函数
    onProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('organize:progress', listener)
      return () => ipcRenderer.removeListener('organize:progress', listener)
    },
    // 订阅撤销进度 { current, total }，返回取消订阅函数
    onUndoProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('organize:undo-progress', listener)
      return () => ipcRenderer.removeListener('organize:undo-progress', listener)
    },
    // 清理整理产生的空分类文件夹（只删应用自己创建且已空的，非递归 rmdir）
    cleanFolders: (folderPath) => ipcRenderer.invoke('organize:clean-folders', folderPath),
    // 查询全部整理历史（供历史弹窗）
    getHistory: () => ipcRenderer.invoke('organize:history'),
    // 顺序回滚到指定整理之前（logFileName 来自 getHistory 返回的 fileName）
    restore: (logFileName) => ipcRenderer.invoke('organize:restore', logFileName),
    // 订阅恢复进度 { current, total }，返回取消订阅函数
    onRestoreProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('organize:restore-progress', listener)
      return () => ipcRenderer.removeListener('organize:restore-progress', listener)
    },
  },

  // API 密钥管理（密钥只单向传入主进程，状态查询绝不返回完整密钥）
  apiKey: {
    getStatus: () => ipcRenderer.invoke('api-key:get-status'),
    save: (key) => ipcRenderer.invoke('api-key:save', key),
    test: (key) => ipcRenderer.invoke('api-key:test', key),
    remove: () => ipcRenderer.invoke('api-key:delete'),
  },
})
