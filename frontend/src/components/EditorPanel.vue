<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, Compartment } from '@codemirror/state'
import {
  curChapter, curBlockName, curUnit, isTocUnit, isTocDerived, tocUnit, setTocMode, setTocDerived,
  tplEdit, toast, editorFontSize, setEditorStatus, unitFlowText, setEditorSel, onGotoSource,
} from '../stores/app'
import { beautifyField, setBeautify, decoPlugin, linkHighlightField, setLinkHighlight } from '../core/editorDeco'
import { markerGuardKeymap } from '../core/editorGuard'
import { autoRuby } from '../core/ruby'
import { clearMarkup } from '../core/markup'
import { countChars, countLines } from '../core/textstat'

/* 目录单元：派生 = 正文由「卷/章」结构自动生成（只读、不落盘）；
 * 手动 = 正文落 guide/目录.txt，可直接编辑（与序/跋同形）。 */
const tocView = computed(() => isTocUnit(curUnit()))
/* 条目来源（章名 / ##标题）与 派生/手动状态：都取全局唯一目录单元 */
const tocMode = computed(() => (tocUnit()?.mode as string) || 'chapter')
const tocDerived = computed(() => isTocDerived(tocUnit()))
/* 派生目录 = 只读态（没有可编的正文对象） */
const tocRO = computed(() => tocView.value && tocDerived.value)
/* 是否有可写的正文对象：普通单元需选中章；手动目录有 chapters[0]；派生目录恒为只读（无正文可编） */
const canEdit = computed(() => !tocRO.value && !!curChapter())
/* 未选中章节时给出编辑侧引导，与预览侧「预览」提示区分（派生目录有自己的说明，不提示） */
const noChapter = computed(() => !tocView.value && !curChapter())

/* 编辑器显示的正文：
 * - 派生目录：显示「自动生成的目录」本身（只读），与实际输出一致；
 *   不用 block.chapters —— 那是切回手动时要恢复的手改稿，派生态显示它会与预览打架。
 * - 其余：当前选中章的正文（手动目录就是它的 chapters[0]）。 */
const editorDoc = computed(() => (tocRO.value ? unitFlowText(curUnit()) : (curChapter()?.text || '')))
/* 文档切换键：
 * - 派生目录（只读）：文档就是「当前自动目录」本身，内容变就换 —— 切条目来源 / 改卷名章名都要跟着刷新；
 *   只读态没有会被冲掉的输入，所以这里可以安全地按内容做键。
 * - 可编辑单元/手动目录：只认单元与章的 id，不跟正文内容走，避免与正在输入的内容互刷、光标乱跳。 */
const docKey = computed(() => tocRO.value
  ? `toc|${editorDoc.value}`
  : `${curUnit()?.id || ''}|${curChapter()?.id || ''}`)

const host = ref<HTMLElement | null>(null)
let cm: EditorView | null = null
let swapping = false
const roComp = new Compartment()   // 未选章时把编辑器切到只读
const beautify = ref(true)         // 编辑器美化态（默认开）：隐藏标记符并渲染内联样式

/* ---- 状态栏：字数 / 行数 / 光标位置 ----
   统计口径与「光标位置」都由 CodeMirror 自己报（不用 curChapter().text，避免与正在输入的内容差一帧） */
const stat = reactive({ chars: 0, lines: 1 })
const pos = reactive({ line: 1, col: 1 })
function restat(text: string) {
  stat.chars = countChars(text); stat.lines = countLines(text)
  setEditorStatus(stat.chars, stat.lines, pos.line, pos.col)
}
function reportCursor(state: EditorState) {
  const head = state.selection.main.head
  const ln = state.doc.lineAt(head)
  pos.line = ln.number
  pos.col = head - ln.from + 1
  setEditorStatus(stat.chars, stat.lines, pos.line, pos.col)
}

