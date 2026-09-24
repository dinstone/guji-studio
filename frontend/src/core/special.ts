/* 特殊页渲染器：封面 / 扉页 / 尾页（古籍实物惯例：无版心、无页码、不参与分页）
 * 由 _cover-demo.html 原型迁入。三类页均为半叶 1754×2480（A4 横向叶之半），
 * 导出时拼装到对开叶（3508×2480）：[扉页|封面] 与 [空|尾页]，与正文同一纸张体系。
 * 纯函数、无 DOM 依赖，返回 SVG 字符串。 */

import { assetInfo } from './assets'

/** 特殊页输出开关：册是独立装订单元，各册可只出封面、或首册加扉页、末册加尾页 */
export interface SpecialPages {
  cover: boolean      // 书衣封面（卷首右半叶）
  fly: boolean        // 扉页（卷首左半叶）
  colophon: boolean   // 尾页跋尾（卷尾右半叶）
}

/** 正文页边距（整叶坐标系，取自版式模板 margins_*）——包装叶双框跟随它，与正文版框对齐 */
export interface LeafMargins {
  left: number
  right: number
  top: number
  bottom: number
}

export interface SpecialCfg {
  coverTitle: string   // 封面/扉页书名（缺省取书级 title_text）
  coverAuthor: string  // 撰者行（封面签内 + 扉页右行）
  volLabel: string     // 册名（封面/扉页书名下方小字，如「道德经上册」）
  imprint: string      // 牌记（扉页左行，位稍低）
  colophon: string     // 尾页跋尾/版权，"/" 分栏
  flyLines: boolean    // 扉页在内框内画两条竖线，将版面分成左中右三栏
  font: 'song' | 'kai'
  fs: number           // 大字字号 110–220
  frame: boolean       // 书衣双框
  paper: string        // 纸色
  slipbg: string       // 题签底色（'none' = 透纸）
  bg: string           // 背景图（宣纹纹理）：留空=纯色；填图片路径/dataURL=拉伸铺满半叶
  stamp: string        // 扉页图章：留空=无；填写为文件名（存于项目 assets/）或 dataURL（旧版兼容）
  stampX: number       // 图章中心横坐标（归一化 0..1，0=纸左 1=纸右）
  stampY: number       // 图章中心纵坐标（归一化 0..1，0=天头 1=地脚）
  stampScale: number   // 图章缩放（相对基准正方形框的倍数，1=默认）
  illus: string        // 尾页插图：留空=无；文件名或 dataURL
  illusX: number       // 插图中心横坐标（归一化 0..1）
  illusY: number       // 插图中心纵坐标（归一化 0..1）
  illusScale: number   // 插图缩放（相对基准正方形框的倍数，1=默认）
  pages: SpecialPages  // 本册输出哪些特殊页
  margins?: LeafMargins // 正文页边距（可选）：有则双框距纸边跟随它，无则回落旧固定值
}

export const SPECIAL_PAGES_DEFAULT: SpecialPages = { cover: true, fly: true, colophon: true }

export const SPECIAL_DEFAULT: SpecialCfg = {
  coverTitle: '', coverAuthor: '', volLabel: '', imprint: '',
  colophon: '', flyLines: false, font: 'song', fs: 150, frame: true,
  paper: 'none', slipbg: '#f2ecdc', bg: '',
  stamp: '', stampX: 0.78, stampY: 0.86, stampScale: 1,
  illus: '', illusX: 0.5, illusY: 0.45, illusScale: 1,
  pages: { ...SPECIAL_PAGES_DEFAULT },
}

export const HALF_W = 1754, HALF_H = 2480
const INK = '#2f2a20'

/** 文本转义；属性值也用它（&quot; 在 XML 属性内合法，保证 SVG 可被严格 XML 解析——
 *  否则 Image 光栅化会失败，导出直接报错。历史上这里漏转义引号导致 PDF 导出失败。） */
export function esc(s: any): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
/** 逐字拆分：保留词间空格（连续空白归一为单个空格、去首尾），空格在竖排中占一格但不落墨 */
function chars(s: any): string[] {
  return String(s || '').replace(/\s+/g, ' ').trim().split('')
}
export function famOf(cfg: SpecialCfg): string {
  return cfg.font === 'kai' ? '"Kaiti SC","STKaiti",serif' : '"Songti TC","STSong",serif'
}

/* 竖排逐字堆叠（与正文引擎同构：每字一格、格心对齐）
 * 空格（词间分隔）占一格但不输出 <text>——竖排里即「空位断词」，高度照常累加。 */
