// Kimi API 调用模块（运行在 Electron 主进程）
// 职责：把文件清单发给 Kimi，让它返回一个 JSON 格式的文件分类方案。
//
// 为什么放在主进程而不是页面里：
// 1. API Key 由 keyStore 管理（系统级加密存储），只有主进程能读到
// 2. 密钥绝不能暴露给渲染进程/页面代码
const OpenAI = require('openai')
const keyStore = require('./keyStore')

// Moonshot 提供 OpenAI 兼容接口，用 openai SDK 指向其 baseURL 调用
const BASE_URL = 'https://api.moonshot.cn/v1'

// 使用的模型。选型依据（2026-06 实测，6 文件清单）：
// - moonshot-v1-auto ≈ 3.7s；kimi-k2.6 / k2.5 是思考型模型，≈ 30s（大部分时间在生成用不到的推理过程）
// - auto 会按输入长度自动选 8k/32k/128k 上下文，文件很多时也不会超限
const MODEL = 'moonshot-v1-auto'

// 系统提示词：约束 Kimi 只返回严格的 JSON 分类方案
const SYSTEM_PROMPT = `你是文件整理专家。根据文件清单，设计一个分类方案。
返回严格的 JSON 格式：{ "folders": [ { "name": "分类名", "files": ["文件名1", "文件名2"], "reason": "为什么这样分" } ] }
分类要符合普通人直觉（如"图片""文档""安装包""压缩包""视频"），
也可以按项目或主题分（如果文件名有明显规律）。
不允许返回 JSON 以外的任何文字。`

/**
 * 把字节数格式化为可读文本（主进程不能直接复用 src/ 下的 ESM 前端代码，故内联一份）
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = -1
  do {
    value /= 1024
    i++
  } while (value >= 1024 && i < units.length - 1)
  return `${value.toFixed(1)} ${units[i]}`
}

/**
 * 把文件列表格式化为发给 Kimi 的文本清单，每行一个文件：
 * 文件名 | 类型 | 大小 | 修改日期
 */
function buildFileList(files) {
  return files
    .map((f) => {
      const size = f.isDirectory ? '—' : formatSize(f.size)
      const date = new Date(f.mtime).toISOString().slice(0, 10)
      return `${f.name} | ${f.type} | ${size} | ${date}`
    })
    .join('\n')
}

/**
 * 从 Kimi 的回复文本中解析出分类方案 JSON。
 * 系统提示词要求只返回 JSON，但模型偶尔仍会包一层 ```json 代码栅栏，先剥掉再解析。
 */
function parsePlan(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  const plan = JSON.parse(cleaned)
  if (!Array.isArray(plan.folders)) {
    throw new Error('返回的 JSON 缺少 folders 数组')
  }
  return plan
}

/**
 * 取当前可用的 API Key：用户在应用内设置的优先，环境变量作为开发者备选。
 * 没有则抛出引导用户去设置的错误。
 */
function resolveApiKey() {
  const key = keyStore.loadKey() || process.env.MOONSHOT_API_KEY
  if (!key) {
    throw new Error('未设置 API Key，请点击右上角 ⚙️ 设置')
  }
  return key
}

/**
 * 把 SDK 的类型化异常翻译成对用户友好的中文 Error。
 */
function translateError(err) {
  if (err instanceof OpenAI.AuthenticationError) {
    return new Error('API Key 无效或已被撤销，请检查后重新设置')
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new Error('请求过于频繁，请稍后再试')
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new Error('无法连接到 Kimi API，请检查网络')
  }
  if (err instanceof OpenAI.APIError) {
    return new Error(`Kimi API 错误（${err.status}）：${err.message}`)
  }
  return err
}

/**
 * 验证一个 API Key 是否有效。
 * 用 models.list 接口：只查模型列表，不产生任何 token 消耗。
 * 有效则正常返回，无效/网络错误抛出中文 Error。
 */
async function testApiKey(rawKey) {
  // 不传 rawKey 时测试当前已保存的密钥
  const key = rawKey ? String(rawKey).trim() : resolveApiKey()
  const client = new OpenAI({ apiKey: key, baseURL: BASE_URL })
  try {
    await client.models.list()
  } catch (err) {
    throw translateError(err)
  }
}

/**
 * 调用 Kimi 分析文件清单，返回解析后的分类方案对象：
 * { folders: [ { name, files: [...], reason } ] }
 * 流式接收回复；每收到一段就调用 onProgress(已接收字符数)，供 UI 展示进度。
 * 失败时抛出带中文说明的 Error。
 */
async function analyzeFiles(files, onProgress) {
  const client = new OpenAI({ apiKey: resolveApiKey(), baseURL: BASE_URL })

  let text = ''
  try {
    const stream = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 16000,
      stream: true,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `文件清单（文件名 | 类型 | 大小 | 修改日期）：\n${buildFileList(files)}` },
      ],
    })
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) {
        text += delta
        if (onProgress) onProgress(text.length)
      }
    }
  } catch (err) {
    throw translateError(err)
  }

  if (!text) {
    throw new Error('Kimi 没有返回文本内容')
  }

  try {
    return parsePlan(text)
  } catch (err) {
    throw new Error(`无法解析 Kimi 返回的 JSON：${err.message}`)
  }
}

module.exports = { analyzeFiles, testApiKey }