onMounted(() => {
  cm = new EditorView({
    state: EditorState.create({
      doc: editorDoc.value,
    extensions: [
      /* 隐藏标记的删除守卫：退格/删除命中 `【】`/`{}`/`[]` 的一端时，连带配对一起删
         （= 取消该标记，内容保留），避免只删一端留下落单括号。
         用 Prec.highest + 排在 basicSetup 之前，保证先于 defaultKeymap 匹配。 */
      markerGuardKeymap,
      basicSetup,
      /* 不挂 `markdown()`：源文是自定义古籍 DSL（`[..]` 强调 / `{..}` 徽标 / `【..】` 夹注 / `#` 章题），
         与 markdown 语法直接撞车——lezer-markdown 把 `[任意内容]`（无 `(url)` 也算）判为 Link，
         basicSetup 的 defaultHighlightStyle 给 tags.link / tags.heading 加 `textDecoration: underline`
         （且不改颜色），于是源码态下 `[]` 包住的段落通体黑下划线、`#` 章题被加粗划线。
         这些语义由 core/editorDeco.ts 的美化态装饰负责，不需要 markdown 高亮。
         回归：tools/probe-md-bracket.mjs */
      EditorView.lineWrapping,
      beautifyField,
      decoPlugin,
      linkHighlightField,
      roComp.of(EditorState.readOnly.of(!canEdit.value)),
      EditorView.updateListener.of(u => {
        if (u.docChanged && !swapping) {
          const ch = curChapter()
          if (ch) ch.text = u.state.doc.toString()
        }
        if (u.docChanged) restat(u.state.doc.toString())
        if (u.docChanged || u.selectionSet) reportCursor(u.state)
        if (u.selectionSet) {
          const s = u.state.selection.main
          setEditorSel(s.from, s.to)
        }
      }),
    ],
    }),
    parent: host.value!,
  })
  restat(cm.state.doc.toString())
  reportCursor(cm.state)
  /* 预览点书页字 → 跳转：把光标移到该源文下标（钳到文档范围内）并滚到可见 */
  onGotoSource(i => {
    if (!cm) return
    const idx = Math.max(0, Math.min(i, cm.state.doc.length))
    /* 选中该字（而非仅放光标到字前）：编辑器原生高亮 + 经 editorSel 联动书页 v-sel，
       即为 demo 中的「选中样式」。head 钳到文档尾避免越界。 */
    const end = Math.min(idx + 1, cm.state.doc.length)
    cm.dispatch({
      selection: { anchor: idx, head: end },
      effects: [setLinkHighlight.of({ from: idx, to: end })],
      scrollIntoView: true,
    })
    cm.focus()
  })
})

/* 切单元 / 切章 / 切派生状态：整体替换文档 */
watch(docKey, () => {
  if (!cm) return
  swapping = true
  cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: editorDoc.value } })
  swapping = false
})

/* 无可写正文对象（未选章 / 派生目录）：编辑器置只读，避免空白区还能点进去输入 */
watch(canEdit, v => {
  if (!cm) return
  cm.dispatch({ effects: roComp.reconfigure(EditorState.readOnly.of(!v)) })
})

/* 美化 / 源码 切换：通过 effect 通知装饰插件重建（不触碰文档，零重排闪烁） */
function toggleBeautify() {
  beautify.value = !beautify.value
  if (!cm) return
  cm.dispatch({ effects: setBeautify.of(beautify.value) })
}

/* 标记工具条：行为由 kind 定义，按钮语义清晰可扩展
 * - line：光标所在（选区覆盖）每一行行首插入 open（如 # / ## 标题符号）
 * - char：选区内每一个字前面插入 open（如 @ 占格符号）
 * - wrap：把选中文本包裹在 open/close 中间（如 【】夹注、{} 注释徽标）
 * - insert：在光标处插入 open（如 % 换页标记）
 * - ruby：选区内逐字生成注音标记（异步懒加载拼音词库）；去音由「清除格式」覆盖 */