function vChars(x: number, yTop: number, arr: string[], fs: number, fill: string, f: string, cellK: number, weight?: boolean) {
  const o: string[] = []
  const cell = fs * cellK
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === ' ') continue          // 空格留白、占位不落墨
    o.push('<text x="' + x + '" y="' + (yTop + (i + 0.5) * cell) + '" font-size="' + fs + '" fill="' + fill +
      '" font-family="' + esc(f) + '"' + (weight ? ' font-weight="bold"' : '') +
      ' text-anchor="middle" dominant-baseline="central">' + esc(arr[i]) + '</text>')
  }
  return { svg: o.join(''), h: arr.length * cell }
}

/** 半叶四边内缩量（半叶坐标系）：l/r 为纸边与订口侧，t/b 为天头地脚 */
interface Pad { l: number; t: number; r: number; b: number }
/** 半叶在对开叶中的位置：left = 左半（纸边在左），right = 右半（纸边在右） */
export type HalfSide = 'left' | 'right'

/** 书衣双框：外框粗、内框细。内缩量可四边不同（跟随正文页边距：天头/地脚常不等） */
function doubleFrame(W: number, H: number, pad: Pad): string {
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b
  const IN = 24                                  // 内外框间距
  return '<rect x="' + pad.l + '" y="' + pad.t + '" width="' + iw + '" height="' + ih +
    '" fill="none" stroke="' + INK + '" stroke-width="7"/>' +
    '<rect x="' + (pad.l + IN) + '" y="' + (pad.t + IN) + '" width="' + (iw - 2 * IN) + '" height="' + (ih - 2 * IN) +
    '" fill="none" stroke="' + INK + '" stroke-width="2"/>'
}

/* 半叶内缩量：有正文页边距则跟随（整叶坐标 ÷ 缩放 → 半叶坐标），否则回落旧固定值。
 * 水平：纸边侧取同侧正文边距，订口侧取同值对称 —— 对开时两半各成一框，中缝自然留出双份间距。
 * 垂直：扉页/尾页与正文完全一致（上取天头 top、下取地脚 bottom）；
 *       封面为题签式、无「天头」一说，上下一视同仁同取地脚 bottom。 */
function padOf(cfg: SpecialCfg, side: HalfSide, s: number, legacy: number, noTop: boolean): Pad {
  const M = cfg.margins
  if (!M) return { l: legacy, t: legacy, r: legacy, b: legacy }
  const h = (side === 'left' ? M.left : M.right) / s
  return { l: h, t: (noTop ? M.bottom : M.top) / s, r: h, b: M.bottom / s }
}

/* ---- 半叶渲染（内部，无 <svg> 根） ---- */

/* 封面：题签式。签条贴左上（远离书脑一侧），签内书名大字居中；
   书名下方左右两行并排（古书右起）：册名居右行、撰者居左行，两行同字号、同起排高度 */
