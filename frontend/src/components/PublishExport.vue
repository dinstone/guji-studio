<script setup lang="ts">
import { ref, computed } from 'vue'
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
import { rasterizeSvg, saveBlobToOutput } from '../core/exportImage'
import PubGroupEditor from './PubGroupEditor.vue'

const E = LayoutEngine

/* ============ 册组装编辑（左/中栏） ============ */
/* sel = -1 表示「整书合并」（虚拟项，不可编辑，导出时自动拼接全部正文 + 包装叶）；否则为册索引 */
const sel = ref(-1)
const cur = computed(() => (sel.value >= 0 ? proj.pubs[sel.value] : null))
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

async function onAdd() { sel.value = addPub() }
async function onDel(i: number) {
  const t = proj.pubs[i]?.title ?? ''
  if (!(await appConfirm(`删除册「${t}」？该册的导出组装配置将丢失。`))) return
  deletePub(i)
  if (sel.value === i) sel.value = -1
  else if (sel.value > i) sel.value--
}

/* ============ 预览 + 导出（右栏） ============ */
interface Spread { label: string; svg: string; W: number; H: number }
const includeSpecial = ref(true)
const exporting = ref(false)
const lastOutputDir = ref('')

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
const renderTick = ref(0)
function collectAssets(): string[] {
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
  return [...out]
}
async function warmAssets(): Promise<void> {
  const ns = collectAssets()
  if (!ns.length) return
  await ensureAssets(ns)
  renderTick.value++
}

const PACK_LEAF: Record<string, 'cover' | 'fly' | 'colophon'> = { '封面': 'cover', '扉页': 'fly', '尾页': 'colophon' }

/* 整书合并：包装前叶 + 全部单元正文（连续页码）+ 包装尾叶；包装不编页码。三叶恒输出，整书级取舍看「包含特殊页」。 */
function buildBookSpreads(): Spread[] {
  const out: Spread[] = []
  const m = bookMetrics()
  if (includeSpecial.value) {
    out.push({ label: '封面', svg: renderSpread(null, 'cover', resolveLeafCfg('cover'), m.W, m.H), W: m.W, H: m.H })
    out.push({ label: '扉页', svg: renderSpread(null, 'fly', resolveLeafCfg('fly'), m.W, m.H), W: m.W, H: m.H })
  }
  let pageNo = 0
  for (const u of [...proj.tree.guide, ...proj.tree.scrolls, ...proj.tree.appendix]) {
    const txt = unitFlowText(u); if (!txt) continue
    const t = resolveTplBlock(u); const mm = E.computeMetrics(t)
    const vl = volLabelOf(u)
    const t2 = prepareTemplateForRender(t)
    E.paginate(t2, txt).pages.forEach((p: any) => {
      p.leaf = ++pageNo; p.volName = vl
      out.push({ label: `${u.name} ${pageNo}`, svg: E.renderPage(t2, p, { guides: 0 }), W: mm.W, H: mm.H })
    })
  }
  if (includeSpecial.value)
    out.push({ label: '尾页', svg: renderSpread(null, 'colophon', resolveLeafCfg('colophon'), m.W, m.H), W: m.W, H: m.H })
  return out
}

/* 按册：front 前辅文 → chapters 按卷/章 → back 后辅文；册内页码从 1 重排；包装叶无页码。
 * inc 控制是否输出该册的包装叶（封面/扉页/尾页），一刀切即「包含特殊页」。 */
