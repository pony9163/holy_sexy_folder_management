// Electron 主进程
// 职责：
// 1. 创建应用主窗口（加载 React 渲染的页面）
// 2. 注册 IPC handler：弹出系统文件夹选择对话框，并读取所选文件夹的第一层内容
//
// 安全说明：渲染进程（React 页面）不能直接访问 Node.js 的 fs/dialog 等能力，
// 所有系统操作都在主进程完成，通过 preload.js 暴露的受限接口调用。
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { analyzeFiles, testApiKey } = require('./ai')
const keyStore = require('./keyStore')

/**
 * 创建主窗口
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    title: 'holy_sexy_folder_management',
    webPreferences: {
      // preload 脚本：在隔离环境中向页面注入 window.api
      preload: path.join(__dirname, 'preload.js'),
      // 以下两项是 Electron 推荐的安全默认值
      contextIsolation: true, // 隔离页面和 preload 的 JS 上下文
      nodeIntegration: false, // 禁止页面直接使用 Node.js API
    },
  })

  if (app.isPackaged) {
    // 生产环境：加载 Vite 构建产物
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  } else {
    // 开发环境：加载 Vite 开发服务器（npm run dev 会先启动它）
    win.loadURL('http://localhost:5173')
  }
}

/**
 * 根据文件名取「类型」展示文本：
 * - 有扩展名 → 大写扩展名，如 "PDF"、"TXT"
 * - 无扩展名 → "文件"
 */
function fileType(name) {
  const ext = path.extname(name)
  return ext ? ext.slice(1).toUpperCase() : '文件'
}

// IPC handler：渲染进程调用 window.api.selectFolder() 时触发
// 返回值：
// - 用户取消选择 → null
// - 选择成功     → { folderPath, files: [{ name, type, isDirectory, size, mtime }] }
ipcMain.handle('select-folder', async () => {
  // 1. 弹出系统的文件夹选择对话框（openDirectory = 只能选文件夹）
  const result = await dialog.showOpenDialog({
    title: '选择文件夹',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const folderPath = result.filePaths[0]

  // 2. 只读取第一层内容，不递归进入子文件夹
  //    withFileTypes: true 让每个条目自带"是否为目录"的信息
  const entries = await fs.readdir(folderPath, { withFileTypes: true })

  const files = []
  for (const entry of entries) {
    try {
      // stat 获取大小和修改时间
      const stats = await fs.stat(path.join(folderPath, entry.name))
      files.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        type: entry.isDirectory() ? '文件夹' : fileType(entry.name),
        size: stats.size,
        mtime: stats.mtimeMs, // 修改时间（毫秒时间戳），由前端负责格式化
      })
    } catch {
      // 个别条目无权限或已被删除（如失效的符号链接）时跳过，不影响整个列表
    }
  }

  return { folderPath, files }
})

// IPC handler：渲染进程调用 window.api.analyzeFiles(files) 时触发
// 把文件清单发给 Kimi 做智能分类，返回：
// - 成功 → { ok: true, plan: { folders: [...] } }
// - 失败 → { ok: false, error: 中文错误信息 }（不让异常裸穿 IPC）
ipcMain.handle('analyze-files', async (event, files) => {
  try {
    // 流式接收：每收到一段就把已接收字符数推给渲染进程，供界面显示进度
    const plan = await analyzeFiles(files, (received) => {
      event.sender.send('analyze-progress', received)
    })
    // 在主进程终端也打印一份，方便在 npm run dev 的终端里直接观察结果
    console.log('Kimi 分类方案:', JSON.stringify(plan, null, 2))
    return { ok: true, plan }
  } catch (err) {
    console.error('分析失败:', err.message)
    return { ok: false, error: err.message }
  }
})

// ===== API 密钥管理 IPC =====
// 安全约定：完整密钥只在 save/test 时从渲染进程单向传入；
// 任何 handler 的返回值都不包含完整密钥，日志也不打印密钥。

// 查询密钥状态（只返回是否配置 + 末 4 位掩码等元信息）
ipcMain.handle('api-key:get-status', () => keyStore.getStatus())

// 保存密钥：格式校验在 keyStore 内完成；persisted=false 表示系统不支持加密、仅本次会话有效
ipcMain.handle('api-key:save', (_event, rawKey) => {
  try {
    const { persisted } = keyStore.saveKey(rawKey)
    return { ok: true, persisted, status: keyStore.getStatus() }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 测试密钥连通性：传 rawKey 则测它，否则测已保存的密钥（零 token 消耗）
ipcMain.handle('api-key:test', async (_event, rawKey) => {
  try {
    await testApiKey(rawKey)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// 删除密钥（清内存 + 删加密文件）
ipcMain.handle('api-key:delete', () => {
  keyStore.deleteKey()
  return { ok: true, status: keyStore.getStatus() }
})

// Electron 初始化完成后创建窗口
app.whenReady().then(() => {
  createWindow()

  // macOS 习惯：点击 Dock 图标且没有窗口时，重新创建一个
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 所有窗口关闭时退出应用（macOS 上习惯保留应用，故排除）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
