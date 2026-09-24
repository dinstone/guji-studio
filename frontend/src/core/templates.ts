/* 新建向导版式预览 + 工具
 * - 向导第二步「模板」tab 的候选直接复用 core/presets.ts 的 BUILTIN_TPLS（出厂内置模板库，唯一真源）。
 * - buildTemplate：把差异 overrides 合并进引擎 DEFAULT_TEMPLATE，产出可整体预览的完整 map。
 * - diffFromDefault：从完整版式 params 中提取相对默认的差异键，写入 book.gvs.Template 时只存变化（遵守书级只存差异铁律）。
 * - pagePreviewSVG：根据版式参数生成一张缩略 SVG 示意图（版框 + 列 + 中缝鱼尾 + 竖排示例字），用于模板卡片与自定义实时预览。 */
import { LayoutEngine } from './engine'
import { FAMS } from './schema'
import { CONTENT_KEYS, PAPER_DEFS } from './presets'

/** 纸张尺寸预设（自定义 tab 的快速选择）：复用 presets.ts 的规范尺寸，末尾附「自定义」 */
export const PAPER_SIZES: { id: string; name: string; w: number; h: number }[] = [
  ...PAPER_DEFS.map(d => ({ id: d.id, name: d.name, w: d.w, h: d.h })),
  { id: 'custom', name: '自定义', w: 0, h: 0 },
]

/** 把差异 overrides 合并进引擎默认，产出可整体预览的完整 map */
export function buildTemplate(overrides: Record<string, any> = {}): Record<string, any> {
  return { ...(LayoutEngine.DEFAULT_TEMPLATE as Record<string, any>), ...overrides }
}

/** 从完整版式 params 中提取相对引擎 DEFAULT_TEMPLATE 的「差异」键。
 *  - 跳过内容字段（CONTENT_KEYS：书名/卷名由书注入，不该落盘成模板差异）；
 *  - 仅保留与默认值不同的键；params 里 DEFAULT 没有的键也保留（防御性）。
 * 写入 book.gvs.Template 时只存这些差异，遵守「书级默认只存差异、不复制全量」铁律。 */
export function diffFromDefault(p: Record<string, any>): Record<string, any> {
  const D = LayoutEngine.DEFAULT_TEMPLATE as Record<string, any>
  const skip = new Set<string>(CONTENT_KEYS as readonly string[])
  const out: Record<string, any> = {}
  for (const k in D) {
    if (skip.has(k)) continue
    if (!Object.is(p[k], D[k])) out[k] = p[k]
  }
  for (const k in p) {
    if (!(k in D) && !skip.has(k)) out[k] = p[k]
  }
  return out
}

function num(v: any, d: number): number {
  const n = parseFloat(v as string)
  return isFinite(n) ? n : d
}

const SAMPLE = '道可道非常名樸雖小天下莫能臣侯王若能守萬物將自賓'

