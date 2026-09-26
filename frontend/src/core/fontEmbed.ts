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
 * 体积问题与子集化（2026-09-26）：
 *   整字体 base64 会让**每一叶**都膨胀（3~5MB 级别的大字体尤其明显），于是设了 6MB 闸门。
 *   但 CJK 字体动辄 10~20MB（思源宋体 CN 10.74MB、Songti SC 20.8MB、苹方 11MB），用户选的
 *   字体**全部卡在闸门外**，导出只能回退系统宋体——症状是「导出的字不是选的那个」。
 *   现在改为**先按字符集做字形子集再内联**（fontSubset.ts）：实测 10.74MB → 345KB，
 *   一本 17 叶的书从「每叶内联 5.11MB」降到约 0.5MB。闸门退化为子集化不可用时的兜底。
 *   不可直接换用外部 url 或 local()，两条在图片文档里都不生效（已验证）。
 */

import * as plat from '../platform/wails'
import { subsetFont } from './fontSubset'

/* 通用族名：内联无意义（图片文档里本来就没有，且命中默认字体更接近现状），跳过。 */
const GENERIC = new Set(['', 'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif'])

/** 别名前缀：@font-face 的 font-family 名字用引号包裹，故族名可原样带进来，只加 ASCII 前缀防撞名。 */
const ALIAS_PREFIX = 'GujiEmbed-'
function aliasOf(family: string): string {
  return ALIAS_PREFIX + family.replace(/["'\\]/g, '')
}
/** 内联后的 SVG 里族名已带别名前缀，反推回缓存键（原族名）。
 *  导出侧的「按族抽样墨迹」也要用它：告警里得报用户认得的族名，而不是 GujiEmbed- 别名。 */
export function unaliasOf(family: string): string {
  return family.startsWith(ALIAS_PREFIX) ? family.slice(ALIAS_PREFIX.length) : family
}

/* 单字体体积闸门（原始字节）：**仅在子集化不可用时生效**——wasm 加载失败、字体非 sfnt、
 * 内存不足等情况下回退到整字体内联，超过它才放弃。子集化正常时基本不会触发（见 fontSubset.ts）。 */
const MAX_FONT_BYTES = 6 * 1024 * 1024

const rawCache = new Map<string, Uint8Array>() // 族名 → 整字体字节（子集化与兜底内联共用，取代原 binCache 的 base64）
const plainB64 = new Map<string, string>()     // 族名 → 整字体 base64（兜底内联路径用，免每叶重编码 10MB）
const subCache = new Map<string, SubData>()    // 族名 → 子集结果（按 chars 版本失效）
const faceCache = new Map<string, string>()    // 族名 → @font-face 声明（可安全复用到任意叶）
/* 声明对应的字符集版本（= chars.size）。**不记录版本就等于没做缓存失效**：
 * 子集是按当时字符集裁的，chars 只增，版本一变，本叶新出现的字就不在子集里，
 * 继续复用旧声明 = 那批字整片缺字形（比回退字体严重）。整字体兜底的声明与字符集无关，记 -1 永不失效。 */
const faceAt = new Map<string, number>()
const inlineB64 = new Map<string, string>()    // 族名 → 实际内联用的 base64（供探针复用，构造对照 SVG）

/** 一份子集字体。`at` = 裁剪时的 `chars.size`（版本号）：chars 只增，size 变了就得重裁。 */
interface SubData { at: number; b64: string; fmt: string }

/* ============ 会话状态：字符集 ============
 * 子集是按「本次导出会用到的字符」裁的，与上一次导出无关，故**每次导出开始都要重置会话**；
 * 整字体字节 rawCache 与内容无关，保留即可（省掉重复 IPC）。
 *
 * chars 只增不改——族的子集若是在更小的字符集上裁的，必须重裁。用 size 当版本号是 O(1) 判断，
 * 不必每叶做集合包含运算（一本书上千字，逐叶求包含会很浪费）。 */
const chars = new Set<number>()

/** 导出会话开始：清掉与「本次导出内容」绑定的状态。
 *  必须调——否则上一本书的子集会因字符集不同而漏字，且失败清单会带着旧记录汇报。
 *  （整字体字节与上一本书无关，故意保留。） */
export function beginFontSession(): void {
  chars.clear()
  subCache.clear()
  faceCache.clear()
  faceAt.clear()
  inlineB64.clear()
  failed.clear()
  probeDone.clear()
}

/** 预热字符集：把「预计会用到」的文字先交进来，让首次子集化就一次到位。
 *  传全书文本（含标题、卷名、册名）即可；漏掉的字符仍会在逐叶扫描里补上并触发重裁，
 *  所以这里**宁多勿少**——多带字形只让子集大一点，少带才会丢字。 */
export function primeCodepoints(text: string): void {
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp && cp > 32) chars.add(cp)
  }
}

