/* 导出光栅化前，把用到的字体二进制内联成 SVG 内的 @font-face。
 *
 * 为什么必须内联：
 *   rasterizeSvg 把 SVG 交给 new Image() 再 drawImage 到 canvas。此刻 SVG 是**独立图片文档**——
 *   继承不到宿主文档的 @font-face，也不允许从外部 url 拉字体，于是自定义字体整族回退成系统
 *   默认宋体（「宋体·简」）。竖排标点走 foreignObject + writing-mode:vertical-rl，字形一旦换族，
 *   直角引号立刻变弯引号，连正文笔画也跟着变。这正是预览正常、导出变样的根因。
 *   （已验证 src:local() 在 WKWebView 的 SVG 图片文档里无效，data: URI 是唯一可用来源。）
 *
 * 做法：
 *   后端按族名定位字体文件、分块回传（Wails 单条 IPC 有体积上限），前端拼回 base64，
 *   在 SVG 内生成 @font-face，并把 SVG 里的 font-family 首项换成本文档定义的别名。
 *   同一族名在会话内只取一次二进制，@font-face 声明复用。
 *
 * 已知代价：整字体 base64 会让每叶 SVG 膨胀（3~5MB 级别的大字体尤其明显）。
 * 需要瘦身时，可在此处按「本叶实际出现的字符」做字形子集再内联——不可直接换用
 * 外部 url 或 local()，两条在图片文档里都不生效。
 */

import * as plat from '../platform/wails'

/* 通用族名：内联无意义（图片文档里本来就没有，且命中默认字体更接近现状），跳过。 */
const GENERIC = new Set(['', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif'])

/** 别名前缀：@font-face 的 font-family 名字用引号包裹，故族名可原样带进来，只加 ASCII 前缀防撞名。 */
function aliasOf(family: string): string {
  return 'GujiEmbed-' + family.replace(/["'\\]/g, '')
}

/* 单字体体积闸门（原始字节）：超过就放弃内联，保持原有回退行为。 */
const MAX_FONT_BYTES = 6 * 1024 * 1024

const binCache = new Map<string, string>()  // 族名 → 完整 base64 二进制
const faceCache = new Map<string, string>() // 族名 → @font-face 声明（可安全复用到任意叶）

async function faceFor(family: string): Promise<string | null> {
  if (faceCache.has(family)) return faceCache.get(family)!
  try {
    if (!binCache.has(family)) {
      const blob = await plat.openFont(family)
      if (!blob || !blob.size) return null
      /* 体积闸门：整字体 base64 会让**每一叶**都膨胀这么多。系统里动辄十几 MB 的大字体
       * 内联后导出会慢到不可用，宁可保持现状也不拖垮整次导出。 */
      if (blob.size > MAX_FONT_BYTES) return null
      let s = ''
      for (let i = 0; i < blob.chunks; i++) s += await plat.readFontChunk(family, i)
      binCache.set(family, s)
    }
    const b64 = binCache.get(family)!
    /* 必须用 <style> 包裹：直接把 @font-face 塞进 <svg> 会被当成 XML 文本节点照着画出来，
     * 既污染版面，图片文档里也更可能整块丢弃这条声明。 */
    const face = `<style>@font-face{font-family:"${aliasOf(family)}";src:url(data:font/ttf;base64,${b64}) format("truetype");}</style>`
    faceCache.set(family, face)
    return face
  } catch {
    return null // 取不到就维持现状，不阻断导出
  }
}

/** 把 @font-face 插进 SVG：有 <style> 就并进去，否则紧跟根 <svg>。 */
function inject(svg: string, face: string): string {
  const st = svg.match(/<style\b[^>]*>/i)
  if (st) return svg.slice(0, st.index! + st[0].length) + face + svg.slice(st.index! + st[0].length)
  const root = svg.match(/<svg\b[^>]*>/i)
  if (!root) return svg
  return svg.slice(0, root.index! + root[0].length) + face + svg.slice(root.index! + root[0].length)
}

/* 引擎输出里 font-family 有两种写法，必须都覆盖：
 *   ① XML 属性：      font-family="FZ...,serif"
 *   ② style 属性内的 CSS 声明：font-family:'FZ...,serif';font-size:90px
 * ② 的边界是 ; 或 "，族名本身可含逗号与空格，故按引号状态机切分而非简单 split(',')。 */
const FAM_RE = /font-family=(["'])((?:(?!\1)[^>])*)\1|font-family:([^;"]*)/g

function parseStack(raw: string): string[] {
  const out: string[] = []
  let cur = '', q = ''
  for (const c of raw) {
    if (q) { if (c === q) q = ''; else cur += c }
    else if (c === '"' || c === "'") q = c
    else if (c === ',') { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  out.push(cur.trim())
  return out.filter(Boolean)
}

/** 扫描 SVG 里每处 font-family 的**首项**族名（去重，保持出现顺序）。
 *  只取首项：引擎把「用户选的字体 + 一串系统 fallback」拼成单个栈（familyStack），
 *  若把 fallback 里的系统族也内联，等于给每叶塞进六七份字体，纯属浪费。 */
function scanFamilies(svg: string): string[] {
  const fams: string[] = []
  FAM_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FAM_RE.exec(svg))) {
    const head = parseStack(m[2] ?? m[3] ?? '')[0]
    if (head && !fams.includes(head)) fams.push(head)
  }
  return fams
}

/** 把 font-family 栈里的内联族换成别名；首项不是内联族则原样返回。 */
function swap(raw: string, inline: Set<string>): string | null {
  const parts = parseStack(raw)
  if (!parts.length || !inline.has(parts[0])) return null
  const out = parts.map((p, i) => (i === 0 && inline.has(p) ? aliasOf(p) : p))
  return out.join(',')
}

/** 内联 SVG 里出现的所有非通用字体；内联失败的族保持原样。 */
export async function embedFonts(svg: string): Promise<string> {
  const fams = scanFamilies(svg).filter(f => !GENERIC.has(f.toLowerCase()))
  if (!fams.length) return svg

  /* 只有**真的拿到字体二进制**的族才允许改名：若某族取失败却照样改写成别名，
   * 文档里就没有对应 @font-face，那些字会整片消失——比回退系统字体严重得多。 */
  const inline = new Set<string>()
  const faces: string[] = []
  for (const f of fams) {
    const r = await faceFor(f)
    if (r) { faces.push(r); inline.add(f) }
  }
  if (!faces.length) return svg

  const sub = (m: string, q: string | undefined, raw: string) => {
    const s = swap(raw, inline)
    return s == null ? m : `font-family=${q ?? ''}${s}${q ?? ''}`
  }
  let out = svg.replace(/font-family=(["'])((?:(?!\1)[^>])*)\1/g,
    (m, q: string, raw: string) => sub(m, q, raw))
  out = out.replace(/font-family:([^;"]*)/g, (m, raw: string) => sub(m, undefined, raw))

  return faces.reduce((acc, face) => inject(acc, face), out)
}
