import { computed, nextTick, reactive, ref, watch } from 'vue'
import { LayoutEngine } from '../core/engine'
import { buildTocTextWithPages, scanTocHeadings } from '../core/toc'
import { cachedChars } from '../core/textstat'
import {
  SPECIAL_DEFAULT, SPECIAL_PAGES_DEFAULT,
  type SpecialCfg, type SpecialPages,
} from '../core/special'
import { BUILTIN_TPLS, CONTENT_KEYS, stripContent, type TplItem } from '../core/presets'
import { hasRuby } from '../core/ruby'

/* 目录（派生单元）默认版式差异：版心略放宽让「章名 + 页码」排得开，
 * 一/二级标题字号加大、正文行距宽松，便于检索。
 * 只保留与引擎 DEFAULT_TEMPLATE 不同的键（与「单元模板只存差异」铁律一致）；
 * 否则会把 canvas_background_image:'' 等默认值也写进覆盖，冲掉书级宣纹等生效值。
 * 随「新增目录」单元自动挂上，走「本单元」覆盖机制，Inspector 可继续微调。
 * 注：这是单元级参数，不属于整书级模板库（库项套用会全量替换整书版式，故不放库）。 */
export const TOC_TPL: Record<string, any> = {
  leaf_center_width: 200,                          // 默认 150
  chapter1_font_delta: 18,                         // 默认 12
  chapter2_font_delta: 12,                         // 默认 8
  margins_top: 260, margins_bottom: 120,           // 默认 240 / 80
  text_ydis: 1.12,                                 // 默认 1.05（自动档：字格锁死，此项只收字号 → 目录字略小、字间更疏）
  /* 历史沿革：原先从库项 b_toc 提取差异，而 b_toc 由 mk() 生成时会把内容字段清空，
   * title_text 由 '图书名称' 变 ''、不等于默认故未被过滤掉 —— 即目录页版心不显示书名。
   * 该行为已存在，此处按原样保留（要去掉让目录页显示书名，删掉这一行即可）。 */
  title_text: '',
}
import * as plat from '../platform/wails'
import { startAutoCheck, getLastUpdate } from '../platform/update'
import type { CheckUpdateResult } from '../platform/update'
import { assetInfo, setAssetDir } from '../core/assets'
import { appConfirm, appPrompt } from './dialog'

/* 全局状态：纯前端 reactive（桌面版持久化后续走 Go settings 服务，不用 localStorage） */

/* ---------------------------------------------------------------- 数据模型（v3 三文件）
 * 磁盘布局：book.gvs（全局信息+书级版式默认+书级特殊页默认）/ setting.json（文章池+卷+固定角色单元+包装叶 patch）/
 * publish.json（册：front/chapters/back 三段式）/ text|guide|appendix 平铺正文。
 * 包装叶（封面/扉页/尾页）的覆盖 patch 属于排版设置，落在 setting.json.packs（而非 book.gvs），
 * 且扁平化、与 SpecialCfg 同构（不再区分 template/fields）。
 * 归一化：正文/卷/册之间一切引用走章 id；文件名由 title 派生（重名 -2）；
 * 导读/附录为固定角色单文件（序/目录/跋/牌记，不能改名，按名引用）；目录派生不落盘。
 * 前端工作模型：卷/单元仍持有 Chapter 对象（零改 UI/树/目录流），
 * 序列化层（toFlat/applyFlat）负责 ↔ 文章池 + id 数组互转。
 * 版式/特殊页继承：书级默认（template / special）+ 单元级覆盖补丁（只存差异字段）。 */

export type Folder = 'pack' | 'guide' | 'scrolls' | 'appendix'

export interface Chapter { id: string; title: string; file: string; text: string }

/** 包装叶 patch：扁平覆盖（与 SpecialCfg 同构，不分 template/fields），键存在 = 该叶要输出 */
export type Patches = Record<string, any>
/** 包装三叶（可选存在；nil = 不出该叶） */
export interface PackPatches { cover?: Patches; fly?: Patches; colophon?: Patches }

/** 卷文的一个卷（逻辑分组）：前端持有章对象，落盘时归一化为章 id 数组 */
export interface Volume {
  id: string
  name: string
  template?: Record<string, any>
  chapters: Chapter[]
}
/** 导读/附录单元（序/凡例/目录/跋/题识/牌记/空白） */
export interface Block {
  id: string
  name: string
  type: string   // preface|notes|toc | postscript|inscription|imprint|blank
  derived?: boolean
  mode?: string   // 目录条目来源：chapter=章名 / heading=##标题（仅 type==='toc' 用）
  template?: Record<string, any>
  chapters: Chapter[]
}
/** 册内一个选组：pack/guide/appendix 单值 = 该组选哪个（顺序完全由 front/back 数组顺序决定） */
export interface PubGroup {
  pack?: string
  guide?: string
  appendix?: string
}
/** 正文选取：整卷（chapters 空）或卷内选章 */
export interface PubChapters { volume: string; chapters?: string[] }
/** 一册（物理装订视图）：front 前辅文 + chapters 正文 + back 后辅文，段内组间有序 */
export interface Publication {
  id: string          // 前端生成（键用），不落盘
  title: string
  template?: Record<string, any>
  front: PubGroup[]
  chapters: PubChapters[]
  back: PubGroup[]
}

export interface BookProj {
  name: string
  meta: { title: string; author: string }
  tree: {
    pack: PackPatches
    guide: Block[]
    scrolls: Volume[]
    appendix: Block[]
  }
  pubs: Publication[]
}

export function uid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) }
function mkChap(title: string, text: string): Chapter { return { id: uid(), title, file: (title || '未命名') + '.txt', text } }
function mkVol(name: string, chaps: [string, string][]): Volume {
  return { id: uid(), name, chapters: chaps.map(([t, x]) => mkChap(t, x)) }
}
function mkBl(name: string, type: string, chaps: [string, string][]): Block {
  return { id: uid(), name, type, chapters: chaps.map(([t, x]) => mkChap(t, x)) }
}

/* ---- 版式：书级默认 + 单元级覆盖 ---- */
export const tpl = reactive<Record<string, any>>({ ...LayoutEngine.DEFAULT_TEMPLATE })
tpl.title_text = '道德經'

/** 书级默认特殊页（封面/扉页/尾页字段与样式）：叶子未覆盖的字段即取这里 */
export const bookSpecial = reactive<SpecialCfg>({
  ...SPECIAL_DEFAULT,
  pages: { ...SPECIAL_PAGES_DEFAULT },
})

/* 编辑作用域：book = 改全书默认；unit = 只改当前单元（写时才建覆盖，未动过的字段仍跟随全书） */
export const tplScope = ref<'book' | 'unit'>('book')
/* 特殊页作用域：book = 改书级默认（三叶共用）；leaf = 只改当前包装叶（封面/扉页/尾页）
 * 封装设计页的「全书 / 封面 / 扉页 / 尾页」四个页签即由它派生，默认落在「全书」。 */
export const spScope = ref<'book' | 'leaf'>('book')

/* ---- 视图 ---- */
export const view = reactive({
  rail: 'book',     // 系统栏当前视图：book | layout | cover | export | settings
  sidebar: 1,
  inspector: 0,    // 版式参数面板默认收起（右侧细条，点开）
  src: 'chapter' as 'chapter' | 'volume' | 'book',   // 预览内容源：chapter 单章 | volume 本卷 | book 全书合订
  guides: 0,
  rulers: 0,    // 尺寸标尺显示开关
  zoom: 100,
})

/* 编辑器（CodeMirror）宽度：可在编辑框与预览之间拖拽分隔条调整；仅内存态，不持久化 */
export const editorWidth = ref(420)

/* ---- 统一底部状态栏数据（EditorPanel / PreviewPanel 写入，StatusBar 读取） ---- */
export const editorStatus = reactive({ chars: 0, lines: 1, line: 1, col: 1 })
export function setEditorStatus(chars: number, lines: number, line: number, col: number) {
  editorStatus.chars = chars
  editorStatus.lines = lines
  editorStatus.line = line
  editorStatus.col = col
}

/* ---- 编辑器 ↔ 预览 双向联动 ----
 * 前提：engine.renderPage 给每个渲染字写了 data-i（= 该字在源文原始文本里的下标）。
 * - editorSel：编辑器当前选区（源文下标 [from,to)），EditorPanel 在选区变化时写入；
 * - setEditorSel：同上，active 表示是否为非空选区（非空才高亮书页）；
 * - 预览点书页字 → gotoSource(index)：EditorPanel 注册回调把光标跳到该源文下标；
 * - linkOn：联动总开关（书页点击跳转 + 选区高亮），可在预览栏关掉。 */