function buildPub(pub: any, inc: boolean): Spread[] {
  const out: Spread[] = []
  let pageNo = 0
  const pushUnit = (u?: Block | Volume) => {
    if (!u) return
    const txt = unitFlowText(u); if (!txt) return
    const t = resolveTplBlock(u); const mm = E.computeMetrics(t)
    const vl = volLabelOf(u)
    const t2 = prepareTemplateForRender(t)
    E.paginate(t2, txt).pages.forEach((p: any) => {
      p.leaf = ++pageNo; p.volName = vl
      out.push({ label: `${u.name} ${pageNo}`, svg: E.renderPage(t2, p, { guides: 0 }), W: mm.W, H: mm.H })
    })
  }
  const pushGroup = (g: PubGroup) => {
    for (const nm of (Array.isArray(g.pack) ? g.pack : g.pack ? [g.pack] : [])) {
      if (!inc) continue
      const leaf = PACK_LEAF[nm]; if (!leaf) continue
      const m = bookMetrics()
      const cfg = resolveLeafCfg(leaf)
      if (leaf !== 'colophon') cfg.volLabel = pub.title   // 封面/扉页书名下方小字 = 当前册名
      out.push({ label: nm, svg: renderSpread(null, leaf, cfg, m.W, m.H), W: m.W, H: m.H })
    }
    for (const nm of (Array.isArray(g.guide) ? g.guide : g.guide ? [g.guide] : [])) pushUnit(proj.tree.guide.find(u => u.name === nm))
    for (const nm of (Array.isArray(g.appendix) ? g.appendix : g.appendix ? [g.appendix] : [])) pushUnit(proj.tree.appendix.find(u => u.name === nm))
  }
  for (const g of pub.front || []) pushGroup(g)
  for (const s of pub.chapters || []) {
    const vol = proj.tree.scrolls.find(v => v.id === s.volume); if (!vol) continue
    const chaps = s.chapters?.length ? vol.chapters.filter(c => s.chapters!.includes(c.id)) : vol.chapters
    const txt = chaps.map(c => c.text).filter(Boolean).join('\n')
    if (!txt) continue
    const t = resolveTplBlock(vol); const mm = E.computeMetrics(t)
    const t2 = prepareTemplateForRender(t)
    E.paginate(t2, txt).pages.forEach((p: any) => {
      p.leaf = ++pageNo; p.volName = vol.name || ''
      out.push({ label: `${vol.name || '正文'} ${pageNo}`, svg: E.renderPage(t2, p, { guides: 0 }), W: mm.W, H: mm.H })
    })
  }
  for (const g of pub.back || []) pushGroup(g)
  return out
}

/* 当前选中成品：整书合并 / 某分册；renderTick 触发素材重算让 <image> 进 SVG */
interface Item { key: string; name: string; spreads: Spread[] }
const selItem = computed<Item>(() => {
  void renderTick.value
  if (sel.value < 0 || !proj.pubs[sel.value]) return { key: 'book', name: '整书合并', spreads: buildBookSpreads() }
  const p = proj.pubs[sel.value]
  return { key: `pub:${sel.value}`, name: p.title, spreads: buildPub(p, includeSpecial.value) }
})
const spreads = computed<Spread[]>(() => selItem.value.spreads)
const bookLen = computed(() => buildBookSpreads().length)

