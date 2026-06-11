// Kimi API 调用模块（运行在 Electron 主进程）
// 职责：把文件清单发给 Kimi，让它返回 JSON 格式的文件分类方案
// （一次分析返回三套思路不同的方案；也支持按用户对话要求调整某套方案）。
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

// 系统提示词：约束 Kimi 一次返回三套思路不同的 JSON 分类方案
const SYSTEM_PROMPT = `你是文件整理专家。根据文件清单，设计恰好 3 套思路明显不同的分类方案。
返回严格的 JSON 格式：
{ "plans": [ { "name": "方案名", "folders": [ { "name": "分类名", "files": ["文件名1", "文件名2"], "reason": "为什么这样分" } ] } ] }
三套方案的建议角度（可按清单实际情况发挥，但必须互相区分）：
1. 按文件类型分（如"图片""文档""安装包""压缩包""视频"）；
2. 按主题或项目分（如果文件名有明显规律）；
3. 混合或其他合理思路。
每套方案的 name 不超过 6 个字、能概括该套思路（如"按类型分类"），三套 name 不得重复。
分类要符合普通人直觉。不允许返回 JSON 以外的任何文字。`

// 对话调整的系统提示词：基于当前方案 + 用户要求，改写出新方案
const ADJUST_SYSTEM_PROMPT = `你是文件整理专家。用户已有一套文件分类方案，会用自然语言提出调整要求（如合并分类、改名、新建分类、挪动某些文件）。
你要在保留用户未提及部分的前提下，按要求改写方案。只能使用文件清单里实际存在的文件名。
返回严格的 JSON 格式：{ "reply": "一句话中文说明你改了什么", "folders": [ { "name": "分类名", "files": ["文件名1"], "reason": "为什么这样分" } ] }
folders 必须是调整后的完整方案（不是增量）。不允许返回 JSON 以外的任何文字。`

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
 * 剥掉模型偶尔包的 ```json 代码栅栏后 JSON.parse。
 * 系统提示词要求只返回 JSON，这里是兜底。
 */
function parseJson(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  return JSON.parse(cleaned)
}

/**
 * 从 Kimi 的回复文本中解析出多套分类方案。
 * 校验 plans 是非空数组、每套有 folders 数组；
 * 方案名缺失或重复时回退为「方案一/二/三」——前端 Tab 的 key 用的是方案名，必须唯一。
 */
function parsePlans(text) {
  const data = parseJson(text)
  if (!Array.isArray(data.plans) || data.plans.length === 0) {
    throw new Error('返回的 JSON 缺少 plans 数组')
  }
  const fallbackNames = ['方案一', '方案二', '方案三', '方案四', '方案五']
  const usedNames = new Set()
  const plans = data.plans.map((plan, i) => {
    if (!Array.isArray(plan.folders)) {
      throw new Error(`第 ${i + 1} 套方案缺少 folders 数组`)
    }
    let name = typeof plan.name === 'string' ? plan.name.trim() : ''
    if (!name || usedNames.has(name)) {
      name = fallbackNames[i] || `方案${i + 1}`
    }
    usedNames.add(name)
    return { name, folders: plan.folders }
  })
  return plans
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
 * 流式调用 Kimi 并收集完整回复文本。
 * 每收到一段就调用 onProgress(已接收字符数)，供 UI 展示进度。
 * analyzeFiles 和 adjustPlan 共用，失败时抛出翻译后的中文 Error。
 */
async function streamCompletion(messages, onProgress) {
  const client = new OpenAI({ apiKey: resolveApiKey(), baseURL: BASE_URL })

  let text = ''
  try {
    const stream = await client.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 16000,
      stream: true,
      messages,
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
  return text
}

/**
 * 调用 Kimi 分析文件清单，返回三套分类方案：
 * [ { name: 方案名, folders: [ { name, files: [...], reason } ] } ]
 * 失败时抛出带中文说明的 Error。
 */
async function analyzeFiles(files, onProgress) {
  const text = await streamCompletion(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `文件清单（文件名 | 类型 | 大小 | 修改日期）：\n${buildFileList(files)}` },
    ],
    onProgress,
  )

  try {
    return parsePlans(text)
  } catch (err) {
    throw new Error(`无法解析 Kimi 返回的 JSON：${err.message}`)
  }
}

/**
 * 按用户的自然语言要求调整一套分类方案。
 * - files：文件清单（与 analyzeFiles 相同结构），让模型知道有哪些文件可分
 * - plan：当前方案的 folders 数组
 * - history：对话历史 [{ role: 'user'|'assistant', content }]，最后一条是用户的新要求；
 *   assistant 历史是上一轮返回的原始 JSON 文本，保证模型能看到自己上次的输出
 * 返回 { reply: 中文说明, folders: 调整后的完整方案, raw: 原始回复文本（供下一轮历史用） }
 */
async function adjustPlan({ files, plan, history }, onProgress) {
  const text = await streamCompletion(
    [
      { role: 'system', content: ADJUST_SYSTEM_PROMPT },
      {
        role: 'user',
        content:
          `文件清单（文件名 | 类型 | 大小 | 修改日期）：\n${buildFileList(files)}\n\n` +
          `当前分类方案 JSON：\n${JSON.stringify({ folders: plan }, null, 2)}`,
      },
      ...history,
    ],
    onProgress,
  )

  let data
  try {
    data = parseJson(text)
    if (!Array.isArray(data.folders)) {
      throw new Error('返回的 JSON 缺少 folders 数组')
    }
  } catch (err) {
    throw new Error(`无法解析 Kimi 返回的 JSON：${err.message}`)
  }
  return {
    reply: typeof data.reply === 'string' && data.reply.trim() ? data.reply.trim() : '已按要求调整',
    folders: data.folders,
    raw: text,
  }
}

module.exports = { analyzeFiles, adjustPlan, testApiKey }
