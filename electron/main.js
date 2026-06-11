// Electron 主进程
// 职责：
// 1. 创建应用主窗口（加载 React 渲染的页面）
// 2. 注册 IPC handler：弹出系统文件夹选择对话框，并读取所选文件夹的第一层内容
//
// 安全说明：渲染进程（React 页面）不能直接访问 Node.js 的 fs/dialog 等能力，
// 所有系统操作都在主进程完成，通过 preload.js 暴露的受限接口调用。
const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron')
const path = require('path')
const fs = require('fs/promises')
const { analyzeFiles, adjustPlan, testApiKey } = require('./ai')
const keyStore = require('./keyStore')
const fileOps = require('./fileOps')

/**
 * root/sudo 运行保护：
 * 文件整理涉及移动操作，root 权限下误操作可能损坏系统文件，
 * 且整理产生的文件归属会变为 root，导致普通用户无法正常使用，
 * 因此检测到 root 时弹原生错误框并拒绝启动。
 * 返回 true 表示检查通过（非 root），false 表示已触发退出。
 */
function ensureNotRoot() {
  // Windows 没有 process.getuid，必须先判断函数存在；Linux/macOS 上 uid 0 即 root
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // showErrorBox 是少数允许在 app ready 之前同步调用的 dialog API，关闭弹窗后才继续执行
    dialog.showErrorBox(
      '请勿以 root 身份运行',
      '请不要使用 sudo 或 root 账户运行 holy_sexy_folder_management。\n' +
        '文件整理涉及移动操作，root 权限下的误操作可能损坏系统文件，\n' +
        '且整理后的文件归属会变为 root 导致你无法正常使用。\n' +
        '请关闭后用普通用户身份重新打开。'
    )
    app.quit()
    return false
  }
  return true
}

// root 检查必须在所有其他初始化（窗口创建、whenReady）之前执行
const passedRootCheck = ensureNotRoot()

/**
 * 创建主窗口
 */
function createWindow() {
  // 无边框窗口：mac 用 hiddenInset 隐藏标题栏但保留原生红绿灯；
  // 其他平台完全去框，窗口控制按钮由渲染进程自绘（WindowControls 组件）。
  // 已知限制：Linux 上无 CSD 的窗口由合成器决定外观——直角、无投影属预期（VS Code 同此），
  // 不要用 transparent: true 兜底（会禁用部分硬件加速、部分 WM 下边缘 resize 失效）。
  // 逃生舱：某个 WM 下出问题时 HSF_NATIVE_FRAME=1 启动即可退回系统原生边框。
  const isMac = process.platform === 'darwin'
  const nativeFrame = process.env.HSF_NATIVE_FRAME === '1'
  const win = new BrowserWindow({
    width: 900,
    height: 680,
    title: 'holy_sexy_folder_management',
    backgroundColor: '#0e0e10', // 与默认暗色主题的 --canvas 一致（index.css 改动需同步此处），避免启动白闪
    show: false, // 渲染就绪后再显示，配合 backgroundColor 消除闪烁
    ...(nativeFrame ? {} : isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    webPreferences: {
      // preload 脚本：在隔离环境中向页面注入 window.api
      preload: path.join(__dirname, 'preload.js'),
      // 以下两项是 Electron 推荐的安全默认值
      contextIsolation: true, // 隔离页面和 preload 的 JS 上下文
      nodeIntegration: false, // 禁止页面直接使用 Node.js API
    },
  })

  win.once('ready-to-show', () => win.show())

  // 最大化状态推送：渲染进程的 WindowControls 据此切换 最大化/还原 图标
  const pushMaxState = () =>
    win.webContents.send('window:maximized-changed', win.isMaximized())
  win.on('maximize', pushMaxState)
  win.on('unmaximize', pushMaxState)

  if (app.isPackaged) {
    // 生产环境：加载 Vite 构建产物
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  } else {
    // 开发环境：加载 Vite 开发服务器（npm run dev 会先启动它）
    win.loadURL('http://localhost:5173')
  }
}

// ===== 窗口控制 IPC（无边框窗口的自绘按钮，仅非 mac 平台的渲染进程会调用）=====
// 三个控制是 fire-and-forget 的单向消息（ipcMain.on 无返回值；{ok} 约定只针对 handle）
ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('window:maximize-toggle', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
})
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())
// 初始最大化状态（渲染进程挂载时查一次，后续变化走 window:maximized-changed 推送）
ipcMain.handle('window:is-maximized', (e) => ({
  ok: true,
  maximized: BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
}))

