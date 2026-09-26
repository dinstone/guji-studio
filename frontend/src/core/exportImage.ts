/* 古籍页 SVG → PNG：光栅化 + 落盘（桌面端写入项目 output/），供预览器与导出面板共用。
 * 逻辑与 ExportPanel 原实现一致，抽出为单一来源，避免两边各维护一份。 */

import * as plat from '../platform/wails'
import { embedFonts, probeFonts } from './fontEmbed'

/* 纹理内联：SVG 以 data:URL 经 new Image() 光栅化时，相对路径（如 textures/xuan.jpg）加载不出来，
 * 这里把每个 <image href="相对路径"> 拉取并内联为 data-URI。同一路径按会话缓存，避免整书多页重复拉取。 */
const texCache = new Map<string, string>()
async function dataURI(path: string): Promise<string> {
  let d = texCache.get(path)
  if (d) return d
  const r = await fetch(path)
  if (!r.ok) throw new Error('纹理加载失败: ' + path)
  const blob = await r.blob()
  d = await new Promise<string>((ok, bad) => {
    const fr = new FileReader()
    fr.onload = () => ok(fr.result as string)
    fr.onerror = () => bad(fr.error as any)
    fr.readAsDataURL(blob)
  })
  texCache.set(path, d)
  return d
}
export async function embedImages(svg: string): Promise<string> {
  const paths = new Set<string>()
  const re = /<image\b[^>]*?\bhref="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(svg))) { if (!m[1].startsWith('data:')) paths.add(m[1]) }
  for (const p of paths) {
    try { const d = await dataURI(p); svg = svg.split(`href="${p}"`).join(`href="${d}"`) }
    catch { /* 留原样：仅导出可能缺此纹理，不影响其余渲染 */ }
  }
  return svg
}

/* ============ 缺字页检测与补画 ============
 * 内联字体在 SVG 图片文档里异步解码：img.onload 只保证「文档可以画了」。字体还没就绪时
 * drawImage 会把正文整片画空（版心走系统族照常出图，看着像整页没渲染）。
 *
 * 关键教训：**同一个 Image 对象绘制过一次后，它的栅格化结果就被缓存**——之后无论清屏重绘
 * 多少轮拿到的都是同一份（缺字的）位图。上一版用「画面指纹比对」判断稳定，恰好在缺字时
 * 指纹纹丝不动，于是立刻 break、把空白页当成最终结果交出去。所以补画必须**重建 Image**。
 *
 * 判据用墨迹覆盖率：把画布缩到 1/8 后统计暗像素占比。实测正常页 ~6.3%、缺字页 ~0.7%
 *（差 9 倍），阈值取 3% 两侧都有近一倍裕度。只在文字密集页上启用——封面/扉页/尾页的
 * <text> 本来就少，稀疏是正常的，不该触发补画。 */
const INK_MIN = 3.0            // 墨迹覆盖率下限（%），1/8 缩略图口径
const INK_CHECK_MIN_TEXTS = 30 // 少于这么多 <text> 的页不做墨迹判据
const RETRY_ROUNDS = 3         // 每叶最多画几轮（首轮达标即停，正常页无额外成本）
const RETRY_WAIT_MS = 90       // 第 n 轮前等 n×90ms

/** 用 1/8 缩略图统计墨迹覆盖率（%）。回读像素只有整幅的 1/64，成本可忽略。
 *  取不到像素返回 null——此时不做判据，保留首轮结果。 */
function inkCoverage(cv: HTMLCanvasElement, W: number, H: number): number | null {
  try {
    const sw = Math.max(1, W >> 3)
    const sh = Math.max(1, H >> 3)
    const p = document.createElement('canvas')
    p.width = sw
    p.height = sh
    const pg = p.getContext('2d')
    if (!pg) return null
    pg.drawImage(cv, 0, 0, sw, sh)
    const d = pg.getImageData(0, 0, sw, sh).data
    let ink = 0
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      if ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 140) ink++
      n++
    }
    return n ? (ink / n) * 100 : null
  } catch {
    return null
  }
}