interface Mark { label: string; title: string; kind: 'line' | 'char' | 'wrap' | 'insert' | 'ruby' | 'clear'; open: string; close?: string }
const MARKS: Mark[] = [
  { label: '#',  title: '一级标题',  kind: 'line', open: '# ' },
  { label: '##', title: '二级标题',  kind: 'line', open: '## ' },
  { label: '@',  title: '占一格空白', kind: 'char', open: '@' },
  { label: '【】', title: '夹注',     kind: 'wrap', open: '【', close: '】' },
  { label: '{}',  title: '注释徽标',  kind: 'wrap', open: '{', close: '}' },
  { label: '[]',  title: '强调样式（[] 包裹片段）', kind: 'wrap', open: '[', close: ']' },
  { label: '%',  title: '换页标记（在光标处另起一张纸）', kind: 'insert', open: '%' },
  { label: '$',  title: '半页标记（跳至下半叶）', kind: 'insert', open: '$' },
  { label: '拼音', title: '注音：给选中文字逐字加拼音（生成 字^pīn^ 标记）', kind: 'ruby', open: '' },
  { label: '清除格式', title: '清除格式：去掉选区内全部标记（# 标题、夹注【】、徽标{}、强调[]、注音、@%$&~），保留文字', kind: 'clear', open: '' },
]
/* 注音标记符取当前单元的生效值（与引擎解析口径一致） */
function rubyTag(): string { return String(tplEdit.tag_ruby || '^^') }
async function insert(m: Mark) {
  if (!cm) return
  const { state } = cm
  const sel = state.selection.main
  const changes: { from: number; to?: number; insert: string }[] = []
  let anchor: number

  /* 注音：整选区替换，一次 dispatch → 单步 undo（去音由「清除格式」覆盖） */
  if (m.kind === 'ruby') {
    if (sel.from === sel.to) {
      toast('请先选中要注音的文字（可只选一个字）')
      return
    }
    const txt = state.sliceDoc(sel.from, sel.to)
    let out = txt
    try {
      out = await autoRuby(txt, rubyTag())
    } catch (e) {
      toast('拼音词库加载失败：' + String(e))
      return
    }
    cm.dispatch({ changes: { from: sel.from, to: sel.to, insert: out }, selection: { anchor: sel.from + out.length } })
    cm.focus()
    return
  }

  /* 清除格式：整选区替换，去掉全部标记、保留文字，一次 dispatch → 单步 undo */
  if (m.kind === 'clear') {
    if (sel.from === sel.to) {
      toast('请先选中要清除格式的文字')
      return
    }
    const txt = state.sliceDoc(sel.from, sel.to)
    const out = clearMarkup(txt, rubyTag())
    if (out === txt) { toast('选区里没有可清除的标记'); return }
    cm.dispatch({ changes: { from: sel.from, to: sel.to, insert: out }, selection: { anchor: sel.from + out.length } })
    cm.focus()
    return
  }

  if (m.kind === 'line') {
    const a = state.doc.lineAt(sel.from).number
    const b = state.doc.lineAt(sel.to).number
    for (let ln = b; ln >= a; ln--) {
      const line = state.doc.line(ln)
      changes.push({ from: line.from, insert: m.open })
    }
    anchor = sel.from + m.open.length
  } else if (m.kind === 'char') {
    if (sel.from === sel.to) {
      changes.push({ from: sel.from, insert: m.open })   // 未选中字符：光标处插入单个符号
      anchor = sel.from + m.open.length
    } else {
      const txt = state.sliceDoc(sel.from, sel.to)
      const out = [...txt].map(c => m.open + c).join('')
      changes.push({ from: sel.from, to: sel.to, insert: out })
      anchor = sel.from + out.length
    }
  } else if (m.kind === 'insert') {
    // 在光标（选区起点）处插入标记，不改动其余文本（如 % 换页标记）
    changes.push({ from: sel.from, insert: m.open })
    anchor = sel.from + m.open.length
  } else {
    const hasSel = sel.from !== sel.to
    const txt = state.sliceDoc(sel.from, sel.to)
    const out = m.open + txt + (m.close || '')
    changes.push({ from: sel.from, to: sel.to, insert: out })
    // 有选中：光标停在包裹后文本末尾；无选中：落入括号内，便于直接输入强调内容
    anchor = hasSel ? sel.from + out.length : sel.from + m.open.length
  }
  cm.dispatch({ changes, selection: { anchor } })
  cm.focus()
}
</script>