export const editorSel = reactive({ from: 0, to: 0, active: false })
export function setEditorSel(from: number, to: number) {
  editorSel.from = from
  editorSel.to = to
  editorSel.active = from !== to
}
let gotoSourceCb: ((i: number) => void) | null = null
export function onGotoSource(cb: (i: number) => void) { gotoSourceCb = cb }
export function gotoSource(i: number) { if (gotoSourceCb) gotoSourceCb(i) }
export const linkOn = ref(true)
export interface PreviewLayoutInfo {
  contentW: number; contentH: number; gutter: number
  cols: number; rows: number; colW: number; rowH: number; cellH: number
  textFamily: string; textSize: number
  commentFamily: string; commentSize: number
  accentFamily: string; accentSize: number
}
export const previewLayout = reactive<PreviewLayoutInfo>({
  contentW: 0, contentH: 0, gutter: 0,
  cols: 0, rows: 0, colW: 0, rowH: 0, cellH: 0,
  textFamily: '—', textSize: 0,
  commentFamily: '—', commentSize: 0,
  accentFamily: '—', accentSize: 0,
})
export function setPreviewLayout(v: PreviewLayoutInfo) { Object.assign(previewLayout, v) }

/* ---- 正文编辑器字号（用户级偏好）----
 * 与项目无关，故存 Go settings.json（不进项目文件）；仅在 boot 时读回一次，
 * 写入做 400ms 防抖（连点 A+/A− 只落一次盘）。 */
export const ED_FS_MIN = 10
export const ED_FS_MAX = 26
export const ED_FS_DEFAULT = 16
export const editorFontSize = ref(ED_FS_DEFAULT)

/** 启动时读回用户偏好。只在 boot 调一次 —— 混进 refreshRecents 会被「最近项目」的
 *  旧快照回冲，把用户刚调的字号顶掉。 */
export async function initUiPrefs() {
  try {
    const st: any = await plat.getSettings()
    const n = Number(st?.editor_font_size)
    if (Number.isFinite(n) && n >= ED_FS_MIN && n <= ED_FS_MAX) editorFontSize.value = Math.round(n)
  } catch { /* 读不到就用默认 */ }
}

let fsTimer: ReturnType<typeof setTimeout> | undefined
/** 调整编辑器字号（自动钳制到 [10, 26]，防抖落盘） */
export function setEditorFontSize(px: number) {
  const n = Math.max(ED_FS_MIN, Math.min(ED_FS_MAX, Math.round(px)))
  if (n === editorFontSize.value) return
  editorFontSize.value = n
  clearTimeout(fsTimer)
  fsTimer = setTimeout(() => { plat.setEditorFontSize(n).catch(() => {}) }, 400)
}

/* ---- 图书项目（v2：四文件夹树 + 册） ---- */
export const proj = reactive<BookProj>({
  name: '道德经',
  meta: { title: '道德經', author: '' },
  tree: {
    pack: {
      cover: { coverTitle: '道德經', coverAuthor: '', volLabel: '' },
      fly: { coverTitle: '道德經', volLabel: '', coverAuthor: '' },
      colophon: { colophon: '' },
    },
    guide: [
      mkBl('序', 'preface', [['序', '']]),
      { id: uid(), name: '目录', type: 'toc', derived: true, mode: 'chapter',
        template: Object.keys(TOC_TPL).length ? { ...TOC_TPL } : undefined, chapters: [] },
    ],
    scrolls: [
      mkVol('卷一', [
        ['一章 体道', '道可道非常道名可名非常名无名天地之始有名万物之母故常无欲以观其妙常有欲以观其徼此两者同出而异名同谓之玄玄之又玄众妙之门【众妙之门者玄牝之根也】'],
        ['二章 养身', '天下皆知美之为美斯恶已皆知善之为善斯善已故有无相生难易相成长短相形高下相倾音声相和前后相随是以圣人处无为之事行不言之教万物作焉而不辞生而不有为而不恃功成而弗居夫唯弗居是以不去【不辞者不拒也】'],
        ['三章 安民', '不尚贤使民不争不贵难得之货使民不为盗不见可欲使民心不乱是以圣人之治虚其心实其腹弱其志强其骨常使民无知无欲使夫智者不敢为也为无为则无不治'],
      ]),
      mkVol('卷二', [
        ['卅八章 上德', '上德不德是以有德下德不失德是以无德上德无为而无以为下德为之而有以为前识者道之华而愚之始也【华者虚而不实也】是以大丈夫处其厚不居其薄处其实不居其华故去彼取此'],
        ['四十章 反者', '反者道之动弱者道之用天下万物生于有有生于无'],
      ]),
    ],
    appendix: [ mkBl('跋', 'postscript', [['跋', '']]) ],
  },
  pubs: [],
})

/* 示例册「全书」：引用示例卷的动态 id，须在 proj 建好后回填 */
proj.pubs = [{
  id: uid(), title: '全书',
  front: [{ pack: '封面' }, { pack: '扉页' }, { guide: '序' }, { guide: '目录' }],
  chapters: proj.tree.scrolls.map(v => ({ volume: v.id })),
  back: [{ appendix: '跋' }, { pack: '尾页' }],
}]

/* cur：当前选中位置。
 *   folder ∈ {pack, guide, scrolls, appendix}
 *   ui     = 当前文件夹数组中的单元索引（guide/appendix/scrolls 通用）
 *   ci     = 当前单元内的章节索引
 *   leaf   = 包装叶索引（0 封面 / 1 扉页 / 2 尾页，仅 folder==='pack' 时有效） */
export const cur = reactive({ folder: 'scrolls' as Folder, ui: 0, ci: 0, leaf: 0 })

/* ---- 选区访问器 ---- */
function folderUnits(): (Block | Volume)[] {
  if (cur.folder === 'guide') return proj.tree.guide as (Block | Volume)[]
  if (cur.folder === 'scrolls') return proj.tree.scrolls as (Block | Volume)[]
  if (cur.folder === 'appendix') return proj.tree.appendix as (Block | Volume)[]
  return []
}
/** 当前选中单元（guide/scrolls/appendix 的单元；pack 时为 undefined） */
export function curUnit(): Block | Volume | undefined {
  if (cur.folder === 'pack') return undefined
  return folderUnits()[cur.ui]
}
/** 兼容别名（旧 curBlock） */
export function curBlock(): Block | Volume | undefined { return curUnit() }
/** 当前选中章节（pack 时为 undefined） */
export function curChapter(): Chapter | undefined {
  if (cur.folder === 'pack') return undefined
  return curUnit()?.chapters[cur.ci]
}
export function curBlockName(): string {
  if (cur.folder === 'pack') return ['封面', '扉页', '尾页'][cur.leaf] || '包装'
  return curUnit()?.name || '—'
}

export function selectUnit(folder: Folder, ui: number, ci = 0) {
  cur.folder = folder
  cur.ui = ui
  cur.ci = Math.max(0, ci)
  cur.leaf = 0
}
export function selectChapter(folder: Folder, ui: number, ci: number) { selectUnit(folder, ui, ci) }
export function selectLeaf(i: number) { cur.folder = 'pack'; cur.leaf = i }
export function selectFolder(folder: Folder) {
  if (folder === 'pack') { cur.folder = 'pack'; cur.leaf = 0; return }
  const arr = folder === 'guide' ? proj.tree.guide : folder === 'scrolls' ? proj.tree.scrolls : proj.tree.appendix
  cur.folder = folder
  cur.ui = Math.min(cur.ui, Math.max(0, arr.length - 1))
  cur.ci = 0
  cur.leaf = 0
}

/* ------------------------------------------------ 解析层：书级默认 + 单元级覆盖
 * 单元（卷/导读/附录）只存与书级不同的版式字段；读取 = { ...书级, ...覆盖 }。 */

/* 注音「自动」档（ruby_show=2）需要「全书」判定：任意一章含 `^注^` 就全书统一缩字。
 * 必须按全书（而非按章/按卷）判定，否则同一本书里会出现有的单元缩字、有的不缩。 */
