/**
 * 编辑器「隐藏标记」删除守卫（CodeMirror 键盘层）。
 *
 * 问题：美化态隐藏了 `【】`/`{}`/`[]` 标记，光标却仍能落在它们两侧；一次退格就可能只删掉一端，
 * 留下落单括号 + 退化成正文的内容（用户截图反馈）。
 *
 * 主策略（依用户反馈定，2026-09-21 第二轮）：**跳过看不见的标记，别碰它**。
 * 待删区间若整个都是隐形字符（成对标记 / 独立控制符），就不删它，改删**同侧紧邻的可见字符**——
 * 隐形的东西不参与编辑，退格的手感始终是「作用在看得见的字上」。
 * 上一版是「命中一端就两端一起删（= 取消该标记）」，同样不留下落单括号，但用户按一下退格样式
 * 就整体变了，比删断更难理解，故废弃。
 * 唯一例外：命中某对标记、且**对内已无可见内容** → 视为「取消这个标记」，整对删掉（反正内容是空的）。
 * 代价：美化态下删不掉标记本身，要精确操作标记请切源码态。
 *
 * 兜底：非空选区（拖选 / 剪切）恰好含标记的一端时，仍连带删掉配对端，不至于留下落单括号。
 * 其余一切（普通退格 / 行合并 / 落单标记 / 文档首尾）一律 `return false` 交回 CodeMirror 默认命令。
 *
 * 判定口径全在 `core/markerScan.ts`（纯函数、零依赖，可离线跑探针）。
 */
import { EditorView, keymap } from '@codemirror/view'
import type { Command } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { skipDeleteFor, pairDeleteFor } from './markerScan'
import type { DeleteDir } from './markerScan'

/** 删除 [from,to) 并（可选）连带删掉配对标记；两端按位置升序排好交给 CM。 */
function applyDelete(view: EditorView, from: number, to: number, partner: number | null): boolean {
  const specs = partner == null
    ? [{ from, to }]
    : partner < from
      ? [{ from: partner, to: partner + 1 }, { from, to }]
      : [{ from, to }, { from: partner, to: partner + 1 }]
  view.dispatch({ changes: specs, userEvent: 'delete', scrollIntoView: true })
  return true
}

/** 主策略：待删位置落在隐形字符上时，把动作重定位到同侧可见字符（返回 false = 不接管）。 */
function skipHidden(view: EditorView, dir: DeleteDir): boolean {
  const sel = view.state.selection.main
  if (!sel.empty) return false                       // 有选区：走兜底判定
  if (dir === 'backward' && sel.from === 0) return false
  const from = dir === 'backward' ? sel.from - 1 : sel.from
  const to = dir === 'backward' ? sel.from : sel.from + 1
  const plan = skipDeleteFor(view.state.doc.toString(), from, to, dir)
  if (!plan) return false
  /* 已接管：同侧没有可见字符可删（文档首/尾，或外侧仍是隐形标记链）→ 按了也不该动，
     否则默认命令会真去删那个看不见的标记。 */
  if (plan.kind === 'none') return true
  view.dispatch({ changes: { from: plan.from, to: plan.to }, userEvent: 'delete', scrollIntoView: true })
  return true
}

/** 兜底：非空选区含标记一端 → 连带删配对（拖选/剪切不留落单括号）。 */
function pairDelete(view: EditorView, dir: DeleteDir): boolean {
  const sel = view.state.selection.main
  const from = sel.empty ? (dir === 'backward' ? sel.from - 1 : sel.from) : sel.from
  const to = sel.empty ? (dir === 'backward' ? sel.from : sel.from + 1) : sel.to
  const partner = pairDeleteFor(view.state.doc.toString(), from, to)
  return partner == null ? false : applyDelete(view, from, to, partner)
}

/** 退格：光标前一个字符若看不见（标记/控制符），跳过它去删左侧的可见字。 */
export const deleteBackwardKeepMarkers: Command = view =>
  skipHidden(view, 'backward') || pairDelete(view, 'backward')

/** 删除键：光标后一个字符同理，跳过它去删右侧的可见字。 */
export const deleteForwardKeepMarkers: Command = view =>
  skipHidden(view, 'forward') || pairDelete(view, 'forward')

/**
 * 守卫键位。用 `Prec.highest` 保证排在 basicSetup 的 defaultKeymap 之前被匹配
 * （keymap 优先级：先声明或高优先级者先检查），未接管时返回 false，默认命令照常执行。
 */
export const markerGuardKeymap = Prec.highest(keymap.of([
  { key: 'Backspace', run: deleteBackwardKeepMarkers },
  { key: 'Delete', run: deleteForwardKeepMarkers },
]))
