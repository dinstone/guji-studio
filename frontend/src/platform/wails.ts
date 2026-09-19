/* 平台桥接层：包装 wails 生成的绑定（JS + JSDoc），对 UI 暴露强类型异步接口。
 * UI 组件只 import 这里，不直接 import bindings。 */

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore 生成的绑定是 JSDoc JS，无独立声明文件
import * as ProjectSvc from '../../bindings/gujistudio/internal/services/projectservice.js'
// @ts-ignore
import * as SettingsSvc from '../../bindings/gujistudio/internal/services/settingsservice.js'
// @ts-ignore
import * as FontSvc from '../../bindings/gujistudio/internal/services/fontservice.js'
// @ts-ignore
import * as TplSvc from '../../bindings/gujistudio/internal/services/templateservice.js'

/** 文章池中的一篇文章（归一化）：文件名由 title 派生（<title>.txt，重名 -2） */
export interface ChapterFull { id: string; title: string; text: string }

/** 包装叶 patch：扁平覆盖（与 SpecialCfg 同构，不分 template/fields），键存在 = 该叶要输出 */
export type PatchesFull = Record<string, any>
/** 包装三叶 patch（setting.json.packs；nil = 不出该叶） */
export interface PackPatchesFull {
  cover?: PatchesFull | null
  fly?: PatchesFull | null
  colophon?: PatchesFull | null
}
/** 卷（逻辑分组）：title 空 = 默认卷（恒排最前）；chapters = 章 id 数组（有序） */
export interface VolumeFull {
  id: string
  title: string
  template?: Record<string, any>
  chapters: string[]
}
/** 固定角色单元（序/目录/跋/牌记）：单文件、至多一个；目录为派生不落盘 */
export interface BlockFull {
  id: string
  name: string
  type: string   // preface | toc | postscript | imprint
  derived?: boolean
  mode?: string   // 目录条目来源：chapter=章名 / heading=##标题（仅 toc 用）
  template?: Record<string, any>
  chapter?: ChapterFull | null
}
/** 册内一个选组（front/back 数组元素）：pack/guide/appendix 单值 = 该组选哪个 */
export interface PubGroup {
  pack?: string
  guide?: string
  appendix?: string
}
/** 正文选取：整卷（chapters 空）或卷内选章 */
export interface PubChapters { volume: string; chapters?: string[] }
/** 一册（物理装订视图）：front 前辅文 + chapters 正文 + back 后辅文，段内组间有序 */
export interface PublicationFull {
  title: string
  template?: Record<string, any>
  front?: PubGroup[]
  chapters?: PubChapters[]
  back?: PubGroup[]
}
/** 前后端传输结构（正文内联） */
export interface BookProjectFlat {
  name: string
  meta: { title: string; author: string }
  template?: Record<string, any>
  special?: Record<string, any>
  packs?: PackPatchesFull | null
  chapters: ChapterFull[]
  volumes: VolumeFull[]
  blocks?: BlockFull[]
  pubs?: PublicationFull[]
}

export interface RecentEntry { dir: string; name: string }
export interface AppSettings {
  last_project_dir: string
  recents: RecentEntry[]
  /** 正文编辑器字号（px）；0/缺省 = 用默认值 */
  editor_font_size?: number
}

/* 版式模板库（Go 后端统一持有，builtin 区分出厂预设与自建） */
export interface TplSummary {
  id: string; name: string; note: string
  builtin: boolean; order: number; ver: number
  updated: string; digest: string
}
export interface TplEntryFull extends TplSummary { params: Record<string, any> }

export async function chooseProjectDir(title: string): Promise<string> {
  return (ProjectSvc as any).ChooseProjectDir(title)
}
export async function openProject(dir: string): Promise<BookProjectFlat> {
  return (ProjectSvc as any).Open(dir)
}
export async function saveProject(dir: string, p: BookProjectFlat): Promise<void> {
  return (ProjectSvc as any).Save(dir, p)
}
export async function ensureNewProject(dir: string, name: string, title: string, template?: Record<string, any>): Promise<void> {
  return (ProjectSvc as any).EnsureNewProject(dir, name, title, template ?? {})
}

