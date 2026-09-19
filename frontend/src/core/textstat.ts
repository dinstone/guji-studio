/* 编辑器状态栏用的文本统计（纯函数，可 node 探针直接验证）。
 *
 * 「字数」口径：**不计空白与排版标记**——正文里的 # @ % $ ^ 与成对括号（【】{}[]）是排版语法、
 * 不会出现在成书里，算进字数会让人对不上。夹注方括号内的文字是内容，照常计入。
 * 按码点计数（`[...s]`），代理对（罕见字/emoji）算一个字，不按 UTF-16 长度。
 */

/** 排版标记字符：# 标题 / @ 占格 / % 换页 / $ 半页 / ^ 注音 / ~ 列尾对齐，以及成对括号 */
const MARKUP_RE = /[#@%$^~【】{}[\]]/g

/** 正文字数（不含空白与排版标记） */
export function countChars(text: string): number {
  if (!text) return 0
  return [...text.replace(/\s+/g, '').replace(MARKUP_RE, '')].length
}

/** 行数（与 CodeMirror doc.lines 同口径：末尾换行算一行） */
export function countLines(text: string): number {
  if (!text) return 1
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/* ---- 跨章求和缓存 ----
 * 全书字数要在每次按键后重算；逐章 countChars 会随书的规模变慢（几百章时每次按键扫全书）。
 * 这里按「章对象 → 上次文本 + 结果」缓存：只有被改动的那一章文本会变（`===` 值比较，长度不同时 O(1)），
 * 其余章直接取缓存。章对象被替换（重新打开项目）后旧条目由 WeakMap 自动回收。 */
const memo = new WeakMap<object, { t: string; n: number }>()

/** countChars 的带缓存版本；key 用稳定的对象（如章对象），text 为当前正文 */
export function cachedChars(key: object, text: string): number {
  const t = text || ''
  const hit = memo.get(key)
  if (hit && hit.t === t) return hit.n
  const n = countChars(t)
  memo.set(key, { t, n })
  return n
}

/** 千分位（1234567 → 1,234,567）；状态栏数字可读性用 */
export function groupNum(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