/* ============ 光栅化性能统计 ============
 * 每叶逐段计时并留档，供导出面板显示与控制台核对。
 * 关键对照点：**首叶的 fonts 段含「首次去后端取字体二进制」的 IPC 开销**，
 * 后续叶应显著更短——若不是，说明 binCache/faceCache 没生效，那是 bug 而非体积问题。
 * 想看控制台明细时，把 localStorage.guji.exportProfile 置 '1'。 */
export interface LeafProfile {
  label: string
  total: number
  svgIn: number   // 内联前 SVG 字符数
  svgOut: number  // 内联后 SVG 字符数
  rounds: number  // 实际画了几轮（>1 说明补画过，即首轮没把正文画出来）
  ink: number     // 最终墨迹覆盖率（%，-1 = 未做判据）
  probeUnproven: boolean // 字体探针没能在多轮内证实「内联字体在这个图片文档里可用」——
                         // **正常现象，不是失败**（图片文档里无法查询字体就绪状态，WebKit 还会
                         // 缓存同 URL 的解析结果）。仅供性能排查看，不得据此告警：见 fontEmbed.ts
                         // 「图片文档字体探针」段的三条原理性局限。
  stages: Record<string, number>
}
const PROF_KEY = 'guji.exportProfile'
let profiles: LeafProfile[] = []
export function resetProfiles(): void { profiles = [] }
export function getProfiles(): LeafProfile[] { return profiles }
export function profileOn(): boolean { try { return localStorage.getItem(PROF_KEY) === '1' } catch { return false } }
const MB = (n: number) => (n / 1024 / 1024).toFixed(2) + 'MB'

export async function rasterizeSvg(svg: string, W: number, H: number, label = ''): Promise<Blob> {
  /* 先内联纹理再内联字体：字体 @font-face 会把 SVG 撑大，放在纹理之后可让两者的字符串替换互不干扰。
   * 少了 embedFonts，SVG 作为独立图片文档拿不到自定义字体，会整体回退系统宋体
   * （竖排标点变弯引号、正文笔画变样）。 */
  const st: Record<string, number> = {}
  const t0 = performance.now()
  let tick = t0
  const mark = (k: string) => { st[k] = +(performance.now() - tick).toFixed(1); tick = performance.now() }
  const svgIn = svg.length

  const texed = await embedImages(svg)
  mark('images')
  const finalSvg = await embedFonts(texed)
  mark('fonts')
  /* 探针只当预热与耗时观测：它的结论不可作为失败依据（见 fontEmbed.ts 的三条局限）。
   * 真发生「字体没就绪」，下面的逐叶墨迹补画会兜住；真发生「内联失败」，failedFamilies 会记。 */
  const probeOk = await probeFonts(finalSvg)
  mark('probe')
  const svgOut = finalSvg.length
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(finalSvg)
  mark('encode')

  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const g = cv.getContext('2d')!
  const dense = (finalSvg.match(/<text\b/g) || []).length >= INK_CHECK_MIN_TEXTS
  const checkInk = finalSvg.includes('@font-face') && dense

  let rounds = 0
  let ink = -1
  for (let i = 0; i < RETRY_ROUNDS; i++) {
    rounds = i + 1
    if (i) await new Promise<void>(r => setTimeout(r, RETRY_WAIT_MS * i))
    /* 每轮都**新建 Image**：同一个 Image 的栅格化结果会被缓存，清屏重绘拿到的还是同一份
     *（缺字的）位图——这正是上一版「指纹比对」失效的原因。重建才会让 SVG 重新解析一遍，
     * 也才有机会拿到「字体已就绪」的那一版。 */
    const img = new Image()
    await new Promise<void>((ok, bad) => {
      img.onload = () => ok()
      img.onerror = () => bad(new Error(`第 ${label || '?'} 叶 SVG 解析失败（字体/引号未转义会产生非法 XML）`))
      img.src = url
    })
    g.clearRect(0, 0, W, H)
    g.drawImage(img, 0, 0, W, H)
    if (!checkInk) break
    const c = inkCoverage(cv, W, H)
    if (c == null) break
    ink = c
    if (c >= INK_MIN) break // 正文已经画出来了
    if (i + 1 < RETRY_ROUNDS) st.retry = (st.retry ?? 0) + 1
  }
  mark('paint')

  if (checkInk && ink >= 0 && ink < INK_MIN) {
    /* 补画到底也没画出来：不静默交白卷，明确留痕（导出汇总里会统计）。 */
    console.warn(`[导出] 第 ${label || '?'} 叶疑似缺字：墨迹 ${ink.toFixed(1)}% < ${INK_MIN}%（已补画 ${rounds} 轮）`)
  }

  const blob: Blob | null = await new Promise(ok => cv.toBlob(ok, 'image/png'))
  mark('png')
  profiles.push({ label, total: +(performance.now() - t0).toFixed(1), svgIn, svgOut, rounds, ink: +ink.toFixed(1), probeUnproven: !probeOk, stages: st })
  if (!blob) throw new Error(`第 ${label || '?'} 叶光栅失败（画布可能过大）`)
  return blob
}

