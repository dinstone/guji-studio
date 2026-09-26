<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from 'vue'
import { LayoutEngine, preloadTexture } from '../core/engine'
import { prepareTemplateForRender } from '../core/fontcheck'
import { ensureAssets, onAssetReady } from '../core/assets'
import { fontLabelOf } from '../core/fontlist'
import { resolveTplBlock, curUnit, curChapter, cur, view, proj, unitFlowText, volLabelOf, isTocUnit, isTocDerived, tocUnit, tplEdit, tplScope, setPreviewLayout, projectDir, toast, editorSel, gotoSource, linkOn } from '../stores/app'
import { rasterizeSvg, saveBlobToOutput, downloadBlob } from '../core/exportImage'
import { beginFontSession, primeCodepoints } from '../core/fontEmbed'

const E = LayoutEngine
const pagesEl = ref<HTMLElement | null>(null)

/* 「本卷」预览：跟随当前所在卷；离开卷（选到导读/附录）时保留上次卷，按钮置灰 */
const volPreviewUi = ref(0)
watch(() => (cur.folder === 'scrolls' ? cur.ui : -1), v => { if (v >= 0) volPreviewUi.value = v }, { immediate: true })
const volModeAvailable = computed(() => cur.folder === 'scrolls')

/* 叶 = 版式 + 页数据成对保存：不同单元可有独立版式，渲染时必须用各自的版式 */
interface Leaf { t: Record<string, any>; p: any }

/** 单章：用当前单元（卷 / 导读 / 附录）的生效版式；目录单元为派生，用卷文结构生成的文本 */
const text = computed(() => {
  const u = curUnit()
  if (u && isTocUnit(u)) return unitFlowText(u)
  return curChapter()?.text || ''
})

/* 渲染防抖：编辑正文时 curChapter().text 逐字变化，若每次都重渲整页 SVG（尤其带宣纹背景图需重新异步加载）
   会持续闪烁。改为 ref + watch 防抖：连续输入只在停顿 200ms 后重渲一次；切章/切单元/切模式/改版式同样防抖，
   滑块拖动更顺。首屏 onMounted 即时算一次，不延迟。 */
const leaves = ref<Leaf[]>([])
function computeLeaves(): Leaf[] {
  if (view.src === 'chapter') {
    const u = curUnit(); if (!u) return []
    const t = resolveTplBlock(u)
    const vl = volLabelOf(u)   // 版心卷次 = 章所在卷的分组名
    return E.paginate(t, text.value).pages.map((p: any) => { p.volName = vl; return { t, p } })
  }
  if (view.src === 'volume') {
    const vol = proj.tree.scrolls[volPreviewUi.value]
    if (!vol || !(vol.chapters || []).length) return []
    const t = resolveTplBlock(vol)
    const vl = volLabelOf(vol)   // 版心卷次 = 本卷分组名
    return E.paginate(t, unitFlowText(vol)).pages.map((p: any, i: number) => { p.leaf = i + 1; p.volName = vl; return { t, p } })
  }
  /* 全书合订：导读 → 卷文 → 附录，依次排版；正文叶连续页码（包装/尾页不编页码，在封面视图预览）。
     目录单元为派生，unitFlowText 自动返回由卷文生成的「卷名+章名」文本。 */
  const blocks: { t: Record<string, any>; txt: string; vl: string }[] = []
  for (const u of [...proj.tree.guide, ...proj.tree.scrolls, ...proj.tree.appendix]) {
    const txt = unitFlowText(u)
    if (txt) blocks.push({ t: resolveTplBlock(u), txt, vl: volLabelOf(u) })
  }
  const out: Leaf[] = []
  let leaf = 0
  for (const bl of blocks) {
    E.paginate(bl.t, bl.txt).pages.forEach((p: any) => {
      p.leaf = ++leaf            // 连续页码：覆盖 paginate 的册内起算值
      p.volName = bl.vl          // 版心卷次 = 所在卷分组名
      out.push({ t: bl.t, p })
    })
  }
  return out
}
let renderTimer: any
function scheduleRender() {
  clearTimeout(renderTimer)
  renderTimer = setTimeout(() => { leaves.value = computeLeaves() }, 200)
}
/* 目录派生文本的输入指纹（只拼字符串、不做分页）：条目来源（章名 / ## 标题）、派生·手动、
 * 各卷卷名与章名。这些只决定「目录里写什么」，既不改当前单元结构也不改版式，
 * 不显式列进下面的 watch 就会一直是旧目录——曾漏掉 mode，切「章名 / ## 标题」预览纹丝不动。 */
