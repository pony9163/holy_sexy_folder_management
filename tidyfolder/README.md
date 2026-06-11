# 📂 holy_sexy_folder_management

一个用 **Electron + React + Tailwind CSS** 构建的桌面小工具：选择一个文件夹，列出其**第一层**所有文件和子文件夹的名称、类型、大小和修改日期（不递归进入子文件夹），并可调用 **Claude API** 生成智能分类方案。

## 运行步骤

```bash
# 1. 进入项目目录
cd tidyfolder

# 2. 安装依赖（首次需要下载 Electron 二进制，可能较慢）
npm install

# 3. 启动开发模式：同时启动 Vite 开发服务器和 Electron 窗口
npm run dev
```

窗口弹出后，点击右上角「选择文件夹」按钮即可浏览文件。

要使用「✨ 分析」功能，点右上角 **⚙️ 设置**，填入你的 Anthropic API Key（在 platform.claude.com 生成，`sk-ant-` 开头），可点「测试连接」验证（不消耗 token）。

> 开发者备选：也可以用环境变量 `export ANTHROPIC_API_KEY=sk-ant-...` 再启动，应用内设置的密钥优先级更高。

## ✨ 分析功能（Claude API）

选好文件夹后点「分析」按钮，应用会把文件清单（文件名、类型、大小、修改日期）发给 Claude（模型 `claude-sonnet-4-6`），由它返回一个 JSON 分类方案：

```json
{ "folders": [ { "name": "图片", "files": ["a.png", "b.jpg"], "reason": "常见图片格式" } ] }
```

当前阶段结果通过 `console.log` 打印在两个地方：
- 运行 `npm run dev` 的**终端**（主进程打印）
- Electron 窗口的 **DevTools 控制台**（Ctrl+Shift+I 打开）

## 🔒 API Key 安全设计

- **加密存储**：密钥用 Electron `safeStorage`（macOS Keychain / Windows DPAPI / Linux libsecret）做操作系统级加密后存在本机 `userData/api-key.enc`，文件权限 600
- **Linux 注意**：需要系统密钥环（gnome-keyring 或 kwallet）才能持久化；没有密钥环时密钥只保存在内存中，本次运行有效，界面会明确提示
- **不暴露给页面**：密钥只在保存时单向传入主进程；状态查询只返回末 4 位掩码（如 `sk-ant-…f3Kq`），渲染进程拿不到完整密钥
- **不进日志**：终端和 DevTools 的任何输出都不包含密钥
- **可彻底删除**：设置弹窗里的「删除密钥」会清除内存缓存并删除加密文件
- **只发往官方**：调用时密钥仅用于直连 Anthropic 官方接口 `api.anthropic.com`，不经任何中转

## 项目结构

```
tidyfolder/
├── package.json          # 依赖与脚本，"main" 指向 Electron 主进程
├── vite.config.js        # Vite 配置（React + Tailwind 插件）
├── index.html            # 页面入口
├── electron/
│   ├── main.js           # 主进程：创建窗口、弹文件夹对话框、读取目录第一层
│   └── preload.js        # 安全桥：向页面暴露 window.api.selectFolder()
└── src/
    ├── main.jsx          # React 挂载入口
    ├── index.css         # 引入 Tailwind
    ├── App.jsx           # 主界面（按钮 + 状态管理）
    ├── components/
    │   └── FileTable.jsx # 文件列表表格
    └── utils/
        └── format.js     # 大小/日期格式化工具
```

## 工作原理

1. 页面（渲染进程）调用 `window.api.selectFolder()`（由 `preload.js` 暴露）
2. 主进程收到 IPC 请求，用 `dialog.showOpenDialog` 弹出系统文件夹选择框
3. 主进程用 `fs.readdir`（不递归）+ `fs.stat` 读取第一层条目信息并返回
4. React 把结果渲染成表格；文件夹排在前面，大小列显示「—」

## 其他命令

```bash
npm run build   # 构建生产版前端到 dist/
npm start       # 用已构建的 dist/ 直接启动 Electron（需先 build）
```
