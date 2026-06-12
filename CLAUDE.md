# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

holy_sexy_folder_management——Electron + React 18 + Tailwind CSS v4 桌面应用：选择文件夹后列出其**第一层**条目（设计上不递归），调用 DeepSeek API 生成文件分类方案，确认后真正移动文件（`fs.rename`），并支持撤销和按历史快照顺序回滚。项目就在仓库根目录，所有命令都在根目录执行。代码注释统一用中文，新代码保持此约定。

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
- **UI 端到端验证**（已验证可行的套路，先例 /tmp/test-adjust-ui.js、/tmp/test-theme-shots.js）：临时 electron 脚本里①补丁 `dialog.showOpenDialog` 返回固定测试目录（原生对话框没法脚本点）；②补丁 `BrowserWindow.prototype.loadURL` 改为 loadFile dist/index.html（需先 `npm run build`）；③要避免耗 API 时，在 require main.js **之前** require ai.js 并覆写其导出函数（main.js 解构到的是同一缓存对象）；④require 真实 main.js，然后用 `win.webContents.executeJavaScript` 驱动 DOM（按钮按 textContent 找、React 输入框用原生 value setter + dispatch input 事件）、`capturePage()` 截图后用 Read 工具目检。测试残留的 localStorage 记得清
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
  ├─ organize:undo           → fileOps undoOrganize（撤销该文件夹最近一次未撤销的整理，入参 folderPath）
  ├─ organize:get-undoable   → fileOps findLatestUndoable（按当前 folderPath 查询，供撤销按钮显隐）
  ├─ organize:history        → fileOps listHistory（历史弹窗的快照摘要列表）
  ├─ organize:restore        → fileOps restoreTo（顺序回滚到某次整理之前）
  ├─ organize:clean-folders  → fileOps cleanEmptyCreatedFolders（删撤销后留下的空分类文件夹）
  ├─ api-key:*               → electron/keyStore.js（密钥存取）
  ├─ window:is-maximized     → 查询初始最大化状态 { ok, maximized }
  └─ window:minimize / maximize-toggle / close —— 自绘窗口按钮，fire-and-forget 的
     ipcMain.on 单向消息（无返回值；{ok} 约定只针对 handle），preload 里是 api.win.*

反向推送（主进程 → 渲染进程）均为「订阅函数返回取消订阅函数」模式（参考 onAnalyzeProgress）：
  analyze-progress           —— 分析期间推送已接收字符数（number）
  adjust-progress            —— 对话调整期间推送已接收字符数（number）
  organize:progress          —— 整理移动进度 { current, total }
  organize:undo-progress     —— 撤销进度 { current, total }
  organize:restore-progress  —— 历史恢复进度 { current, total }
  window:maximized-changed   —— 最大化状态（boolean），WindowControls 据此切换图标
  进度 channel 故意分开不复用：App 订阅 analyze-progress/undo-progress，
  PlanPreview 订阅 adjust-progress，HistoryModal 订阅 restore-progress，复用会状态串台