function stamp() { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}` }
function bookFileName() { return `${(proj.meta.title || proj.name || 'guji')}-${stamp()}.pdf` }
function pubFileName(p: any) { return `${p.title}-${stamp()}.pdf` }
function selPdfName(): string { return sel.value < 0 ? bookFileName() : pubFileName(proj.pubs[sel.value]) }
function selStem(): string { return sel.value < 0 ? (proj.meta.title || proj.name || 'guji') : proj.pubs[sel.value].title }

async function exportPDF() {
  const it = selItem.value
  if (!it.spreads.length) { toast('当前选择没有可导出的内容'); return }
  exporting.value = true; lastOutputDir.value = ''
  done.value = false; expErr.value = null
  expName.value = selPdfName(); expTotal.value = it.spreads.length; expCur.value = 0
  try {
    await warmAssets()
    const s = selItem.value!          // 预热后重取：这时 <image> 才已进 SVG
    expTotal.value = s.spreads.length
    const { PDFDocument } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const total = s.spreads.length
    for (let i = 0; i < total; i++) {
      const sp = s.spreads[i]
      const blob = await rasterizeSvg(sp.svg, sp.W, sp.H, sp.label)
      const img = await doc.embedPng(await blob.arrayBuffer())
      const pw = sp.W / 300 * 72, ph = sp.H / 300 * 72   // 300dpi px → pt（各叶纸幅可不同，按叶取值）
      const page = doc.addPage([pw, ph])
      page.drawImage(img, { x: 0, y: 0, width: pw, height: ph })
      expCur.value = i + 1
    }
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
  const it = selItem.value
  if (!it.spreads.length) { toast('当前选择没有可导出的内容'); return }
  exporting.value = true; lastOutputDir.value = ''
  done.value = false; expErr.value = null
  expName.value = `${selStem()}-*.png`; expTotal.value = it.spreads.length; expCur.value = 0
  try {
    await warmAssets()
    const s = selItem.value!          // 预热后重取：这时 <image> 才已进 SVG
    const total = s.spreads.length
    expTotal.value = total
    let od = ''
    for (let i = 0; i < total; i++) {
      const sp = s.spreads[i]
      const blob = await rasterizeSvg(sp.svg, sp.W, sp.H, sp.label)
      const buf = new Uint8Array(await blob.arrayBuffer())
      const name = `${selStem()}-${String(i + 1).padStart(2, '0')}.png`
      od = await saveBlobToOutput(projectDir.value, name, new Blob([buf as any]))
      expCur.value = i + 1
    }
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
        <li :class="{ on: sel === -1 }" @click="sel = -1">
          <span class="t">整书合并</span>
          <span class="cnt">{{ bookLen }} 叶</span>
        </li>
        <li v-for="(p, i) in proj.pubs" :key="p.id" :class="{ on: sel === i }" @click="sel = i">
          <span class="t">{{ p.title }}</span>
          <button class="del" @click.stop="onDel(i)" title="删除">×</button>
        </li>
      </ul>
      <div v-if="!proj.pubs.length" class="none">（尚无分册，点上方「新建册」）</div>

      <div class="grp">拼装选项</div>
      <label class="ck"><input v-model="includeSpecial" type="checkbox"> 包含特殊页（封面/扉页/尾页）</label>

      <div class="grp">输出</div>
      <button class="act" :disabled="exporting" @click="exportPDF">导出 PDF（{{ spreads.length }} 叶）</button>
      <button class="act sub" :disabled="exporting" @click="exportPNG">导出 PNG（逐叶）</button>
      <button class="act sub" @click="openOutput">打开导出目录</button>
      <div class="note">
        选中左侧某项后，导出按钮<span class="hl">仅对该成品生效</span>。<br>
        <b>整书合并</b>：一份 PDF = 封面·扉页 + 导读·卷文·附录正文（连续页码）+ 尾页。<br>
        <b>分册</b>：按该册 front/chapters/back 三段组装（册内页码从 1 重排），文件名 <b>册名-时间.pdf</b>。<br>
        桌面端 PDF/PNG 落到项目 <b>output/</b> 目录。
      </div>
    </aside>

    <!-- 中栏：册组装编辑（整书合并为虚拟项，不可编辑） -->
    <section class="edit" v-if="cur">
      <div class="hdr">
        <input class="title" v-model="proj.pubs[sel].title" placeholder="册名" />
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
      <p>整书合并为导出时自动拼接全部正文与包装叶，不可单独编排。<br>在左侧新建 / 选择分册以编排前辅文、正文卷章与后辅文。</p>
    </section>

    <!-- 右栏：成品预览 -->
    <div class="stage">
      <figure v-for="(s, i) in spreads" :key="i">
        <div class="card" v-html="s.svg"></div>
        <figcaption>{{ i + 1 }}. {{ s.label }}</figcaption>
      </figure>
      <div v-if="!spreads.length" class="empty">暂无可导出内容</div>
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
.exp-wx-wrap { margin-top: 16px; display: flex; flex-direction: column; align-items: center; }
.exp-wx { display: block; width: 160px; border-radius: 8px; border: 0.5px solid #e2dfd4; }
.exp-wx-tip { font-size: 12px; color: #6b6a63; margin: 8px 0 0; }
.exp-actions { display: flex; gap: 10px; justify-content: center; margin-top: 16px; }
.exp-btn { border: 0.5px solid #0f6e56; background: #0f6e56; color: #e1f5ee; border-radius: 7px; padding: 8px 18px; font-size: 13px; cursor: pointer; }
.exp-btn.ghost { background: #fff; color: #0f6e56; }
.exp-btn:hover { opacity: .9; }
</style>
