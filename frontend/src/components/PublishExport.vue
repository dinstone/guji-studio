<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { LayoutEngine } from '../core/engine'
import { prepareTemplateForRender } from '../core/fontcheck'
import {
  proj, addPub, deletePub, availablePackLeaves,
  resolveTplBlock, toast, resolveLeafCfg, tpl, unitFlowText, volLabelOf, projectDir,
  type PubGroup, type PubChapters, type Block, type Volume,
} from '../stores/app'
import { appConfirm } from '../stores/dialog'
import * as plat from '../platform/wails'
import { ensureAssets } from '../core/assets'
import { renderSpread } from '../core/special'
import { rasterizeSvg, saveBlobToOutput, resetProfiles, getProfiles, logProfileSummary, suspectLeaves } from '../core/exportImage'
import { failedFamilies } from '../core/fontEmbed'
import PubGroupEditor from './PubGroupEditor.vue'

const E = LayoutEngine

/* ============ 册组装编辑（左/中栏） ============ */
/* sel = null 表示「未选择」；-1 表示「整书合并」（虚拟项）；>=0 为册索引。
 * 默认 null → 进入页面不渲染任何预览，秒开。点击左侧任意项才异步渲染并带进度。 */
const sel = ref<number | null>(null)
const cur = computed(() => (sel.value !== null && sel.value >= 0) ? proj.pubs[sel.value] : null)
const packItems = computed(() => availablePackLeaves())
const guideItems = computed(() => proj.tree.guide.map(g => g.name))
const appendixItems = computed(() => proj.tree.appendix.map(a => a.name))

function volEntry(vid: string): PubChapters | undefined { return cur.value?.chapters.find(c => c.volume === vid) }
function hasVol(vid: string): boolean { return !!volEntry(vid) }
function hasChap(vid: string, cid: string): boolean {
  const e = volEntry(vid); if (!e) return false
  return !e.chapters || e.chapters.includes(cid)
}
function toggleVol(vid: string, on: boolean) {
  const p = cur.value; if (!p) return
  const i = p.chapters.findIndex(c => c.volume === vid)
  if (on) { if (i < 0) p.chapters.push({ volume: vid }) }
  else if (i >= 0) p.chapters.splice(i, 1)
}
function toggleChap(vid: string, cid: string, on: boolean) {
  const p = cur.value; if (!p) return
  let e = p.chapters.find(c => c.volume === vid)
  if (!e) { if (!on) return; e = { volume: vid, chapters: [] }; p.chapters.push(e) }
  const vol = proj.tree.scrolls.find(v => v.id === vid)
  if (!e.chapters) {
    if (!on && vol) e.chapters = vol.chapters.filter(c => c.id !== cid).map(c => c.id)
  } else {
    const j = e.chapters.indexOf(cid)
    if (on) { if (j < 0) e.chapters.push(cid) }
    else if (j >= 0) e.chapters.splice(j, 1)
  }
  if (e.chapters && e.chapters.length === 0) {
    const i = p.chapters.findIndex(c => c.volume === vid)
    if (i >= 0) p.chapters.splice(i, 1)
  }
}
function setFront(g: PubGroup[]) { if (cur.value) cur.value.front = g }
function setBack(g: PubGroup[]) { if (cur.value) cur.value.back = g }

function onAdd() { selectAndRender(addPub()) }
async function onDel(i: number) {
  const t = proj.pubs[i]?.title ?? ''
  if (!(await appConfirm(`删除册「${t}」？该册的导出组装配置将丢失。`))) return
  deletePub(i)
  await selectAndRender(proj.pubs.length ? 0 : -1)
}

/* ============ 预览 + 导出（右栏） ============ */
interface Spread { label: string; svg: string; W: number; H: number }
const includeSpecial = ref(true)
const exporting = ref(false)
const lastOutputDir = ref('')
/* 导出性能统计：光栅合计耗时 + 字体内联带来的每叶膨胀。看数字要不要上子集化，就以这一行为准。 */
const expStat = ref('')