function coverHalf(cfg: SpecialCfg, pad: Pad): string {
  const f = famOf(cfg), fs = cfg.fs
  /* 封面外框纸边侧（x 小端）距纸边固定 120px：古籍书衣前口留白大于书脑侧，
   * 故封面左框按此定值、不跟随正文左右边距；书脑侧 r 仍随正文边距。 */
  const COVER_LEFT = 120
  const p: Pad = { ...pad, l: COVER_LEFT }
  const o: string[] = ['<rect width="' + HALF_W + '" height="' + HALF_H + '" fill="' + cfg.paper + '"/>']
  const bg = resolveBg(cfg.bg)
  if (bg) o.push('<image x="0" y="0" width="' + HALF_W + '" height="' + HALF_H + '" href="' + esc(bg) + '" preserveAspectRatio="none"/>')
  if (cfg.frame) o.push(doubleFrame(HALF_W, HALF_H, p))
  /* 题签贴左上（远离书脑一侧）；与左外框之间留 INSET_LEFT 呼吸空间。 */
  const INSET_LEFT = 90
  const sx = Math.max(HALF_W * 0.11, COVER_LEFT + 24 + INSET_LEFT)
  const sy = Math.max(HALF_H * 0.11, pad.t + 24)   // 相对上一版整体下移（0.075 → 0.11）
  const sw = Math.min(HALF_W * 0.235 * 0.75, HALF_W - sx - pad.r - 24)  // 题签框宽收窄 1/4
  const sh = Math.min(HALF_H * 0.55, HALF_H - sy - pad.b - 24)
  o.push('<rect x="' + sx + '" y="' + sy + '" width="' + sw + '" height="' + sh + '" fill="' +
    (cfg.slipbg === 'none' ? cfg.paper : cfg.slipbg) + '" stroke="' + INK + '" stroke-width="5"/>')
  o.push('<rect x="' + (sx + 12) + '" y="' + (sy + 12) + '" width="' + (sw - 24) + '" height="' + (sh - 24) +
    '" fill="none" stroke="' + INK + '" stroke-width="1.5"/>')
  const cx = sx + sw / 2
  const t = chars(cfg.coverTitle), v = chars(cfg.volLabel), a = chars(cfg.coverAuthor)
  const fsS = fs * 0.42
  const cellT = fs * 1.12, cellS = fsS * 1.2
  const gap = 46                                    // 书名 ↔ 下方两行的间距
  const titleH = t.length * cellT
  const subH = Math.max(v.length ? v.length * cellS : 0, a.length ? a.length * cellS : 0)
  const hasSub = subH > 0
  let y = sy + (sh - (titleH + (hasSub ? gap + subH : 0))) / 2
  if (t.length) { const r1 = vChars(cx, y, t, fs, INK, f, 1.12, true); o.push(r1.svg); y += r1.h }
  if (hasSub) {
    const subY = y + gap
    const colGap = fsS * 1.75                       // 两行中心距：容得下一格字 + 行间留白
    if (v.length) o.push(vChars(cx + colGap / 2, subY, v, fsS, INK, f, 1.2).svg)   // 册名 → 右行
    if (a.length) o.push(vChars(cx - colGap / 2, subY, a, fsS, INK, f, 1.2).svg)   // 撰者 → 左行
  }
  return o.join('')
}

/* 扉页：居中大字书名 + 册名小字（双行并列）；右行撰者、左行牌记（牌记位稍低）。
 * 开启 flyLines 时，在内框内画两条竖线，把版面分成左中右三栏，三栏文字分别居中对齐。 */
function flyHalf(cfg: SpecialCfg, pad: Pad): string {
  const f = famOf(cfg), fs = cfg.fs, W = HALF_W, H = HALF_H
  const o: string[] = ['<rect width="' + W + '" height="' + H + '" fill="' + cfg.paper + '"/>']
  const bg = resolveBg(cfg.bg)
  if (bg) o.push('<image x="0" y="0" width="' + W + '" height="' + H + '" href="' + esc(bg) + '" preserveAspectRatio="none"/>')
  if (cfg.frame) o.push(doubleFrame(W, H, pad))

  // 内框范围（外框 = pad 边界；内框再内缩 IN）
  const innerL = pad.l, innerR = W - pad.r
  const innerW = Math.max(innerR - innerL, 1)
  const IN = 24                                    // 与 doubleFrame 一致
  const innerTop = pad.t + IN, innerBottom = H - pad.b - IN
  const hasLines = cfg.flyLines
  // 开启分栏线时：左:中:右 = 1:2:1，即各占 1/4、2/4、1/4
  const colCenters = hasLines
    ? [innerL + innerW / 8, innerL + innerW / 2, innerL + innerW * 7 / 8]
    : [W / 2]

  if (hasLines) {
    const x1 = innerL + innerW / 4          // 左栏右边界 = 中栏左边界
    const x2 = innerL + innerW * 3 / 4     // 中栏右边界 = 右栏左边界
    o.push('<line x1="' + x1 + '" y1="' + innerTop + '" x2="' + x1 + '" y2="' + innerBottom +
      '" stroke="' + INK + '" stroke-width="2"/>')
    o.push('<line x1="' + x2 + '" y1="' + innerTop + '" x2="' + x2 + '" y2="' + innerBottom +
      '" stroke="' + INK + '" stroke-width="2"/>')
  }

  const t = chars(cfg.coverTitle), v = chars(cfg.volLabel), a = chars(cfg.coverAuthor), im = chars(cfg.imprint)
  const cellT = fs * 1.18, bh = t.length * cellT
  const vGap = fs * 0.3
  const vCell = fs * 0.5 * 1.2, vh = v.length * vCell
  const blockH = bh + (v.length ? vGap + vh : 0)
  // 书名块（含下方册名）整体在中间栏（无分栏线时即内框整区）内垂直居中
  const colCenterY = (innerTop + innerBottom) / 2
  const ty = colCenterY - blockH / 2
  const midCx = hasLines ? colCenters[1] : colCenters[0]
  const rightCx = hasLines ? colCenters[2] : W * 0.70
  const leftCx = hasLines ? colCenters[0] : W * 0.30
  if (t.length) o.push(vChars(midCx, ty, t, fs, INK, f, 1.18, true).svg)
  if (v.length) o.push(vChars(midCx, ty + bh + vGap, v, fs * 0.5, INK, f, 1.2).svg)
  if (a.length) o.push(vChars(rightCx, H * 0.20, a, fs * 0.40, INK, f, 1.25).svg)
  if (im.length) o.push(vChars(leftCx, H * 0.62, im, fs * 0.38, INK, f, 1.25).svg)
  /* 扉页图章：上传图片存项目 assets/（配置只存文件名），归一化中心坐标 + 正方形框（缩放可调）
   * 必须经 resolveImg 解析成 dataURL —— 直接拼文件名会变成相对路径，预览里加载失败成破图。 */
  if (cfg.stamp) {
    const src = resolveImg(cfg.stamp)
    if (src) {
      const bw = 0.16 * HALF_W * (cfg.stampScale || 1)
      const x = cfg.stampX * HALF_W - bw / 2, y = cfg.stampY * HALF_H - bw / 2
      o.push('<image x="' + n3(x) + '" y="' + n3(y) + '" width="' + n3(bw) + '" height="' + n3(bw) +
        '" href="' + esc(src) + '" preserveAspectRatio="xMidYMid meet"/>')
    }
  }
  return o.join('')
}

