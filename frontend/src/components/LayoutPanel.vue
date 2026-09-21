<script setup lang="ts">
/* 版视图：版式模板库（Go 后端统一持有，builtin 区分出厂预设 / 自建）
 * 左：模板列表（内置 + 我的）  右：样例叶预览 + 只读参数摘要 + 库操作
 * 库内模板不提供参数编辑；新模板由「导入当前图书版式」产生，同名导入即覆盖更新。 */
import { computed, onMounted, ref, watch } from 'vue'
import { LayoutEngine } from '../core/engine'
import { SAMPLE_TEXT, RUBY_DEMO, summarize } from '../core/presets'
import { checkTemplateFonts, prepareTemplateForRender } from '../core/fontcheck'
import { matchPaper } from '../core/papersize'
import {
  tplLib, tplSel, tplParams, loadTemplates,
  applyTemplate, importTplFromBook, renameTpl, deleteTpl, view, proj,
} from '../stores/app'
import { appPrompt, appConfirm } from '../stores/dialog'

const E = LayoutEngine
const params = ref<Record<string, any> | null>(null)
const stage = ref<HTMLElement | null>(null)

const builtins = computed(() => tplLib.value.filter(t => t.builtin))
const mine = computed(() => tplLib.value.filter(t => !t.builtin))
const cur = computed(() => tplLib.value.find(t => t.id === tplSel.value) || tplLib.value[0])

async function loadCur() {
  const t = cur.value
  params.value = t ? await tplParams(t.id) : null
}
watch(() => tplSel.value, loadCur)
onMounted(async () => {
  if (!tplLib.value.length) await loadTemplates()
  if (!tplSel.value) tplSel.value = tplLib.value[0]?.id || ''
  await loadCur()
})

/* 预览：固定样例语料的第一叶，各模板横向可比 */
const svg = computed(() => {
  const p = params.value
  if (!p) return ''
  const t = prepareTemplateForRender(p)
  /* 模板显式开启注音（ruby_show=1）时追加注音样例句，让注音参数在样张上可见 */
  const txt = Number(p.ruby_show) === 1 ? SAMPLE_TEXT + '\n' + RUBY_DEMO : SAMPLE_TEXT
  const res = E.paginate(t, txt)
  return res.pages.length ? E.renderPage(t, res.pages[0], { guides: view.guides, rulers: view.rulers }) : ''
})
const width = computed(() => {
  const p = params.value
  if (!p) return 600
  return Math.round(E.computeMetrics(p).W * view.zoom / 100)
})
/* 适宽 = 只按宽度分支，纸张铺满 .stage 的内容宽，左右只余内边距。
   基准与 PreviewPanel 刻意不同：这里按「纸张」(m.W)，预览面板按「版框」(m.frame.w)——
   本面板是改版式用的，页边距（纸张边→版框）正是要看的对象，按版框算会把纸边裁掉、调不准。
   旧版 min(宽, 高) 的整页适配会让宽面板左右空出一大截；常数 40 也与实际内边距 2×16 不符。
   取 floor 不取 round：向上取整会超出可用宽、带出横向滚动条。 */