/* 导出弹窗：进度 + 文件名 + 常驻赞赏码。done 态不自动关闭，保证赞赏码被看到 */
const done = ref(false)
const expErr = ref<string | null>(null)
const expName = ref('')
const expCur = ref(0)
const expTotal = ref(0)
const pct = computed(() => (expTotal.value ? Math.round((expCur.value / expTotal.value) * 100) : 0))
function closeExport() { exporting.value = false; done.value = false; expErr.value = null }

function bookMetrics() { return E.computeMetrics(tpl) }

/* 图片素材预热（与原 ExportPanel 一致）：特殊页/堂号/水印未就绪时 <image> 不会进 SVG → 导出静默缺图 */
const ASSET_KEYS = ['seam_stamp_src', 'watermark_src']
async function warmAssets(): Promise<void> {
  const out = new Set<string>()
  const add = (o: any) => { if (o) for (const k of ASSET_KEYS) if (o[k]) out.add(String(o[k])) }
  add(tpl)
  for (const u of [...proj.tree.guide, ...proj.tree.scrolls, ...proj.tree.appendix]) add(resolveTplBlock(u))
  for (const k of ['cover', 'fly', 'colophon'] as const) {
    const c = resolveLeafCfg(k)
    if (c.stamp && !String(c.stamp).startsWith('data:')) out.add(String(c.stamp))
    if (c.illus && !String(c.illus).startsWith('data:')) out.add(String(c.illus))
    if (c.bg && !String(c.bg).startsWith('data:') && !String(c.bg).includes('/')) out.add(String(c.bg))
  }
  if (!out.size) return
  await ensureAssets([...out])
}

const PACK_LEAF: Record<string, 'cover' | 'fly' | 'colophon'> = { '封面': 'cover', '扉页': 'fly', '尾页': 'colophon' }

/* 整书合并的单元序列：导读 → 卷文 → 附录（预览与计数共用，保证口径一致） */
function bookUnits(): (Block | Volume)[] { return [...proj.tree.guide, ...proj.tree.scrolls, ...proj.tree.appendix] }

/* 叶计划：只分页（快速），特殊页直接成图，正文页留待渲染阶段逐叶成图。
 * 预览与导出共用同一份计划，保证所见即所得、且分页只做一次。target=-1 整书合并，>=0 某分册。 */
interface PlanLeaf { label: string; W: number; H: number; svg?: string; tpl?: any; page?: any }
const arrOf = (v: string | string[] | undefined): string[] => v == null ? [] : Array.isArray(v) ? v : [v]

function planSpreads(target: number): PlanLeaf[] {
  const out: PlanLeaf[] = []
  const m = bookMetrics()
  const no = { n: 0 }
  const pushSpecial = (nm: string, k: 'cover' | 'fly' | 'colophon', volLabel?: string) => {
    const cfg = resolveLeafCfg(k)
    if (volLabel) cfg.volLabel = volLabel
    out.push({ label: nm, W: m.W, H: m.H, svg: renderSpread(null, k, cfg, m.W, m.H) })
  }
  const pushText = (tplUnit: any, flowText: string, baseName: string, volName: string) => {
    if (!flowText) return
    const t = prepareTemplateForRender(resolveTplBlock(tplUnit))
    const mm = E.computeMetrics(t)
    for (const p of E.paginate(t, flowText).pages as any[]) {
      p.leaf = ++no.n; p.volName = volName
      out.push({ label: `${baseName} ${no.n}`, W: mm.W, H: mm.H, tpl: t, page: p })
    }
  }
  if (target < 0) {
    if (includeSpecial.value) { pushSpecial('封面', 'cover'); pushSpecial('扉页', 'fly') }
    for (const u of bookUnits()) pushText(u, unitFlowText(u), u.name, volLabelOf(u))
    if (includeSpecial.value) pushSpecial('尾页', 'colophon')
  } else {
    const p = proj.pubs[target]; if (!p) return out
    const pushGroup = (g: PubGroup) => {
      for (const nm of arrOf(g.pack)) {
        if (!includeSpecial.value) continue
        const k = PACK_LEAF[nm]; if (!k) continue
        pushSpecial(nm, k, k !== 'colophon' ? p.title : undefined)
      }
      for (const nm of arrOf(g.guide)) { const u = proj.tree.guide.find(x => x.name === nm); if (u) pushText(u, unitFlowText(u), nm, '') }
      for (const nm of arrOf(g.appendix)) { const u = proj.tree.appendix.find(x => x.name === nm); if (u) pushText(u, unitFlowText(u), nm, '') }
    }
    for (const g of p.front || []) pushGroup(g)
    for (const s of p.chapters || []) {
      const vol = proj.tree.scrolls.find(v => v.id === s.volume); if (!vol) continue
      const chaps = s.chapters?.length ? vol.chapters.filter(c => s.chapters!.includes(c.id)) : vol.chapters
      const txt = chaps.map(c => c.text).filter(Boolean).join('\n')
      pushText(vol, txt, vol.name || '正文', vol.name || '')
    }
    for (const g of p.back || []) pushGroup(g)
  }
  return out
}