/* 尾页：跋尾 / 版权。文字用 "/" 分栏，多栏成组水平居中，最右栏先读 */
function coloHalf(cfg: SpecialCfg, pad: Pad): string {
  const f = famOf(cfg), W = HALF_W, H = HALF_H
  const o: string[] = ['<rect width="' + W + '" height="' + H + '" fill="' + cfg.paper + '"/>']
  const bg = resolveBg(cfg.bg)
  if (bg) o.push('<image x="0" y="0" width="' + W + '" height="' + H + '" href="' + esc(bg) + '" preserveAspectRatio="none"/>')
  if (cfg.frame) o.push(doubleFrame(W, H, pad))
  const fs = 66, cellK = 1.3
  const cols = String(cfg.colophon || '').split('/').map(s => chars(s)).filter(c => c.length)
  if (cols.length) {
    const colGap = fs * 1.15, groupW = (cols.length - 1) * colGap
    const startX = W / 2 + groupW / 2
    for (let i = 0; i < cols.length; i++) {
      const h = cols[i].length * fs * cellK
      o.push(vChars(startX - i * colGap, H / 2 - h / 2, cols[i], fs, INK, f, cellK).svg)
    }
  }
  /* 尾页插图：上传图片存项目 assets/（配置只存文件名），归一化中心坐标 + 正方形框（缩放可调） */
  if (cfg.illus) {
    const src = resolveImg(cfg.illus)
    if (src) {
      const bw = 0.46 * HALF_W * (cfg.illusScale || 1)
      const x = cfg.illusX * HALF_W - bw / 2, y = cfg.illusY * HALF_H - bw / 2
      o.push('<image x="' + n3(x) + '" y="' + n3(y) + '" width="' + n3(bw) + '" height="' + n3(bw) +
        '" href="' + esc(src) + '" preserveAspectRatio="xMidYMid meet"/>')
    }
  }
  return o.join('')
}

/* ---- 对开拼装（返回完整 SVG，尺寸与正文叶一致） ---- */
export type SpecialKind = 'cover' | 'fly' | 'colophon'

/** 半叶内容；null = 素纸衬页（不放任何特殊页）。s = 半叶坐标系 → 纸张的缩放比 */
function halfOf(kind: SpecialKind | null, cfg: SpecialCfg, side: HalfSide, s: number): string {
  const legacy = kind === 'cover' ? 70 : 110      // 无正文边距时的旧固定值（封面 70 / 扉页·尾页 110）
  const pad = padOf(cfg, side, s, legacy, kind === 'cover')   // 仅封面无天头
  if (!kind) {
    const o: string[] = ['<rect width="' + HALF_W + '" height="' + HALF_H + '" fill="' + cfg.paper + '"/>']
    const bg = resolveBg(cfg.bg)
    if (bg) o.push('<image x="0" y="0" width="' + HALF_W + '" height="' + HALF_H + '" href="' + esc(bg) + '" preserveAspectRatio="none"/>')
    return o.join('')
  }
  return kind === 'cover' ? coverHalf(cfg, pad) : kind === 'fly' ? flyHalf(cfg, pad) : coloHalf(cfg, pad)
}