function tocSig(): string {
  const t = tocUnit()
  if (!t) return ''
  const vols = proj.tree.scrolls
    .map(v => `${v.name || ''}~${(v.chapters || []).map(c => c.title).join(',')}`)
    .join(';')
  return `${t.mode || ''}|${isTocDerived(t) ? 'd' : 'm'}|${vols}`
}
watch(
  [
    () => curChapter()?.id,
    () => curChapter()?.text,
    () => view.src,
    () => cur.folder,
    () => cur.ui,
    volPreviewUi,
    () => view.guides,
    () => view.rulers,
    () => tocSig(),
    () => (curUnit() ? resolveTplBlock(curUnit()!) : null),
  ],
  scheduleRender,
  { deep: true }
)
/* 背景纹理预热：当前单元版式带宣纹时立即预取为 dataURL，使 200ms 防抖重渲时 cache 已就绪 → 内联同步显示、零闪 */
watch(
  () => {
    const u = curUnit()
    if (!u) return ''
    const t = resolveTplBlock(u) as Record<string, any>
    return t.canvas_background_image || ''
  },
  (bg) => { if (bg) preloadTexture(bg) },
  { immediate: true }
)

const svgs = computed(() =>
  leaves.value.map(l => E.renderPage(prepareTemplateForRender(l.t), l.p, { guides: view.guides, rulers: view.rulers }))
)
/* 版心尺寸参考模板：本卷模式取当前卷，其余取首叶或当前单元 */
const refTpl = computed(() => {
  if (view.src === 'volume') {
    const vol = proj.tree.scrolls[volPreviewUi.value]
    if (vol) return resolveTplBlock(vol)
  }
  return leaves.value[0]?.t || resolveTplBlock(curUnit())
})
const width = computed(() => {
  const m = E.computeMetrics(refTpl.value)
  return Math.round(m.W * view.zoom / 100)
})
/* 纸张定位：让「版框」在可视区居中，同时保证版框左缘始终可达。
   margin-left 取「居中位移」与「−纸张自留边」的较大者：
     · 纸张比容器窄（缩得小）→ 居中位移为正 → 正常居中（与原来的 margin-inline:auto 等价）；
     · 适宽（版框铺满内容宽）→ 居中位移约 −78px，仍大于 −81px（纸张自留边）→ 版框居中、纸边对称裁掉；
     · 手动放大更多 → 居中位移越来越负，被 −纸张自留边 兜住 → 纸张自留边正好裁尽、版框左缘贴内边距、
       右侧可滚到底（纯居中会让左半边永远滚不到，丢内容）。
   不用 flex 的 justify-content:center：左侧溢出部分同样滚不到。 */
const pageStyle = computed(() => {
  const w = width.value
  const t = refTpl.value as Record<string, any> | null
  const m = t ? E.computeMetrics(t) : null
  const bleed = m ? (m.W - m.frame.w) / 2 * view.zoom / 100 : 0   // 单侧纸张自留边的屏显宽度
  return { width: w + 'px', marginLeft: `max(calc((100% - ${w}px) / 2), ${-bleed}px)` }
})

/* 底部状态栏：由当前生效版式实时推导几何量与字体信息（与渲染同源，改版式即同步）。
   几何量来自 computeMetrics；字体名优先取引擎内置中文别名（FONT_CN），回退本机本地化名。 */