function renderLeaf(leaf: PlanLeaf): string {
  return leaf.svg ?? E.renderPage(leaf.tpl!, leaf.page!, { guides: 0 })
}

/* 当前选择的叶数（仅分页，不渲染 SVG）：列表与导出按钮共读。sel===null 时为 0（未选，导出禁用）。 */
const expCount = computed(() => (sel.value === null ? 0 : planSpreads(sel.value).length))
/* 整书合并的叶数：列表常显，让用户预估渲染成本；与计划口径同源。 */
const bookCount = computed(() => planSpreads(-1).length)

/* 预览渲染：异步分页 + 逐叶成图，带进度；切换选择会取消上一次渲染（renderToken）。
 * 渲染结果按「册稳定 id + 包含特殊页」缓存：重复点同一项 / 切回已渲染项 = 秒回，不做无谓重渲。 */
const spreads = ref<Spread[]>([])
const rendering = ref(false)
const renderProgress = ref({ cur: 0, total: 0 })
let renderToken = 0
const renderCache = new Map<string, Spread[]>()
/* 缓存键：整书合并用 'book'，分册用其稳定 id（不用下标，避免删册后下标错位命中旧项）；
 * 含 includeSpecial 使「含/不含特殊页」两版互不污染。 */
function cacheKey(target: number): string {
  const id = target < 0 ? 'book' : (proj.pubs[target]?.id ?? `pub:${target}`)
  return `${id}:${includeSpecial.value ? 1 : 0}`
}
const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()))
async function selectAndRender(target: number, force = false) {
  /* 命中缓存且非强制 → 直接复用上次叶数组，秒回（不重算不重渲） */
  if (!force) {
    const hit = renderCache.get(cacheKey(target))
    if (hit) { sel.value = target; spreads.value = hit; return }
  }
  sel.value = target
  const token = ++renderToken
  spreads.value = []
  rendering.value = true
  renderProgress.value = { cur: 0, total: 0 }
  await nextFrame()                 // 先让「正在渲染」上屏一帧，避免点下去像卡死
  await warmAssets()                 // 确保 <image> 进 SVG（否则缺图）
  if (token !== renderToken) return
  const plan = planSpreads(target)
  renderProgress.value = { cur: 0, total: plan.length }
  for (let i = 0; i < plan.length; i++) {
    if (token !== renderToken) return
    const leaf = plan[i]
    spreads.value.push({ label: leaf.label, svg: renderLeaf(leaf), W: leaf.W, H: leaf.H })
    renderProgress.value = { cur: i + 1, total: plan.length }
    if ((i + 1) % 2 === 0) await nextFrame()   // 每 2 叶让出一帧，保持界面可响应
  }
  if (token !== renderToken) return
  renderCache.set(cacheKey(target), spreads.value)   // 渲染完成才入缓存，半成品/被取消的不存
  rendering.value = false
}