export function bookHasRuby(tag = '^^'): boolean {
  const has = (units: (Block | Volume)[]) =>
    units.some(u => (u.chapters || []).some(c => hasRuby(String(c.text || ''), tag)))
  const tr = proj.tree
  return has(tr.guide) || has(tr.scrolls) || has(tr.appendix)
}
/** 全书字数（不含目录这类派生单元 —— 那是自动生成的文本，不是作者写的字）。
 *  逐章走 `cachedChars`：每次按键只重算被改的那一章，其余取缓存（书大了也不会掉帧）。 */
export const bookCharCount = computed(() => {
  const tr = proj.tree
  let n = 0
  for (const u of [...tr.guide, ...tr.scrolls, ...tr.appendix]) {
    if (isTocUnit(u)) continue
    for (const c of (u.chapters || [])) n += cachedChars(c as object, String(c.text || ''))
  }
  return n
})
/** 版心/封面书名的**唯一真源**：项目信息里的「图书名称」（book.gvs.meta.title）；
 *  为空时回落「项目名称」（book.gvs.name）—— 与新建向导/项目信息三处文案
 *  「留空则使用项目名称」对齐（2026-09-21 用户定：按文案补实现）。
 *
 *  绝不回落空串 —— 模板里的 `title_text` 只是投影（导入模板时被 `stripContent` 清空、
 *  旧项目里也可能是空），拿它当渲染值就会让版心书名位静默空白（用户 2026-09-21 反馈：
 *  「模板参数没有设置书名参数时，预览不会填充书名」）。
 *  引擎侧 `String(t.title_text || '').split('')` 对空串得空数组、一个字都不吐，故兜底必须在这里。
 *  最后一级仍留引擎默认占位（「图书名称」），只在项目名也为空时兜底，不出现空白书名位。 */
export function bookTitle(): string {
  const t = String(proj.meta.title || '').trim()
  if (t) return t
  const n = String(proj.name || '').trim()
  if (n) return n
  return String((LayoutEngine.DEFAULT_TEMPLATE as Record<string, any>).title_text || '')
}

/** 解析结果收尾：挂「瞬时」键（只活在内存里的解析产物，绝不回写 book.gvs）。
 *  `_rubyOn` = 引擎唯一读的注音开关：0=关 / 1=开。ruby_show=2 自动档在此按全书判定落地。 */
function finalizeTpl(out: Record<string, any>): Record<string, any> {
  const rs = out.ruby_show == null ? 2 : Number(out.ruby_show)
  out._rubyOn = (rs === 1 || (rs === 2 && bookHasRuby(out.tag_ruby))) ? 1 : 0
  return out
}

export function resolveTplBlock(block?: Block | Volume): Record<string, any> {
  const ov = block?.template
  /* 书名按真源（项目书名）注入**书级层**，位置在单元覆盖之前 ——
     目录这类「有意清空书名」的单元覆盖（`TOC_TPL.title_text = ''`）因此仍照常生效，
     而书级残留的空书名 / 旧书名不会再漏到渲染端。 */
  const base: Record<string, any> = { ...tpl, title_text: bookTitle() }
  if (!ov || !Object.keys(ov).length) return finalizeTpl(base)
  /* 单元模板只应存「与书级不同的差异字段」。若种子/旧数据把引擎默认值
   * （如 canvas_background_image:''）也写进覆盖，会把它后面的书级生效值
   * （如宣纹 textures/xuan.jpg）冲掉——目录等派生单元因此拿不到书级宣纹。
   * 故与引擎默认相同的字段视为「无覆盖」跳过，让书级生效值透传。 */
  const D = LayoutEngine.DEFAULT_TEMPLATE as Record<string, any>
  const out: Record<string, any> = { ...base }
  for (const k of Object.keys(ov)) {
    if (ov[k] === D[k]) continue
    out[k] = ov[k]
  }
  return finalizeTpl(out)
}
/** 解析某单元生效版式 */
export function resolveTplUnit(u?: Block | Volume): Record<string, any> { return resolveTplBlock(u) }
/** 解析当前单元生效版式 */
export function resolveTpl(): Record<string, any> { return resolveTplBlock(curUnit()) }

/* ------------------------------------------------ 派生单元（目录）判别与流文本 ----
 * 目录（type=toc, derived=true）是 guide 中的派生单元：其正文不是手编 .txt，
 * 而是由「卷文」结构自动生成的「卷名 + 章名 + 章首页码」文本。渲染/导出时统一走 unitFlowText。
 * 章首页码需全书模拟分页后才能定位，故 computeTocText 做两遍定稿：
 *   1) 用目录页数估计（首遍取 0）生成目录文本；
 *   2) 用该文本分页得真实目录页数 T，回填章首页码（目录自身占 T 页，后续章顺延）；
 *   3) T 稳定即收敛（目录文本长度变化通常不改变自身页数）。 */
export function isTocUnit(u?: Block | Volume): boolean {
  const b = u as Block | undefined
  return !!b && b.type === 'toc'
}
/** 是否「派生」目录（false = 手动目录，下一步支持直接编辑正文） */
export function isTocDerived(u?: Block | Volume): boolean {
  const b = u as Block | undefined
  return isTocUnit(u) && !!b && b.derived !== false
}
export function tocUnit(): Block | undefined {
  return proj.tree.guide.find(b => isTocUnit(b)) as Block | undefined
}
/** 目录条目来源：chapter=章名 / heading=##标题（落盘到 toc 单元的 mode 字段，随 proj 自动保存） */
export function setTocMode(m: 'chapter' | 'heading') { const t = tocUnit(); if (t) t.mode = m }
/** 目录 派生/手动 切换（手动正文落盘到 guide/目录.txt）。
 *  派生 → 手动：正文为空时用当前派生结果播种——把当前的自动目录「冻结」成可编辑正文再手改，
 *              不从空白开始；已有正文（上次手改的 / 从 guide/目录.txt 载入的）原样保留。
 *  手动 → 派生：手改正文**保留不删**（派生模式不读它，也不写盘），切回手动即恢复，来回切不丢内容。 */
export function setTocDerived(on: boolean) {
  const t = tocUnit()
  if (!t) return
  if (!on) {
    const cur = (t.chapters || []).map(c => c.text).filter(Boolean).join('\n')
    if (!cur) {
      const seed = computeTocText()
      const nm = t.name || '目录'
      t.chapters = [{ id: t.id || uid(), title: nm, file: nm + '.txt', text: seed }]
    }
  }
  t.derived = on
}
/** 把一组字符位置映射到「单元内」0-based 页序（按 tpl 对 text 分页，用 token._pos 反查） */
function pageIndexOfText(tpl: Record<string, any>, text: string, positions: number[]): number[] {
  const norm = String(text || '').replace(/\r\n?/g, '\n')
  const pages = LayoutEngine.paginate(tpl, norm).pages as any[]
  if (!pages.length) return positions.map(() => 0)
  return positions.map(pos => {
    for (let pi = 0; pi < pages.length; pi++) {
      for (const col of pages[pi].cols) {
        for (const it of col.items) {
          if (it._pos != null && it._pos >= pos) return pi
        }
      }
    }
    return pages.length - 1
  })
}
/** 取某单元各章首字所在的 0-based 页序（按「单元内」分页；不依赖 # 标记，章标题为元数据也成立） */
function chapterPageIdx(u: Block | Volume): number[] {
  const chaps = (u.chapters || []) as Chapter[]
  if (!chaps.length) return []
  const norm = (s: string) => String(s || '').replace(/\r\n?/g, '\n')
  const segs = chaps.map(c => norm(c.text))
  const offsets: number[] = []
  let acc = 0
  for (const s of segs) { offsets.push(acc); acc += s.length + 1 }   // +1 为章间 \n
  return pageIndexOfText(resolveTplBlock(u), segs.join('\n'), offsets)
}
/** 由各单元真实分页，计算每章的「全书连续页码」（目录页数 tocPages 计入偏移） */
function buildTocVolEntries(tocPages: number) {
  const out: { name: string; chapters: { title: string; page: number }[] }[] = []
  const toc = tocUnit()
  const headingMode = !!(toc && toc.mode === 'heading')
  let cursor = tocPages
  for (const g of proj.tree.guide) {
    if (isTocUnit(g)) continue
    cursor += LayoutEngine.paginate(resolveTplBlock(g), (g.chapters || []).map(c => c.text).filter(Boolean).join('\n')).pages.length
  }
  for (const vol of proj.tree.scrolls) {
    const vtext = (vol.chapters || []).map(c => c.text).filter(Boolean).join('\n')
    let entries: { title: string; page: number }[]
    if (headingMode) {
      /* 扫卷文流里的二级标题（## 且非 ###），每个 ## 行作为一条目录项，按字符位置定位页码。
       * 扫描与 \r\n 归一同源（scanTocHeadings 返回 norm），保证「参与分页的文本」与
       * 「位置基准」一致——否则偏移与 token._pos 错位会串页。 */
      const { titles, positions, norm } = scanTocHeadings(vtext)
      const pages = titles.length ? pageIndexOfText(resolveTplBlock(vol), norm, positions) : []
      entries = titles.map((t, i) => ({ title: t, page: cursor + (pages[i] ?? 0) + 1 }))
    } else {
      const idx = chapterPageIdx(vol)
      entries = (vol.chapters || []).map((c, i) => ({
        title: c.title || '',
        page: cursor + (idx[i] != null ? idx[i] : (idx[i - 1] ?? 0)) + 1,
      }))
    }
    out.push({ name: vol.name, chapters: entries })
    if (vtext) cursor += LayoutEngine.paginate(resolveTplBlock(vol), vtext).pages.length
  }
  return out
}
/** 生成带页码的目录文本（两遍定稿目录自身页数） */
function computeTocText(): string {
  const toc = tocUnit()
  if (!toc) return ''
  /* 页码行尾对齐：取目录单元生效模板的「列尾锚定」标记（空串 = 关闭，页码紧接章名）。
     标记由引擎在分页时把页码贴到本列末端（目录项独占一列，故视觉上各行页码对齐）。 */
  const ce = String((resolveTplBlock(toc) as any).tag_colend || '')
  let tocPages = 0
  let txt = buildTocTextWithPages(buildTocVolEntries(tocPages), ce)
  for (let iter = 0; iter < 4; iter++) {
    const np = LayoutEngine.paginate(resolveTplBlock(toc), txt).pages.length
    if (np === tocPages) break
    tocPages = np
    const t2 = buildTocTextWithPages(buildTocVolEntries(tocPages), ce)
    if (t2 === txt) break
    txt = t2
  }
  return txt
}
export function unitFlowText(u?: Block | Volume): string {
  if (!u) return ''
  if (isTocUnit(u)) return isTocDerived(u) ? computeTocText() : (u.chapters || []).map(c => c.text).filter(Boolean).join('\n')
  return (u.chapters || []).map(c => c.text).filter(Boolean).join('\n')
}

