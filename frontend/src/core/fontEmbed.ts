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
const ALIAS_PREFIX = 'GujiEmbed-'
function aliasOf(family: string): string {
  return ALIAS_PREFIX + family.replace(/["'\\]/g, '')
}
/** 内联后的 SVG 里族名已带别名前缀，反推回 binCache 的键（原族名）。 */
function unaliasOf(family: string): string {
  return family.startsWith(ALIAS_PREFIX) ? family.slice(ALIAS_PREFIX.length) : family
}

/* 单字体体积闸门（原始字节）：超过就放弃内联，保持原有回退行为。 */
const MAX_FONT_BYTES = 6 * 1024 * 1024

const binCache = new Map<string, string>()  // 族名 → 完整 base64 二进制
const faceCache = new Map<string, string>() // 族名 → @font-face 声明（可安全复用到任意叶）
/** 内联失败的族 → 原因（「族名（原因）」形式，UI 直接展示）。
 *
 *  **「取不到二进制」不算失败**：新版 macOS 的部分系统字体（楷体 Kaiti SC、苹方等）由系统字体
 *  服务提供，本来就不在 fontDirs 的四个目录里，SVG 图片文档里按族名照样能解析，回退是正常
 *  行为——把它当失败报警只会刷屏，还会把真正的问题淹掉。真该提示的只有两种：
 *  能取到数据却拼出残缺字体，以及体积超限（用户选的字体确实没能跟着走）。 */
const failed = new Map<string, string>()
export function failedFamilies(): string[] {
  return [...failed.entries()].map(([f, why]) => `${f}（${why}）`)
}

/** 校验拼回来的 base64 是不是**完整、有效**的字体二进制。
 *
 *  为什么必须校验：后端按块回传 base64，前端拼串。base64 是 3 字节 → 4 字符、末尾各自补 '='，
 *  所以**分块字节数不是 3 的倍数时**，每块结尾的 '=' 会留在拼接串**中间**——宽松解码器解到
 *  第一个块边界就停、atob 直接抛错，拿到的字体是**残缺**的。浏览器遇到坏字体不报错，只会
 *  静默丢弃这条 @font-face 并回退系统默认中文字体，整件事在界面上只表现为「导出的字不是选的
 *  那个字体」（本册真踩过：512K 分块 %3 余 2，8 块字体坏 7 块）。
 *  宁可在这里判定失败、放弃内联（会记进 failed 并在 UI 提示），也不交付错字形。 */
function fontB64Ok(b64: string, size: number): boolean {
  if (b64.length !== Math.ceil(size / 3) * 4) return false
  try {
    const raw = atob(b64)            // 拼接串中间混入 '=' 会在这里抛错
    if (raw.length !== size) return false
    const m = raw.slice(0, 4)
    return m === '\x00\x01\x00\x00' || m === 'OTTO' || m === 'true' || m === 'ttcf'
  } catch {
    return false
  }
}

async function faceFor(family: string): Promise<string | null> {
  if (faceCache.has(family)) return faceCache.get(family)!
  try {
    if (!binCache.has(family)) {
      const blob = await plat.openFont(family)
      if (!blob || !blob.size) return null // 系统字体服务提供，按族名回退即可
      /* 体积闸门：整字体 base64 会让**每一叶**都膨胀这么多。系统里动辄十几 MB 的大字体
       * 内联后导出会慢到不可用，宁可保持现状也不拖垮整次导出。 */
      if (blob.size > MAX_FONT_BYTES) { failed.set(family, '体积超限，未内联'); return null }
      let s = ''
      for (let i = 0; i < blob.chunks; i++) s += await plat.readFontChunk(family, i)
      if (!fontB64Ok(s, blob.size)) {
        failed.set(family, '数据残缺')
        console.error(`[导出] 字体 ${family} 的分块 base64 拼接后无法还原成有效字体` +
          `（${s.length} 字符 / 期望 ${Math.ceil(blob.size / 3) * 4}，分块 ${blob.chunks} × ${blob.chunkSize} 字节；` +
          `分块字节数须为 3 的倍数）。已跳过内联，该族将回退系统字体。`)
        return null
      }
      binCache.set(family, s)
    }
    const b64 = binCache.get(family)!
    /* 只产出声明本身，<style> 包裹交给 embedFonts 合并注入。
     * 逐条各自包一层 <style> 再插是错的：第二次注入会匹配到自己刚插入的 <style> 开标签，
     * 把后一条声明塞进前一条的 <style> 内部——XML 里嵌套 <style> 会被当子元素，
     * 外层 CSS 文本里混进标记，整条声明可能被丢弃（探针实测过，输出形如 <style><style>…</style>…）。 */
    const face = `@font-face{font-family:"${aliasOf(family)}";src:url(data:font/ttf;base64,${b64}) format("truetype");}`
    faceCache.set(family, face)
    return face
  } catch {
    return null // 取不到就维持现状，不阻断导出
  }
}

/** 把整块 <style>…</style> 插到根 <svg> 之后。
 *  刻意**不**复用文档里已有的 <style>：SVG 允许多个 <style> 元素，@font-face 的作用范围
 *  是整个文档，声明插在哪儿都一样；而往已有块里插就得先对齐它的收尾标签，多一处要同步的几何。 */
function inject(svg: string, styleBlock: string): string {
  const root = svg.match(/<svg\b[^>]*>/i)
  if (!root) return svg
  return svg.slice(0, root.index! + root[0].length) + styleBlock + svg.slice(root.index! + root[0].length)
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

/** 重建单个族名：不是纯标识符就补引号（族名可含空格，如 Times New Roman、Songti SC）。 */
const quoteFam = (s: string) => (/^[-\w]+$/.test(s) ? s : `'${s}'`)

/** 把 font-family 栈里的内联族换成别名；首项不是内联族则原样返回。
 *  注意别名必须按族名规则补引号：`parseStack` 已把原引号剥掉，而别名可能含空格
 *  （GujiEmbed-Times New Roman），不补引号的 CSS 值会被拆成多个族名，内联永远匹配不上。 */
function swap(raw: string, inline: Set<string>): string | null {
  const parts = parseStack(raw)
  if (!parts.length || !inline.has(parts[0])) return null
  const out = parts.map((p, i) => quoteFam(i === 0 && inline.has(p) ? aliasOf(p) : p))
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

  /* 所有声明合并成**一块** <style> 后一次性注入，避免逐条插入时的嵌套 <style>。 */
  return inject(out, `<style>${faces.join('')}</style>`)
}

/* ================= 图片文档字体探针（尽力而为，不作判定） =================
 * 症状：@font-face 在 SVG-as-image 里是**异步解码**的。img.onload 只保证「文档可以画了」，
 * 不保证字体已就绪；此刻 drawImage 会把正文画成整片空白——版心走系统族照常出图，
 * 于是看着像「这一页没渲染」（本册 34 叶里稳定漏 1~5 叶）。
 *
 * 上一版在**主文档**里 document.fonts.add + load 预热，方向不对：SVG-as-image 是独立图片
 * 文档，主文档的解码结果与它并不共享。这里改用**真图片文档探针**：把一小段 SVG 交给
 * new Image() 光栅化，直接观察字体有没有被用上。
 *
 * 判据是「双版对比」：只看到"画出了字"不能说明内联生效——字体没就绪时浏览器会回退到
 * 默认族，照样画出字。故同尺寸渲染两版，一版用内联别名、一版用必然不存在的族名作纯回退
 * 基准；两版位图不一致才说明内联族真的被采用了。
 *
 * ⚠ **这个判据不能用来判失败**（2026-09-26 定，别再把它接到告警上）：
 *   ① 图片文档里没有 document.fonts，字体是否就绪**无法查询**；
 *   ② WebKit 会缓存同一 data URL 文档的解析结果，多轮重试未必重新解析，加了等待也不保证；
 *   ③ 于是「两版位图相同」无法区分**字体没就绪**与**字体无效**——前者是时序、后者是数据，
 *      而它恰恰把前者当成后者。
 *   本册实测：34 叶导出时探针报「未生效」，而同一次导出里内联的 Times New Roman Italic
 *   明明是生效的（注音整体倾斜即其证据）——纯误报。
 *   真正能确定「内联失败」的只有 fontB64Ok（数据完整性校验），以及「取不到二进制 / 体积超限」
 *   这两条确定的分支；渲染时序问题由 exportImage 的逐叶墨迹补画兜底。
 *   故本模块的探针只当**预热**（提前把该族交给底层字体缓存）与耗时观测用。 */
const PROBE_SIZE = 64
const PROBE_TRIES = 3      // 单版渲染的重试次数（加载失败等）
const PROBE_WAIT_MS = 40
const PROBE_ATTEMPTS = 3   // 双版对比的轮次
const PROBE_RETRY_MS = 120
const PROBE_MIN_DIFF = 6   // 两版位图至少差这么多像素才算「内联生效」
const PROBE_CHAR = '永'    // 常用字，目标字体必备

/** 构造探针 SVG。useAlias=false 的版本刻意不带 @font-face、用一个不存在的族名，
 *  它会稳定回退到默认族，作为「内联没生效时长什么样」的基准。 */
function probeSvg(alias: string, b64: string, useAlias: boolean): string {
  const fam = useAlias ? alias : 'GujiProbe-Missing-Family'
  const style = useAlias
    ? `<style>@font-face{font-family:"${alias}";src:url(data:font/ttf;base64,${b64}) format("truetype");}</style>`
    : ''
  /* 族名一律补引号：属性值本身用双引号包裹，内层改用单引号，含空格的族名才不会被拆开。 */
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PROBE_SIZE}" height="${PROBE_SIZE}">${style}` +
    `<text x="${PROBE_SIZE / 2}" y="${PROBE_SIZE - 14}" font-family="${quoteFam(fam)}" font-size="46"` +
    ` text-anchor="middle" fill="#000">${PROBE_CHAR}</text></svg>`
}

const dataUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)

/** 把一段 SVG 光栅化到 PROBE_SIZE² 小画布，返回像素数据（取不到返回 null）。 */
async function shoot(url: string): Promise<Uint8ClampedArray | null> {
  const cv = document.createElement('canvas')
  cv.width = PROBE_SIZE
  cv.height = PROBE_SIZE
  const g = cv.getContext('2d')
  if (!g) return null
  for (let i = 0; i < PROBE_TRIES; i++) {
    const img = new Image()
    try {
      await new Promise<void>((ok, bad) => {
        img.onload = () => ok()
        img.onerror = () => bad(new Error('probe image'))
        img.src = url
      })
    } catch {
      await new Promise<void>(r => setTimeout(r, PROBE_WAIT_MS))
      continue
    }
    g.clearRect(0, 0, PROBE_SIZE, PROBE_SIZE)
    g.drawImage(img, 0, 0)
    try {
      return g.getImageData(0, 0, PROBE_SIZE, PROBE_SIZE).data
    } catch {
      return null
    }
  }
  return null
}

/** 单族探针：两版位图一致 → 判「内联未生效」，等一会儿再来一轮。 */
async function probeOne(family: string, b64: string): Promise<boolean> {
  const alias = aliasOf(family)
  /* URL 预先编码一次：重试时复用同一串，浏览器命中同一 URL 的图片缓存，后续轮次近乎免费。 */
  const urlA = dataUrl(probeSvg(alias, b64, true))
  const urlB = dataUrl(probeSvg(alias, b64, false))
  for (let i = 0; i < PROBE_ATTEMPTS; i++) {
    if (i) await new Promise<void>(r => setTimeout(r, PROBE_RETRY_MS * i))
    const a = await shoot(urlA)
    const b = await shoot(urlB)
    if (!a || !b) continue
    let diff = 0
    for (let k = 0; k < a.length; k += 4) if (a[k] !== b[k]) diff++
    if (diff >= PROBE_MIN_DIFF) return true
  }
  return false
}

const probeDone = new Map<string, Promise<boolean>>()

/** 预热 + 尽力确认：把已内联的族各交给图片文档渲染一次。同一导出任务里每族只跑一次。
 *
 *  ⚠ 返回值 `false` **只表示「多轮内没能证明」**，不代表内联失败——见上方三条原理性局限。
 *  调用方**不得据此告警**（本册曾据此在导出面板报「内联字体未在图片文档生效」，
 *  而实际字形是生效的）。要判内联失败只有两条确定依据：`failedFamilies()` 与
 *  「取不到二进制」，二者都由 faceFor 记录。 */
export async function probeFonts(svg: string): Promise<boolean> {
  if (typeof document === 'undefined') return true
  const fams = scanFamilies(svg).map(unaliasOf).filter(f => binCache.has(f))
  if (!fams.length) return true
  let ready = true
  for (const f of fams) {
    let p = probeDone.get(f)
    if (!p) {
      p = probeOne(f, binCache.get(f)!)
      probeDone.set(f, p)
    }
    if (!(await p)) ready = false
  }
  return ready
}