/**
 * 根据文件名取「类型」展示文本：
 * - 有扩展名 → 大写扩展名，如 "PDF"、"TXT"
 * - 无扩展名 → "文件"
 */
function fileType(name) {
  const ext = path.extname(name)
  return ext ? ext.slice(1).toUpperCase() : '文件'
}

/**
 * 读取文件夹第一层内容（不递归），返回前端文件列表所需的字段。
 * 被 select-folder 和整理/撤销完成后的列表刷新共用。
 */
async function readFolderEntries(folderPath) {
  // withFileTypes: true 让每个条目自带"是否为目录"的信息
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
  return files
}

// IPC handler：渲染进程调用 window.api.selectFolder() 时触发
// 返回值：
// - 用户取消选择 → null
// - 选择成功     → { folderPath, files: [{ name, type, isDirectory, size, mtime }] }
ipcMain.handle('select-folder', async () => {
  // 弹出系统的文件夹选择对话框（openDirectory = 只能选文件夹）
  const result = await dialog.showOpenDialog({
    title: '选择文件夹',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const folderPath = result.filePaths[0]
  const files = await readFolderEntries(folderPath)
  return { folderPath, files }
})

// IPC handler：渲染进程调用 window.api.analyzeFiles(files) 时触发
// 把文件清单发给 DeepSeek 做智能分类，返回：
// - 成功 → { ok: true, plans: [ { name, folders: [...] } ] }（三套思路不同的方案）
// - 失败 → { ok: false, error: 中文错误信息 }（不让异常裸穿 IPC）
ipcMain.handle('analyze-files', async (event, files) => {
  try {
    // 流式接收：每收到一段就把已接收字符数推给渲染进程，供界面显示进度
    const plans = await analyzeFiles(files, (received) => {
      event.sender.send('analyze-progress', received)
    })
    // 在主进程终端也打印一份，方便在 npm run dev 的终端里直接观察结果
    console.log('DeepSeek 分类方案:', JSON.stringify(plans, null, 2))
    return { ok: true, plans }
  } catch (err) {
    console.error('分析失败:', err.message)
    return { ok: false, error: err.message }
  }
})

// IPC handler：渲染进程调用 window.api.adjustPlan(payload) 时触发
// 按用户的自然语言要求调整当前方案（只生成新方案 JSON，不动任何文件），返回：
// - 成功 → { ok: true, reply, folders, raw }
// - 失败 → { ok: false, error: 中文错误信息 }
// 进度走独立的 adjust-progress channel（分析进度订阅在 App，调整进度订阅在 PlanPreview，
// 复用 analyze-progress 会让两处状态串台）
ipcMain.handle('adjust-plan', async (event, payload) => {
  try {
    const result = await adjustPlan(payload, (received) => {
      event.sender.send('adjust-progress', received)
    })
    console.log('DeepSeek 调整后方案:', JSON.stringify(result.folders, null, 2))
    return { ok: true, ...result }
  } catch (err) {
    console.error('调整失败:', err.message)
    return { ok: false, error: err.message }
  }
})

// ===== 文件整理 IPC =====
// 核心移动/撤销逻辑在 electron/fileOps.js；这里负责输入校验（渲染进程不可信）、
// 硬性安全检查（必须在动文件之前全部通过）和进度事件转发。

// 整理映射表的存放目录（userData 下的子目录，避免和 api-key.enc 混在一起）
const organizeLogDir = () => path.join(app.getPath('userData'), 'organize-logs')

/**
 * 校验单个文件/文件夹名：必须是纯名字，不能携带路径段。
 * AI 输出和渲染进程传入的名字都不可信，path.basename(x) === x
 * 保证名字里没有分隔符，配合 path.join 拼接后不可能逃出目标文件夹。
 */
function isSafeName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('\0') &&
    path.basename(name) === name
  )
}