/** 版心卷次标签 = 章所在卷的分组名（卷才有；导读/附录等非卷单元返回 ''，回落版式默认的卷次逻辑） */
export function volLabelOf(u?: Block | Volume): string {
  if (!u || (u as any).type) return ''
  return u.name || ''
}

/** 当前选中单元的版式覆盖对象（写时懒创建；读不创建，避免污染成「有覆盖」） */
function curTplOv(): Record<string, any> {
  const b = curUnit()
  if (!b) return {}
  if (!b.template) (b as any).template = {}
  return b.template!
}

/* ---- 版式读写门面（供 Inspector 双向绑定；读=生效值，写=按作用域落点） ---- */
export function tplGet(k: string): any {
  if (tplScope.value === 'unit') {
    const ov = curTplOv()
    if (k in ov) return ov[k]
  }
  /* 书级书名的存储真源是项目信息（meta.title），不是版式快照 ——
     读 tpl 会拿到旧书名/空书名，出现「项目信息改了，版式面板还显示旧值」。
     此处回**原值**（可以为空 = 未设置），不走 bookTitle() 的占位兜底：
     字段空 = 没设过；预览里看到的「图书名称」是兜底填充，两者语义不同。 */
  if (k === 'title_text') return String(proj.meta.title || '')
  return tpl[k]
}

export function tplSet(k: string, v: any) {
  /* 书名是**内容字段**（每本书不同、不入模板库）：
     书级作用域 = 改「这本书的书名」→ 写真源 meta.title（同时镜像进版式快照便于落盘；
       清空则渲染层回落占位「图书名称」，不会让版心空着）；
     单元作用域 = 只改本单元 → 写覆盖，空串即「本单元版心不排书名」（目录用的就是这条）。 */
  if (k === 'title_text') {
    const s = String(v ?? '')
    if (tplScope.value === 'unit') curTplOv().title_text = s
    else { proj.meta.title = s; tpl.title_text = s }
    return
  }
  if (tplScope.value === 'unit') curTplOv()[k] = v
  else tpl[k] = v
}
export const tplEdit: Record<string, any> = new Proxy({} as Record<string, any>, {
  get: (_t, k) => tplGet(String(k)),
  set: (_t, k, v) => { tplSet(String(k), v); return true },
})
export function tplOverridden(k: string): boolean {
  if (tplScope.value !== 'unit') return false
  return k in curTplOv()
}
export function tplRevert(k: string) {
  if (tplScope.value === 'unit') delete curTplOv()[k]
}
export function tplOverrideCount(): number {
  return tplScope.value === 'unit' ? Object.keys(curTplOv()).length : 0
}
export function tplRevertAll() {
  const b = curUnit()
  if (b) (b as any).template = undefined
}

/* ---- 特殊页（包装叶）读写门面（供封面视图双向绑定） ----
 * 书级默认存在 bookSpecial；某包装叶以扁平 patch 覆盖（与 SpecialCfg 同构，不分 fields/template）。 */
export type SpKey = keyof Omit<SpecialCfg, 'pages'>

/** 当前选中包装叶（按 cur.leaf）：封面/扉页/尾页 */
function curLeafKind(): 'cover' | 'fly' | 'colophon' {
  return (['cover', 'fly', 'colophon'] as const)[cur.leaf]
}
/** 当前叶的覆盖 patch（读改写统一走它）。
 *  刻意不看 cur.folder：封装设计页与图书视图的选区解耦，
 *  否则从系统栏直接进「封」视图（folder 仍是 scrolls）时，写会落到叶上、读却回落书级默认，
 *  表现为「改了没反应」。 */
function curLeafPatch(): Patches | undefined {
  return (proj.tree.pack as any)[curLeafKind()]
}
export function spGet(k: SpKey): any {
  if (spScope.value === 'book') return (bookSpecial as any)[k]
  const leaf = curLeafPatch()
  if (leaf && k in leaf) return leaf[k]
  return (bookSpecial as any)[k]
}
function ensureLeaf(): Patches {
  const kind = curLeafKind()
  const p = proj.tree.pack as any
  if (!p[kind]) p[kind] = {}
  return p[kind]
}
export function spSet(k: SpKey, v: any) {
  if (spScope.value === 'book') { (bookSpecial as any)[k] = v; return }
  const def = (bookSpecial as any)[k]
  /* 与全书默认值相等 → 视为未覆盖，删键（否则「已覆盖」标记会错把跟随默认的项当成改过） */
  if (v === def) {
    const leaf = curLeafPatch()
    if (leaf && k in leaf) delete leaf[k]
    return
  }
  const leaf = ensureLeaf()
  leaf[k] = v
}
export const spEdit = new Proxy({} as Record<string, any>, {
  get: (_t, k) => spGet(String(k) as SpKey),
  set: (_t, k, v) => { spSet(String(k) as SpKey, v); return true },
})
export function spOverridden(k: SpKey): boolean {
  if (spScope.value !== 'leaf') return false
  const leaf = curLeafPatch()
  return !!(leaf && k in leaf)
}
export function spRevert(k: SpKey) {
  const leaf = curLeafPatch()
  if (!leaf) return
  delete leaf[k]
}
export function spOverrideCount(): number {
  const leaf = curLeafPatch(); if (!leaf) return 0
  return Object.keys(leaf).length
}
export function spRevertAll() {
  if (spScope.value === 'book') {
    assignInto(bookSpecial as any, undefined, SPECIAL_DEFAULT)
    return
  }
  const kind = curLeafKind()
  const p = proj.tree.pack as any
  p[kind] = {}
}

/* ---- 包装三叶（封面/扉页/尾页）恒为设计对象：不再有「输出页开关」 ----
 * 三叶永远参与导出；要单独取舍某叶，走「册」视图的前/后辅文组装，
 * 或「出」视图的「包含特殊页」总开关。`proj.tree.pack[kind]` 仅表示该叶有无覆盖 patch。 */
export const PACK_KINDS = ['cover', 'fly', 'colophon'] as const
export type PackKind = typeof PACK_KINDS[number]

