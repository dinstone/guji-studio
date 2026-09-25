/* 古籍页 SVG → PNG：光栅化 + 落盘（桌面端写入项目 output/），供预览器与导出面板共用。
 * 逻辑与 ExportPanel 原实现一致，抽出为单一来源，避免两边各维护一份。 */

import * as plat from '../platform/wails'
import { embedFonts } from './fontEmbed'

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

/* 内联字体后，等字体解码落定的毫秒数（见下方 drawImage 处的重绘）。 */
const FONT_SETTLE_MS = 30

export async function rasterizeSvg(svg: string, W: number, H: number, label = ''): Promise<Blob> {
  /* 先内联纹理再内联字体：字体 @font-face 会把 SVG 撑大，放在纹理之后可让两者的字符串替换互不干扰。
   * 少了 embedFonts，SVG 作为独立图片文档拿不到自定义字体，会整体回退系统宋体
   * （竖排标点变弯引号、正文笔画变样）。 */
  const finalSvg = await embedFonts(await embedImages(svg))
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(finalSvg)
  const img = new Image()
  await new Promise<void>((ok, bad) => {
    img.onload = () => ok()
    img.onerror = () => bad(new Error(`第 ${label || '?'} 叶 SVG 解析失败（字体/引号未转义会产生非法 XML）`))
    img.src = url
  })
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const g = cv.getContext('2d')!
  g.drawImage(img, 0, 0, W, H)
  /* @font-face 是**异步解码**的：img.onload 只保证 SVG 可绘制，不保证字体已就绪。
   * 此刻 drawImage 会把字画成 fallback 字形，等 fonts 落定后清屏重绘一次，
   * 避免导出结果随时序漂移（同一份模板两次导出长得不一样）。 */
  if (finalSvg.includes('@font-face')) {
    await new Promise<void>(r => setTimeout(r, FONT_SETTLE_MS))
    g.clearRect(0, 0, W, H)
    g.drawImage(img, 0, 0, W, H)
  }
  const blob: Blob | null = await new Promise(ok => cv.toBlob(ok, 'image/png'))
  if (!blob) throw new Error(`第 ${label || '?'} 叶光栅失败（画布可能过大）`)
  return blob
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