// 执行整理：创建分类子文件夹并移动文件，移动过程经 organize:progress 推送进度
ipcMain.handle('organize:run', async (event, payload) => {
  try {
    // ===== 硬性安全检查：必须最先执行，全部通过才允许动文件 =====
    // 1) root 双保险（启动时 ensureNotRoot 已查过，这里再拦一道）
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return { ok: false, error: '禁止以 root 身份执行整理' }
    }
    // 2) 目录必须存在；realpath 消解符号链接，防止链接指向系统目录绕过黑名单
    const rawPath = String(payload?.folderPath || '')
    if (!rawPath) return { ok: false, error: '未指定要整理的文件夹' }
    let folderPath
    try {
      folderPath = await fs.realpath(rawPath)
    } catch {
      return { ok: false, error: '文件夹不存在或无法访问' }
    }
    // 3) 系统目录黑名单（路径边界前缀匹配）
    const unsafe = fileOps.checkFolderSafety(folderPath)
    if (unsafe) return { ok: false, error: unsafe }
    // 4) 必须是目录
    const stats = await fs.stat(folderPath)
    if (!stats.isDirectory()) return { ok: false, error: '所选路径不是文件夹' }
    // 5) 分类名和文件名逐一校验，拒绝任何携带路径段的名字
    const groups = Array.isArray(payload?.groups) ? payload.groups : null
    if (!groups || groups.length === 0) return { ok: false, error: '没有可整理的文件' }
    for (const group of groups) {
      // 分开校验并指明肇事名字：分类名是 AI 自由生成的（如带 / 的「图片/截图」），最容易踩中
      if (!isSafeName(group?.folderName)) {
        return {
          ok: false,
          error: `整理方案包含非法分类名「${String(group?.folderName ?? '')}」（不能含路径分隔符或为 . / ..），已拒绝执行`,
        }
      }
      if (!Array.isArray(group?.fileNames) || group.fileNames.length === 0) {
        return { ok: false, error: `分类「${group.folderName}」没有文件，已拒绝执行` }
      }
      const badFile = group.fileNames.find((n) => !isSafeName(n))
      if (badFile !== undefined) {
        return {
          ok: false,
          error: `分类「${group.folderName}」中包含非法文件名「${String(badFile ?? '')}」，已拒绝执行`,
        }
      }
    }
    // ===== 检查结束，执行整理 =====
    // allowDirs 来自前端「不整理已有文件夹」开关的显式放行，强制布尔化（默认拒绝移动文件夹）
    const result = await fileOps.organize(
      folderPath,
      groups,
      organizeLogDir(),
      (current, total) => {
        event.sender.send('organize:progress', { current, total })
      },
      { allowDirs: payload?.allowDirs === true },
    )
    // 附带刷新后的文件列表，前端免二次往返
    const files = await readFolderEntries(folderPath)
    return { ok: true, ...result, files }
  } catch (err) {
    console.error('整理失败:', err.message)
    return { ok: false, error: err.message || '整理失败' }
  }
})

// 撤销最近一次整理：按映射表把文件移回原位，进度经 organize:undo-progress 推送
ipcMain.handle('organize:undo', async (event) => {
  try {
    // root 双保险，与整理同理
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return { ok: false, error: '禁止以 root 身份执行撤销' }
    }
    const result = await fileOps.undoOrganize(organizeLogDir(), (current, total) => {
      event.sender.send('organize:undo-progress', { current, total })
    })
    // 撤销的目录若仍可读则附带刷新后的列表（前端比对 folderPath 再决定是否使用）
    let files = null
    try {
      files = await readFolderEntries(result.folderPath)
    } catch {
      // 目录已不可访问时只返回结果，不影响撤销本身
    }
    return { ok: true, ...result, files }
  } catch (err) {
    console.error('撤销失败:', err.message)
    return { ok: false, error: err.message || '撤销失败' }
  }
})

// 查询是否有可撤销的整理记录（供"撤销上次整理"按钮显隐）
ipcMain.handle('organize:get-undoable', async () => {
  try {
    const found = await fileOps.findLatestUndoable(organizeLogDir())
    if (!found) return { ok: true, undoable: false, info: null }
    const { record } = found
    return {
      ok: true,
      undoable: true,
      info: {
        createdAt: record.createdAt,
        folderPath: record.folderPath,
        moveCount: record.moves.length,
      },
    }
  } catch (err) {
    return { ok: false, error: err.message || '查询撤销记录失败' }
  }
})