/* 切换包含特殊页时，清除当前项的缓存（两版都清）后强制重渲，保证预览与勾选一致 */
watch(includeSpecial, () => {
  if (sel.value !== null) {
    const id = sel.value < 0 ? 'book' : (proj.pubs[sel.value]?.id ?? `pub:${sel.value}`)
    renderCache.delete(`${id}:0`); renderCache.delete(`${id}:1`)
    selectAndRender(sel.value, true)
  }
})

/* 性能统计文案：只统计光栅化（不含 PDF 拼装与落盘），免得把子集化的收益算到别处头上。 */
function statText(ms: number): string {
  const ps = getProfiles()
  if (!ps.length) return ''
  const grow = ps.reduce((a, p) => a + Math.max(0, p.svgOut - p.svgIn), 0) / ps.length
  /* 缺字页必须显形：桌面端看不到 console，否则用户只会得到一页白的，无从下手。 */
  const bad = suspectLeaves()
  /* 字体没能内联同样要显形：墨迹判据抓不到它——回退字体照样把字画出来，
   * 只是字形不对。用户看到的会是「导出的字不是选的字体」，不给提示就无从定位。 */
  const noFont = failedFamilies()
  /* 第三条独立信号：字体数据没问题，但探针多轮都没能证明它在**图片文档**里可用。 */
  const probeBad = ps.some(p => p.probeFail)
  return `光栅 ${(ms / 1000).toFixed(1)}s · ${ps.length} 叶 · 每叶内联增加 ${(grow / 1024 / 1024).toFixed(2)}MB` +
    (bad.length ? ` · ⚠ ${bad.length} 叶疑似缺字（${bad.map(p => p.label).join('、')}）` : '') +
    (noFont.length ? ` · ⚠ 字体未内联：${noFont.join('、')}` : '') +
    (probeBad ? ' · ⚠ 内联字体未在图片文档生效' : '')
}

