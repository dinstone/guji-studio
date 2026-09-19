/* 纸张规格换算与匹配 —— 300dpi 下像素 <=> 物理尺寸
 * 用于 Inspector / 模板库摘要：提示用户当前纸幅需要哪张常规打印纸 */

export type Orientation = 'landscape' | 'portrait'

export interface PaperSize {
  key: string
  name: string
  /** 短边 × 长边（mm） */
  mm: [number, number]
  /** 非 mm 尺寸时显示原尺寸名 */
  rawLabel?: string
}

const MM_PER_INCH = 25.4
const DPI = 300

export const PAPER_SIZES: PaperSize[] = [
  { key: 'a4', name: 'A4', mm: [210, 297] },
  { key: 'a5', name: 'A5', mm: [148, 210] },
  { key: 'b5', name: 'B5', mm: [176, 250] },
  { key: '16k', name: '16开', mm: [187, 260] },
  { key: '32k', name: '32开', mm: [130, 184] },
  { key: 'letter', name: 'Letter', mm: [215.9, 279.4], rawLabel: '8.5×11in' },
]

export function pxToMm(px: number) { return px / DPI * MM_PER_INCH }
export function mmToPx(mm: number) { return Math.round(mm / MM_PER_INCH * DPI) }

/** 按 300dpi 把 px 尺寸换算为物理尺寸并格式化 */
export function physicalDims(w: number, h: number) {
  return { w: pxToMm(w), h: pxToMm(h) }
}

export function formatMm(n: number, digits = 0) {
  const m = Math.pow(10, digits)
  return String(Math.round(n * m) / m)
}

export function paperPx(p: PaperSize, o: Orientation): [number, number] {
  return o === 'landscape'
    ? [mmToPx(p.mm[1]), mmToPx(p.mm[0])]
    : [mmToPx(p.mm[0]), mmToPx(p.mm[1])]
}

export function paperMm(p: PaperSize, o: Orientation): [number, number] {
  return o === 'landscape' ? [p.mm[1], p.mm[0]] : [p.mm[0], p.mm[1]]
}

/** 生成下拉列表用的 label，例如 "A4 横向 210×297mm (3508×2480px @300dpi)"
 *  物理尺寸名保持纸的固定标称（210×297 / 8.5×11in），仅 px 随方向 swap。 */
export function paperLabel(p: PaperSize, o: Orientation) {
  const [pw, ph] = paperPx(p, o)
  const dim = p.rawLabel || `${formatMm(p.mm[0])}×${formatMm(p.mm[1])}mm`
  return `${p.name} ${o === 'landscape' ? '横向' : '纵向'} ${dim} (${pw}×${ph}px @300dpi)`
}

export interface PaperMatch {
  paper: PaperSize
  orientation: Orientation
  px: [number, number]
  mm: [number, number]
  /** 面积差相对当前纸幅的比例（越小越接近） */
  areaRatio: number
  fits: boolean
}

export interface MatchResult {
  current: { w: number; h: number; wMm: number; hMm: number }
  /** 能完整装下当前纸幅的最小常规纸 */
  fits?: PaperMatch
  /** 与当前纸幅面积最接近的常规纸（可能装不下） */
  nearest: PaperMatch
}

/** 根据当前 px 宽高，计算物理尺寸并推荐最小常规打印纸 */
export function matchPaper(w: number, h: number): MatchResult {
  const currentMm = physicalDims(w, h)
  const currentArea = w * h

  const candidates: PaperMatch[] = []
  for (const p of PAPER_SIZES) {
    for (const o of ['landscape', 'portrait'] as Orientation[]) {
      const [pw, ph] = paperPx(p, o)
      const [mw, mh] = paperMm(p, o)
      const fits = pw + 1 >= w && ph + 1 >= h
      candidates.push({
        paper: p,
        orientation: o,
        px: [pw, ph],
        mm: [mw, mh],
        areaRatio: Math.abs(pw * ph - currentArea) / Math.max(currentArea, 1),
        fits,
      })
    }
  }

  const fitting = candidates
    .filter(c => c.fits)
    .sort((a, b) => a.px[0] * a.px[1] - b.px[0] * b.px[1])

  const nearest = candidates.slice().sort((a, b) => a.areaRatio - b.areaRatio)[0]

  return {
    current: { w, h, wMm: currentMm.w, hMm: currentMm.h },
    fits: fitting[0],
    nearest,
  }
}

/** 当前 px 是否精确匹配某个常规尺寸（±1px 容差） */
export function exactPaper(w: number, h: number): { paper: PaperSize; orientation: Orientation } | null {
  for (const p of PAPER_SIZES) {
    for (const o of ['landscape', 'portrait'] as Orientation[]) {
      const [pw, ph] = paperPx(p, o)
      if (Math.abs(pw - w) <= 1 && Math.abs(ph - h) <= 1) return { paper: p, orientation: o }
    }
  }
  return null
}