/* 取出启动时经 .gvs 文件关联（双击）传入、尚未被前端消费的待打开路径 */
export async function takePendingOpen(): Promise<string[]> {
  return (ProjectSvc as any).TakePendingOpen()
}
export async function getSettings(): Promise<AppSettings> {
  return (SettingsSvc as any).Get()
}
export async function touchRecent(dir: string, name: string): Promise<AppSettings> {
  return (SettingsSvc as any).TouchRecent(dir, name)
}
export async function removeRecent(dir: string): Promise<AppSettings> {
  return (SettingsSvc as any).RemoveRecent(dir)
}
/* 保存正文编辑器字号（单独一个方法，读-改-写；避免回传整个 settings 冲掉最近项目列表） */
export async function setEditorFontSize(px: number): Promise<AppSettings> {
  return (SettingsSvc as any).SetEditorFontSize(px)
}
/* 系统字体条目：family = 英文族名（写入版式、CSS 渲染用），label = 本地化显示名（优先简体中文） */
export interface FontInfo {
  family: string
  label: string
}
export async function listFonts(): Promise<FontInfo[]> {
  return (FontSvc as any).List()
}

/* ---- 版式模板库 ---- */
export async function seedTemplates(items: TplEntryFull[]): Promise<boolean> {
  return (TplSvc as any).Seed(items)
}
export async function listTemplates(): Promise<TplSummary[]> {
  return (TplSvc as any).List()
}
export async function getTemplate(id: string): Promise<TplEntryFull | null> {
  return (TplSvc as any).Get(id)
}
export async function importTemplate(name: string, params: Record<string, any>): Promise<TplEntryFull | null> {
  return (TplSvc as any).Import(name, params)
}
export async function renameTemplate(id: string, name: string): Promise<void> {
  return (TplSvc as any).Rename(id, name)
}
export async function deleteTemplate(id: string): Promise<void> {
  return (TplSvc as any).Delete(id)
}

/* 把前端生成的文件（base64）写入临时目录并用系统默认程序打开（打印/导出用） */
export async function openTempFile(name: string, dataB64: string): Promise<string> {
  return (ProjectSvc as any).OpenTempFile(name, dataB64)
}

/* 把前端生成的导出文件分块写入项目 output/ 目录（绕过 Wails 单条 IPC 调用体上限），返回 output 目录路径。
 * create=true 时创建/截断，false 时追加。前端按固定字节数切片逐次调用。 */
export async function saveExportFileChunk(dir: string, name: string, dataB64: string, create: boolean): Promise<string> {
  return (ProjectSvc as any).SaveExportFileChunk(dir, name, dataB64, create)
}
/* 在文件管理器中打开指定目录（导出后一键定位 output/） */
export async function openFolder(path: string): Promise<void> {
  return (ProjectSvc as any).OpenFolder(path)
}

/* 用系统默认浏览器打开外部链接（Wails 内 webview 的 <a target=_blank> 不会自动弹系统浏览器） */
export async function openExternal(url: string): Promise<void> {
  try {
    const { Browser } = await import('@wailsio/runtime')
    await Browser.OpenURL(url)
  } catch {
    window.open(url, '_blank', 'noopener')
  }
}

/** 导入文件结果：name = 去扩展名的文件名（作章节标题），content = UTF-8 文本 */
export interface ImportFile { name: string; content: string }
/* 弹出系统「导入文件」对话框（多选、文件/文件夹均可、过滤文本），读取内容后返回；
 * 取消选择时返回空数组。详见 Go ProjectService.ImportFiles */
export async function importFiles(): Promise<ImportFile[]> {
  return (ProjectSvc as any).ImportFiles()
}

/* ---- 图片素材（项目 assets/） ----
 * 图片不进前端内存：导入时由 Go 直接拷进 项目/assets/，只把文件名回给前端存进版式参数；
 * 读取时按「项目目录 + 文件名」向 Go 要 base64 → dataURL（预览与导出共用同一份缓存）。 */
/* 弹出系统「选择图片」对话框（多选），拷贝进项目 assets/（PNG 自动裁掉四周透明边）。
 * 返回落盘后的文件名数组（不含目录）；用户取消时为空数组；项目未保存时抛错。 */
export async function importImage(dir: string): Promise<string[]> {
  return (ProjectSvc as any).ImportImage(dir)
}
/* 读项目 assets/ 里的图片，返回 base64（不带 data: 前缀，由调用方拼 dataURL） */
export async function readProjectAsset(dir: string, name: string): Promise<string> {
  return (ProjectSvc as any).ReadProjectAsset(dir, name)
}
/* 列出项目 assets/ 里已有的图片文件名（目录不存在时为空数组） */
export async function listProjectAssets(dir: string): Promise<string[]> {
  return (ProjectSvc as any).ListProjectAssets(dir)
}