// 查询全部整理历史（供历史弹窗列表，只含摘要不含 moves 明细）
ipcMain.handle('organize:history', async () => {
  try {
    const history = await fileOps.listHistory(organizeLogDir())
    return { ok: true, history }
  } catch (err) {
    return { ok: false, error: err.message || '读取整理历史失败' }
  }
})

// 顺序回滚到指定整理之前：连带撤销同文件夹该时间点之后的所有未撤销记录，
// 进度经 organize:restore-progress 推送（独立 channel，避免与撤销按钮的进度状态串台）
ipcMain.handle('organize:restore', async (event, logFileName) => {
  try {
    // root 双保险，与整理/撤销同理
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return { ok: false, error: '禁止以 root 身份执行恢复' }
    }
    // 渲染进程传入的文件名不可信：必须是纯文件名 + 严格匹配落盘命名格式
    // （fileOps.organize 生成的时间戳末尾带 Z：organize-2026-06-11T08-30-00-123Z.json）
    if (
      typeof logFileName !== 'string' ||
      path.basename(logFileName) !== logFileName ||
      !/^organize-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/.test(logFileName)
    ) {
      return { ok: false, error: '非法的记录文件名，已拒绝执行' }
    }
    const logDir = organizeLogDir()
    // 三保险：拼接后再确认确实落在 logDir 之内
    const full = path.resolve(path.join(logDir, logFileName))
    if (path.dirname(full) !== path.resolve(logDir)) {
      return { ok: false, error: '非法的记录路径，已拒绝执行' }
    }
    const result = await fileOps.restoreTo(logDir, logFileName, (current, total) => {
      event.sender.send('organize:restore-progress', { current, total })
    })
    // 目录仍可读则附带刷新后的列表（前端比对 folderPath 再决定是否使用）
    let files = null
    try {
      files = await readFolderEntries(result.folderPath)
    } catch {
      // 目录已不可访问时只返回结果，不影响恢复本身
    }
    return { ok: true, ...result, files }
  } catch (err) {
    console.error('恢复失败:', err.message)
    return { ok: false, error: err.message || '恢复失败' }
  }
})

// 清理整理产生的空分类文件夹（用户在撤销/恢复后主动点击清理按钮）：
// 候选集由 fileOps 从映射表里取（仅应用自己创建过的），渲染进程只传 folderPath；
// 删除只用非递归 rmdir，非空目录必然失败保留
ipcMain.handle('organize:clean-folders', async (_event, rawPath) => {
  try {
    // root 双保险，与整理/撤销同理
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return { ok: false, error: '禁止以 root 身份执行清理' }
    }
    if (typeof rawPath !== 'string' || !rawPath) {
      return { ok: false, error: '未指定要清理的文件夹' }
    }
    let folderPath
    try {
      folderPath = await fs.realpath(rawPath)
    } catch {
      return { ok: false, error: '文件夹不存在或无法访问' }
    }
    const result = await fileOps.cleanEmptyCreatedFolders(organizeLogDir(), folderPath)
    // 目录仍可读则附带刷新后的列表（前端比对 folderPath 再决定是否使用）
    let files = null
    try {
      files = await readFolderEntries(folderPath)
    } catch {
      // 目录已不可访问时只返回结果
    }
    return { ok: true, ...result, files }
  } catch (err) {
    console.error('清理失败:', err.message)
    return { ok: false, error: err.message || '清理失败' }
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

// Electron 初始化完成后创建窗口（root 检查未通过时已触发退出，不进入主界面）
if (passedRootCheck) {
  app.whenReady().then(() => {
    // 移除默认菜单栏（File/Edit/View…）：对本应用无用且不像成品。
    // 副作用：Ctrl+R 刷新、Ctrl+Shift+I DevTools 等默认快捷键随菜单失效，
    // 开发期需要 DevTools 时可临时注释本行或调 win.webContents.openDevTools()。
    // macOS 的系统菜单承载 Cmd+C/V 等编辑快捷键，去掉会破坏复制粘贴，故仅非 mac 移除
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    createWindow()

    // macOS 习惯：点击 Dock 图标且没有窗口时，重新创建一个
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// 所有窗口关闭时退出应用（macOS 上习惯保留应用，故排除）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