/** 收集一段 SVG 里出现的全部码位，并入会话字符集；返回是否有新增。 */
function noteCodepoints(svg: string): boolean {
  let added = false
  for (const ch of svg) {
    const cp = ch.codePointAt(0)
    if (cp && cp > 32 && !chars.has(cp)) { chars.add(cp); added = true }
  }
  return added
}
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

/** 校验拼回来的 base64 是不是**完整、有效**的字体二进制；合格则解成字节返回，否则 null。
 *
 *  为什么必须校验：后端按块回传 base64，前端拼串。base64 是 3 字节 → 4 字符、末尾各自补 '='，
 *  所以**分块字节数不是 3 的倍数时**，每块结尾的 '=' 会留在拼接串**中间**——宽松解码器解到
 *  第一个块边界就停、atob 直接抛错，拿到的字体是**残缺**的。浏览器遇到坏字体不报错，只会
 *  静默丢弃这条 @font-face 并回退系统默认中文字体，整件事在界面上只表现为「导出的字不是选的
 *  那个字体」（本册真踩过：512K 分块 %3 余 2，8 块字体坏 7 块）。
 *  宁可在这里判定失败、放弃内联（会记进 failed 并在 UI 提示），也不交付错字形。
 *
 *  原实现只判真假（fontB64Ok）；子集化需要字节，故一并解出来，省掉二次 atob。 */
function decodeFontB64(b64: string, size: number): Uint8Array | null {
  if (b64.length !== Math.ceil(size / 3) * 4) return null
  try {
    const bin = atob(b64)            // 拼接串中间混入 '=' 会在这里抛错
    if (bin.length !== size) return null
    const raw = new Uint8Array(size)
    for (let i = 0; i < size; i++) raw[i] = bin.charCodeAt(i)
    return sfntFormat(raw) ? raw : null
  } catch {
    return null
  }
}

/** 按 sfnt 魔数判字体格式，返回 @font-face 的 format() 取值；非 sfnt 返回 ''。
 *
 *  为什么不能写死 truetype：CFF/OTF（思源宋体、多数专业中文字体）的 format 是 opentype，
 *  声明成 truetype 属于「格式不符」，浏览器有权直接拒绝这条 @font-face——同样是静默回退。 */
function sfntFormat(raw: Uint8Array): string {
  if (raw.length < 4) return ''
  const m = String.fromCharCode(raw[0], raw[1], raw[2], raw[3])
  if (m === 'OTTO') return 'opentype'
  if (m === 'ttcf') return 'collection'          // 集合文件：Go 侧应已重建为单字体，走到这说明有 bug
  if (m === '\x00\x01\x00\x00' || m === 'true') return 'truetype'
  return ''
}

/* base64 编码分块大小。`String.fromCharCode(...arr)` 是参数展开，块太大会爆栈；
 * 8192 在 8G 机的 WKWebView（JSCore）上也留足裕度。 */
const B64_CHUNK = 0x2000

/** 字节 → base64（同步）。整字体 10MB 级，故必须分块。 */
function bytesToB64(raw: Uint8Array): string {
  let s = ''
  for (let i = 0; i < raw.length; i += B64_CHUNK) {
    const c = raw.subarray(i, i + B64_CHUNK)
    s += String.fromCharCode.apply(null, Array.prototype.slice.call(c) as number[])
  }
  return btoa(s)
}

/** 组装一条 @font-face 声明。data URI 的 MIME 与 format() 都随字体格式走（见 sfntFormat）。 */
function faceDecl(alias: string, b64: string, fmt: string): string {
  return `@font-face{font-family:"${alias}";src:url(data:font/${fmt === 'opentype' ? 'otf' : 'ttf'};` +
    `base64,${b64}) format("${fmt}");}`
}

/** 取整字体字节（每族一次，会话内复用）。
 *  返回 null：① 取不到（新版 macOS 的楷体、苹方等由系统字体服务提供，本就不在字体目录里，
 *  按族名在图片文档里照样能解析，属正常回退）；② 分块数据残缺（已在 failed 留痕）。 */
async function rawBytes(family: string): Promise<Uint8Array | null> {
  const cached = rawCache.get(family)
  if (cached) return cached
  try {
    const blob = await plat.openFont(family)
    if (!blob || !blob.size) return null
    let s = ''
    for (let i = 0; i < blob.chunks; i++) s += await plat.readFontChunk(family, i)
    const raw = decodeFontB64(s, blob.size)
    if (!raw) {
      failed.set(family, '数据残缺')
      console.error(`[导出] 字体 ${family} 的分块 base64 拼接后无法还原成有效字体` +
        `（${s.length} 字符 / 期望 ${Math.ceil(blob.size / 3) * 4}，分块 ${blob.chunks} × ${blob.chunkSize} 字节；` +
        `分块字节数须为 3 的倍数）。已跳过内联，该族将回退系统字体。`)
      return null
    }
    rawCache.set(family, raw)
    return raw
  } catch {
    return null
  }
}

