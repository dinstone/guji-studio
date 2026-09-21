/**
 * 编辑器的「包裹标记」扫描与删除守卫判定（纯函数，零依赖）。
 *
 * 背景：美化态把 `【】`（夹注）、`{}`（徽标）、`[]`（强调）的开/闭标记**隐藏**掉，只留内容样式，
 * 目的是让编辑器看起来接近书页。副作用是标记在文档里依然存在（不可见），用户按退格/删除时
 * 很容易只删掉其中一端 → **配对断裂**：内容退化成普通正文，另一端括号孤零零留在原处。
 *
 * 本模块只做判断，不做渲染，也不碰 CodeMirror：
 *   ① `scanWraps`  —— 按与渲染**完全相同**的正则口径扫出配对，以及**落单**（有字符、无装饰）的标记；
 *   ② `hiddenMask` / `skipDeleteFor` —— 美化态删除的**落点重定位**（主策略，见下）；
 *   ③ `partnerOf` / `pairDeleteFor` —— 非空选区的兜底：算出应**连带删除**的配对标记。
 *
 * 主策略（2026-09-21 依用户反馈定）：**跳过，而不是连带删**。标记既然看不见，退格就该作用在
 * 看得见的字上——否则用户按一下退格，样式突然变了（上一版「两端一起删 = 取消标记」的行为），
 * 比删断更难理解。代价是美化态下删不掉标记本身，要精确操作标记需切源码态。
 * 口径唯一是硬要求：守卫与装饰若各扫一套，就会出现「装饰认得的对，守卫不认」的鬼故事。
 */

export type WrapKind = 'comment' | 'badge' | 'emph'

export interface Wrap {
  kind: WrapKind
  /** 开标记字符的下标 */
  open: number
  /** 闭标记字符的下标 */
  close: number
}

/** 三类包裹标记。顺序 = 装饰顺序 = 扫描顺序（改这里即改全部）。 */
export const WRAP_DEFS: ReadonlyArray<{ kind: WrapKind; open: string; close: string }> = [
  { kind: 'comment', open: '【', close: '】' },
  { kind: 'badge', open: '{', close: '}' },
  { kind: 'emph', open: '[', close: ']' },
]

/** 独立控制符（无配对，美化态一并隐藏）：删掉它们不会破坏结构，无需守卫。 */
export const LONE_MARKS = '@%$&~'

export interface ScanResult {
  wraps: Wrap[]
  /** 落单标记字符的下标（升序）：它们没有配对，美化态会高亮成警告，而不是静默隐藏 */
  orphans: number[]
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 整篇扫描（允许跨行，与 editorDeco 的 wrapFull 同口径）：
 * 开标记、非贪婪内容、闭标记三者匹配成对；未被任何一对吃掉的标记字符记为落单。
 *
 * 注意交叉的情形（如 `[a[bc]d]`）：正则非贪婪配到 `[a[bc]` 一对，末尾 `]` 成为落单——
 * 这正是装饰层的实际行为，守卫必须照抄，不能"更聪明"。
 */
export function scanWraps(doc: string): ScanResult {
  const wraps: Wrap[] = []
  const usedOpen = new Set<number>()
  const usedClose = new Set<number>()
  for (const d of WRAP_DEFS) {
    const re = new RegExp(`([${esc(d.open)}])([^${esc(d.close)}]*?)([${esc(d.close)}])`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(doc))) {
      const open = m.index
      const close = m.index + m[0].length - 1
      wraps.push({ kind: d.kind, open, close })
      usedOpen.add(open)
      usedClose.add(close)
    }
  }
  const orphans: number[] = []
  for (const d of WRAP_DEFS) {
    for (let i = 0; i < doc.length; i++) {
      if (doc[i] === d.open && !usedOpen.has(i)) orphans.push(i)
      else if (doc[i] === d.close && !usedClose.has(i)) orphans.push(i)
    }
  }
  orphans.sort((a, b) => a - b)
  return { wraps, orphans }
}

/** 下标 i 处标记字符的配对标记下标；i 不是「已配对」的标记则返回 null（落单标记也算 null）。 */
export function partnerOf(doc: string, i: number): number | null {
  for (const w of scanWraps(doc).wraps) {
    if (w.open === i) return w.close
    if (w.close === i) return w.open
  }
  return null
}