/** 光栅后「补画兜底也没救回来」的叶。UI 要拿它提示用户，故导出——
 *  桌面端没有 devtools，console.warn 那一行用户根本看不见。 */
export function suspectLeaves(): LeafProfile[] {
  return profiles.filter(p => p.ink >= 0 && p.ink < INK_MIN)
}

/** 导出完成后打一份人能读的性能汇总（仅开关打开时）。 */
export function logProfileSummary(kind: string): void {
  if (!profileOn() || !profiles.length) return
  const total = profiles.reduce((a, p) => a + p.total, 0)
  const grow = profiles.reduce((a, p) => a + Math.max(0, p.svgOut - p.svgIn), 0)
  const retried = profiles.filter(p => p.rounds > 1)
  const bad = suspectLeaves()
  console.info(`[导出性能] ${kind} · ${profiles.length} 叶 · 光栅总 ${(total / 1000).toFixed(1)}s` +
    (retried.length ? ` · 补画 ${retried.length} 叶（${retried.map(p => p.label).join('、')}）` : '') +
    (bad.length ? ` · **仍有 ${bad.length} 叶疑似缺字：${bad.map(p => p.label).join('、')}**` : ''))
  for (const p of profiles.slice(0, 3)) {
    const s = p.stages
    console.info(`  ${p.label}: 总 ${p.total}ms | 内联 图${s.images ?? 0}/字${s.fonts ?? 0}ms | 探针 ${s.probe ?? 0}ms | 编码 ${s.encode ?? 0}ms` +
      ` | 绘制 ${s.paint ?? 0}ms | 墨迹 ${p.ink < 0 ? '未测' : p.ink + '%'}·画 ${p.rounds} 轮 | PNG ${s.png ?? 0}ms | SVG ${MB(p.svgIn)} → ${MB(p.svgOut)}`)
  }
  console.info(`  内联使每叶平均膨胀 ${MB(grow / profiles.length)}，光栅合计 ${(total / 1000).toFixed(1)}s`)
}

function toB64(bytes: Uint8Array): Promise<string> {
  return new Promise<string>((ok, bad) => {
    const r = new FileReader()
    r.onload = () => ok((r.result as string).split(',')[1])
    r.onerror = () => bad(new Error('base64 编码失败'))
    r.readAsDataURL(new Blob([bytes as any]))
  })
}

/* 分块落盘：绕过 Wails 单条 IPC 调用体体积上限（整张图一次性传会报「assembled body too large」）。
 * 把 blob 按固定字节切片、逐片 base64 后调用后端追加写。返回 output 目录路径。 */
const EXPORT_CHUNK = 512 * 1024
export async function saveBlobToOutput(dir: string, name: string, blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  if (buf.length === 0) return plat.saveExportFileChunk(dir, name, '', true)
  let od = ''
  for (let off = 0, i = 0; off < buf.length; off += EXPORT_CHUNK, i++) {
    const slice = buf.subarray(off, Math.min(off + EXPORT_CHUNK, buf.length))
    od = await plat.saveExportFileChunk(dir, name, await toB64(slice), i === 0)
  }
  return od
}

/* 浏览器下载单个 blob（Web 预览端、无项目目录时兜底）。 */
export async function downloadBlob(blob: Blob, name: string): Promise<void> {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