/** 数值格式化：避免浮点长串污染 SVG 属性（导出走严格 XML 解析，保持字符串干净） */
function n3(v: number): string { return String(Math.round(v * 1000) / 1000) }

/** 图章/插图来源解析：文件名 → 经 core/assets 缓存取项目 assets/ 的 dataURL；
 *  dataURL（旧版兼容）原样返回；未就绪返回 null（本帧不画，预热完成后上层触发重渲）。 */
function resolveImg(s: string): string | null {
  if (!s) return null
  if (s.startsWith('data:')) return s
  const info = assetInfo(s)
  return info ? info.url : null
}

/** 底图来源解析：与图章/插图不同，bg 可能是三类值 ——
 *  ① 内置宣纸纹理（相对路径如 textures/xuan.jpg）→ 直接渲染，导出时 embedImages 内联；
 *  ② 旧版内联 dataURL → 原样返回；
 *  ③ 项目 assets/ 文件名（新默认落盘方式）→ 经缓存取 dataURL，未就绪返回 null 本帧不画。 */
function resolveBg(s: string): string | null {
  if (!s) return null
  if (s.startsWith('data:')) return s
  if (s.includes('/')) return s          // 相对路径（内置纹理）
  const info = assetInfo(s)
  return info ? info.url : null
}

/** 对开叶内单个半叶的摆放：等比缩放 + 在半幅内居中（改纸张尺寸也不会错位/溢出） */
function placeHalf(kind: SpecialKind | null, cfg: SpecialCfg, side: HalfSide, W: number, H: number): string {
  const s = Math.min((W / 2) / HALF_W, H / HALF_H)
  const ox = (W / 2 - HALF_W * s) / 2 + (side === 'right' ? W / 2 : 0)
  const oy = (H - HALF_H * s) / 2
  return '<g transform="translate(' + n3(ox) + ',' + n3(oy) + ') scale(' + n3(s) + ')">' +
    halfOf(kind, cfg, side, s) + '</g>'
}

/** 通用对开叶：左右半叶各放一个特殊页（null = 素纸衬页）。导出按册开关自由组合 */
export function renderSpread(
  left: SpecialKind | null, right: SpecialKind | null,
  cfg: SpecialCfg, W = 3508, H = HALF_H,
): string {
  // width/height 必须显式给出：Image 光栅化需要固有尺寸，仅 viewBox 在部分浏览器会得到 0 尺寸
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" xmlns="http://www.w3.org/2000/svg">' +
    '<rect width="' + W + '" height="' + H + '" fill="' + cfg.paper + '"/>' +
    placeHalf(left, cfg, 'left', W, H) +
    placeHalf(right, cfg, 'right', W, H) + '</svg>'
}

/** 单个特殊页占右半叶、左半衬纸的对开叶（用于封面/尾页独立预览或单页导出） */
export function renderSpecialSpread(kind: SpecialKind, cfg: SpecialCfg, W = 3508, H = HALF_H): string {
  return renderSpread(null, kind, cfg, W, H)
}

/** 卷首对开叶：右半=封面、左半=扉页（右→左阅读顺序：封面 → 扉页 → 正文…） */
export function renderFrontSpread(cfg: SpecialCfg, W = 3508, H = HALF_H): string {
  return renderSpread('fly', 'cover', cfg, W, H)
}

/** 卷尾对开叶：右半=尾页、左半衬纸 */
export function renderBackSpread(cfg: SpecialCfg, W = 3508, H = HALF_H): string {
  return renderSpread(null, 'colophon', cfg, W, H)
}

/** 半叶单页（预览用小 SVG，自带 width/height 缩放）；kind 决定它落在对开的哪半（扉页左、封面/尾页右） */
export function renderHalfPreview(kind: SpecialKind, cfg: SpecialCfg, w = 300): string {
  const side: HalfSide = kind === 'fly' ? 'left' : 'right'
  const inner = halfOf(kind, cfg, side, 1)        // 内含底纸 rect
  return '<svg viewBox="0 0 ' + HALF_W + ' ' + HALF_H + '" width="' + w + '" height="' +
    Math.round(w * HALF_H / HALF_W) + '" xmlns="http://www.w3.org/2000/svg">' + inner + '</svg>'
}