```

约定：IPC handler 一律返回 `{ ok: true, ... }` 或 `{ ok: false, error: 中文消息 }`，异常不裸穿 IPC；用户可见的错误信息全部是中文。`organize:run`/`organize:undo` 返回值附带刷新后的 `files` 列表（`organize:restore` 在目录可读时附带），前端直接 setFiles 免二次往返。

### 文件整理安全不变量（electron/fileOps.js，最高优先级）

- **零删除（针对用户文件）**：映射表撤销后只改写 JSON 标 `undone: true` 不删文件；损坏的记录文件跳过不删。仅有两个严格限定的例外：① keyStore.js 删应用自己的密钥文件（用户主动删除密钥、解密失败清理损坏文件）；② `cleanEmptyCreatedFolders`（用户在撤销后主动点「清理空分类文件夹」按钮触发）——候选只来自已撤销记录的 `createdFolders`（应用自己创建过的，渲染进程只传 folderPath 不传名字），删除只用**非递归 `fs.rmdir`**（非空目录天然失败保留），不可能触碰用户文件
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
- 密钥优先级：keyStore 内的用户密钥 > 环境变量 `DEEPSEEK_API_KEY`（开发备选）；格式校验为 `sk-` 前缀（DeepSeek 密钥格式）

### DeepSeek API（electron/ai.js）

- 用 `openai` SDK 走 DeepSeek 的 OpenAI 兼容接口（baseURL `https://api.deepseek.com`）；client 实例经 `getClient()` 缓存复用（keep-alive 连接池省握手、降首响应延迟，换密钥自动重建），**不要改回每次 new OpenAI**
- 模型是 `deepseek-v4-flash`（官方主 ID；`deepseek-chat`/`deepseek-reasoner` 是兼容别名，2026-07-24 弃用，别用），`temperature: 0.3`；系统提示词作为 `messages` 第一条（`role: 'system'`）。**该模型思考模式默认开启**，`streamCompletion` 里显式传 `thinking: { type: 'disabled' }` 关闭（openai SDK 透传未知参数）——2026-06 实测关闭后首字 token 秒级、整体快于之前的 moonshot-v1-auto；删掉这行会慢到思考型模型的 ≈30s 量级（生成用不到的推理过程），与之前弃用 kimi 思考型模型是同一个教训
- 调用是流式的（`stream: true`，共用 `streamCompletion`）：`analyzeFiles(files, onProgress)` 边接收边回调字符数，main.js 经 `analyze-progress` 事件推给渲染进程显示进度
- 分析的系统提示词要求一次返回恰好三套思路不同的方案，严格 JSON（`{ plans: [{ name, folders: [{ name, files, reason }] }] }`）；`parsePlans` 剥掉模型偶尔包的 ```json 栅栏再 parse，校验 plans/folders 结构，方案名缺失或重复时回退「方案一/二/三」（前端 Tab 的 key 是方案名，必须唯一）
- **分类名禁含路径分隔符**：deepseek-v4-flash 爱起「图片/截图」式分类名，会被 main.js 的 `isSafeName` 安全卡口整单拒绝。分析和对话调整两个提示词都已加约束（并列含义用顿号）；卡口报错会指明肇事名字（分类名/空分类/文件名三种分开报）。提示词只能挡大部分——若实际仍频发，下一步是在 parsePlans/adjustPlan 解析后清洗分类名（替换 `/` `\` 为全角），别去松动 isSafeName 本身
- **每套方案必须独立覆盖全部文件**（三套是三选一的备选项，不是把文件分摊到三套里）：提示词已强调，但模型偶尔仍漏个别文件，`fillMissingFiles` 在分析后把每套未覆盖的文件归入「其他」兜底分类。对话调整**故意不做**这个兜底——用户可能就是要求把某些文件从方案里去掉
- `adjustPlan({ files, plan, history }, onProgress)`：按用户自然语言要求改写一套方案，返回 `{ reply, folders, raw }`；history 里 assistant 消息发上一轮的 `raw` 原始 JSON（让模型看到自己的输出），进度走独立的 `adjust-progress`
- `testApiKey` 用 `client.models.list()` 验证密钥——零 token 成本，改动时别换成会计费的接口（它测新 key，不走 getClient 缓存）
- SDK 错误统一经 `translateError` 翻译成中文（按类型化异常 `instanceof` 分发）。**DeepSeek 的错误语义按状态码区分**（与之前 Moonshot 把多种含义塞进 429 不同）：429 只表示请求过快/动态并发限流；余额不足是 **402**、服务端过载是 **503**——这两个没有专属 SDK 异常类，在 `APIError` 分支里按 `err.status` 判断，别把它们并回笼统的通用报错
- 文件数量保护的阈值 **300 在两处**：前端 `App.jsx` 的 `LARGE_FILE_THRESHOLD`（超过先弹确认框）和 `ai.js` 解析失败时的提示判断（CJS/ESM 双模块体系无法共享常量），改阈值要两处同步

### 主进程窗口行为（electron/main.js）

- **无边框窗口**（2026-06 UI 升级）：mac 用 `titleBarStyle: 'hiddenInset'`（保留原生红绿灯），其他平台 `frame: false`（窗口控制按钮由渲染进程 WindowControls 自绘）。**逃生舱**：`HSF_NATIVE_FRAME=1` 启动即退回系统原生边框（某个 WM 下出问题时不用改代码）。Linux 上无 CSD 的窗口直角、无投影属合成器限制（VS Code 同此），**不要**用 `transparent: true` 兜底（禁用部分硬件加速、部分 WM 下边缘 resize 失效）；frame:false 下边缘拖拽 resize 是 Electron 自带的
- 窗口 `maximize`/`unmaximize` 事件推送 `window:maximized-changed` 给渲染进程换图标
- **非 mac 平台移除默认菜单栏**（`Menu.setApplicationMenu(null)`）：mac 必须保留——系统菜单承载 Cmd+C/V 等编辑快捷键，删掉会坏复制粘贴。副作用：Ctrl+R / Ctrl+Shift+I 等默认快捷键随菜单失效，开发要 DevTools 临时注释该行
- 窗口 `backgroundColor: '#0e0e10'`（与默认暗主题 --canvas **真正一致**，改 index.css 暗色底必须同步此处）+ `show: false` + `ready-to-show` 再显示：防启动白闪，别当成多余配置清理掉

### 打包与 CI

- electron-builder 配置在 `package.json` 的 `build` 字段（appId `com.pony9163.holy-sexy-folder-management`，产物输出 `release/`，图标 `build/icon.png`）；打包只收 `dist/**`、`electron/**`、`package.json`
- `build/icon.png` 已按 macOS 图标比例切圆角（半径 22.37%，1024px 下 229px，四角透明）；原始方形版在 git 历史里，重做圆角用 ImageMagick 黑底白圆角蒙版 + CopyOpacity（蒙版务必 `-fill white`，默认黑填充会把整图变全透明）
- **Linux deb 本地打**（`npm run dist`）；**mac dmg 只能走 CI**（本地是 Linux 构建不了 mac 产物）：`.github/workflows/build-mac.yml`，手动触发或推 `v*` 标签，在 macOS runner 上打 arm64 + x64 的 dmg，artifact 名 `mac-dmg`
- CI 里 `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` 是故意的：没有签名证书，跳过签名（产物未签名，用户需右键打开放行）；以后有 Developer ID 证书再接公证
- workflow 用的官方 actions 均为 v5（checkout/setup-node/upload-artifact），别降回 v4（Node 20 弃用警告）

### 前端

- Tailwind v4 走 `@tailwindcss/vite` 插件：**没有也不需要** `tailwind.config.js`/PostCSS 配置，主题系统全在 `src/index.css`
- **双主题机制**：`index.css` 用 `@custom-variant dark` 把暗色绑定到 html 的 `.dark` 类。App.jsx 的 theme state 是**三态** `system | light | dark`（localStorage `ui-theme` 持久化，默认 system），`system` 经 `matchMedia('(prefers-color-scheme: dark)')` 实时跟随系统明暗（Electron 渲染进程里它反映 nativeTheme/桌面配色，KDE Plasma 6 走 portal，无需 IPC）；落到 `.dark` 类的是派生值 `isDark`，顶栏按钮按 系统→亮→暗 循环（Monitor/Sun/Moon 图标显示当前态）；语义令牌（`--canvas/--surface/--sunken/--line/--ink/--ink-2/--ink-3/--accent`）经 `@theme inline` 注册成 Tailwind 颜色。**改样式用令牌类**（`bg-surface`、`text-ink-2`、`border-line` 等，一个类两主题通吃），不要写死 gray-xxx。**层级约定两主题一致：canvas < sunken < surface（由低到浮起）**——暗色 sunken 必须介于 canvas 和 surface 之间，曾经 sunken 比 surface 亮是层级倒置已修正，勿改回。图标用 lucide-react（行内 15-16、按钮 16-18），不要混回 emoji；顶栏按钮必须 `whitespace-nowrap`（中文被挤压会逐字竖排）
- **状态色走令牌**：`--success/--warning/--danger`（亮暗两套在 index.css），弱化形态用透明度修饰符（`bg-warning/10`、`border-danger/30`、`hover:bg-danger/10`），**不写 `dark:` 变体**（令牌随主题切换）；**实底 CTA 按钮一律 accent 蓝**（macOS 默认按钮惯例），绿色只用于成功反馈、琥珀只用于撤销/恢复类警示性次级按钮（半透明形态）。例外：WindowControls 关闭按钮 hover 固定 `#e81123` 红（窗口语义不是状态语义）
- **阴影分级**（index.css 注册成 `shadow-card/raised/modal`，亮暗两套、暗色更重）：card→卡片/表格容器/约束栏/聊天面板；raised→状态提示条；modal→弹窗。卡片同时保留 `border border-line` 发丝边
- **视觉气质：Apple 骨架 + 科技光效语言**（2026-06 动效升级，用户钦定全面科技风）：布局/圆角/字体/令牌沿用 Apple 系——accent 苹果蓝（亮 #0071e3 / 暗 #0a84ff，蓝底始终白字）、发丝边框、-apple-system 字体栈、sticky 毛玻璃顶栏（`bg-canvas/70 backdrop-blur-xl`）；圆角规范：按钮胶囊 rounded-full、卡片/表格/聊天面板 rounded-xl、弹窗 rounded-2xl，弹窗遮罩带 `backdrop-blur-sm`；约束栏用 App.jsx 内的 `Switch` 组件（iOS 拨动开关），方案 Tab 是 segmented control（凹槽 bg-sunken p-1 + 选中段 bg-surface 浮起 + glow-sm）；**数字一律 `tabular-nums`**；全局 `:focus-visible` accent 环和自定义滚动条在 index.css，别在组件里另写
- **动效系统**（index.css「动效系统」节，全部纯 CSS、只动 transform/opacity/背景位移，不引动画库）：
  - 入场：`animate-fade-in`（提示条/卡片/表格行）、`animate-spring-pop`（弹窗回弹，已全面取代弹窗上的 pop-in）、`animate-slide-in-right/left`（聊天气泡：用户从右、AI 从左）；列表 stagger 用 inline `animationDelay` 封顶套路（FileTable 行 25ms×15、方案卡片 40ms×6），fade-in 是 both 填充 delay 期间不闪现
  - 光效：`--glow-sm/md` 辉光令牌（亮暗两套，注册成 `shadow-glow-sm/md`）——**实底 accent 按钮 hover 用 glow-md，次级按钮/进度条/选中 Tab 用 glow-sm**；`.shimmer` 表面流光（分析中按钮、进度条填充带；它设 background-image，**别和 bg-gradient-* 同用**会互相覆盖）；`.scan-bar` 扫描线（分析中 header 底边）；`.border-flow` 流光边框常驻于弹窗、`.border-flow-hover` 悬停渐显于聊天面板——**有 overflow-hidden 的容器用不了**（伪元素被裁），卡片 hover 用 `hover:border-accent/40 + glow-sm` 替代
  - 背景：`.bg-tech-grid` 固定网格层（z-index:-1，网格漂移走 transform 合成器）；**根容器不再铺 bg-canvas**，页面底色挂在 html 上（改底色仍须同步 main.js backgroundColor），网格层夹在 html 底色与内容之间
  - 主题切换：明暗实际变化时走 View Transitions 圆形扩散（App.jsx cycleTheme：`.dark` 类必须在 startViewTransition 回调内同步切换 + flushSync，useEffect 重放同值幂等；API 不存在时直接切换兜底）；`::view-transition-*` 样式在 index.css
  - **`prefers-reduced-motion: reduce` 全局兜底必须保留**（动画压到 0.01ms）；整理弹窗三态 confirm→running→done 用 `key={phase}` 交叉淡入、方案 Tab 切换用 `key={activeIndex}` 重放卡片入场，别改回瞬切
- **header 即标题栏**（无边框窗口）：`app-drag` 整体拖拽 + 交互区 `app-no-drag`（两个工具类在 index.css），高 h-13；mac `pl-20` 给红绿灯留白，非 mac `pr-[150px]` 给 WindowControls（绝对定位贴右上，`!isMac && window.api.win` 才渲染）；双击最大化**仅 Linux** 绑 JS（mac/Windows 系统原生处理，再绑会双重切换）；平台标识 `window.api.platform` 模块级取一次
- `vite.config.js` 的 `base: './'` 是生产模式 `file://` 加载 dist 所必需的，别删
- 文件列表排序规则在 `FileTable.jsx`：文件夹在前，组内 `localeCompare(name, 'zh')`；文件夹的大小列显示 `—`
- 约束开关栏在 `App.jsx`：三个开关（不整理已有文件夹默认开/不动最近 7 天/排除扩展名），状态持久化到 localStorage（`organize-constraints-v1`）；App 用 useMemo 把 files 分成 `eligibleFiles`（发给 AI、传给 PlanPreview）和 `skippedEntries`（预览灰色区展示）；分析中或预览打开时整栏锁定，防止方案与约束不一致；PlanPreview 的 `resolvedFolders` 只认 fileMap 成员（不再特判 isDirectory，目录参与与否由 App 过滤决定）
- `PlanPreview.jsx`：三套方案按 Tab 切换，方案数组提升为本地 state `localPlans`（对话调整会改写当前方案的 folders；App 重新分析前先 setPlans(null) 卸载组件，故用 props 初始化安全）；排除集合和聊天历史都按方案独立（`plans.map(() => …)` 模式）；聊天调整成功后替换当前方案 folders 并**清空该方案的排除集合**（文件归属已变）；整理弹窗为三态状态机 confirm → running → done，发给主进程的 groups 由 `resolvedFolders` 过滤排除项得出（AI 幻觉文件名靠它的 fileMap 过滤兜底）
- `HistoryModal.jsx`：历史快照弹窗，四阶段（列表/confirm/running/done）；"连带撤销 N 次"的链条由前端用 `getHistory` 返回的摘要自行计算（同 folderPath、createdAt >= 目标、未撤销），与主进程 `restoreTo` 的链条定义保持一致——改一边必须同步另一边
- 整理/撤销/恢复完成后的列表刷新都走 handler 返回的 `files`（撤销/恢复要先比对返回的 `folderPath` 是否等于当前展示的文件夹）