/**
 * 美化态的「隐形字符」掩码——**必须与 editorDeco 的隐藏口径逐字一致**：
 *   - 隐形 = 已配对包裹标记的开/闭字符 + 独立控制符 `@ % $ & ~`；
 *   - 落单标记**不算**隐形（美化态给它们染警示色，是可见的）。
 */
export function hiddenMask(doc: string): { hidden: boolean[]; wraps: Wrap[] } {
  const { wraps } = scanWraps(doc)
  const hidden: boolean[] = new Array(doc.length).fill(false)
  for (let i = 0; i < doc.length; i++) if (LONE_MARKS.indexOf(doc[i]) >= 0) hidden[i] = true
  for (const w of wraps) { hidden[w.open] = true; hidden[w.close] = true }
  return { hidden, wraps }
}

export type DeleteDir = 'backward' | 'forward'

/**
 * 美化态的删除落点。三种语义分开命名，便于断言与排查：
 *   - `skip`   跳过隐形标记，改删同侧**可见**字符（退格删左侧、Delete 删右侧）；
 *   - `unwrap` 该对标记内部已无可见内容 → 视为「取消这个标记」，整对删掉（内容本来就是空）；
 *   - `none`   已接管，但同侧没有可删的可见字符 → 什么也不做（等价于文档开头的默认 no-op）。
 */
export type SkipPlan =
  | { kind: 'skip'; from: number; to: number }
  | { kind: 'unwrap'; from: number; to: number }
  | { kind: 'none' }

/**
 * 判定：**美化态**下这次删除（区间 `[from, to)`，文档坐标）该落在哪里？
 *
 * 用户要的语义是「看不见的字符不该被一次退格吃掉」（太容易误会成『删了内容』）。
 * 所以只要待删区间**整个都是隐形字符**，就接管并重新定位落点；返回 null = 不接管。
 *
 * 规则：
 *   ① 区间里只要出现一个可见字符就 return null —— 那是用户在删内容，交回默认命令；
 *   ② 命中某对标记、且对内已无可见字符 → `unwrap`（整对删掉，等于取消该标记）；
 *   ③ 其余情况沿删除方向跨过连续隐形字符，删紧邻的可见字符 → `skip`；到文档首/尾则 `none`。
 */
export function skipDeleteFor(doc: string, from: number, to: number, dir: DeleteDir): SkipPlan | null {
  const a = Math.max(0, from)
  const b = Math.min(doc.length, to)
  if (a >= b) return null
  const { hidden, wraps } = hiddenMask(doc)
  for (let i = a; i < b; i++) if (!hidden[i]) return null          // ①
  for (const w of wraps) {                                          // ②
    if (!((w.open >= a && w.open < b) || (w.close >= a && w.close < b))) continue
    let empty = true
    for (let i = w.open + 1; i < w.close; i++) if (!hidden[i]) { empty = false; break }
    if (empty) return { kind: 'unwrap', from: w.open, to: w.close + 1 }
  }
  if (dir === 'backward') {                                         // ③
    let j = a
    while (j > 0 && hidden[j - 1]) j--
    return j === 0 ? { kind: 'none' } : { kind: 'skip', from: j - 1, to: j }
  }
  let j = b
  while (j < doc.length && hidden[j]) j++
  return j >= doc.length ? { kind: 'none' } : { kind: 'skip', from: j, to: j + 1 }
}

/**
 * 兜底判定（**非空选区**才走，如剪切/拖选删除）：这次删除会不会把某个包裹标记拆散？
 * 返回**应连带删除的配对标记下标**；不该干预则返回 null。
 *
 * 规则（故意保守）：
 *   - 区间里恰好含某个标记的**一端**，且不含它的配对 → 两端一起删（= 取消该标记，内容保留）；
 *   - 其余一律返回 null 交回默认实现：没碰标记 / 整对都在区间内（如整段选中删除）/
 *     一次吃掉多对的标记 / 删的是落单标记（删掉它正好是修复）。
 */
export function pairDeleteFor(doc: string, from: number, to: number): number | null {
  const hit: number[] = []
  for (let i = Math.max(0, from); i < Math.min(to, doc.length); i++) {
    const ch = doc[i]
    for (const d of WRAP_DEFS) {
      if (ch === d.open || ch === d.close) { hit.push(i); break }
    }
  }
  if (hit.length !== 1) return null
  const partner = partnerOf(doc, hit[0])
  if (partner == null) return null
  if (partner >= from && partner < to) return null
  return partner
}
