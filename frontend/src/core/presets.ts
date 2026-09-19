/* 出厂版式预设（播种到 Go 模板库）+ 内容字段约定
 *
 * 模板库由 Go 后端统一持有（~/Library/Application Support/GujiStudio/templates/*.json），
 * 内置与自建同结构、以 builtin 标记区分。这里只负责「参数推导」——
 * 唯一真源是引擎的 DEFAULT_TEMPLATE，避免 Go/TS 双份维护：
 *   · 内置预设仅在库中缺失或版本落后时播种（Seed），已存在同版本不覆盖；
 *   · 用户模板由「把当前图书版式导入为模板」产生，与内置同库存放。
 *
 * 内置预设分两类（cat）：
 *   · paper  纸张开本：以典型纸张尺寸为轴（A4横/纵、A5横/纵、16开、32开、B5、A3），
 *             各配宋体古籍默认版式（列数/边距/鱼尾随纸幅）。新建向导的模板 tab 只展示此类。
 *   · style  风格：与纸张正交的标点/套印风格（朱墨套印、白文无标点），不绑定具体开本。
 *
 * 注意：模板库里的每一项都是「整书级」快照（套用 = 全量替换当前书的版式），
 * 因此目录这类「单元专用」版式不能放进来（会被误套到整本书）——目录的默认版式
 * 内联在 stores/app.ts 的 TOC_TPL，随「新增目录」单元自动挂上，可在 Inspector 微调。
 */
import { LayoutEngine } from './engine'

/** 内容字段：每本书不同，导入模板时清空、套用模板时由书注入 */
export const CONTENT_KEYS = ['title_text', 'title_volnames'] as const

/** 出厂预设版本：调参后 +1，下次启动自动播种覆盖旧版内置模板 */
export const BUILTIN_VER = 5

/** 典型纸张尺寸（@300dpi，1mm = 11.811px）。唯一真源，自定义 tab 与内置纸张预设共用 */
export interface PaperDef { id: string; name: string; w: number; h: number }
export const PAPER_DEFS: PaperDef[] = [
  { id: 'a4h', name: 'A4 横（297×210mm）', w: 3508, h: 2480 },
  { id: 'a4v', name: 'A4 竖（210×297mm）', w: 2480, h: 3508 },
  { id: 'a5h', name: 'A5 横（210×148mm）', w: 2480, h: 1748 },
  { id: 'a5v', name: 'A5 竖（148×210mm）', w: 1748, h: 2480 },
  { id: 'k16', name: '16开（185×260mm）', w: 2185, h: 3071 },
  { id: 'k32', name: '32开（130×184mm）', w: 2173, h: 1535 },
  { id: 'b5',  name: 'B5（176×250mm）',   w: 2953, h: 2079 },
  { id: 'a3h', name: 'A3 横（420×297mm）', w: 4961, h: 3508 },
]

export type TplCat = 'paper' | 'style'

export interface TplItem {
  id: string
  name: string
  note: string
  builtin: boolean      // 出厂预设 = true（不可改名/删除）
  cat: TplCat
  order: number         // 内置排序位
  ver: number
  updated?: string
  digest?: string
  params: Record<string, any>
}

const D = LayoutEngine.DEFAULT_TEMPLATE as Record<string, any>

let seq = 0
function mk(id: string, name: string, note: string, over: Record<string, any>, cat: TplCat = 'paper'): TplItem {
  const params: Record<string, any> = { ...D, ...over }
  CONTENT_KEYS.forEach(k => { params[k] = '' })   // 内容字段一律留空
  if (!params.title_postfix) params.title_postfix = '卷X'
  return { id, name, note, builtin: true, cat, order: seq++, ver: BUILTIN_VER, params }
}

/* 纸张开本预设：开启 fish_auto / title_y_auto / pager_y_auto，
 * 鱼尾贴内框、书名/页码随内容区比例落位，换任意纸张高度都正确。 */
function paper(id: string, name: string, note: string, pd: PaperDef, over: Record<string, any>): TplItem {
  return mk(id, name, note, {
    canvas_width: pd.w, canvas_height: pd.h,
    fish_auto: 1, title_y_auto: 1, pager_y_auto: 1,
    text_font_family: 'song_tc',
    ...over,
  }, 'paper')
}

