# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

holy_sexy_folder_management——Electron + React 18 + Tailwind CSS v4 桌面应用：选择文件夹后列出其**第一层**条目（设计上不递归），调用 Kimi API（Moonshot）生成文件分类方案，确认后真正移动文件（`fs.rename`），并支持撤销和按历史快照顺序回滚。项目就在仓库根目录，所有命令都在根目录执行。代码注释统一用中文，新代码保持此约定。

## 常用命令

```bash
npm run dev      # 同时启动 Vite(5173, strictPort) 和 Electron 窗口（concurrently + wait-on）
npm run build    # vite build → dist/
npm start        # 以生产模式启动（加载 dist/，需先 build）
npm run dist     # vite build + electron-builder 打 Linux deb → release/
```

注意：Vite 只热重载 `src/`；**`electron/`（主进程 + preload）改动必须重启 `npm run dev` 才生效**，否则跑的还是旧代码。

没有测试框架和 lint 配置。验证方式：
- 主进程代码改动后 `node --check electron/<file>.js`（CJS 语法检查）
- 前端改动后 `npm run build` 确认可编译
- `fileOps.js` 不依赖 Electron，可用纯 Node 脚本实测：/tmp 下 `fs.mkdtemp` 建临时文件夹和 logDir，绝对路径 require 后直接调 `organize`/`undoOrganize`/`restoreTo` 断言文件位置与映射表内容（已有先例：/tmp/test-organize.js、/tmp/test-restore.js、/tmp/test-safety.js，会话间可能已被清理）
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
  ├─ select-folder           → dialog + readFolderEntries（fs.readdir withFileTypes，仅第一层）
  ├─ analyze-files           → electron/ai.js analyzeFiles（一次返回三套方案）
  ├─ adjust-plan             → electron/ai.js adjustPlan（对话调整当前方案，只生成 JSON 不动文件）
  ├─ organize:run            → electron/fileOps.js organize（创建分类文件夹 + fs.rename 移动）
  ├─ organize:undo           → fileOps undoOrganize（撤销最近一次未撤销的整理）
  ├─ organize:get-undoable   → fileOps findLatestUndoable（撤销按钮显隐）
  ├─ organize:history        → fileOps listHistory（历史弹窗的快照摘要列表）
  ├─ organize:restore        → fileOps restoreTo（顺序回滚到某次整理之前）
  └─ api-key:*               → electron/keyStore.js（密钥存取）

反向推送（主进程 → 渲染进程）均为「订阅函数返回取消订阅函数」模式（参考 onAnalyzeProgress）：
  analyze-progress           —— 分析期间推送已接收字符数（number）
  adjust-progress            —— 对话调整期间推送已接收字符数（number）
  organize:progress          —— 整理移动进度 { current, total }
  organize:undo-progress     —— 撤销进度 { current, total }
  organize:restore-progress  —— 历史恢复进度 { current, total }
  进度 channel 故意分开不复用：App 订阅 analyze-progress/undo-progress，
  PlanPreview 订阅 adjust-progress，HistoryModal 订阅 restore-progress，复用会状态串台
