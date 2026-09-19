/**
 * 编辑器「美化 / 源码」内联装饰（方案一）。
 *
 * 思路：不在编辑器里重写排版，只用 CodeMirror 6 的 Decoration 把源文标记「翻译」成视觉样式：
 *   - `#` / `##` 行首标记隐藏，章题/二级标题文本放大、变红；
 *   - `【…】` 夹注 → 行间小注样式，括号隐藏；
 *   - `字^拼音^` 注音 → 真 ruby 控件（拼音落字上方），分隔符取自解析后的 tag_ruby；
 *   - `[…]` 强调、`{…}` 徽标 → 对应样式，括号隐藏；
 *   - 独立标记 `@ % $ & ~` 隐藏（古籍 DSL 保留符，纯视觉噪音）。
 * 源码态不装饰，显示全部原始标记，便于精确定位与编辑。
 *
 * 注音分隔符与引擎一致：引擎把 tag_ruby（默认 `^^`）拆成首尾字符当分隔符，源文里实际写作
 * 单 caret `字^拼音^`。装饰模块直接读解析后的 tag_ruby，因此用户改过某单元 ruby 标记符也能对齐。
 */
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view'
import { StateField, StateEffect, RangeSetBuilder } from '@codemirror/state'
import { resolveTplBlock, curUnit } from '../stores/app'

/** 转义正则特殊字符（用于把 tag_ruby 的分隔符安全拼进正则）。 */
function reEsc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 美化开关：true=美化态，false=源码态。通过 effect 切换，ViewPlugin 监听后重建装饰。 */
export const setBeautify = StateEffect.define<boolean>()

export const beautifyField = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBeautify)) return e.value
    return value
  },
})

/** 预览→编辑器联动高亮：预览里点中的字，在编辑器里加红色背景，醒目且与原生选区解耦。 */
export const setLinkHighlight = StateEffect.define<{ from: number; to: number } | null>()

const linkMark = Decoration.mark({ class: 'cm-link-hl' })

export const linkHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(setLinkHighlight)) {
        deco = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none
      }
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f),
})

/* 注音控件：不依赖原生 <ruby>（在 CodeMirror contenteditable 里原生 ruby 既会把 rt 显示异常、
 * 又会把光标困在控件内部导致左侧文字选不中）。改为 span + 绝对定位拼音，CSS 保证拼音在基字上方，
 * 且控件是普通内联元素，CM 能在两侧落光标、跨选。 */
class RubyWidget extends WidgetType {
  constructor(readonly base: string, readonly rt: string) { super() }
  eq(o: RubyWidget) { return o.base === this.base && o.rt === this.rt }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-ruby'
    const base = document.createElement('span')
    base.className = 'cm-ruby-base'
    base.textContent = this.base
    const rt = document.createElement('span')
    rt.className = 'cm-rt'
    rt.textContent = this.rt
    wrap.appendChild(base)
    wrap.appendChild(rt)
    return wrap
  }
  /* 不忽略事件：让选区能跨过注音控件（否则注音字无法被框选）。拼音 .cm-rt 另有 pointer-events:none + user-select:none，只选基字。 */
  ignoreEvent() { return false }
}

/* 隐藏标记符（# 【 】 @ % $ & ~）：用 replace({}) 把字符从 DOM 彻底移除（与 demo 一致），
   而非 font-size:0 的零宽 span——后者会搞乱 CM contenteditable 的选区命中，导致【】夹注等内层选不中。 */
const hiddenMark = Decoration.replace({})
const chapterMark = Decoration.mark({ class: 'cm-chapter' })
const subMark = Decoration.mark({ class: 'cm-sub' })
const commentMark = Decoration.mark({ class: 'cm-comment' })
const emphMark = Decoration.mark({ class: 'cm-emph' })
const badgeMark = Decoration.mark({ class: 'cm-badge' })

interface D { from: number; to: number; deco: Decoration; replace?: boolean }

/** 扫描一行内联标记。start = 该行在文档中的绝对起始下标；text = 该行文本；rubyRe = 注音正则（按 tag_ruby 动态生成）。 */
function scanInline(start: number, text: string, out: D[], rubyRe: RegExp) {
  // 注音：基字（可多汉字）+ 拼音（分隔符取自解析后的 tag_ruby，默认单 caret ^）
  let m: RegExpExecArray | null
  while ((m = rubyRe.exec(text))) {
    const base = m[1]
    const rt = m[2]
    const from = start + m.index
    const to = from + m[0].length
    out.push({ from, to, deco: Decoration.replace({ widget: new RubyWidget(base, rt) }), replace: true })
  }
  // 独立标记 @ % $ & ~ 隐藏
  const lone = /[@%$&~]/g
  let l: RegExpExecArray | null
  while ((l = lone.exec(text))) {
    const p = start + l.index
    out.push({ from: p, to: p + 1, deco: hiddenMark })
  }
}