/** 解析某包装叶的生效特殊配置（书级默认 + 叶级覆盖），供封面/扉页/尾页渲染 */
export function resolveLeafCfg(kind: 'cover' | 'fly' | 'colophon'): SpecialCfg {
  const leaf = (proj.tree.pack as any)[kind] as Patches | undefined
  const base: any = { ...bookSpecial }
  delete base.pages
  if (leaf) Object.assign(base, leaf)
  /* 封面/扉页书名留空 = 沿用全书 —— 与版心同源（bookTitle()），
     项目书名未填时也拿得到占位，不会漏出一片空白书名 */
  if (!base.coverTitle) base.coverTitle = bookTitle()
  if (!base.coverAuthor) base.coverAuthor = proj.meta.author || ''
  /* 包装叶双框跟随正文页边距（整叶坐标系）：左右取 margins_left/right；
     扉页/尾页与正文完全一致（上取天头 top、下取地脚 bottom），
     仅封面为题签式无天头、上下同取 bottom（由 special.ts 按叶型区分） */
  const num = (v: any, d: number) => (typeof v === 'number' && isFinite(v) ? v : d)
  base.margins = {
    left: num(tpl.margins_left, 70), right: num(tpl.margins_right, 70),
    top: num(tpl.margins_top, 240), bottom: num(tpl.margins_bottom, 80),
  }
  return base as SpecialCfg
}

/* ---- 覆盖统计（侧栏徽标 / 导出范围） ---- */
export function unitOverrideCount(u?: Block | Volume): number {
  return Object.keys(u?.template || {}).length
}
export function unitOverrideInfo(u?: Block | Volume) {
  const n = unitOverrideCount(u)
  return { tpl: n, total: n }
}
export function leafOverrideCount(kind: 'cover' | 'fly' | 'colophon'): number {
  const leaf = (proj.tree.pack as any)[kind] as Patches | undefined
  return leaf ? Object.keys(leaf).length : 0
}

/* ---- 入口跳转（跨视图统一走这里，不在组件里散写 view.rail = ...） ---- */
export function openUnitTemplate(folder: Folder, ui: number) {
  selectUnit(folder, ui, 0)
  tplScope.value = 'unit'
  view.rail = 'book'
  view.inspector = 1
}
/** 打开封面视图并定位到指定包装叶（封面/扉页/尾页） */
export function openCoverLeaf(i: number) {
  selectLeaf(i)
  spScope.value = 'leaf'
  view.rail = 'cover'
}
/** 打开版式参数面板（作用域按当前选择：选中单元→本单元，否则全书） */
export function openVolTemplate() {
  if (cur.folder !== 'pack' && curUnit()) tplScope.value = 'unit'
  else tplScope.value = 'book'
  view.rail = 'book'
  view.inspector = 1
}
/** 打开出版 / 册管理视图 */
export function openPubView() { view.rail = 'pub' }

/* ---- 册（Publication）增删改：均直接改响应式 proj.pubs，由 watch(proj,{deep}) 标脏后自动落盘 ---- */
const PACK_KIND_CN: Record<string, string> = { cover: '封面', fly: '扉页', colophon: '尾页' }
/** 可装订进册的包装叶中文名：三叶恒定可选（输出页开关已移除，取舍改在册组装里做） */
export function availablePackLeaves(): string[] {
  return PACK_KINDS.map(k => PACK_KIND_CN[k])
}
/** 新建一册：按现有卷/辅文预填可用组装，便于立即导出 */
export function addPub(): number {
  const leaves = availablePackLeaves()
  const guideNames = proj.tree.guide.map(g => g.name)
  const appNames = proj.tree.appendix.map(a => a.name)
  const front: PubGroup[] = []
  const fl = leaves.filter(l => l === '封面' || l === '扉页')
  for (const l of fl) front.push({ pack: l })
  for (const n of guideNames.slice(0, 2)) front.push({ guide: n })
  const back: PubGroup[] = []
  for (const n of appNames.slice(0, 1)) back.push({ appendix: n })
  if (leaves.includes('尾页')) back.push({ pack: '尾页' })
  const chapters: PubChapters[] = proj.tree.scrolls.map(v => ({ volume: v.id }))
  proj.pubs.push({ id: uid(), title: '新册 ' + (proj.pubs.length + 1), front, chapters, back })
  return proj.pubs.length - 1
}
export function deletePub(i: number) {
  if (i >= 0 && i < proj.pubs.length) proj.pubs.splice(i, 1)
}
export function renamePub(i: number, title: string) {
  if (proj.pubs[i]) proj.pubs[i].title = title
}

/* ---- 版式模板库（Go 后端统一持有；builtin 区分出厂预设与自建） ---- */
export const tplLib = ref<TplItem[]>([])
export const tplSel = ref('')
const tplCache = new Map<string, Record<string, any>>()

export async function loadTemplates() {
  try {
    await plat.seedTemplates(BUILTIN_TPLS as any)
    const list = await plat.listTemplates()
    tplLib.value = list.map(s => ({
      id: s.id, name: s.name, note: s.note || '',
      builtin: !!s.builtin, order: s.order || 0, ver: s.ver || 0,
      cat: (BUILTIN_TPLS.find(t => t.id === s.id)?.cat) || 'paper',
      updated: s.updated || '', digest: s.digest || '',
      params: {},
    }))
  } catch {
    tplLib.value = BUILTIN_TPLS.map(t => ({ ...t, cat: t.cat, params: t.params }))
  }
  if (!tplLib.value.some(t => t.id === tplSel.value)) {
    tplSel.value = tplLib.value[0]?.id || ''
  }
}

export async function tplParams(id: string): Promise<Record<string, any> | null> {
  const b = BUILTIN_TPLS.find(t => t.id === id)
  if (b) return b.params
  const hit = tplCache.get(id)
  if (hit) return hit
  try {
    const e = await plat.getTemplate(id)
    if (e?.params) { tplCache.set(id, e.params); return e.params }
  } catch { /* 读取失败：回落 null */ }
  return null
}

export async function applyTemplate(id: string) {
  const p = await tplParams(id)
  if (!p) { toast('模板参数读取失败'); return }
  const name = tplLib.value.find(t => t.id === id)?.name || '模板'
  const snap = JSON.parse(JSON.stringify(p))
  /* 防呆：库项里若残留运行时瞬时键（旧版本存下的 _rubyOn / _vert_supported），
     套用时必须剔除——否则会把注音「自动」档钉死成某个具体状态 */
  Object.keys(snap).forEach(k => { if (k.charAt(0) === '_') delete snap[k] })
  /* 防呆②：**内容字段一律剔除**（书名 / 逐卷卷名）。模板库里这两个键恒为空串
     （mk() / stripContent 的约定），原样铺进去就会把书级书名冲成空——
     单元覆盖尤甚：空串 ≠ 引擎默认，resolveTplBlock 合覆盖时不会被跳过，直接盖掉书名。
     书名/卷名由书注入，见 bookTitle()。 */
  ;(CONTENT_KEYS as readonly string[]).forEach(k => delete snap[k])
  if (tplScope.value === 'unit') {
    const ov = curTplOv()
    Object.keys(ov).forEach(k => delete ov[k])
    Object.assign(ov, snap)
    toast(`已套用到「${curBlockName()}」：${name}（仅本单元）`)
  } else {
    const volnames = tpl.title_volnames
    Object.keys(tpl).forEach(k => delete (tpl as Record<string, any>)[k])
    /* 先铺引擎默认、再覆盖模板值：旧模板（或新增参数之后存下的模板）缺键时不会留 undefined，
       渲染与预览拖动都能拿到确定值 */
    Object.assign(tpl, LayoutEngine.DEFAULT_TEMPLATE, snap)
    tpl.title_text = bookTitle()
    tpl.title_volnames = volnames
    toast('已套用「' + name + '」（书名沿用本项目，卷名保留）')
  }
}

export async function importTplFromBook(name: string) {
  const nm = (name || '').trim()
  if (!nm) return
  const params = stripContent(resolveTplBlock(curUnit()))
  try {
    const e = await plat.importTemplate(nm, params)
    await loadTemplates()
    if (e) { tplCache.set(e.id, e.params); tplSel.value = e.id }
    toast('已导入模板：' + nm)
  } catch (err: any) {
    toast('导入失败：' + (err?.message || err))
  }
}

export async function renameTpl(id: string, name: string) {
  const nm = (name || '').trim()
  if (!nm) return
  try {
    await plat.renameTemplate(id, nm)
    await loadTemplates()
    toast('已重命名')
  } catch (err: any) { toast('重命名失败：' + (err?.message || err)) }
}

