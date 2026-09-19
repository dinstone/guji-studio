/* 模板字体就绪检查：列出模板用到的全部字体，标注本机是否存在。
 * 纯函数、无 DOM 强依赖（document.fonts 不可用时乐观返回 true），可 node 探针验证。
 * 检测栈复用 engine 的 familyStack —— 保证「检查结论 == 实际渲染所用字体」。
 * 竖排字形判定在 fontfeature.ts（独立、无引擎依赖）。 */

import { LayoutEngine } from './engine'
import { fontVertSupported, isGenericFont } from './fontfeature'

/* 字体字段键 → 角色中文名（未在表内的按去后缀显示） */
const FONT_ROLE: Record<string, string> = {
  text_font_family: '正文',
  comment_font_family: '夹注',
  accent_font_family: '强调',
  title_font_family: '书名',
  pager_font_family: '页码',
  ruby_font_family: '注音',
}

function firstFamily(stack: string): string {
  return (stack.split(',')[0] || '').replace(/^['"]|['"]$/g, '').trim()
}

/* 本机是否可用该字体族。无 DOM / 不支持 check 时乐观返回 true（不误报）。 */
export function fontAvailable(family: string): boolean {
  if (isGenericFont(family)) return true
  const d: any = (typeof document !== 'undefined') ? document : null
  if (!d || !d.fonts || typeof d.fonts.check !== 'function') return true
  try {
    return d.fonts.check(`16px "${family}"`, '永')
  } catch {
    return true
  }
}

/* 为模板建立「首选字体 → 是否支持竖排字形」映射，供 engine render 时缺 vert 自动 fallback。 */
export function buildVertSupport(p: Record<string, any> | null): Record<string, boolean> {
  const map: Record<string, boolean> = {}
  if (!p) return map
  for (const key of Object.keys(p)) {
    if (!/_font_family$/.test(key)) continue
    /* 注音是横排拉丁小字，永不使用竖排字形（vert），无需参与竖排能力探测 */
    if (key === 'ruby_font_family') continue
    const val = p[key]
    if (val == null || val === '') continue
    const stack = LayoutEngine.familyStack(val, 'song_tc')
    const fam = firstFamily(stack)
    if (map[fam] !== undefined) continue
    map[fam] = fontVertSupported(fam)
  }
  return map
}

/* 渲染前注入竖排字形支持信息；保持原对象引用外的浅拷贝，不污染持久化模板。 */
export function prepareTemplateForRender(p: Record<string, any> | null): Record<string, any> | null {
  if (!p) return p
  return { ...p, _vert_supported: buildVertSupport(p) }
}

export interface FontCheck {
  role: string
  fam: string
  cn: string               // 内置逻辑名的中文别名（如 宋体·繁），自定义字体为空
  builtin: boolean          // 是否内置逻辑名（有兜底栈）
  level: 'ok' | 'warn' | 'err'  // ok=本机有 / warn=逻辑名首选缺有兜底 / err=自定义名完全缺
  vert: boolean             // 是否支持竖排字形（缺 vert 时括号/引号将 fallback rotate）
}

export function checkTemplateFonts(p: Record<string, any> | null): FontCheck[] {
  if (!p) return []
  const out: FontCheck[] = []
  for (const key of Object.keys(p)) {
    if (!/_font_family$/.test(key)) continue
    /* 注音字体只在模板显式开启注音（ruby_show=1）时列出：关/自动档下它不起作用，列出来是噪音 */
    if (key === 'ruby_font_family' && Number(p.ruby_show) !== 1) continue
    const val = p[key]
    if (val == null || val === '') continue
    const stack = LayoutEngine.familyStack(val, 'song_tc')
    const fam = firstFamily(stack)
    const builtin = !!LayoutEngine.FONT_STACKS[val]
    const cn = builtin ? (LayoutEngine.FONT_CN[val] || '') : ''
    const avail = fontAvailable(fam)
    const vert = fontVertSupported(fam)
    out.push({
      role: FONT_ROLE[key] || key.replace(/_font_family$/, ''),
      fam,
      cn,
      builtin,
      level: avail ? 'ok' : (builtin ? 'warn' : 'err'),
      vert,
    })
  }
  // 稳定排序：ok 在前，其次 warn，最后 err
  const rank: Record<FontCheck['level'], number> = { ok: 0, warn: 1, err: 2 }
  out.sort((a, b) => rank[a.level] - rank[b.level])
  return out
}
