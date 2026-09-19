/* ==========================================================================
 * 目录（目录叶）派生
 * 纯函数、无 DOM 依赖。从「正文」结构生成「卷名 + 章名 + 章首页码」三级目录文本，
 * 文本走现有 paginate 流分页引擎渲染（与导读/正文/附录同机制）。
 * 页码由 store 侧的全书模拟分页算得后注入（见 stores/app.ts 的 computeTocText）。
 * ========================================================================== */

export interface TocVol {
  name?: string
  chapters: { title?: string; text?: string }[]
}

/** 带页码的目录输入：卷名 + 每章标题与所在页（1-based） */
export interface TocVolEntry {
  name?: string
  chapters: { title?: string; page: number }[]
}

/** 阿拉伯数字 -> 中文数字（与引擎 cn 同口径） */
function cn(n: number): string {
  n = Math.floor(n)
  if (n <= 0) return '〇'
  const d = '〇一二三四五六七八九'
  if (n < 10) return d[n]
  if (n < 20) return '十' + (n % 10 ? d[n % 10] : '')
  if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '')
  if (n < 1000) {
    const h = d[Math.floor(n / 100)], r = n % 100
    if (!r) return h + '百'
    if (r < 10) return h + '百〇' + d[r]
    return h + '百' + cn(r)
  }
  return String(n)
}

/**
 * 由卷文结构派生「无页码」目录文本（兼容旧调用 / 测试）。
 * 一级：# 目錄（目录扉题）
 * 二级：## 卷名（卷→章的逻辑分组名）
 * 三级内容：@章名（前导一格空白缩进，正文级）
 */
export function buildTocText(scrolls: TocVol[]): string {
  const lines: string[] = ['# 目錄']
  for (const vol of scrolls) {
    if (vol.name) lines.push('## ' + vol.name)   // 空卷名（默认卷）只跳过卷名行，章照列
    for (const ch of vol.chapters) {
      if (ch.title) lines.push('@' + ch.title)
    }
  }
  return lines.join('\n')
}

/**
 * 扫「卷文流」里的二级标题（`##` 且非 `###`），返回标题与它在文流中的字符位置。
 * 位置用于反查该标题落在哪一页（走 token._pos），故**必须与引擎同基准**：
 * 引擎分词前会把 `\r\n` 归一为 `\n`，这里也要先归一，否则偏移逐行累积错位、页码串页。
 * 返回的 `norm` 即归一后的文流，调用方拿它去分页，保证「文本」「位置」同源。
 */
export function scanTocHeadings(vtext: string): { titles: string[]; positions: number[]; norm: string } {
  const norm = (vtext || '').replace(/\r\n?/g, '\n')
  const titles: string[] = []
  const positions: number[] = []
  let acc = 0
  for (const line of norm.split('\n')) {
    if (/^##[^#]/.test(line)) {                        // ## 且下一字符不是 #（排除 ###）
      const t = line.slice(2).replace(/^\s+/, '').replace(/\s+$/, '')   // ## 后可无空格，两端 trim
      if (t) { titles.push(t); positions.push(acc) }   // 空标题（光秃 ##）不成条目
    }
    acc += line.length + 1                             // +1 = 行尾 \n
  }
  return { titles, positions, norm }
}

/**
 * 由「卷名 + 章名 + 章首页码」生成目录文本。
 * 行格式：@章名 + 分隔 + 页码。页码用中文数字（与古籍版心页码一致）。
 *
 * colend 为空 → 旧行为「@章名·页码」（页码紧跟章名）；
 * colend 给字符（引擎 template.tag_colend）→ 「@章名<colend>页码」，该标记让引擎把页码
 * 锚定到本列末端（目录项独占一列，页码即行尾对齐，中间留白）。
 */
export function buildTocTextWithPages(vols: TocVolEntry[], colend = ''): string {
  const lines: string[] = ['# 目錄']
  for (const vol of vols) {
    if (vol.name) lines.push('## ' + vol.name)   // 空卷名（默认卷）只跳过卷名行，章照列
    for (const ch of vol.chapters) {
      const t = ch.title || ''
      if (!t) continue
      const pg = cn(Math.max(1, ch.page | 0))
      lines.push(colend ? '@' + t + colend + pg : '@' + t + '·' + pg)
    }
  }
  return lines.join('\n')
}