export async function deleteTpl(id: string) {
  try {
    await plat.deleteTemplate(id)
    tplCache.delete(id)
    await loadTemplates()
    toast('已删除模板')
  } catch (err: any) { toast('删除失败：' + (err?.message || err)) }
}

/* ---- 项目文件读写（Go services 桥接） ---- */

export const projectDir = ref('')

/* 图片素材接线：engine 保持纯函数、不 import 具体实现，这里把 core/assets 的解析器注入进去；
   项目目录一变就清空素材缓存（换了项目，同名文件是另一张图）。 */
LayoutEngine.setAssetResolver(assetInfo)
watch(projectDir, d => setAssetDir(d), { immediate: true })
export const projectLoaded = ref(false)
/** 启动态：boot 完成前为 true，期间只显示载入态、不渲染欢迎页，避免首帧闪欢迎页 */
export const booting = ref(true)
export const toastMsg = ref('')

/* ---- 最近项目 + 欢迎页（新建 / 切换项目的统一入口） ----
 * recents 由 Go SettingsService 持有（≤10 条，新在前）；欢迎页与侧栏切换器共用同一份。 */
export interface RecentItem { dir: string; name: string }
export const recents = ref<RecentItem[]>([])

export async function refreshRecents() {
  try {
    const st = await plat.getSettings()
    recents.value = (st?.recents || [])
      .filter((r: any) => r?.dir)
      .map((r: any) => ({ dir: r.dir, name: r.name || String(r.dir).split('/').pop() || '未命名' }))
  } catch { /* 读取失败：保留现有列表 */ }
}

/** 欢迎页显隐：启动无项目时常驻；点系统栏「古」标可随时呼出用于新建/切换 */
export const welcomeOpen = ref(false)
export function openWelcome() {
  refreshRecents()
  welcomeOpen.value = true
}
export function closeWelcome() { welcomeOpen.value = false }

/** 项目信息对话框（编辑项目名称 / 图书名称 / 作者），关闭时刷新最近项目列表中的名称 */
export const projectInfoOpen = ref(false)
export function openProjectInfo() { projectInfoOpen.value = true }
export function closeProjectInfo() {
  projectInfoOpen.value = false
  if (projectDir.value) plat.touchRecent(projectDir.value, proj.name).catch(() => {})
}

/** 关于 / 赞助对话框（远程拉取赞助者名单） */
export const aboutOpen = ref(false)
export function openAbout() { aboutOpen.value = true }
export function closeAbout() { aboutOpen.value = false }

/** 更新对话框（含赞赏码）：自动检查发现新版 / 关于页手动检查均可触发 */
export const updateOpen = ref(false)
export const updateResult = ref<CheckUpdateResult | null>(null)
export function openUpdate(r: CheckUpdateResult) { updateResult.value = r; updateOpen.value = true; downloadVer.value = r.version }

// 更新进行中状态：由 wails updater headless 进度事件驱动。
// WindowNone 模式下 wails 不弹原生更新窗口，进度/速度/百分比靠 wails:updater:download-progress 回传。
export const updateProgress = ref<{
  active: boolean
  stage: string
  devReady: boolean
  error: string
  written: number
  total: number
  rate: number
  percent: number
}>({
  active: false, stage: '', devReady: false, error: '',
  written: 0, total: 0, rate: 0, percent: 0,
})

// 应用下载窗口：点「立即更新」后统一展示下载 / 安装进度。
// 自动弹窗（启动发现新版）与关于页（手动检查）两条路径共用，确保反馈一致、
// 不再只是状态栏一行小字 + 一条日志（用户反馈“点了就啥都没有了”）。
export const downloadOpen = ref(false)
export const downloadVer = ref('')
export function closeDownload() { downloadOpen.value = false }

export function closeUpdate() { updateOpen.value = false }

/** 立即落盘当前项目（切换/退出前调用）。返回是否保存成功。 */
export async function flushSave(): Promise<boolean> {
  if (!projectDir.value) return true
  try {
    await plat.saveProject(projectDir.value, toFlat())
    markClean()
    lastSavedAt.value = nowClock()
    return true
  } catch (err: any) {
    saveState.value = 'error'
    toast('保存失败：' + (err?.message || err))
    return false
  }
}

/** 打开失败的提示分类：缺少 book.gvs 单独说明，其余报原始错误 */
const MISSING_RE = /book\.gvs|no such file|不存在|missing/i
function isMissingProject(err: any): boolean { return MISSING_RE.test(String(err?.message || err || '')) }
function openErrToast(err: any, dir: string) {
  if (isMissingProject(err)) {
    toast('该文件夹不是有效的 GujiStudio 项目（缺少 book.gvs）：' + dir + '，已从最近列表移除')
  } else {
    toast('打开失败：' + String(err?.message || err || ''))
  }
}

/** 切换到另一个项目：先保存当前项目，再打开目标目录。返回是否打开成功。 */
export async function switchProject(dir: string): Promise<boolean> {
  if (!dir) return false
  if (dir === projectDir.value) { welcomeOpen.value = false; return true }
  const ok = await flushSave()
  if (!ok && !(await appConfirm('当前项目未能保存，仍要切换？未保存的修改可能丢失。'))) return false
  try {
    await openProjectAt(dir)
    return true
  } catch (err: any) {
    /* 目录失效（被删/改名/非项目）时顺手清掉最近列表里的死链，避免每次点都报错 */
    if (isMissingProject(err)) removeRecentAt(dir)
    openErrToast(err, dir)
    return false
  }
}

/** 从最近列表中移除一条记录（只清记录，不动磁盘项目） */
export async function removeRecentAt(dir: string) {
  try {
    await plat.removeRecent(dir)
    recents.value = recents.value.filter(r => r.dir !== dir)
  } catch (err: any) {
    toast('移除失败：' + (err?.message || err))
  }
}
let toastTimer: ReturnType<typeof setTimeout> | undefined
export function toast(m: string) {
  toastMsg.value = m
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastMsg.value = '' }, 2600)
}

function clone<T>(o: T): T { return JSON.parse(JSON.stringify(o)) }
function nonEmpty(o: Record<string, any> | undefined): boolean { return !!o && Object.keys(o).length > 0 }

/** 用 src 覆盖进 dst，缺字段回落 defaults（深拷贝，避免共享 SPECIAL_DEFAULT.pages 之类嵌套对象） */
function assignInto(dst: Record<string, any>, src: Record<string, any> | undefined | null, defaults: Record<string, any>) {
  Object.keys(dst).forEach(k => delete dst[k])
  Object.assign(dst, clone(defaults), src ? clone(src) : {})
}

/* ---- 扁平（传输）结构 ↔ 前端模型 互转 ---- */
/* 归一化：单元落盘只存章 id 数组；正文收进 tree.chapters 文章池。
 * 前端工作模型保持卷/单元持有章对象——此处负责 双向转换。 */
function toPatches(l: plat.PatchesFull | null | undefined): Patches | undefined {
  if (l === null || l === undefined) return undefined
  return clone(l)
}
function fromPatches(l: Patches | undefined): plat.PatchesFull | null {
  if (l === undefined) return null
  return clone(l)
}
/** 章 id 数组 + 文章池 → 章对象数组（id 稳定，文件名由 title 派生） */
function poolToChaps(ids: string[] | undefined, pool: Record<string, plat.ChapterFull>): Chapter[] {
  return (ids || []).map(cid => {
    const e = pool[cid]
    const title = e?.title || '未命名'
    return { id: cid || uid(), title, file: title + '.txt', text: e?.text || '' }
  })
}
/** 固定角色单元（序/目录/跋/牌记）→ 前端 Block（0 或 1 个章） */
function toBlock(b: plat.BlockFull): Block {
  const c = b.chapter
  return {
    id: b.id || uid(), name: b.name, type: b.type, derived: b.derived, mode: b.mode,
    template: nonEmpty(b.template) ? clone(b.template) : undefined,
    chapters: c ? [{ id: c.id || uid(), title: c.title, file: (c.title || '') + '.txt', text: c.text || '' }] : [],
  }
}
function fromBlock(b: Block): plat.BlockFull {
  const c = b.chapters[0]
  return {
    id: b.id, name: b.name, type: b.type, derived: b.derived, mode: b.mode,
    template: nonEmpty(b.template) ? clone(b.template) : undefined,
    chapter: c ? { id: c.id, title: c.title, text: c.text } : undefined,
  }
}
function toVolume(v: plat.VolumeFull, pool: Record<string, plat.ChapterFull>): Volume {
  return {
    id: v.id || uid(), name: v.title,
    template: nonEmpty(v.template) ? clone(v.template) : undefined,
    chapters: poolToChaps(v.chapters, pool),
  }
}
function fromVolume(v: Volume): plat.VolumeFull {
  return {
    id: v.id, title: v.name,
    template: nonEmpty(v.template) ? clone(v.template) : undefined,
    chapters: v.chapters.map(c => c.id),
  }
}

