// API 密钥安全存取模块（仅主进程使用）
//
// 安全设计：
// - 用 Electron 内置 safeStorage 做操作系统级加密（macOS Keychain / Windows DPAPI / Linux libsecret）
//   后再落盘，文件权限 0600，存放在应用的 userData 目录
// - Linux 上没有系统密钥环时 safeStorage 不可用 → 密钥只保存在内存中（本次会话有效，不落盘明文）
// - 本模块绝不向外暴露完整密钥（getStatus 只返回末 4 位掩码）；调用方也不应打印密钥
const { app, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')

// 加密后的密钥文件路径（userData 是各平台标准的应用数据目录）
function keyFilePath() {
  return path.join(app.getPath('userData'), 'api-key.enc')
}

// 内存缓存：避免每次调用都读盘解密；加密不可用时这是唯一的保存位置
let cachedKey = null

/**
 * 校验密钥格式：trim 后必须以 sk- 开头且不含空白字符（Moonshot 密钥格式）。
 * 返回清洗后的密钥，不合法时抛错。
 */
function normalizeKey(rawKey) {
  const key = String(rawKey || '').trim()
  if (!key.startsWith('sk-')) {
    throw new Error('密钥格式不正确：应以 sk- 开头')
  }
  if (/\s/.test(key)) {
    throw new Error('密钥格式不正确：不能包含空格或换行')
  }
  return key
}

/**
 * Linux 上 safeStorage 可能退化为 basic_text（用硬编码密钥混淆，非真加密）。
 * 返回 true 表示当前是弱加密后端，UI 应提示用户。
 */
function isWeakBackend() {
  // getSelectedStorageBackend 仅 Linux 存在；其他平台视为强后端
  return (
    typeof safeStorage.getSelectedStorageBackend === 'function' &&
    safeStorage.getSelectedStorageBackend() === 'basic_text'
  )
}

/**
 * 保存密钥。
 * - 加密可用：加密后写入文件（0600），并更新内存缓存 → { persisted: true }
 * - 加密不可用：只存内存，本次会话有效 → { persisted: false }
 */
function saveKey(rawKey) {
  const key = normalizeKey(rawKey)
  cachedKey = key

  if (!safeStorage.isEncryptionAvailable()) {
    // 不落盘明文 —— 宁可让用户每次重新输入，也不在磁盘上留明文密钥
    return { persisted: false }
  }

  const encrypted = safeStorage.encryptString(key)
  fs.writeFileSync(keyFilePath(), encrypted, { mode: 0o600 })
  return { persisted: true }
}

/**
 * 读取密钥：内存缓存优先，其次读文件解密。
 * 解密失败（文件损坏 / 系统密钥环变更）时删除坏文件并返回 null。
 * 没有配置时返回 null。
 */
function loadKey() {
  if (cachedKey) return cachedKey

  const file = keyFilePath()
  if (!fs.existsSync(file)) return null
  if (!safeStorage.isEncryptionAvailable()) return null

  try {
    cachedKey = safeStorage.decryptString(fs.readFileSync(file))
    return cachedKey
  } catch {
    // 解不开的文件留着没有意义，删掉让用户重新设置
    try { fs.unlinkSync(file) } catch { /* 忽略删除失败 */ }
    return null
  }
}

/**
 * 删除密钥：清内存缓存 + 删除加密文件。
 */
function deleteKey() {
  cachedKey = null
  try { fs.unlinkSync(keyFilePath()) } catch { /* 文件不存在时忽略 */ }
}

/**
 * 返回给渲染进程的状态（绝不包含完整密钥）：
 * - configured：是否已配置
 * - persisted：是否已加密落盘（false = 仅本次会话有效）
 * - encryptionAvailable / weakBackend：供 UI 显示安全提示
 * - maskedKey：形如 "sk-…f3Kq"，只含末 4 位
 */
function getStatus() {
  const key = loadKey()
  return {
    configured: key !== null,
    persisted: key !== null && fs.existsSync(keyFilePath()),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    weakBackend: isWeakBackend(),
    maskedKey: key ? `sk-…${key.slice(-4)}` : null,
  }
}

module.exports = { saveKey, loadKey, deleteKey, getStatus }