<template>
  <section class="ed">
    <div class="bar">
      <!-- 第一层 header：操作对象信息（卷名 / 章名；目录单元右侧放 派生/手动 开关） -->
      <div class="hdr">
        <span class="bk" :title="curBlockName()">{{ curBlockName() }}</span>
        <span class="sl">/</span>
        <span class="ch" :title="curChapter()?.title || '—'">{{ curChapter()?.title || '—' }}</span>
        <!-- header 右侧：目录单元放 派生/手动 开关；美化/源码 常驻居右 -->
        <div class="hdr-right">
          <span v-if="tocView" class="toc-switch">
            <button :class="{ on: tocDerived }" title="派生：目录正文由「正文」结构（卷名 + 章名 / ##标题）自动生成" @click="setTocDerived(true)">派生</button>
            <button :class="{ on: !tocDerived }" title="手动：目录正文可直接编辑，落盘到 guide/目录.txt" @click="setTocDerived(false)">手动</button>
          </span>
          <button class="beauty" :class="{ on: beautify }" @click="toggleBeautify"
            :title="beautify ? '美化：隐藏标记符并把注音/夹注/强调/徽标渲染成对应样式' : '源码：显示全部原始标记'">{{ beautify ? '美化' : '源码' }}</button>
        </div>
      </div>
      <!-- 第二层工具栏：编辑按钮；派生目录换成「条目来源」切换（正文自动生成，无标记可编） -->
      <div v-if="!tocRO" class="marks">
        <button
          v-for="m in MARKS" :key="m.title"
          :title="m.title"
          :disabled="!canEdit"
          @click="insert(m)"
        >{{ m.label }}</button>
      </div>
      <div v-else class="marks toc-marks">
        <span class="lbl">条目来源</span>
        <button :class="{ on: tocMode === 'chapter' }" title="每章单元作为一条目录项" @click="setTocMode('chapter')">章名</button>
        <button :class="{ on: tocMode === 'heading' }" title="扫描卷文流中的二级标题（##）作为目录项" @click="setTocMode('heading')">## 标题</button>
      </div>
    </div>
    <div v-if="tocRO" class="derived-note">
      目录为<strong>派生内容</strong>，由「正文」结构自动生成，无需编辑。<br>
      条目来源：<strong>{{ tocMode === 'heading' ? '## 标题' : '章名' }}</strong>——{{ tocMode === 'heading' ? '扫描各卷卷文流中的二级标题（##）逐条生成目录项' : '每个章单元作为一条目录项' }}。<br>
      在「正文」增删卷或章、调整 ## 标题后，目录会同步刷新。
    </div>
    <div v-else-if="tocView" class="manual-note">
      <strong>手动</strong>目录：正文可直接编辑，保存后落盘到 <code>guide/目录.txt</code>。切回「派生」正文保留，不会被丢弃。
    </div>
    <div class="body">
      <div ref="host" class="cmhost" :class="{ dim: tocRO }" :style="{ '--ed-fs': editorFontSize + 'px' }" />
      <div v-if="noChapter" class="empty-hint">尚未选中章节。在左侧点「＋ 章」新建，或选中一章后在此编辑正文。</div>
    </div>
  </section>
</template>