/* ---- 出厂预设：纸张开本（向导模板 tab 展示） ---- */
export const BUILTIN_TPLS: TplItem[] = [
  paper('a4h', 'A4 横', '标准 A4 横版：每半叶 16 列 × 22 字，双鱼尾、双象鼻', PAPER_DEFS[0],
    { margins_top: 240, margins_bottom: 80, margins_left: 70, margins_right: 70, leaf_col: 16, row_num: 22 }),

  paper('a4v', 'A4 竖', 'A4 竖版：10 列 × 40 字，双鱼尾、双象鼻', PAPER_DEFS[1],
    { margins_top: 500, margins_bottom: 280, margins_left: 70, margins_right: 70, leaf_col: 10, row_num: 40 }),

  paper('a5h', 'A5 横', 'A5 横版：14 列 × 20 字，双鱼尾、双象鼻', PAPER_DEFS[2],
    { margins_top: 180, margins_bottom: 60, margins_left: 55, margins_right: 55, leaf_col: 14, row_num: 20 }),

  paper('a5v', 'A5 竖', 'A5 竖版：10 列 × 40 字，双鱼尾、双象鼻', PAPER_DEFS[3],
    { margins_top: 500, margins_bottom: 280, margins_left: 50, margins_right: 50, leaf_col: 10, row_num: 40 }),

  paper('k16', '16开', '标准 16 开：10 列 × 42 字，双鱼尾、双象鼻', PAPER_DEFS[4],
    { margins_top: 500, margins_bottom: 270, margins_left: 60, margins_right: 60, leaf_col: 12, row_num: 42 }),

  paper('k32', '32开', '标准 32 开：10 列 × 16 字，双鱼尾、双象鼻', PAPER_DEFS[5],
    { margins_top: 150, margins_bottom: 55, margins_left: 45, margins_right: 45, leaf_col: 10, row_num: 16 }),

  paper('b5', 'B5', '标准 B5：12 列 × 22 字，双鱼尾、双象鼻', PAPER_DEFS[6],
    { margins_top: 200, margins_bottom: 70, margins_left: 60, margins_right: 60, leaf_col: 12, row_num: 22 }),

  paper('a3h', 'A3 横', '大幅 A3 横版：20 列 × 54 字，双鱼尾、双象鼻', PAPER_DEFS[7],
    { margins_top: 280, margins_bottom: 90, margins_left: 80, margins_right: 80, leaf_col: 20, row_num: 54 }),

  /* ---- 风格（与纸张正交，不绑定开本） ---- */
  mk('b_zhu', '朱墨套印本', '墨色正文 + 朱色句读圈点与夹注，评点本常用', {
    text_comma_zhu: 1, comment_comma_zhu: 1,
    text_comma_mode: 'full', comment_comma_mode: 'full',
    text_comma_color: '#b5342a', comment_font_color: '#9c2b22',
  }, 'style'),

  mk('b_baiwen', '白文无标点本', '不加句读的白文本：正文与夹注均不渲染标点，保留纯文字版式', {
    text_comma_mode: 'none', comment_comma_mode: 'none',
    text_comma_zhu: 0, comment_comma_zhu: 0,
  }, 'style'),
]

/* 模板库预览用固定样例：含二级标题、夹注与标点，保证各模板横向可比
 * （必须有标点，否则白文本与标准本渲染无差别，看不出预设差异）
 * 内容抽离到 sample-text.txt，方便直接替换而无需改动代码。 */
import sampleTextRaw from './sample-text.txt?raw'
export const SAMPLE_TEXT = sampleTextRaw.trim()

/* 注音样例句：**仅当模板把 ruby_show 显式设为 1（开启）时**追加到模板库预览语料，
 * 让「注音字号比 / 呼吸间距」这类参数在样例叶上当场可见可调。
 * 关闭（0）/自动（2）档不追加——否则 ^..^ 会以普通字符原样显示在样张上。 */
export const RUBY_DEMO = '性^xìng^相^xiāng^近^jìn^，习^xí^相^xiāng^远^yuǎn^也^yě^。'

/* ---- 工具 ---- */

/** 深拷贝并清空内容字段：图书版式 → 模板 */
export function stripContent(p: Record<string, any>): Record<string, any> {
  const o = JSON.parse(JSON.stringify(p))
  CONTENT_KEYS.forEach(k => { o[k] = '' })
  /* 运行时「瞬时」键（`_rubyOn` / `_vert_supported` …）绝不进模板快照：
     它们由运行时环境（全书是否含注音、本机字体是否支持竖排字形）推导，
     一旦落库就会把「自动」档钉死成某个具体状态，换台机器/改本书就错了。 */
  Object.keys(o).forEach(k => { if (k.charAt(0) === '_') delete o[k] })
  return o
}

const FISH_LB: Record<string, string> = { none: '无鱼尾', single: '单鱼尾', double: '双鱼尾' }
const SEAM_LB: Record<string, string> = { none: '无书口', single: '单象鼻', double: '双象鼻' }

/** 一行摘要：纸幅 · 行列 · 鱼尾 · 书口（与 Go 侧 digest 口径一致） */
export function summarize(p: Record<string, any>): string {
  if (!p || !p.canvas_width) return ''
  const parts = [
    `${p.canvas_width}×${p.canvas_height}`,
    `${p.row_num}字×${p.leaf_col}列`,
    FISH_LB[String(p.fish_mode)] || '—',
    SEAM_LB[String(p.if_seam)] || '—',
  ]
  if (p.text_comma_zhu || p.comment_comma_zhu) parts.push('朱色句读')
  if (p.text_comma_mode === 'none') parts.push('白文')
  return parts.join(' · ')
}