const CN = E.FONT_CN
const toNum = (v: any, d: number) => { const n = parseFloat(v); return isFinite(n) ? n : d }
const r1 = (n: number) => Math.round(n * 10) / 10
const r0 = (n: number) => Math.round(n)
function dispFont(v: any): string {
  const s = (v || '').toString().trim()
  if (!s) return '—'
  return CN[s] || fontLabelOf(s) || s
}
const layout = computed(() => {
  const t = refTpl.value as Record<string, any>
  if (!t) return null
  const m: any = E.computeMetrics(t)
  const accentFamily = t.accent_font_family || t.text_font_family
  const accentSize = toNum(t.accent_font_size, m.fontSize * 0.9)
  return {
    contentW: r0(m.content.w), contentH: r0(m.content.h),
    gutter: r0(m.centerW),
    cols: m.cols, rows: m.rowNum,
    colW: r1(m.colW), rowH: r0(m.rowH), cellH: r1(m.cellH),
    textFamily: dispFont(t.text_font_family), textSize: r1(m.fontSize),
    commentFamily: dispFont(t.comment_font_family), commentSize: r1(m.commentSize),
    accentFamily: dispFont(accentFamily), accentSize: r1(accentSize),
  }
})
watch(layout, v => { if (v) setPreviewLayout(v) }, { immediate: true })
/* 适宽 = 以「版框」（m.frame，外框线矩形）为基准，让可读的版框铺满 .pages 的内容宽。
   预览优先看内容（用户 2026-09-21：「既然是预览，肯定是先想看到内容」）：
     按纸张算 → 版框只占内容宽 86.3%（纸张自留边 240×2），面板边→版框约 97px 空白；
     按版框算 → 版框铺满，面板边→版框只剩内边距。
   代价：纸张自留边必然溢出容器（W/frameW = 1.159 倍），由 pageStyle 居中裁切。
   取 floor 不取 round：四舍五入会向上取整到比可用宽还宽、反而溢出。 */
const PAGE_PAD = 18                       // 与 .pages 的 padding 保持一致
function fitZoom() {
  const m = E.computeMetrics(refTpl.value)
  const el = pagesEl.value
  if (!el) return view.zoom
  const z = Math.floor((el.clientWidth - 2 * PAGE_PAD) / m.frame.w * 100)
  return Math.max(10, Math.min(120, z))
}
function fit() { view.zoom = fitZoom() }

/* ---- 预览器 PNG 导出：把当前预览的分页（单章/本卷/全书）逐叶光栅成 PNG。
 * 桌面端落盘到项目 output/，Web 预览端逐张触发浏览器下载。导出按真实版面尺寸（computeMetrics），
 * 与缩放无关；不含辅助线/标尺（导出的是书页本身）。 */
const exporting = ref(false)
const ASSET_KEYS = ['seam_stamp_src', 'watermark_src']
function collectPreviewAssets(): string[] {
  const out = new Set<string>()
  for (const l of leaves.value) {
    const t = l.t as any
    if (!t) continue
    for (const k of ASSET_KEYS) if (t[k]) out.add(String(t[k]))
  }
  return [...out]
}
const pad3 = (n: number) => String(n).padStart(3, '0')
async function exportPreviewPng() {
  if (!leaves.value.length) { toast('当前预览没有可导出的页面'); return }
  if (exporting.value) return
  exporting.value = true
  try {
    const ns = collectPreviewAssets()
    if (ns.length) await ensureAssets(ns)   // 堂号/水印素材预热，避免导出的图缺件
    /* 字体会话：每次导出重置（子集按字符集裁，沿用上一次会漏掉本轮新出现的字），
     * 并用当前单元文本 + 数字标点超集预热；漏掉的字符由逐叶扫描兜底（见 fontEmbed.ts）。 */
    beginFontSession()
    primeCodepoints(unitFlowText(curUnit() as any) +
      '0123456789〇零一二三四五六七八九十百千万、，。：；！？「」『』〔〕…—（）()《》〈〉·')
    const dir = projectDir.value
    const total = leaves.value.length
    let od = ''
    for (let i = 0; i < total; i++) {
      const l = leaves.value[i]
      const t2 = prepareTemplateForRender(l.t)
      const svg = E.renderPage(t2, l.p, { guides: 0, rulers: 0 })
      const m = E.computeMetrics(l.t) as any
      const blob = await rasterizeSvg(svg, m.W, m.H, String(l.p.leaf ?? i + 1))
      const n = l.p.leaf != null ? l.p.leaf : i + 1
      const name = `预览-${pad3(n)}.png`
      if (dir) od = await saveBlobToOutput(dir, name, blob)
      else await downloadBlob(blob, name)
    }
    if (dir) toast(`已导出 ${total} 张 PNG 到项目 output/ 目录`)
    else toast(`已下载 ${total} 张 PNG`)
  } catch (e: any) {
    toast('PNG 导出失败：' + (e?.message || e))
  } finally {
    exporting.value = false
  }
}
/* 缩放钳制 + 步进：与滑块 min/max/step 对齐（10–120，5 为步） */
function clampZoom(z: number) { return Math.max(10, Math.min(120, z)) }
function zoomStep(d: number) { view.zoom = clampZoom(Math.round((view.zoom + d) / 5) * 5) }
function zoomIn() { zoomStep(5) }
function zoomOut() { zoomStep(-5) }
/* 桌面壳里捏合（trackpad pinch）会派发带 ctrlKey 的 wheel 事件，这里接管做缩放；
   普通两指滚动无 ctrlKey，放行由容器正常滚动。 */