<style scoped>
.ed { flex: 1; display: flex; flex-direction: column; min-width: 0; border-right: 0.5px solid #d3d1c7; background: #f3f1ec; position: relative; }
/* 两层结构：header（操作对象信息）+ 工具栏（编辑按钮） */
.bar { padding: 5px 10px 7px; background: #fff; border-bottom: 0.5px solid #e3e1d7; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
.hdr { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.bk { flex: none; max-width: 45%; color: #b3b0a2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sl { flex: none; color: #d3d1c7; }
.ch { min-width: 0; color: #444; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.marks { display: flex; gap: 4px; flex-wrap: wrap; }
.marks button { border: 0.5px solid #d3d1c7; background: #faf9f6; border-radius: 4px; font-size: 12px; padding: 1px 7px; cursor: pointer; color: #444; }
.marks button:hover { border-color: #0f6e56; color: #0f6e56; }
.marks button:disabled { opacity: .4; cursor: not-allowed; }
/* 编辑器主体：包一层定位容器，空态提示只覆盖编辑器区域本身（不依赖 bar 高度） */
.body { position: relative; flex: 1; min-height: 0; display: flex; }
.cmhost { flex: 1; overflow: hidden; }
.cmhost.dim { opacity: 0.35; pointer-events: none; }
/* 未选章空态：覆盖在编辑器之上，靠上排布，明确引导编辑动作；
   接收点击（pointer-events:auto），避免穿透到下方只读编辑器 */
.empty-hint { position: absolute; inset: 0; padding: 40px 20px; text-align: center; color: #888780; font-size: 13px; line-height: 1.9; pointer-events: auto; }
/* 字号由状态栏的 A−/A+ 控制：走 CSS 变量注入，不重配 CodeMirror（改字号不触碰文档，零重排闪烁） */
.cmhost :deep(.cm-editor) { height: 100%; font-size: var(--ed-fs, 16px); background: transparent; }
.cmhost :deep(.cm-gutters) { background: transparent; border-right: none; color: #b3b0a2; }
/* header 右侧成组：派生/手动 开关 + 美化/源码 切换，整体居右 */
.hdr-right { margin-left: auto; display: flex; gap: 8px; align-items: center; flex: none; align-self: center; }
/* 目录 header 右侧：派生/手动 分段开关 */
.toc-switch { display: inline-flex; border: 0.5px solid #d3d1c7; border-radius: 5px; overflow: hidden; align-self: center; }
.toc-switch button { border: 0; background: #faf9f6; font-size: 12px; padding: 1px 9px; cursor: pointer; color: #888780; }
.toc-switch button.on { background: #0f6e56; color: #fff; }
/* 目录（派生）工具栏：条目来源 章名 / ## 标题 */
.toc-marks { align-items: center; }
.toc-marks .lbl { font-size: 12px; color: #888780; }
.toc-marks button { border: 0.5px solid #d3d1c7; background: #faf9f6; border-radius: 4px; font-size: 12px; padding: 1px 9px; cursor: pointer; color: #444; }
.toc-marks button:hover { border-color: #0f6e56; color: #0f6e56; }
.toc-marks button.on { border-color: #0f6e56; color: #0f6e56; background: #e1f5ee; }
.derived-note { padding: 26px 22px; font-size: 13px; line-height: 1.9; color: #5f5e5a; background: #faf9f6; border-bottom: 0.5px solid #e3e1d7; }
.derived-note strong { color: #0f6e56; }
/* 手动目录提示：可编辑态只占一行，不挤压编辑器 */
.manual-note { padding: 6px 12px; font-size: 12px; line-height: 1.7; color: #888780; background: #faf9f6; border-bottom: 0.5px solid #e3e1d7; }
.manual-note strong { color: #0f6e56; }
.manual-note code { font-family: Menlo, monospace; font-size: 11px; background: #efece4; border-radius: 3px; padding: 0 3px; }
.cmhost :deep(.cm-scroller) { font-family: 'PingFang SC', sans-serif; }
/* 美化/源码 切换：居右常驻可点 */
.beauty { border: 0.5px solid #d3d1c7; background: #faf9f6; border-radius: 4px; font-size: 12px; padding: 1px 9px; cursor: pointer; color: #5f5e5a; align-self: center; }
.beauty:hover { border-color: #0f6e56; color: #0f6e56; }
.beauty.on { background: #0f6e56; color: #e1f5ee; border-color: #0f6e56; }

</style>

<!-- 美化态装饰样式：作用于 CodeMirror 内部 DOM，必须全局（scoped 不会命中 CM 动态节点） -->
<style>
/* 五类语义色（美化态专用，彼此不撞色）：
     正文 #2c2c2a（继承 body）· 标题/二级标题 朱红 #9e2b25 · 夹注 赭石 #8a6d3b
     · 强调 松绿 #1a7f37 · 徽标 靛蓝 #2f4a9e
   注意美化态是「语义色编码」，与书页实际输出无关——书页默认里标题/正文/夹注/强调全是黑，
   只有徽标是朱红（badge_color）。因此配色目标是**五类互不撞色**，不是复刻书页。
   徽标原先用橙 #b35c00，与夹注赭石、标题朱红挤在同一暖色家族里难以分辨；
   改用五色中唯一的冷色，并放大到与正文同字号 + 加粗 + 描边药丸，一眼可从正文里挑出。 */
.cm-chapter { font-size: 1.5em; font-weight: 700; color: #9e2b25; }
.cm-sub { font-size: 1.2em; font-weight: 600; color: #9e2b25; }
.cm-comment { color: #8a6d3b; font-size: .82em; background: #f3ead6; border-radius: 3px; padding: 0 2px; }
.cm-emph { color: #1a7f37; font-weight: 600; }
/* 落单标记警示：美化态本该隐藏的 `【】`/`{}`/`[]` 若有字符没配对（多半是刚被误删了另一端），
   就把它染成警示红——否则「配对被删断」在美化态里完全看不出，内容悄悄退化成正文。 */
.cm-orphan {
  color: #b3261e; background: #fde7e5;
  border-radius: 3px; padding: 0 1px;
  box-shadow: inset 0 0 0 1px #eeb4ae;
}
.cm-badge {
  color: #2f4a9e; background: #e7ecf9; border: 0.5px solid #bcc8ee;
  border-radius: 999px; padding: 0 7px;
  font-size: 1em; font-weight: 600;
}
/* 夹注里的徽标：.cm-comment 把字号压到 .82em，徽标跟着缩会变得比周围注字还小、更认不出；
   反其道放大一档，保证「徽标恒不小于所在文本」 */
.cm-comment .cm-badge { font-size: 1.15em; }
/* 注音：span 容器相对定位，拼音绝对定位到基字正上方（不用原生 <ruby>，避免 contenteditable 下
 * rt 显示异常 + 光标被控件内部困住导致左侧文字选不中）。padding-top 给拼音留白、避免压到上一行。 */
.cm-ruby { position: relative; display: inline-block; padding-top: .72em; line-height: 1; vertical-align: baseline; }
.cm-ruby-base { color: inherit; }
.cm-ruby .cm-rt {
  position: absolute; top: 0; left: 0; width: 100%;
  text-align: center; font-size: .52em; line-height: 1; color: #888;
  user-select: none; pointer-events: none; white-space: nowrap;
}
/* 预览联动高亮：独立于原生选区，预览里点中的字在编辑器里强制红底，醒目且稳定 */
.cm-link-hl { background: rgba(255, 60, 60, .35); border-radius: 3px; box-shadow: 0 0 0 1px rgba(255, 60, 60, .18); }
/* 联动选区：与预览 v-sel 红一致，让「点书页字 → 编辑器高亮」同样醒目（默认 CM 选区浅蓝不显眼） */
.cmhost :deep(.cm-selectionBackground),
.cmhost :deep(.cm-content ::selection) { background: rgba(255, 82, 82, .26) !important; }
.cmhost :deep(.cm-focused .cm-selectionBackground) { background: rgba(255, 82, 82, .34) !important; }
</style>