/** 把磁盘上的 PubGroup 归一为单值：兼容旧格式（字段为 string[]）——这是处理旧数组格式的唯一入口 */
function normGroup(g: plat.PubGroup): PubGroup {
  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? (v[0] ?? undefined) : v
  return {
    ...(g.pack !== undefined ? { pack: one(g.pack) } : {}),
    ...(g.guide !== undefined ? { guide: one(g.guide) } : {}),
    ...(g.appendix !== undefined ? { appendix: one(g.appendix) } : {}),
  }
}
function applyFlat(f: plat.BookProjectFlat) {
  proj.name = f.name
  proj.meta.title = f.meta.title
  proj.meta.author = f.meta.author
  assignInto(tpl, f.template, LayoutEngine.DEFAULT_TEMPLATE)
  /* 书级书名恒按真源注入（不再 `if (f.meta.title)` 才注）：
     「meta.title 有值、template.title_text 为空」是历史数据里常见的错位状态
     （先套用模板、后填项目书名的项目就会留下它），漏注入会让版心书名一直空着。 */
  tpl.title_text = bookTitle()
  assignInto(bookSpecial as unknown as Record<string, any>, f.special, SPECIAL_DEFAULT)
  bookSpecial.pages = { ...SPECIAL_PAGES_DEFAULT, ...((f.special?.pages as SpecialPages) || {}) }
  const pool: Record<string, plat.ChapterFull> = {}
  for (const c of f.chapters || []) pool[c.id] = c
  const packs = f.packs || undefined
  proj.tree.pack = {
    cover: toPatches(packs?.cover),
    fly: toPatches(packs?.fly),
    colophon: toPatches(packs?.colophon),
  }
  // 固定角色单元按典制顺序挂树：序→目录 / 跋→牌记
  const byType = new Map((f.blocks || []).map(b => [b.type, b]))
  const gb: Block[] = []
  if (byType.has('preface')) gb.push(toBlock(byType.get('preface')!))
  if (byType.has('toc')) gb.push(toBlock(byType.get('toc')!))
  proj.tree.guide = gb
  proj.tree.scrolls = (f.volumes || []).map(v => toVolume(v, pool))
  const ab: Block[] = []
  if (byType.has('postscript')) ab.push(toBlock(byType.get('postscript')!))
  if (byType.has('imprint')) ab.push(toBlock(byType.get('imprint')!))
  proj.tree.appendix = ab
  proj.pubs = (f.pubs || []).map(p => ({
    id: uid(), title: p.title,
    template: nonEmpty(p.template) ? clone(p.template) : undefined,
    front: (p.front || []).map(normGroup),
    chapters: (p.chapters || []).map(c => ({ volume: c.volume, chapters: c.chapters ? c.chapters.slice() : undefined })),
    back: (p.back || []).map(normGroup),
  }))
  cur.folder = 'scrolls'
  cur.ui = 0
  cur.ci = 0
  cur.leaf = 0
  tplScope.value = 'book'
  spScope.value = 'book'
}

function toFlat(): plat.BookProjectFlat {
  /* 文章池：仅正文卷的章（guide/appendix 为独立文件不进池）；
   * 文件名由 title 派生（改名 = 改 title，保存时文件名随之更新），正文以编辑器为准 */
  const chapters: plat.ChapterFull[] = []
  proj.tree.scrolls.forEach(v => v.chapters.forEach(c => chapters.push({ id: c.id, title: c.title, text: c.text })))
  return {
    name: proj.name,
    meta: { title: proj.meta.title, author: proj.meta.author },
    template: clone(tpl),
    special: clone(bookSpecial),
    packs: {
      cover: fromPatches(proj.tree.pack.cover),
      fly: fromPatches(proj.tree.pack.fly),
      colophon: fromPatches(proj.tree.pack.colophon),
    },
    chapters,
    volumes: proj.tree.scrolls.map(fromVolume),
    blocks: [...proj.tree.guide.map(fromBlock), ...proj.tree.appendix.map(fromBlock)],
    pubs: proj.pubs.map(p => ({
      title: p.title,
      template: nonEmpty(p.template) ? clone(p.template) : undefined,
      front: p.front.map(g => ({ ...g })),
      chapters: p.chapters.map(c => ({ volume: c.volume, chapters: c.chapters ? c.chapters.slice() : undefined })),
      back: p.back.map(g => ({ ...g })),
    })),
  }
}

export async function openProjectAt(dir: string) {
  suppressDirty = true
  try {
    const flat = await plat.openProject(dir)
    applyFlat(flat)
    projectDir.value = dir
    projectLoaded.value = true
    plat.touchRecent(dir, flat.name).catch(() => {})
    refreshRecents()
    welcomeOpen.value = false
    toast('已打开项目：' + flat.name)
  } finally {
    nextTick().then(() => { suppressDirty = false; markClean() })
  }
}

export async function openProjectDialog() {
  const dir = await plat.chooseProjectDir('打开图书项目')
  if (!dir) return
  await switchProject(dir)
}

export async function saveProjectDialog() {
  let dir = projectDir.value
  if (!dir) {
    dir = await plat.chooseProjectDir('保存图书项目：选择文件夹')
    if (!dir) return
    projectDir.value = dir
  }
  await plat.saveProject(dir, toFlat())
  markClean()
  lastSavedAt.value = nowClock()
  plat.touchRecent(dir, proj.name).catch(() => {})
  refreshRecents()
  toast('已保存到 ' + dir.split('/').pop())
}

/* ---- 自动保存：3s 轮询脏标记，静默落盘（仅桌面壳且已打开真实项目时生效） ---- */
export const AUTO_SAVE_MS = 3000
export const saveState = ref<'saved' | 'dirty' | 'error'>('saved')
export const lastSavedAt = ref('')
/* 保存状态文案：侧栏与编辑器状态栏共用同一份（避免两处文案/口径不一致） */
export const saveLabel = computed(() => {
  if (!projectDir.value) return ''
  if (saveState.value === 'error') return '⚠ 自动保存失败'
  if (saveState.value === 'dirty') return '● 有未保存更改'
  return lastSavedAt.value ? `✓ 已自动保存 ${lastSavedAt.value}` : '✓ 已保存'
})
let dirty = false
let suppressDirty = false
let lastErrToastAt = 0

function nowClock(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}
function markClean() {
  dirty = false
  saveState.value = 'saved'
}

watch([proj, tpl, bookSpecial], () => {
  if (suppressDirty) return
  dirty = true
  saveState.value = 'dirty'
}, { deep: true })

setInterval(async () => {
  if (!dirty || !projectLoaded.value || !projectDir.value) return
  try {
    await plat.saveProject(projectDir.value, toFlat())
    markClean()
    lastSavedAt.value = nowClock()
  } catch (err: any) {
    dirty = true
    saveState.value = 'error'
    const now = Date.now()
    if (now - lastErrToastAt > 30_000) {
      lastErrToastAt = now
      toast('自动保存失败：' + (err?.message || err))
    }
  }
}, AUTO_SAVE_MS)

export async function newProjectDialog() {
  try {
    const dir = await plat.chooseProjectDir('新建项目：选择文件夹')
    if (!dir) return
    try {
      await plat.openProject(dir)
      if (!(await appConfirm('该文件夹已有图书项目，确定覆盖新建？'))) return
    } catch { /* 无 book.gvs：正常新建 */ }
    const name = await appPrompt('项目名', '未命名项目'); if (name === null) return
    const title = await appPrompt('书名（写入版心）', (name || '').replace(/《|》/g, '')); if (title === null) return
    /* 新建会整体替换内存项目：先把当前项目落盘，避免未保存改动丢失 */
    const ok = await flushSave()
    if (!ok && !(await appConfirm('当前项目未能保存，仍要继续新建？未保存的修改可能丢失。'))) return
    await plat.ensureNewProject(dir, name || '未命名项目', title || '')
    await openProjectAt(dir)
    /* 新建即落盘：把引擎默认版式写进 book.gvs，项目自描述、可复现，
     * 不依赖将来引擎默认值的变化。此时结构为空，setting.json / publish.json 不会落盘。 */
    await flushSave()
  } catch (err: any) {
    toast('新建失败：' + (err?.message || err))
  }
}