function onWheel(e: WheelEvent) {
  if (!(e.ctrlKey || e.metaKey)) return
  e.preventDefault()
  zoomStep(e.deltaY < 0 ? 5 : -5)
}

/* ---- 预览 ↔ 源文 双向联动 ----
 * 前提：engine 给每个渲染字写了 data-i（源文下标）。
 * - 点书页字 → gotoSource(i)：编辑器把光标跳到该源文下标。
 *   仅单章模式有效（编辑器与预览同文）；本卷/全书模式下 data-i 是各单元本地偏移，跳过去会错位，故关掉跳转。
 * - 编辑器选区 → editorSel 变化 → 书页落在 [from,to) 的字加 v-sel 高亮并滚到首个。
 *   此路径在全书/本卷下仍成立：高亮的是「当前章」在聚合页里对应的字（data-i 落在当前章文本区间内）。 */
function onPageClick(e: MouseEvent) {
  if (!linkOn.value || view.src !== 'chapter') return
  const t = (e.target as Element | null)?.closest('text[data-i]') as SVGTextElement | null
  if (!t) return
  const i = Number(t.dataset.i)
  if (Number.isFinite(i)) gotoSource(i)
}
function applySelHighlight() {
  const root = pagesEl.value
  if (!root) return
  if (!linkOn.value) {
    root.querySelectorAll('text.v-sel').forEach(n => n.classList.remove('v-sel'))
    return
  }
  let first: Element | null = null
  root.querySelectorAll('text[data-i]').forEach(n => {
    const i = Number((n as SVGTextElement).dataset.i)
    const hit = editorSel.active && Number.isFinite(i) && i >= editorSel.from && i < editorSel.to
    if (hit) { n.classList.add('v-sel'); if (!first) first = n } else n.classList.remove('v-sel')
  })
  if (first) (first as Element).scrollIntoView({ block: 'center' })
}
watch([svgs, editorSel, linkOn], () => { nextTick(applySelHighlight) }, { flush: 'post' })
/* ---- 预览内拖动定位（图片素材） ----
   唯一入口：按住预览里的堂号 / 水印直接拖 —— 几何命中（不受绘制层叠影响），素材上自带抓手光标作提示。
   拖动期间只改 DOM 里的 <image>（零重渲、跟手），松手才写回参数并重渲一次；拖动中按 Esc 放弃。
   写回走 tplEdit —— 与右侧参数面板同一门面，故「全书 / 本单元」档位对拖动同样生效。
   用 mousedown + window 级监听（与 App.vue 分隔条同一套成熟做法），不依赖 PointerEvent/Capture。 */
type DragKind = '' | 'seam' | 'wm'
const dragging = ref<DragKind>('')      // 本次手势抓住的对象（'' = 未拖动）
let stt = { px: 0, py: 0, pos: 0, wx: 0, wy: 0 }

