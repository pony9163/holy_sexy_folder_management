// 格式化工具函数：把原始数字转成适合界面展示的文本

/**
 * 把字节数格式化为可读的大小文本，如 1536 → "1.5 KB"
 * @param {number} bytes 字节数
 * @returns {string}
 */
export function formatSize(bytes) {
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
 * 把毫秒时间戳格式化为本地日期时间，如 "2026/06/10 14:30"
 * @param {number} ms 毫秒时间戳
 * @returns {string}
 */
export function formatDate(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