/** 子集化并取 base64；任一步不成立返回 null，由 faceFor 回退整字体路径。
 *
 *  字符集版本（chars.size）没变就复用上次结果——同一族的子集会被整本书的每一叶反复请求，
 *  缺这道缓存会把子集化重跑 N 次（每次 200~300ms）。 */
async function subsetFor(family: string): Promise<SubData | null> {
  const old = subCache.get(family)
  if (old && old.at === chars.size) return old
  const raw = await rawBytes(family)
  if (!raw) return old ?? null
  const cps = [...chars].filter(cp => cp > 32)
  if (!cps.length) return old ?? null
  const sub = await subsetFont(raw, cps)
  /* 重裁失败时**保留旧子集**：它至少覆盖旧字符集，退化为「本轮新增字符缺字形」，
   * 比整族不内联（全部字回退系统字体）好。版本号未更新，下次仍会重试。 */
  if (!sub || !sub.length) return old ?? null
  const fmt = sfntFormat(sub)
  if (!fmt) return old ?? null
  const d: SubData = { at: chars.size, b64: bytesToB64(sub), fmt }
  subCache.set(family, d)
  return d
}

async function faceFor(family: string): Promise<string | null> {
  /* 缓存只在「声明对应的字符集版本仍是当前版本」时可复用（整字体兜底的声明记 -1，永不失效）。
   * 少了这道版本比对，前面叶子裁出的子集会被后面所有叶子继续引用，新增字符直接缺字形。 */
  const cached = faceCache.get(family)
  if (cached && faceAt.get(family) === chars.size) return cached

  /* ① 首选子集路径：体积受字符集约束，跟用户所选字体无关，不再受闸门挟持。 */
  const sub = await subsetFor(family)
  if (sub) {
    /* 只产出声明本身，<style> 包裹交给 embedFonts 合并注入。
     * 逐条各自包一层 <style> 再插是错的：第二次注入会匹配到自己刚插入的 <style> 开标签，
     * 把后一条声明塞进前一条的 <style> 内部——XML 里嵌套 <style> 会被当子元素，
     * 外层 CSS 文本里混进标记，整条声明可能被丢弃（探针实测过，输出形如 <style><style>…</style>…）。 */
    const face = faceDecl(aliasOf(family), sub.b64, sub.fmt)
    faceCache.set(family, face)
    /* 记 `sub.at` 而非 chars.size：重裁失败时保留的是**旧子集**，版本更旧 → 下一叶仍会重试。 */
    faceAt.set(family, sub.at)
    inlineB64.set(family, sub.b64)
    return face
  }
  /* 重裁没成但已有可用声明（含上一轮的整字体兜底）→ 沿用，不做没把握的替换。 */
  if (cached) return cached
  /* ② 兜底：子集化不可用（wasm 加载失败、字体非 sfnt、内存不足）时按整字体内联，
   *    行为与引入子集化之前完全一致——超闸门就不内联，并记进 failed 让 UI 提示。 */
  const raw = await rawBytes(family)
  if (!raw) return null
  if (raw.length > MAX_FONT_BYTES) { failed.set(family, '体积超限，未内联'); return null }
  const fmt = sfntFormat(raw)
  if (!fmt) { failed.set(family, '数据残缺'); return null }
  /* base64 缓存：子集不可用时这条路径会被**每一叶**走到，没有缓存就要把 10MB 整字体重编码 N 次。 */
  let b64 = plainB64.get(family)
  if (!b64) { b64 = bytesToB64(raw); plainB64.set(family, b64) }
  const face = faceDecl(aliasOf(family), b64, fmt)
  faceCache.set(family, face)
  faceAt.set(family, -1)              // 整字体：与字符集无关，永不失效
  inlineB64.set(family, b64)
  return face
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
  /* 先并入本叶字符，再逐族取字体：子集裁的是「并入之后」的字符集，否则本叶**首次**出现的
   * 字会被裁掉（表现为该字没有字形，画成空白或方框——比回退字体严重得多）。 */
  noteCodepoints(svg)

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
 *   真正能确定「内联失败」的只有 decodeFontB64（数据完整性校验），以及「取不到二进制 / 体积超限」
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
  const fams = scanFamilies(svg).map(unaliasOf).filter(f => inlineB64.has(f))
  if (!fams.length) return true
  let ready = true
  for (const f of fams) {
    let p = probeDone.get(f)
    if (!p) {
      p = probeOne(f, inlineB64.get(f)!)
      probeDone.set(f, p)
    }
    if (!(await p)) ready = false
  }
  return ready
}