const m0 = () => E.computeMetrics(refTpl.value) as any
const clamp01 = (v: number) => (v < 0 ? 0 : (v > 1 ? 1 : v))
/* 可拖判定按「预览正在渲染的生效版式」，与右侧面板的「全书 / 本单元」档位解耦 */
const canSeam = computed(() => !!(refTpl.value as any)?.seam_stamp_src)
const canWm = computed(() => !!(refTpl.value as any)?.watermark_src)

/* 几何命中：水印压在版框与文字之下，点在字上时 target 是 <text> 而非 <image>，
   所以不靠事件 target、按各 <image> 的屏幕包围盒判。堂号更小且绘在最上层，先判。 */
function hitKind(x: number, y: number): DragKind {
  const inside = (sel: string, kind: DragKind): DragKind => {
    const nodes = pagesEl.value?.querySelectorAll(sel)
    if (!nodes) return ''
    for (const n of Array.from(nodes)) {
      const r = (n as Element).getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return kind
    }
    return ''
  }
  return inside('.v-seamstamp', 'seam') || inside('.v-wm', 'wm')
}

function onDown(e: MouseEvent) {
  if (e.button !== 0) return
  /* 指哪打哪：按住哪张图就抓哪张 */
  const kind: DragKind = hitKind(e.clientX, e.clientY)
  if (!kind || (kind === 'seam' ? !canSeam.value : !canWm.value)) return
  stt = {
    px: e.clientX, py: e.clientY,
    pos: Number(tplEdit.seam_stamp_pos) || 0,
    wx: Number(tplEdit.watermark_x) || 0,
    wy: Number(tplEdit.watermark_y) || 0,
  }
  dragging.value = kind
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  document.body.style.userSelect = 'none'
  document.body.style.cursor = kind === 'seam' ? 'ns-resize' : 'move'
  e.preventDefault()
}

/* 跟手位移：只挪 <image>、不重算版面。两点要害 ——
   ① 位移取「相对手势起点的总位移」，不是两次 move 之间的增量（增量叠加到起点基准上会互相覆盖，
      图只在原地抖、跟不上光标）；
   ② 屏幕 px → SVG 用户单位要除以缩放，否则图比光标走得慢（松手才跳到位）。 */
function liveShift(kind: DragKind, dx: number, dy: number) {
  const nodes = pagesEl.value?.querySelectorAll(kind === 'seam' ? '.v-seamstamp' : '.v-wm')
  if (!nodes) return
  const z = Math.max(0.01, view.zoom / 100)
  nodes.forEach(n => {
    const el = n as SVGImageElement
    if (el.dataset.bx === undefined) {          // 基准只记一次；重渲后 DOM 换新自动归零
      el.dataset.bx = el.getAttribute('x') || '0'
      el.dataset.by = el.getAttribute('y') || '0'
    }
    el.setAttribute('x', String(parseFloat(el.dataset.bx || '0') + (kind === 'seam' ? 0 : dx / z)))
    el.setAttribute('y', String(parseFloat(el.dataset.by || '0') + dy / z))
  })
}

function onMove(e: MouseEvent) {
  const k = dragging.value
  if (!k) return
  liveShift(k, e.clientX - stt.px, e.clientY - stt.py)
}

function endDrag() {
  window.removeEventListener('mousemove', onMove)
  window.removeEventListener('mouseup', onUp)
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  dragging.value = ''
}

function onUp(e: MouseEvent) {
  const k = dragging.value
  if (!k) return
  const dx = e.clientX - stt.px, dy = e.clientY - stt.py
  endDrag()
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return    // 只是点了一下：不写参数、不污染覆盖
  const m = m0(), z = Math.max(0.01, view.zoom / 100)
  if (k === 'seam') {
    tplEdit.seam_stamp_pos = clamp01(stt.pos + dy / (z * Math.max(1, m.content.h)))
  } else {
    tplEdit.watermark_x = clamp01(stt.wx + dx / (z * Math.max(1, m.W)))
    tplEdit.watermark_y = clamp01(stt.wy + dy / (z * Math.max(1, m.H)))
  }
  scheduleRender()
}
/* Esc：放弃本次拖动（不写参数，重渲还原） */
function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !dragging.value) return
  endDrag(); scheduleRender()
}