/** 向导创建项目：先把当前项目落盘（防丢），必要时询问覆盖，再把版式 template 写进 book.gvs 并打开。
 * template 为完整版式 map（buildTemplate 产出），由 Go EnsureNewProject 落盘到 book.gvs.Template。 */
export async function createProject(dir: string, name: string, title: string, template: Record<string, any>): Promise<boolean> {
  const ok = await flushSave()
  if (!ok && !(await appConfirm('当前项目未能保存，仍要继续新建？未保存的修改可能丢失。'))) return false
  try {
    await plat.openProject(dir)
    if (!(await appConfirm('该文件夹已有图书项目，确定覆盖新建？'))) return false
  } catch { /* 无 book.gvs：正常新建 */ }
  try {
    await plat.ensureNewProject(dir, name || '未命名项目', title || '', template)
    await openProjectAt(dir)
    await flushSave()
    return true
  } catch (err: any) {
    toast('新建失败：' + (err?.message || err))
    return false
  }
}

/** 恢复上次项目：目录失效（被删/改名）时清掉死链记录，静默停在欢迎页 */
export async function restoreLastProject() {
  const st = await plat.getSettings().catch(() => null)
  const dir = st?.last_project_dir
  if (dir) {
    try {
      await openProjectAt(dir)
    } catch {
      await removeRecentAt(dir)   // Go 侧同时清空 LastProjectDir，下次启动不再尝试
      toast('上次项目已失效，已从最近列表移除：' + dir)
    }
  }
  refreshRecents()   // 侧栏切换器/欢迎页共用：启动时即备好最近列表
}

/* ---------------------------------------------------------------- 外部打开：拖放 / 双击 .gvs */

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i <= 0 ? p : p.slice(0, i)
}
function resolveProjectDir(p: string): string {
  return p.toLowerCase().endsWith('.gvs') ? dirnameOf(p) : p
}

/** 依次尝试打开给定路径（拖放/文件关联），返回是否有任一成功 */
export async function openFromPaths(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    if (await switchProject(resolveProjectDir(p))) return true
  }
  return false
}

let extWatching = false
/** 订阅运行时事件：拖放进窗口 / 应用已运行时双击 .gvs（冷启动的待打开路径由 boot 统一取走） */
/* ---- 导入本地文件到卷 ---- */
/** 弹出系统对话框选文件/文件夹，读取内容后作为章节追加到指定卷（vi = scrolls 索引）末尾。
 * 取消选择时 ImportFiles 返回空数组，不改动项目。导入后即时落盘并 toast 反馈。 */
export async function importFilesToVolume(vi: number) {
  const vol = proj.tree.scrolls[vi]
  if (!vol) return
  let files: plat.ImportFile[]
  try {
    files = await plat.importFiles()
  } catch (err: any) {
    toast('导入失败：' + (err?.message || err))
    return
  }
  if (!files || !files.length) return
  for (const f of files) {
    const title = (f.name || '').trim() || '未命名'
    vol.chapters.push({ id: uid(), title, file: title + '.txt', text: f.content || '' })
  }
  await flushSave()
  toast(`已导入 ${files.length} 篇到「${vol.name || '（默认卷）'}」`)
}

export async function watchExternalOpen() {
  if (extWatching) return
  extWatching = true
  try {
    const { Events } = await import('@wailsio/runtime')
    Events.On('files-dropped', (ev: any) => {
      const files: string[] = ev?.data?.files || []
      if (files.length) openFromPaths(files)
    })
    // 系统菜单「关于 Guji Studio」点击 → 打开应用内「关于 / 赞助」对话框
    Events.On('open-about', () => openAbout())
    // 后台自动检查发现新版本 → 回取完整结果并打开更新弹窗（含赞赏码）
    Events.On('updater:available', async () => {
      try {
        const r = await getLastUpdate()
        if (r?.hasUpdate) openUpdate(r)
      } catch { /* 忽略 */ }
    })
    // 更新进度：优先使用自己应用层事件（guji:update:*），不依赖 wails updater 内部
    // 事件名在前端是否可达；同时保留 wails 内部事件作为补充/兜底。
    const onUpdStarted = () => {
      // 点「立即更新」后统一弹出应用下载窗口（自动弹窗 / 关于页共用）。
      updateProgress.value = {
        active: true, stage: '正在下载更新…', devReady: false, error: '',
        written: 0, total: 0, rate: 0, percent: 0,
      }
      if (updateResult.value?.version) downloadVer.value = updateResult.value.version
      downloadOpen.value = true
    }
    const onUpdFinished = (e: any) => {
      const data = e?.data || {}
      if (data.error) {
        // 终态：active 复位，避免「检查更新」按钮被全局进度态永久禁用（下载窗口仍开，显示失败原因）
        updateProgress.value = { ...updateProgress.value, active: false, stage: '更新失败', devReady: false, error: String(data.error || '') }
        toast('更新失败：' + (data.error || ''))
      } else if (data.devReady) {
        // 开发模式不自动重启：提示手动重启；进度结束 active 复位，关于页「检查更新」可再次点击
        updateProgress.value = { ...updateProgress.value, active: false, stage: '已下载完成，请手动重启应用', devReady: true, error: '' }
      } else {
        updateProgress.value = { ...updateProgress.value, active: true, stage: '更新完成，即将重启…', devReady: false, error: '' }
      }
    }
    Events.On('guji:update:started', onUpdStarted)
    Events.On('guji:update:finished', onUpdFinished)
    // wails updater 内部事件作为补充（若在 WindowNone 下可达，可提供更细粒度阶段）
    Events.On('wails:updater:download-started', onUpdStarted)
    Events.On('wails:updater:download-progress', (e: any) => {
      const d = e?.data || {}
      const written = Number(d.written || 0)
      const total = Number(d.total || 0)
      const rate = Number(d.rate || 0)
      const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((written / total) * 100))) : 0
      updateProgress.value = {
        ...updateProgress.value,
        active: true,
        stage: '正在下载更新…',
        written, total, rate, percent,
      }
    })
    Events.On('wails:updater:download-complete', () => {
      // 下载完成但尚未进入校验：保持进度为 100%，等待 verifying 事件接管文案
      updateProgress.value = { ...updateProgress.value, active: true, percent: 100, stage: '正在下载更新…' }
    })
    Events.On('wails:updater:verifying', () => { if (updateProgress.value.active) updateProgress.value = { ...updateProgress.value, stage: '正在校验更新包…' } })
    Events.On('wails:updater:installing', () => { if (updateProgress.value.active) updateProgress.value = { ...updateProgress.value, stage: '正在安装更新…' } })
    Events.On('wails:updater:update-ready', () => { if (updateProgress.value.active) updateProgress.value = { ...updateProgress.value, stage: '即将完成，准备重启…' } })
    Events.On('wails:updater:error', (e: any) => {
      const msg = e?.data?.message || (typeof e?.data === 'string' ? e.data : '')
      updateProgress.value = { ...updateProgress.value, active: false, stage: '更新失败', devReady: false, error: String(msg || '未知错误') }
      toast('更新失败：' + (msg || '未知错误'))
    })
    // 启动后由 Go 端延迟做后台自动检查（Go 端再延 3s，确保本监听已就位）
    startAutoCheck().catch(() => {})
  } catch { /* 非 wails 壳或运行时缺失：忽略 */ }
}

/* ---------------------------------------------------------------- 启动序列
 * 1) 载入模板库；
 * 2) 冷启动双击 .gvs（Go 已缓存路径）→ 直接打开它，跳过「恢复上次项目」（双击哪个开哪个）；
 * 3) 否则恢复上次项目；pending 全部打不开（失效文件）时回落到 2) 的老路子；
 * 4) 最后才订阅运行时事件，避免与启动期的打开动作抢同一个 openProjectAt。 */
export async function boot() {
  try {
    await initUiPrefs()
    await loadTemplates()
    const pending = await takePending()
    /* pending 全部打不开（失效 .gvs）时回落到「恢复上次项目」 */
    if (!(pending.length && await openFromPaths(pending))) await restoreLastProject()
    watchExternalOpen()
  } finally {
    /* boot 结束（无论成功/失败）才解除启动态，一次性决定显示欢迎页还是项目，不闪欢迎页 */
    booting.value = false
  }
}

async function takePending(): Promise<string[]> {
  try { return (await plat.takePendingOpen()) || [] } catch { return [] }
}