/** 生成一张版式缩略 SVG（字符串）。viewBox 按纸张比例自适应，外部用 v-html 注入。 */
export function pagePreviewSVG(p: Record<string, any>): string {
  const W = num(p.canvas_width, 3508)
  const H = num(p.canvas_height, 2480)
  const THUMB = 240
  const sc = THUMB / Math.max(W, H)            // 等比缩放（保持横竖比例）
  const tw = W * sc
  const th = H * sc
  const mT = num(p.margins_top, 240) * sc
  const mB = num(p.margins_bottom, 80) * sc
  const mL = num(p.margins_left, 70) * sc
  const mR = num(p.margins_right, 70) * sc
  const bx = mL, by = mT, bw = tw - mL - mR, bh = th - mT - mB
  const cols = Math.max(1, Math.round(num(p.leaf_col, 16)))
  const colW = bw / cols
  const seamW = num(p.leaf_center_width, 150) * sc
  const fishMode = p.fish_mode || 'double'
  const ifSeam = p.if_seam || 'double'
  const fam = LayoutEngine.familyStack(p.text_font_family || 'song_tc', 'song_tc')
  const rowN = Math.max(4, Math.round(num(p.row_num, 22)))
  const charH = Math.min(colW * 0.82, bh / Math.min(rowN, 8) * 0.9)

  const parts: string[] = []
  // 纸张
  parts.push(`<rect x="0" y="0" width="${tw.toFixed(1)}" height="${th.toFixed(1)}" fill="#fdfcf7" stroke="#d8d4c8" stroke-width="1"/>`)
  // 版心框
  parts.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="none" stroke="#3a3a3a" stroke-width="1.4"/>`)
  // 列竖线
  for (let i = 1; i < cols; i++) {
    const x = bx + i * colW
    parts.push(`<line x1="${x.toFixed(1)}" y1="${by.toFixed(1)}" x2="${x.toFixed(1)}" y2="${(by + bh).toFixed(1)}" stroke="#c9c4b6" stroke-width="0.6"/>`)
  }
  // 中缝 + 鱼尾
  const cx = bx + bw / 2
  if (ifSeam !== 'none') {
    const half = seamW / 2
    parts.push(`<line x1="${(cx - half).toFixed(1)}" y1="${by.toFixed(1)}" x2="${(cx - half).toFixed(1)}" y2="${(by + bh).toFixed(1)}" stroke="#9a958a" stroke-width="0.6"/>`)
    parts.push(`<line x1="${(cx + half).toFixed(1)}" y1="${by.toFixed(1)}" x2="${(cx + half).toFixed(1)}" y2="${(by + bh).toFixed(1)}" stroke="#9a958a" stroke-width="0.6"/>`)
  } else {
    parts.push(`<line x1="${cx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(by + bh).toFixed(1)}" stroke="#9a958a" stroke-width="0.6"/>`)
  }
  if (fishMode !== 'none') {
    const fs = Math.min(seamW * 1.6, bh * 0.06)
    // 上鱼尾（倒置三角/弧）
    parts.push(`<path d="M ${(cx - fs).toFixed(1)} ${(by + fs).toFixed(1)} Q ${cx.toFixed(1)} ${(by - fs * 0.4).toFixed(1)} ${(cx + fs).toFixed(1)} ${(by + fs).toFixed(1)} Z" fill="#3a3a3a"/>`)
    // 下鱼尾
    parts.push(`<path d="M ${(cx - fs).toFixed(1)} ${(by + bh - fs).toFixed(1)} Q ${cx.toFixed(1)} ${(by + bh + fs * 0.4).toFixed(1)} ${(cx + fs).toFixed(1)} ${(by + bh - fs).toFixed(1)} Z" fill="#3a3a3a"/>`)
  }
  // 竖排示例字：每列若干字
  const perCol = Math.min(rowN, 7)
  let idx = 0
  for (let c = 0; c < cols; c++) {
    const x = bx + colW * (c + 0.5)
    for (let r = 0; r < perCol; r++) {
      const y = by + charH * (r + 0.9)
      const ch = SAMPLE[idx % SAMPLE.length]
      idx++
      parts.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${fam.replace(/"/g, '&quot;')}" font-size="${charH.toFixed(1)}" fill="#2b2b2b" text-anchor="middle">${ch}</text>`)
    }
  }
  return `<svg viewBox="0 0 ${tw.toFixed(1)} ${th.toFixed(1)}" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`
}

/** 取预设/自定义参数的人类可读摘要（第三步确认页用） */
export function templateSummary(p: Record<string, any>): { paper: string; margins: string; layout: string; font: string } {
  const W = Math.round(num(p.canvas_width, 3508) / 300 * 25.4)
  const H = Math.round(num(p.canvas_height, 2480) / 300 * 25.4)
  const orient = (p.canvas_width || 3508) >= (p.canvas_height || 2480) ? '横' : '竖'
  const famLabel = FAMS.find((f) => f[0] === p.text_font_family)?.[1] || '宋体·繁'
  return {
    paper: `${orient}开本 · ${W}×${H}mm（${Math.round(num(p.canvas_width, 3508))}×${Math.round(num(p.canvas_height, 2480))}px）`,
    margins: `上${num(p.margins_top, 240)} 下${num(p.margins_bottom, 80)} 左${num(p.margins_left, 70)} 右${num(p.margins_right, 70)}`,
    layout: `${num(p.leaf_col, 16)} 列 × 每列 ${num(p.row_num, 22)} 字`,
    font: famLabel + (p.fish_mode && p.fish_mode !== 'none' ? ' · 含鱼尾中缝' : ' · 无中缝'),
  }
}