const STAGE_PAD = 16
function fit() {
  const p = params.value, el = stage.value
  if (!p || !el) return
  const m = E.computeMetrics(p)
  const z = Math.floor((el.clientWidth - 2 * STAGE_PAD) / m.W * 100)
  view.zoom = Math.max(10, Math.min(120, z))
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

/* 只读参数摘要 */
const FAM_LB = LayoutEngine.FONT_CN
const PUNCT_LB: Record<string, string> = { full: '全角', half: '半角', hang: '悬空', none: '不渲染' }
const SEAM_LB: Record<string, string> = { none: '无', single: '单象鼻', double: '双象鼻' }
const FISH_LB: Record<string, string> = { none: '无', single: '单鱼尾', double: '双鱼尾', triple: '三鱼尾' }
const SHAPE_LB: Record<string, string> = { triangle: '三角', arc: '弧形', flower: '花瓣' }

const rows = computed(() => {
  const p = params.value
  if (!p) return [] as [string, string][]
  const m = matchPaper(Number(p.canvas_width) || 0, Number(p.canvas_height) || 0)
  const dims = `${m.current.wMm.toFixed(1)}×${m.current.hMm.toFixed(1)}mm`
  const advice = m.fits
    ? `最小需 ${m.fits.paper.name} ${m.fits.orientation === 'landscape' ? '横向' : '纵向'}`
    : `超出常规纸，最接近 ${m.nearest.paper.name} ${m.nearest.orientation === 'landscape' ? '横向' : '纵向'}`
  return [
    ['纸幅', `${p.canvas_width} × ${p.canvas_height} px ≈ ${dims} @300dpi，${advice}`],
    ['页边距', `上 ${p.margins_top} · 下 ${p.margins_bottom} · 左 ${p.margins_left} · 右 ${p.margins_right}`],
    ['版框', `外线 ${p.outline_width} · 内线 ${p.inline_width}${p.if_vline ? ' · 界行竖线' : ''}`],
    ['行列', `每半叶 ${p.leaf_col} 列 × 每列 ${p.row_num} 字`],
    ['中缝 / 书口', `中缝 ${p.leaf_center_width}px · ${SEAM_LB[String(p.if_seam)] || '—'}`],
    ['鱼尾', `${FISH_LB[String(p.fish_mode)] || '—'} · ${SHAPE_LB[String(p.fish_shape)] || '—'}`],
    ['正文字号', p.text_size_auto ? `自动 · 字距 ${p.text_ydis}×` : `${p.text_font1_size}px`],
    ['字体', `正文 ${FAM_LB[p.text_font_family] || p.text_font_family} · 夹注 ${FAM_LB[p.comment_font_family] || p.comment_font_family}`],
    ['标点', `正文 ${PUNCT_LB[String(p.text_comma_mode)] || '—'} · 夹注 ${PUNCT_LB[String(p.comment_comma_mode)] || '—'}`],
    ['版心文字', `卷次 ${p.title_postfix || '—'} · 书名 ${p.title_font_size}px · 页码 ${p.pager_style === 'arabic' ? '阿拉伯' : '中文'}`],
    ['内容字段', '书名 / 逐卷卷名不入库，套用时由图书注入'],
  ] as [string, string][]
})

/* 字体就绪检查：随 params 自动重算（选中模板即刷新），列出模板用到字体 + 本机状态 */
const fontRows = computed(() => checkTemplateFonts(params.value))

/* ---- 库操作 ---- */
async function doApply() {
  if (!cur.value) return
  await applyTemplate(cur.value.id)
}
async function doImport() {
  const nm = await appPrompt('把当前图书的版式导入为模板，模板名：', proj.name + ' 版式')
  if (nm === null) return
  await importTplFromBook(nm)
}
async function doRename() {
  const t = cur.value
  if (!t) return
  const nm = await appPrompt('重命名模板', t.name)
  if (nm === null || !nm.trim()) return
  await renameTpl(t.id, nm)
}
async function doDelete() {
  const t = cur.value
  if (!t) return
  if (!(await appConfirm(`删除模板「${t.name}」？此操作不可撤销。`))) return
  await deleteTpl(t.id)
}
function pick(id: string) { tplSel.value = id }
</script>

<template>
  <section class="ly">
    <!-- 左：模板库 -->
    <aside class="lib">
      <div class="libhd">版式模板库</div>
      <!-- 列表区独立滚动：标题与底部提示固定，模板再多也不裁切 -->
      <div class="libbody">
        <div class="grp">
          <div class="gt">内置模板</div>
          <div
            v-for="t in builtins" :key="t.id"
            class="card" :class="{ on: t.id === tplSel }" @click="pick(t.id)"
          >
            <div class="r1"><b>{{ t.name }}</b><span class="tag">内置</span></div>
            <div class="dg">{{ t.digest || summarize(t.params) }}</div>
          </div>
        </div>
        <div class="grp" v-if="mine.length">
          <div class="gt">我的模板</div>
          <div
            v-for="t in mine" :key="t.id"
            class="card" :class="{ on: t.id === tplSel }" @click="pick(t.id)"
          >
            <div class="r1"><b>{{ t.name }}</b></div>
            <div class="dg">{{ t.digest || summarize(t.params) }}</div>
          </div>
        </div>
      </div>
      <div class="tip">
        库内模板只读预览，不做参数编辑。<br>
        新模板由「导入当前图书版式」产生，同名导入即覆盖更新。
      </div>
    </aside>

    <!-- 右：预览 + 操作 -->
    <div class="main">
      <div class="bar">
        <b class="nm">{{ cur?.name || '—' }}</b>
        <span class="note">{{ cur?.note }}</span>
        <span class="sp" />
        <button class="pri" :disabled="!cur" @click="doApply">套用到当前图书</button>
        <button @click="doImport">导入当前图书版式…</button>
        <button :disabled="!cur || cur.builtin" @click="doRename">重命名</button>
        <button class="dgr" :disabled="!cur || cur.builtin" @click="doDelete">删除</button>
      </div>
      <div class="toolbar">
        <button class="fit" @click="fit">适宽</button>
        <div class="zgrp">
          <button class="zbtn" :disabled="view.zoom <= 10" @click="zoomOut" title="缩小">−</button>
          <input v-model.number="view.zoom" type="range" min="10" max="120" step="5" class="zoom">
          <button class="zbtn" :disabled="view.zoom >= 120" @click="zoomIn" title="放大">+</button>
        </div>
        <span class="pct">{{ view.zoom }}%</span>
        <span class="sp" />
        <label class="ck"><input v-model="view.guides" type="checkbox" :true-value="1" :false-value="0">辅助线</label>
        <label class="ck"><input v-model="view.rulers" type="checkbox" :true-value="1" :false-value="0">尺寸标尺</label>
        <span class="sp" />
        <span class="dig">{{ summarize(params || {}) }}</span>
      </div>
      <div class="body">
        <div ref="stage" class="stage" @wheel="onWheel">
          <div v-if="svg" class="leaf" :style="{ width: width + 'px' }" v-html="svg" />
          <div v-else class="empty">暂无可预览的模板</div>
        </div>
        <div class="meta">
          <div class="mhd">参数摘要（只读）</div>
          <div v-for="[k, v] in rows" :key="k" class="mrow"><span>{{ k }}</span><b>{{ v }}</b></div>
          <div class="mhd" style="margin-top:12px">字体就绪（本机）</div>
          <div v-for="f in fontRows" :key="f.role" class="frow" :class="f.level">
            <span class="fr">{{ f.role }}</span>
            <b class="ff">{{ f.cn ? f.cn + ' · ' + f.fam : f.fam }}</b>
            <span class="fs">{{ f.level === 'ok' ? '✓ 已安装' : (f.level === 'warn' ? '⚠ 首选未装·有兜底' : '✗ 未安装·将落系统衬线') }}</span>
            <span class="fv" :class="f.vert ? 'ok' : 'bad'">{{ f.vert ? '竖排标点 ✓' : '竖排标点 ✗' }}</span>
          </div>
          <div class="hint">
            套用＝把模板快照拷进当前图书：版式全量替换，书名沿用本项目、逐卷卷名保留。
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ly { flex: 1; display: flex; min-width: 0; background: #f3f1ec; }
/* 左栏 */
.lib { width: 232px; background: #faf9f6; border-right: 0.5px solid #d3d1c7; display: flex; flex-direction: column; padding: 10px 10px 12px; }
.libhd { flex: none; font-size: 13px; font-weight: 600; color: #2c2c2a; padding: 2px 2px 8px; }
/* 列表滚动区：flex:1 + min-height:0 才能在定高父容器里产生滚动条 */
.libbody { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-right: 4px; }
.libbody::-webkit-scrollbar { width: 8px; }
.libbody::-webkit-scrollbar-track { background: transparent; }
.libbody::-webkit-scrollbar-thumb { background: #d3d1c7; border-radius: 4px; }
.libbody::-webkit-scrollbar-thumb:hover { background: #b9b6a8; }
.gt { font-size: 11px; color: #888780; padding: 6px 2px 4px; }
.card { border: 0.5px solid #e3e1d7; background: #fff; border-radius: 7px; padding: 7px 9px; margin-bottom: 6px; cursor: pointer; }
.card:hover { border-color: #b9b6a8; }
.card.on { border-color: #0f6e56; background: #eef7f3; }
.r1 { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #2c2c2a; }
.r1 b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { font-size: 10px; color: #0f6e56; border: 0.5px solid #9ccfbf; border-radius: 4px; padding: 0 4px; }
.dg { font-size: 11px; color: #888780; margin-top: 3px; }
.sp { flex: 1; }
.tip { flex: none; font-size: 11px; color: #9a988f; line-height: 1.7; border-top: 0.5px solid #e3e1d7; padding-top: 8px; }
/* 右栏 */
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.bar { padding: 7px 12px; background: #fff; border-bottom: 0.5px solid #d3d1c7; display: flex; align-items: center; gap: 8px; }
.nm { font-size: 14px; }
.note { font-size: 12px; color: #888780; max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar button { border: 0.5px solid #d3d1c7; background: #faf9f6; border-radius: 5px; font-size: 12px; padding: 3px 10px; cursor: pointer; color: #55534d; }
.bar button:hover:not(:disabled) { border-color: #0f6e56; color: #0f6e56; }
.bar button:disabled { opacity: 0.4; cursor: not-allowed; }
.bar button.pri { background: #0f6e56; border-color: #0f6e56; color: #fff; }
.bar button.pri:hover:not(:disabled) { background: #0c5744; color: #fff; }
.bar button.dgr:hover:not(:disabled) { border-color: #b5342a; color: #b5342a; }
.toolbar { padding: 5px 12px; background: #fbfaf7; border-bottom: 0.5px solid #e3e1d7; display: flex; align-items: center; gap: 10px; font-size: 12px; }
.fit { border: 0.5px solid #d3d1c7; background: #fff; border-radius: 4px; font-size: 12px; padding: 1px 8px; cursor: pointer; color: #5f5e5a; }
.zoom { width: 120px; accent-color: #0f6e56; }
.zgrp { display: inline-flex; align-items: center; gap: 4px; }
.zbtn { width: 20px; height: 20px; line-height: 1; border: 0.5px solid #d3d1c7; background: #fff; border-radius: 4px; font-size: 13px; cursor: pointer; color: #5f5e5a; padding: 0; }
.zbtn:hover:not(:disabled) { border-color: #0f6e56; color: #0f6e56; }
.zbtn:disabled { opacity: .4; cursor: not-allowed; }
.pct { color: #5f5e5a; min-width: 38px; }
.ck { display: inline-flex; align-items: center; gap: 3px; color: #5f5e5a; cursor: pointer; }
.dig { color: #888780; font-size: 11px; }
.body { flex: 1; display: flex; min-height: 0; }
/* 同预览视图：block + margin-inline:auto 居中（flex center 会把放大后的左侧溢出滚死） */
.stage { flex: 1; overflow: auto; padding: 16px; background: #eceae2; }
.leaf { background: #fff; box-shadow: 0 1px 5px rgba(0,0,0,.14); line-height: 0; margin-inline: auto; }
.leaf :deep(svg) { width: 100%; height: auto; display: block; }
.empty { color: #9a988f; font-size: 13px; padding: 40px 0; text-align: center; }
.meta { width: 300px; border-left: 0.5px solid #d3d1c7; background: #faf9f6; padding: 10px 12px; overflow: auto; }
.mhd { font-size: 12px; font-weight: 600; color: #2c2c2a; padding-bottom: 6px; border-bottom: 0.5px solid #e3e1d7; }
.mrow { display: flex; gap: 8px; font-size: 12px; padding: 6px 0; border-bottom: 0.5px solid #efede5; }
.mrow span { width: 92px; flex: none; color: #888780; }
.mrow b { font-weight: 500; color: #3b3a35; }
.frow { display: flex; gap: 8px; font-size: 12px; padding: 5px 0; border-bottom: 0.5px solid #efede5; align-items: baseline; }
.frow .fr { width: 52px; flex: none; color: #888780; }
.frow .ff { font-weight: 500; color: #3b3a35; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow .fs { font-size: 11px; white-space: nowrap; }
.frow.ok .fs { color: #0f6e56; }
.frow.warn .fs { color: #b5851f; }
.frow.err .fs { color: #b5342a; }
.frow.err .ff { color: #b5342a; }
.fv { font-size: 10px; padding: 0 4px; border-radius: 3px; white-space: nowrap; }
.fv.ok { color: #0f6e56; background: #e8f5ef; }
.fv.bad { color: #b5342a; background: #fdecea; }
.hint { font-size: 11px; color: #9a988f; line-height: 1.7; margin-top: 10px; }
</style>