```

约定：IPC handler 一律返回 `{ ok: true, ... }` 或 `{ ok: false, error: 中文消息 }`，异常不裸穿 IPC；用户可见的错误信息全部是中文。`organize:run`/`organize:undo` 返回值附带刷新后的 `files` 列表（`organize:restore` 在目录可读时附带），前端直接 setFiles 免二次往返。

### 文件整理安全不变量（electron/fileOps.js，最高优先级）

- **零删除（针对用户文件）**：文件整理相关代码不调用任何删除 API（unlink/rm/rmdir 等）。映射表撤销后只改写 JSON 标 `undone: true` 不删文件；空分类文件夹撤销后保留（前端提示用户手动删）；损坏的记录文件跳过不删。唯一例外是 keyStore.js 删应用自己的密钥文件（用户主动删除密钥、解密失败清理损坏文件），不触碰用户文件
- **只用 `fs.rename`** 移动（同盘原子操作）；EXDEV 跨设备时报错跳过，**绝不退化为复制后删除**
- **映射表先落盘再动文件**：`organize` 在第一次 rename 之前把完整计划写入 `userData/organize-logs/organize-<ISO时间戳>.json`（`:` `.` 换 `-`，**末尾带 Z**——`organize:restore` 的文件名校验正则必须匹配这个格式）；每条 rename 成功/失败后立刻改写 JSON。撤销对"rename 成功但 JSON 未更新"的崩溃窗口有容错（to 不存在按 skipped 处理）
- **`checkFolderSafety` 是唯一安全卡口**（organize:run、undoRecord、restoreTo 都先过它），拒绝四类目录：文件系统根目录、系统目录黑名单（前缀边界匹配，Linux/Mac/Windows 各一份）、用户主文件夹本身（子文件夹允许）、隐藏文件夹（路径任一段以 `.` 开头，含 ~/.config 及其子目录）。新增保护规则只改这一个函数
- **渲染进程输入不可信**：organize:run 对 folderPath 先 `fs.realpath`（防符号链接绕过黑名单）再查安全；所有分类名/文件名校验 `path.basename(x) === x` 且非 `.`/`..`；organize:restore 的 logFileName 三重校验（纯文件名 + 严格正则 + resolve 后确认在 logDir 内）
- 路径拼接一律 `path.join`/`path.resolve`，不手写分隔符；root 检查双保险（启动时 `ensureNotRoot` 弹窗退出 + organize/undo handler 内再拦一道）
- 目标重名自动加 ` (1)`、` (2)`…（`uniqueName`，rename 前还会复核一次防 POSIX rename 静默覆盖）；单文件失败跳过记录不中止，恢复统一交给显式撤销
- **organize 默认拒绝移动文件夹**（"是文件夹，不参与整理"）；`options.allowDirs === true` 为显式放行（来自前端「不整理已有文件夹」开关关闭，organize:run 透传并强制布尔化），放行时仍拒绝「分类名==被移动文件夹名」的自吞移动，更深嵌套由 OS rename 报错兜底
- **顺序回滚语义**（restoreTo）：恢复到第 N 次之前 = 同 folderPath（字符串严格相等即可，落盘前已 realpath 规范化，勿对历史路径再 realpath——目录可能已不存在）、createdAt >= 目标、未撤销的记录按时间倒序逐份撤销；其他文件夹不受影响

### API 密钥安全不变量（改动相关代码时必须维持）

- 完整密钥**只单向**从渲染进程传入主进程（save/test 时）；任何返回值/状态只含末 4 位掩码（`keyStore.getStatus()`）
- 落盘必须经 `safeStorage` 加密（文件 `userData/api-key.enc`，权限 0600）；`isEncryptionAvailable()` 为 false 时只存内存、绝不落明文
- 任何 console.log / 错误消息不得包含密钥
- 密钥优先级：keyStore 内的用户密钥 > 环境变量 `MOONSHOT_API_KEY`（开发备选）；格式校验为 `sk-` 前缀（Moonshot 密钥格式）

### Kimi API（electron/ai.js）

- 用 `openai` SDK 走 Moonshot 的 OpenAI 兼容接口：`new OpenAI({ apiKey, baseURL: 'https://api.moonshot.cn/v1' })`
- 模型是 `moonshot-v1-auto`，`temperature: 0.3`；系统提示词作为 `messages` 第一条（`role: 'system'`）。**不要换回 kimi-k2.6 / k2.5**：它们是思考型模型，同样任务 ≈30s（v1-auto ≈4s），且 k2.6 只接受 temperature=1
- 调用是流式的（`stream: true`，共用 `streamCompletion`）：`analyzeFiles(files, onProgress)` 边接收边回调字符数，main.js 经 `analyze-progress` 事件推给渲染进程显示进度
- 分析的系统提示词要求一次返回恰好三套思路不同的方案，严格 JSON（`{ plans: [{ name, folders: [{ name, files, reason }] }] }`）；`parsePlans` 剥掉模型偶尔包的 ```json 栅栏再 parse，校验 plans/folders 结构，方案名缺失或重复时回退「方案一/二/三」（前端 Tab 的 key 是方案名，必须唯一）
- **每套方案必须独立覆盖全部文件**（三套是三选一的备选项，不是把文件分摊到三套里）：提示词已强调，但模型偶尔仍漏个别文件，`fillMissingFiles` 在分析后把每套未覆盖的文件归入「其他」兜底分类。对话调整**故意不做**这个兜底——用户可能就是要求把某些文件从方案里去掉
- `adjustPlan({ files, plan, history }, onProgress)`：按用户自然语言要求改写一套方案，返回 `{ reply, folders, raw }`；history 里 assistant 消息发上一轮的 `raw` 原始 JSON（让模型看到自己的输出），进度走独立的 `adjust-progress`
- `testApiKey` 用 `client.models.list()` 验证密钥——零 token 成本，改动时别换成会计费的接口
- SDK 错误统一经 `translateError` 翻译成中文（用类型化异常 `instanceof`，不要字符串匹配）