/* 素材预热是异步的：就绪后重渲一次，首帧缺的图补上 */
const offAsset = onAssetReady(() => scheduleRender())
onUnmounted(() => { offAsset(); endDrag(); window.removeEventListener('keydown', onKeyDown) })
/* 参数里出现的素材立即预取（切模板 / 换单元后马上发起请求） */
watch(
  () => [tplEdit.seam_stamp_src, tplEdit.watermark_src],
  arr => { const ns = (arr as string[]).filter(Boolean); if (ns.length) ensureAssets(ns) },
  { immediate: true }
)

onMounted(() => { leaves.value = computeLeaves(); fit(); window.addEventListener('keydown', onKeyDown) })
</script>

<template>
  <section class="pv">
    <div class="bar">
      <div class="seg">
        <button :class="{ on: view.src === 'chapter' }" @click="view.src = 'chapter'">单章</button>
        <button :class="{ on: view.src === 'volume' }" :disabled="!volModeAvailable" @click="view.src = 'volume'">本卷</button>
        <button :class="{ on: view.src === 'book' }" @click="view.src = 'book'">全书</button>
      </div>
      <label class="ck"><input v-model="view.guides" type="checkbox" :true-value="1" :false-value="0">辅助线</label>
      <label class="ck"><input v-model="view.rulers" type="checkbox" :true-value="1" :false-value="0">尺寸标尺</label>
      <span class="sp" />
      <button class="fit" @click="fit">适宽</button>
      <div class="zgrp">
        <button class="zbtn" :disabled="view.zoom <= 10" @click="zoomOut" title="缩小">−</button>
        <input v-model.number="view.zoom" type="range" min="10" max="120" step="5" class="zoom">
        <button class="zbtn" :disabled="view.zoom >= 120" @click="zoomIn" title="放大">+</button>
      </div>
      <span class="pct">{{ view.zoom }}%</span>
      <button class="fit link" :class="{ on: linkOn }" @click="linkOn = !linkOn" title="联动：开 → 点书页字跳回源文、源文选区高亮书页字">联动</button>
      <button class="fit exp" :disabled="exporting || !svgs.length" @click="exportPreviewPng">{{ exporting ? '导出中…' : 'PNG 导出' }}</button>
    </div>
    <div
      ref="pagesEl" class="pages" :class="{ dragging: !!dragging }"
      @wheel="onWheel" @mousedown="onDown" @click="onPageClick"
    >
      <div class="page" :style="pageStyle">
        <div v-for="(svg, i) in svgs" :key="i" class="leaf" v-html="svg" />
      </div>
      <div v-if="!svgs.length" class="none">
        <p v-if="view.src === 'chapter'">尚未选中章节。在左侧点「＋ 章」新建，或选中一章后预览。</p>
        <p v-else-if="view.src === 'volume'">本卷暂无章节。在左侧「正文」下为该卷添加章节，或选择其它卷后预览。</p>
        <p v-else>全书为空。在左侧「正文」下点「＋ 章」添加章节，或点「＋ 序 / ＋ 目录 / ＋ 跋」添加辅文。</p>
      </div>
      <div class="cnt" v-if="svgs.length">{{ svgs.length }} 叶</div>
    </div>
    <div v-if="dragging" class="draghint">
      <b>拖动中</b>
      <span>{{ dragging === 'seam' ? '堂号 · 仅上下' : '水印 · 上下左右' }}</span>
      <span>写入{{ tplScope === 'unit' ? '本单元' : '全书默认' }}</span>
      <span class="esc">Esc 取消</span>
    </div>
  </section>
</template>