function stamp() { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}` }
function bookFileName() { return `${(proj.meta.title || proj.name || 'guji')}-${stamp()}.pdf` }
function pubFileName(p: any) { return `${p.title}-${stamp()}.pdf` }
function selPdfName(): string { return sel.value !== null && sel.value >= 0 ? pubFileName(proj.pubs[sel.value]) : bookFileName() }
function selStem(): string { return sel.value !== null && sel.value >= 0 ? proj.pubs[sel.value].title : (proj.meta.title || proj.name || 'guji') }

async function exportPDF() {
  if (sel.value === null) { toast('请先在左侧选择整书合并或某个分册'); return }
  if (!expCount.value) { toast('当前选择没有可导出的内容'); return }
  exporting.value = true; lastOutputDir.value = ''; expStat.value = ''
  done.value = false; expErr.value = null
  expName.value = selPdfName(); expTotal.value = expCount.value; expCur.value = 0
  resetProfiles()
  try {
    await warmAssets()
    const plan = planSpreads(sel.value)   // 预热后重新取：特殊页 <image> 此时才进 SVG
    const total = plan.length
    expTotal.value = total
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const t0 = performance.now()
    for (let i = 0; i < total; i++) {
      const leaf = plan[i]
      const blob = await rasterizeSvg(renderLeaf(leaf), leaf.W, leaf.H, leaf.label)
      const img = await doc.embedPng(await blob.arrayBuffer())
      const pw = leaf.W / 300 * 72, ph = leaf.H / 300 * 72   // 300dpi px → pt（各叶纸幅可不同，按叶取值）
      const page = doc.addPage([pw, ph])
      page.drawImage(img, { x: 0, y: 0, width: pw, height: ph })
      expCur.value = i + 1
    }
    expStat.value = statText(performance.now() - t0)
    logProfileSummary('PDF')
    const bytes = await doc.save()
    const od = await saveBlobToOutput(projectDir.value, selPdfName(), new Blob([bytes as any], { type: 'application/pdf' }))
    lastOutputDir.value = od
    done.value = true
  } catch (e: any) {
    expErr.value = 'PDF 生成失败：' + (e?.message || e)
    done.value = true
    toast('PDF 生成失败：' + (e?.message || e))
  }
  exporting.value = false
}

async function openOutput() {
  if (!projectDir.value) { toast('项目尚未保存到磁盘，还没有 output/ 目录'); return }
  const dir = lastOutputDir.value || (projectDir.value.endsWith('output') ? projectDir.value : projectDir.value + '/output')
  try { await plat.openFolder(dir); toast('已打开：' + dir) }
  catch (e: any) { toast('打开目录失败：' + (e?.message || e)) }
}

async function exportPNG() {
  if (sel.value === null) { toast('请先在左侧选择整书合并或某个分册'); return }
  if (!expCount.value) { toast('当前选择没有可导出的内容'); return }
  exporting.value = true; lastOutputDir.value = ''; expStat.value = ''
  done.value = false; expErr.value = null
  expName.value = `${selStem()}-*.png`; expTotal.value = expCount.value; expCur.value = 0
  resetProfiles()
  try {
    await warmAssets()
    const plan = planSpreads(sel.value)   // 预热后重新取：特殊页 <image> 此时才进 SVG
    const total = plan.length
    expTotal.value = total
    let od = ''
    const t0 = performance.now()
    for (let i = 0; i < total; i++) {
      const leaf = plan[i]
      const blob = await rasterizeSvg(renderLeaf(leaf), leaf.W, leaf.H, leaf.label)
      const buf = new Uint8Array(await blob.arrayBuffer())
      const name = `${selStem()}-${String(i + 1).padStart(2, '0')}.png`
      od = await saveBlobToOutput(projectDir.value, name, new Blob([buf as any]))
      expCur.value = i + 1
    }
    expStat.value = statText(performance.now() - t0)
    logProfileSummary('PNG')
    lastOutputDir.value = od
    done.value = true
  } catch (e: any) {
    expErr.value = 'PNG 导出失败：' + (e?.message || e)
    done.value = true
    toast('PNG 导出失败：' + (e?.message || e))
  }
  exporting.value = false
}
</script>

<template>
  <div class="pub-view">
    <!-- 左栏：册列表 + 导出控制 -->
    <aside class="ctrl">
      <div class="grp">册 / 成品</div>
      <button class="add" @click="onAdd">＋ 新建册</button>
      <ul>
        <li :class="{ on: sel === -1 }" @click="selectAndRender(-1)">
          <span class="t">整书合并</span>
          <span class="cnt">{{ bookCount }} 叶</span>
        </li>
        <li v-for="(p, i) in proj.pubs" :key="p.id" :class="{ on: sel === i }" @click="selectAndRender(i)">
          <span class="t">{{ p.title }}</span>
          <button class="del" @click.stop="onDel(i)" title="删除">×</button>
        </li>
      </ul>
      <div v-if="!proj.pubs.length" class="none">（尚无分册，点上方「新建册」）</div>

      <div class="grp">拼装选项</div>
      <label class="ck"><input v-model="includeSpecial" type="checkbox"> 包含特殊页（封面/扉页/尾页）</label>

      <div class="grp">输出</div>
      <button class="act" :disabled="exporting || !expCount" @click="exportPDF">导出 PDF（{{ expCount }} 叶）</button>
      <button class="act sub" :disabled="exporting" @click="exportPNG">导出 PNG（逐叶）</button>
      <button class="act sub" @click="openOutput">打开导出目录</button>
      <div class="note">
        选中左侧某项后异步渲染预览，导出按钮<span class="hl">仅对该成品生效</span>。<br>
        <b>整书合并</b>：一份 PDF = 封面·扉页 + 导读·卷文·附录正文（连续页码）+ 尾页。<br>
        <b>分册</b>：按该册 front/chapters/back 三段组装（册内页码从 1 重排），文件名 <b>册名-时间.pdf</b>。<br>
        选中后<span class="hl">逐叶异步渲染</span>（数十叶成图较慢，带进度），渲染中可继续操作；导出不依赖预览。<br>
        桌面端 PDF/PNG 落到项目 <b>output/</b> 目录。
      </div>
    </aside>

    <!-- 中栏：册组装编辑（整书合并为虚拟项，不可编辑） -->
    <section class="edit" v-if="cur">
      <div class="hdr">
        <input class="title" v-model="cur.title" placeholder="册名" />
        <span class="meta">正文 {{ cur.chapters.length }} 卷 · 前辅文 {{ cur.front.length }} 项 · 后辅文 {{ cur.back.length }} 项</span>
      </div>

      <div class="blk">
        <div class="blk-h">正文（按卷纳入；展开可选具体章）</div>
        <div v-for="v in proj.tree.scrolls" :key="v.id" class="vol">
          <label class="vrow">
            <input type="checkbox" :checked="hasVol(v.id)"
              @change="toggleVol(v.id, ($event.target as HTMLInputElement).checked)" />
            <b>{{ v.name || '（默认卷）' }}</b>
            <span class="cnt">{{ v.chapters.length }} 章</span>
          </label>
          <div v-if="hasVol(v.id)" class="chaps">
            <label v-for="c in v.chapters" :key="c.id" class="chap">
              <input type="checkbox" :checked="hasChap(v.id, c.id)"
                @change="toggleChap(v.id, c.id, ($event.target as HTMLInputElement).checked)" />
              {{ c.title }}
            </label>
          </div>
        </div>
        <div v-if="!proj.tree.scrolls.length" class="none">（无正文卷，请先在书视图建立卷）</div>
      </div>

      <div class="blk">
        <div class="blk-h">前辅文（封面 / 扉页 / 序 / 目录…）</div>
        <PubGroupEditor :groups="cur.front" :pack-items="packItems" :guide-items="guideItems"
          :appendix-items="appendixItems" @update:groups="setFront" />
      </div>

      <div class="blk">
        <div class="blk-h">后辅文（跋 / 牌记 / 尾页…）</div>
        <PubGroupEditor :groups="cur.back" :pack-items="packItems" :guide-items="guideItems"
          :appendix-items="appendixItems" @update:groups="setBack" />
      </div>
    </section>
    <section class="edit empty" v-else>
      <p v-if="sel === null">请在左侧选择「整书合并」或某个分册，<br>选中后将异步渲染预览，并可直接导出。</p>
      <p v-else>整书合并为导出时自动拼接全部正文与包装叶，不可单独编排。<br>右侧点击后将异步渲染预览；左下角「导出 PDF」可直接导出整书，无需等待预览。</p>
    </section>

    <!-- 右栏：成品预览 -->
    <div class="stage">
      <div v-if="sel === null" class="empty">请选择左侧的整书合并或某个分册以预览</div>
      <template v-else>
        <div v-if="rendering" class="gate">
          <div class="gate-card">
            <div class="gate-t">正在渲染预览…</div>
            <div class="gate-d">已生成 {{ renderProgress.cur }} / {{ renderProgress.total }} 叶</div>
            <div class="gate-bar"><div class="gate-bar-fill" :style="{ width: (renderProgress.total ? Math.round(renderProgress.cur / renderProgress.total * 100) : 0) + '%' }"></div></div>
          </div>
        </div>
        <figure v-for="(s, i) in spreads" :key="i">
          <div class="card" v-html="s.svg"></div>
          <figcaption>{{ i + 1 }}. {{ s.label }}</figcaption>
        </figure>
        <div v-if="!rendering && !spreads.length" class="empty">该册暂无可导出内容</div>
      </template>
    </div>

    <!-- 导出弹窗：进度 + 文件名 + 常驻赞赏码；导出中不可关闭，完成后停留 -->
    <div class="exp-mask" v-if="exporting || done">
      <div class="exp">
        <div class="exp-head">
          <h3 :class="{ err: done && expErr }">{{ done ? (expErr ? '导出失败' : '导出完成') : '正在导出…' }}</h3>
          <button v-if="done" class="exp-x" @click="closeExport" title="关闭">✕</button>
        </div>
        <div class="exp-name">{{ expName }}</div>

        <div v-if="!done" class="exp-bar"><div class="exp-bar-fill" :style="{ width: pct + '%' }"></div></div>
        <div v-if="!done" class="exp-prog">{{ expCur }} / {{ expTotal }} 叶 · {{ pct }}%</div>
        <div v-else-if="expErr" class="exp-err">{{ expErr }}</div>
        <div v-else class="exp-ok">
          已保存到：<span class="exp-path">{{ lastOutputDir }}</span>
          <div v-if="expStat" class="exp-stat">{{ expStat }}</div>
        </div>

        <div class="exp-wx-wrap">
          <img class="exp-wx" src="/wxsponor.jpg" alt="微信赞赏码" />
          <p class="exp-wx-tip">如果这个工具帮到你，欢迎扫码赞助 ☕</p>
        </div>

        <div v-if="done && !expErr" class="exp-actions">
          <button class="exp-btn ghost" @click="closeExport">完成</button>
          <button class="exp-btn" @click="openOutput">打开目录</button>
        </div>
        <div v-else-if="done && expErr" class="exp-actions">
          <button class="exp-btn" @click="closeExport">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pub-view { flex: 1; display: flex; overflow: hidden; }
/* 左栏：册列表 + 导出控制 */
.ctrl { width: 248px; flex: none; background: #faf9f6; border-right: 0.5px solid #d3d1c7; padding: 12px 10px; overflow: auto; }
.grp { font-size: 12px; font-weight: 600; color: #6b6a63; margin: 8px 0 6px; border-bottom: 0.5px dashed #d3d1c7; padding-bottom: 3px; }
.add { display: block; width: 100%; border: 0.5px solid #0f6e56; background: #0f6e56; color: #e1f5ee; border-radius: 6px; padding: 6px 0; font-size: 13px; cursor: pointer; margin-bottom: 8px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
li { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; color: #3a3a37; background: #fff; border: 0.5px solid #e3e1d8; }
li.on { background: #e1f5ee; border-color: #0f6e56; color: #0c4a3a; }
li .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.cnt { font-size: 11px; opacity: 0.8; flex: none; }
.del { border: none; background: none; color: #b4452f; font-size: 15px; cursor: pointer; line-height: 1; }
.none { font-size: 11px; color: #888780; margin: 6px 2px; }
.ck { display: flex; gap: 6px; align-items: flex-start; font-size: 12px; color: #444; margin: 6px 0; }
.act { display: block; width: 100%; margin: 8px 0; border: 0.5px solid #0f6e56; background: #0f6e56; color: #e1f5ee; border-radius: 6px; padding: 7px 0; font-size: 13px; cursor: pointer; }
.act.sub { background: #fff; color: #0f6e56; }
.act:disabled { opacity: 0.5; cursor: default; }
.note { font-size: 11px; color: #888780; line-height: 1.7; margin-top: 10px; }
.note .hl { color: #0f6e56; font-weight: 600; }

/* 中栏：册组装编辑（收窄，不占满，留出空间给预览） */
.edit { flex: 1; max-width: 360px; min-width: 0; overflow: auto; padding: 18px 22px; background: #faf9f6; }
.edit.empty { display: flex; align-items: center; justify-content: center; text-align: center; color: #888780; font-size: 13px; }
.hdr { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; margin-bottom: 14px; }
.title { font-size: 16px; font-weight: 600; border: none; border-bottom: 1px solid #d3d1c7; background: none; padding: 3px 2px; width: 280px; color: #2c2c2a; }
.title:focus { outline: none; border-bottom-color: #0f6e56; }
.meta { font-size: 12px; color: #8a877c; }
.blk { margin-bottom: 18px; }
.blk-h { font-size: 13px; font-weight: 600; color: #4c4a44; margin-bottom: 8px; padding-left: 8px; border-left: 3px solid #0f6e56; }
.vol { border: 0.5px solid #e3e1d8; border-radius: 7px; padding: 7px 9px; margin-bottom: 7px; background: #fff; }
.vrow { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.vrow .cnt { font-size: 11px; color: #8a877c; }
.chaps { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 7px 0 2px 22px; }
.chap { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; color: #444; cursor: pointer; }

/* 右栏：成品预览（调宽，2 列栅格） */
.stage { flex: 1.6; min-width: 0; overflow: auto; display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px 16px; align-items: start; padding: 20px; background: #faf9f6; }
figure { margin: 0; text-align: center; }
.card { background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, 0.13); line-height: 0; width: 100%; }
.card :deep(svg) { width: 100%; height: auto; display: block; }
figcaption { font-size: 11px; color: #888780; margin-top: 6px; line-height: 1.4; }
.empty { color: #888780; font-size: 13px; padding: 40px; }

/* 预览渲染进度（横跨两列） */
.gate { grid-column: 1 / -1; display: flex; align-items: center; justify-content: center; padding: 48px 20px; }
.gate-card { max-width: 420px; background: #fff; border: 0.5px solid #e2dfd4; border-radius: 12px; padding: 22px 24px; box-shadow: 0 1px 6px rgba(0, 0, 0, .06); text-align: center; }
.gate-t { font-size: 15px; font-weight: 600; color: #2c2c2a; }
.gate-d { font-size: 12px; color: #6b6a63; line-height: 1.9; margin: 10px 0 14px; }
.gate-bar { height: 6px; background: #eceae2; border-radius: 4px; overflow: hidden; }
.gate-bar-fill { height: 100%; background: #0f6e56; border-radius: 4px; transition: width .15s ease; }

/* 导出弹窗：进度 + 文件名 + 常驻赞赏码 */
.exp-mask { position: fixed; inset: 0; z-index: 220; background: rgba(40, 37, 30, .34); display: flex; align-items: center; justify-content: center; }
.exp { width: 360px; max-width: 90vw; background: #fffdf8; border: 0.5px solid #e2dfd4; border-radius: 16px; padding: 22px 22px 18px; box-shadow: 0 18px 54px rgba(40, 34, 24, .30); text-align: center; }
.exp-head { display: flex; align-items: center; justify-content: space-between; }
.exp-head h3 { margin: 0; font-size: 16px; color: #2c2c2a; }
.exp-head h3.err { color: #b05a4a; }
.exp-x { width: 26px; height: 26px; border: 0; background: none; color: #9a978c; font-size: 14px; cursor: pointer; border-radius: 6px; }
.exp-x:hover { background: #f1efe8; color: #2c2c2a; }
.exp-name { font-size: 12px; color: #6b6a63; margin: 10px 0 12px; word-break: break-all; }
.exp-bar { height: 6px; background: #eceae2; border-radius: 4px; overflow: hidden; }
.exp-bar-fill { height: 100%; background: #0f6e56; border-radius: 4px; transition: width .15s ease; }
.exp-prog { font-size: 11px; color: #9a978c; margin-top: 6px; }
.exp-ok { font-size: 12px; color: #0f6e56; margin: 10px 0 0; word-break: break-all; }
.exp-path { color: #6b6a63; }
.exp-err { font-size: 12px; color: #b05a4a; margin: 10px 0 0; word-break: break-all; }
.exp-stat { font-size: 11px; color: #9a978c; margin-top: 7px; letter-spacing: .2px; }
.exp-wx-wrap { margin-top: 16px; display: flex; flex-direction: column; align-items: center; }
.exp-wx { display: block; width: 160px; border-radius: 8px; border: 0.5px solid #e2dfd4; }
.exp-wx-tip { font-size: 12px; color: #6b6a63; margin: 8px 0 0; }
.exp-actions { display: flex; gap: 10px; justify-content: center; margin-top: 16px; }
.exp-btn { border: 0.5px solid #0f6e56; background: #0f6e56; color: #e1f5ee; border-radius: 7px; padding: 8px 18px; font-size: 13px; cursor: pointer; }
.exp-btn.ghost { background: #fff; color: #0f6e56; }
.exp-btn:hover { opacity: .9; }
</style>