### 打包与 CI

- electron-builder 配置在 `package.json` 的 `build` 字段（appId `com.pony9163.holy-sexy-folder-management`，产物输出 `release/`，图标 `build/icon.png`）；打包只收 `dist/**`、`electron/**`、`package.json`
- **Linux deb 本地打**（`npm run dist`）；**mac dmg 只能走 CI**（本地是 Linux 构建不了 mac 产物）：`.github/workflows/build-mac.yml`，手动触发或推 `v*` 标签，在 macOS runner 上打 arm64 + x64 的 dmg，artifact 名 `mac-dmg`
- CI 里 `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` 是故意的：没有签名证书，跳过签名（产物未签名，用户需右键打开放行）；以后有 Developer ID 证书再接公证
- workflow 用的官方 actions 均为 v5（checkout/setup-node/upload-artifact），别降回 v4（Node 20 弃用警告）

### 前端

- Tailwind v4 走 `@tailwindcss/vite` 插件：**没有也不需要** `tailwind.config.js`/PostCSS 配置，入口只有 `src/index.css` 的 `@import "tailwindcss"`
- `vite.config.js` 的 `base: './'` 是生产模式 `file://` 加载 dist 所必需的，别删
- 文件列表排序规则在 `FileTable.jsx`：文件夹在前，组内 `localeCompare(name, 'zh')`；文件夹的大小列显示 `—`
- 约束开关栏在 `App.jsx`：三个开关（不整理已有文件夹默认开/不动最近 7 天/排除扩展名），状态持久化到 localStorage（`organize-constraints-v1`）；App 用 useMemo 把 files 分成 `eligibleFiles`（发给 AI、传给 PlanPreview）和 `skippedEntries`（预览灰色区展示）；分析中或预览打开时整栏锁定，防止方案与约束不一致；PlanPreview 的 `resolvedFolders` 只认 fileMap 成员（不再特判 isDirectory，目录参与与否由 App 过滤决定）
- `PlanPreview.jsx`：三套方案按 Tab 切换，方案数组提升为本地 state `localPlans`（对话调整会改写当前方案的 folders；App 重新分析前先 setPlans(null) 卸载组件，故用 props 初始化安全）；排除集合和聊天历史都按方案独立（`plans.map(() => …)` 模式）；聊天调整成功后替换当前方案 folders 并**清空该方案的排除集合**（文件归属已变）；整理弹窗为三态状态机 confirm → running → done，发给主进程的 groups 由 `resolvedFolders` 过滤排除项得出（AI 幻觉文件名靠它的 fileMap 过滤兜底）
- `HistoryModal.jsx`：历史快照弹窗，四阶段（列表/confirm/running/done）；"连带撤销 N 次"的链条由前端用 `getHistory` 返回的摘要自行计算（同 folderPath、createdAt >= 目标、未撤销），与主进程 `restoreTo` 的链条定义保持一致——改一边必须同步另一边
- 整理/撤销/恢复完成后的列表刷新都走 handler 返回的 `files`（撤销/恢复要先比对返回的 `folderPath` 是否等于当前展示的文件夹）
