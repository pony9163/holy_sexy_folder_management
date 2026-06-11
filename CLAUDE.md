# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

holy_sexy_folder_management——Electron + React 18 + Tailwind CSS v4 桌面应用：选择文件夹后列出其**第一层**条目（设计上不递归），并可调用 Kimi API（Moonshot）生成文件分类方案。实际项目在 `holy_sexy_folder_management/` 子目录，所有命令都在那里执行。代码注释统一用中文，新代码保持此约定。

## 常用命令

```bash
cd holy_sexy_folder_management
npm run dev      # 同时启动 Vite(5173, strictPort) 和 Electron 窗口（concurrently + wait-on）
npm run build    # vite build → dist/
npm start        # 以生产模式启动（加载 dist/，需先 build）
```

注意：Vite 只热重载 `src/`；**`electron/`（主进程 + preload）改动必须重启 `npm run dev` 才生效**，否则跑的还是旧代码。

没有测试框架和 lint 配置。验证方式：
- 主进程代码改动后 `node --check electron/<file>.js`（CJS 语法检查）
- 前端改动后 `npm run build` 确认可编译
- `keyStore.js` 依赖 `app`/`safeStorage`，**只能在 Electron 环境测试**：写临时入口脚本用 `npx electron /tmp/test.js` 跑（先 `app.setPath('userData', 临时目录)` 避免污染真实数据）
- 端到端实测 API 调用：临时脚本里 `app.setPath('userData', '~/.config/holy_sexy_folder_management')` 指向真实目录，即可用已保存的密钥直接调 `analyzeFiles`（只读密钥、**绝不打印**；脚本里 require 项目内模块和 `node_modules/openai` 要用绝对路径，因为脚本在 /tmp）
- 无头环境跑 `npm run dev` 时终端的 GetVSyncParameters GL 报错是无害的

## 架构

### 双模块体系（最容易踩的坑）

`package.json` **没有** `"type": "module"`：
- `electron/`（主进程 + preload）是 **CommonJS**（`require`）——preload 在 contextIsolation 下必须 CJS
- `src/` 是 ESM + JSX，由 Vite 打包，主进程**不能** import 它（这就是 `electron/ai.js` 内联了一份 `formatSize` 而不复用 `src/utils/format.js` 的原因）

### 进程边界与 IPC

渲染进程无 Node 能力（`contextIsolation: true`、`nodeIntegration: false`），只能通过 `electron/preload.js` 暴露的 `window.api` 调用主进程。数据流：

```
src/App.jsx → window.api.*（preload contextBridge）→ ipcMain.handle（electron/main.js）
  ├─ select-folder   → dialog + fs.readdir（withFileTypes，仅第一层）
  ├─ analyze-files   → electron/ai.js（Kimi API 流式调用）
  └─ api-key:*       → electron/keyStore.js（密钥存取）

反向推送（主进程 → 渲染进程，唯一一处）：
  analyze-progress 事件 —— 分析期间持续推送已接收字符数，
  渲染进程经 window.api.onAnalyzeProgress(cb) 订阅（返回取消订阅函数）
```

约定：IPC handler 一律返回 `{ ok: true, ... }` 或 `{ ok: false, error: 中文消息 }`，异常不裸穿 IPC；用户可见的错误信息全部是中文。

### API 密钥安全不变量（改动相关代码时必须维持）

- 完整密钥**只单向**从渲染进程传入主进程（save/test 时）；任何返回值/状态只含末 4 位掩码（`keyStore.getStatus()`）
- 落盘必须经 `safeStorage` 加密（文件 `userData/api-key.enc`，权限 0600）；`isEncryptionAvailable()` 为 false 时只存内存、绝不落明文
- 任何 console.log / 错误消息不得包含密钥
- 密钥优先级：keyStore 内的用户密钥 > 环境变量 `MOONSHOT_API_KEY`（开发备选）；格式校验为 `sk-` 前缀（Moonshot 密钥格式）

### Kimi API（electron/ai.js）

- 用 `openai` SDK 走 Moonshot 的 OpenAI 兼容接口：`new OpenAI({ apiKey, baseURL: 'https://api.moonshot.cn/v1' })`
- 模型是 `moonshot-v1-auto`，`temperature: 0.3`；系统提示词作为 `messages` 第一条（`role: 'system'`）。**不要换回 kimi-k2.6 / k2.5**：它们是思考型模型，同样任务 ≈30s（v1-auto ≈4s），且 k2.6 只接受 temperature=1
- 调用是流式的（`stream: true`）：`analyzeFiles(files, onProgress)` 边接收边回调字符数，main.js 经 `analyze-progress` 事件推给渲染进程显示进度
- 系统提示词要求严格 JSON（`{ folders: [{ name, files, reason }] }`）；`parsePlan` 会剥掉模型偶尔包的 ```json 栅栏再 parse，并校验 `folders` 是数组
- `testApiKey` 用 `client.models.list()` 验证密钥——零 token 成本，改动时别换成会计费的接口
- SDK 错误统一经 `translateError` 翻译成中文（用类型化异常 `instanceof`，不要字符串匹配）

### 前端

- Tailwind v4 走 `@tailwindcss/vite` 插件：**没有也不需要** `tailwind.config.js`/PostCSS 配置，入口只有 `src/index.css` 的 `@import "tailwindcss"`
- `vite.config.js` 的 `base: './'` 是生产模式 `file://` 加载 dist 所必需的，别删
- 文件列表排序规则在 `FileTable.jsx`：文件夹在前，组内 `localeCompare(name, 'zh')`；文件夹的大小列显示 `—`