<style scoped>
.pv { position: relative; flex: 1; display: flex; flex-direction: column; min-width: 0; background: #f3f1ec; }
.bar { padding: 6px 10px; background: #fff; border-bottom: 0.5px solid #d3d1c7; font-size: 12px; display: flex; align-items: center; flex-wrap: wrap; row-gap: 4px; gap: 10px; }
.seg { display: inline-flex; border: 0.5px solid #d3d1c7; border-radius: 6px; overflow: hidden; }
.seg button { border: 0; background: none; padding: 2px 10px; font-size: 12px; cursor: pointer; color: #5f5e5a; }
.seg button.on { background: #0f6e56; color: #e1f5ee; }
.seg button:disabled { opacity: .4; cursor: not-allowed; }
.ck { display: inline-flex; align-items: center; gap: 3px; color: #5f5e5a; cursor: pointer; }
.sp { flex: 1; }
.zoom { width: 110px; accent-color: #0f6e56; }
.zgrp { display: inline-flex; align-items: center; gap: 4px; }
.zbtn { width: 20px; height: 20px; line-height: 1; border: 0.5px solid #d3d1c7; background: #faf9f6; border-radius: 4px; font-size: 13px; cursor: pointer; color: #5f5e5a; padding: 0; }
.zbtn:hover:not(:disabled) { border-color: #0f6e56; color: #0f6e56; }
.zbtn:disabled { opacity: .4; cursor: not-allowed; }
.fit { border: 0.5px solid #d3d1c7; background: #faf9f6; border-radius: 4px; font-size: 12px; padding: 1px 8px; cursor: pointer; color: #5f5e5a; }
.fit:hover { border-color: #0f6e56; color: #0f6e56; }
.fit.exp { border-color: #0f6e56; color: #0f6e56; }
.fit.exp:hover:not(:disabled) { background: #0f6e56; color: #e1f5ee; }
.fit.exp:disabled { opacity: .4; cursor: not-allowed; border-color: #d3d1c7; color: #5f5e5a; }
.fit.link.on { background: #0f6e56; color: #e1f5ee; border-color: #0f6e56; }
.pct { color: #5f5e5a; min-width: 38px; text-align: right; }
/* 拖动反馈：素材上直接给抓手光标（这就是唯一的入口提示），拖动期间整页 grabbing；浮动提示条不挡鼠标 */
.pages :deep(.v-seamstamp) { cursor: ns-resize; }
.pages :deep(.v-wm) { cursor: move; }
.pages :deep(text.v-sel) { fill: #ff5252 !important; }
.pages.dragging { cursor: grabbing; }
.pages.dragging :deep(svg) { user-select: none; }
.draghint {
  position: absolute; left: 50%; bottom: 16px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 8px;
  background: rgba(15, 110, 86, .93); color: #e1f5ee;
  font-size: 12px; padding: 5px 13px; border-radius: 999px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .2); pointer-events: none; white-space: nowrap;
}
.draghint b { font-weight: 600; }
.draghint .esc { opacity: .75; }
/* 滚动容器用 block + 子元素自定位：`.page` 的实际 margin-left 由 pageStyle 内联给出
   （max(居中位移, −纸张自留边)），这里保留的 margin-inline:auto 仅在无内联时兜底。
   （flex align-items/justify-content:center 会把左侧溢出滚死；safe center 老 WebKit 不认） */
/* 放开选中：App.vue 根容器设了 user-select:none 防误选 UI 文字，此处覆盖回 text，
   让书页 SVG 文本可被框选/复制。拖动堂号/水印时仍由 .pages.dragging 临时关掉。 */
.pages { flex: 1; overflow: auto; padding: 18px; user-select: text; -webkit-user-select: text; }
.page { display: flex; flex-direction: column; gap: 14px; margin-inline: auto; }
.leaf { background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.12); line-height: 0; }
.leaf :deep(svg) { width: 100%; height: auto; display: block; user-select: text; -webkit-user-select: text; }
.pages :deep(text) { cursor: text; }
.cnt { font-size: 12px; color: #888780; margin-top: 14px; text-align: center; }
.none { padding: 40px 20px; text-align: center; color: #888780; font-size: 13px; line-height: 1.9; }
.none p { margin: 0; }
</style>