/** 整篇扫描包裹类标记（允许跨行）。开/闭标记隐藏，内层加样式。 */
function wrapFull(docText: string, re: RegExp, inner: Decoration, out: D[]) {
  let mm: RegExpExecArray | null
  while ((mm = re.exec(docText))) {
    const openLen = mm[1].length
    const closeLen = mm[3].length
    const innerFrom = mm.index + openLen
    const innerTo = mm.index + mm[0].length - closeLen
    out.push({ from: mm.index, to: innerFrom, deco: hiddenMark })
    out.push({ from: innerTo, to: mm.index + mm[0].length, deco: hiddenMark })
    if (innerFrom < innerTo) out.push({ from: innerFrom, to: innerTo, deco: inner })
  }
}

function buildDeco(view: EditorView, beautify: boolean): DecorationSet {
  if (!beautify) return Decoration.none
  const doc = view.state.doc
  const all: D[] = []
  // 注音分隔符取当前单元解析后的 tag_ruby（引擎同样把 tag_ruby 拆成首尾字符当分隔符）
  let tagR = '^^'
  try { tagR = String((resolveTplBlock(curUnit()) as any)?.tag_ruby || '^^') } catch { /* 单元未就绪时回落默认 */ }
  const rOpen = tagR.charAt(0) || '^'
  const rClose = tagR.charAt(1) || rOpen
  /* 注音 base = 紧邻开标记前的一个汉字（与引擎一致：engine 把 ^拼音^ 挂到「紧邻的上一个字形」，
     仅单字，不吞前面整段汉字）。用 {1} 而非 +，避免贪心把「前一段无分隔的汉字」也并进 base。 */
  const rubyRe = new RegExp(
    '([\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3007])' +
    reEsc(rOpen) + '([^' + reEsc(rClose) + '\\n]+?)' + reEsc(rClose), 'g')
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    const text = line.text
    const start = line.from
    const h = /^(#{1,2})\s*([\s\S]*)$/.exec(text)
    if (h) {
      const markLen = h[1].length
      const hasSpace = text.length > markLen && text[markLen] === ' '
      const hiddenTo = start + markLen + (hasSpace ? 1 : 0)
      all.push({ from: start, to: hiddenTo, deco: hiddenMark })
      if (hiddenTo < line.to) {
        all.push({ from: hiddenTo, to: line.to, deco: markLen === 1 ? chapterMark : subMark })
      }
      // 章题行内可能还有注音等内联标记，从标题起始处继续扫
      scanInline(hiddenTo, text.slice(hiddenTo - start), all, rubyRe)
    } else {
      scanInline(start, text, all, rubyRe)
    }
  }
  // 包裹类允许跨行，必须在整篇文本上扫（按行扫会漏掉换行后的闭括号）
  const docText = doc.toString()
  wrapFull(docText, /([【])([^】]*?)([】])/g, commentMark, all)
  wrapFull(docText, /([{])([^}]*?)([}])/g, badgeMark, all)
  wrapFull(docText, /([\[])([^\]]*?)([\]])/g, emphMark, all)
  // 过滤：replace（ruby 控件）区间覆盖了包裹内层/标记时，去掉重叠的 mark，避免 RangeSet 重叠报错
  const replaces = all.filter(d => d.replace)
  const kept = all.filter(d => {
    if (d.replace) return true
    for (const r of replaces) if (d.from < r.to && r.from < d.to) return false
    return true
  })
  kept.sort((a, b) => a.from - b.from || a.to - b.to)
  const b = new RangeSetBuilder<Decoration>()
  for (const d of kept) if (d.from < d.to) b.add(d.from, d.to, d.deco)
  return b.finish()
}

export const decoPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = buildDeco(view, view.state.field(beautifyField)) }
  update(u: ViewUpdate) {
    const changed = u.docChanged || u.viewportChanged ||
      u.transactions.some(tr => tr.effects.some(e => e.is(setBeautify)))
    if (changed) this.decorations = buildDeco(u.view, u.state.field(beautifyField))
  }
}, { decorations: v => v.decorations })
