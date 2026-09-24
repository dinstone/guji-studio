<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { CLUSTERS, type SchemaItem, type SchemaGroup, type SchemaCluster } from '../core/schema'
import {
  PAPER_SIZES, paperLabel, paperPx, exactPaper, matchPaper, type Orientation,
} from '../core/papersize'
import {
  tplEdit, tplScope, tplOverridden, tplRevert, tplOverrideCount, tplRevertAll,
  proj, view, importTplFromBook, curBlockName, projectDir,
} from '../stores/app'
import { ensureAsset } from '../core/assets'
import { importImage } from '../platform/wails'
import FontPicker from './FontPicker.vue'
import { appPrompt, appConfirm, appAlert } from '../stores/dialog'

const open = reactive<Record<string, boolean>>({})
CLUSTERS.forEach(c => { open[c.id] = !!c.open; c.groups.forEach(g => { open[g.id] = !!g.open }) })

const filter = ref('')
function hit(it: SchemaItem) {
  if (!filter.value) return true
  return (it.lb + it.k).toLowerCase().includes(filter.value.toLowerCase())
}
function vis(g: SchemaGroup) {
  return g.items.filter(it => hit(it) && (!it.show || it.show(tplEdit)))
}
/* 置灰：控件保留可见但当前档位下取值不生效（如手动字号档下的「字距比例」） */
function off(it: SchemaItem) {
  return !!(it.off && it.off(tplEdit))
}
/* 簇 / 组展开态：有筛选词时强制展开命中项，否则遵从用户折叠选择 */
function groupOpen(g: SchemaGroup) {
  const any = vis(g).length > 0
  return filter.value ? any : (open[g.id] && any)
}
function clusterOpen(c: SchemaCluster) {
  const any = c.groups.some(g => vis(g).length > 0)
  return filter.value ? any : (open[c.id] && any)
}

const volName = computed(() => curBlockName())
const ovdCount = computed(() => (tplScope.value === 'unit' ? tplOverrideCount() : 0))
async function clearAll() {
  if (!(await appConfirm(`清除「${volName.value}」的全部版式覆盖（${ovdCount.value} 项），恢复跟随全书？`))) return
  tplRevertAll()
}

/* ---- 作用域显名 + 参数来源三态（降低「改哪一级」的心智负担） ---- */
const unit = computed(() => tplScope.value === 'unit')
const scopeTitle = computed(() => unit.value ? volName.value : '全书默认')
const scopeSub = computed(() =>
  unit.value ? '覆盖全书 · 仅作用于本单元' : '改动影响所有未单独覆盖的单元'
)
/* 参数来源三态：book=书级根（无来源标识）/ unit-ov=本单元已覆盖 / unit-inh=跟随全书 */
function srcInfo(k: string) {
  if (!unit.value) return { cls: 'book', text: '', title: '' }
  if (tplOverridden(k)) return { cls: 'unit-ov', text: '本单元', title: '本单元已覆盖此项 · 点击恢复跟随全书' }
  return { cls: 'unit-inh', text: '继承', title: '跟随全书默认值' }
}
function onSrcClick(k: string) {
  if (unit.value && tplOverridden(k)) tplRevert(k)
}

/* 把当前图书版式导入模板库（内容字段在 store 内剥离） */
async function saveAsTpl() {
  const nm = await appPrompt('导入为模板，模板名：', proj.name + ' 版式')
  if (nm === null || !nm.trim()) return
  await importTplFromBook(nm)
}

/* ---- 图片素材（版心堂号 / 叶面水印）：Go 把选中的图直接拷进项目 assets/，这里只把文件名写进参数 ---- */
const picking = ref('')
async function pickAsset(k: string) {
  if (!projectDir.value) {
    await appAlert('请先把项目保存到磁盘：图片素材会存进项目的 assets/ 目录，随项目一起搬走。')
    return
  }
  picking.value = k
  try {
    const names = await importImage(projectDir.value)
    if (!names.length) return                    // 用户取消
    tplEdit[k] = names[0]
    await ensureAsset(names[0])                  // 立刻解码出固有宽高，预览下一帧即可见
  } catch (e: any) {
    await appAlert('导入图片失败：' + (e?.message || e))
  } finally {
    picking.value = ''
  }
}

/* ---- 纸张规格提示与常规尺寸选择 ---- */
const paperOptions = PAPER_SIZES.flatMap(p =>
  (['portrait', 'landscape'] as Orientation[]).map(o => ({
    key: `${p.key}:${o}`,
    label: paperLabel(p, o),
  }))
)

const currentPaperKey = computed(() => {
  const ex = exactPaper(Number(tplEdit.canvas_width) || 0, Number(tplEdit.canvas_height) || 0)
  return ex ? `${ex.paper.key}:${ex.orientation}` : ''
})

function applyPaperSize(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (!v) return
  const [key, o] = v.split(':') as [string, Orientation]
  const p = PAPER_SIZES.find(x => x.key === key)
  if (!p) return
  const [w, h] = paperPx(p, o)
  tplEdit.canvas_width = w
  tplEdit.canvas_height = h
}

const paperHint = computed(() => {
  const w = Number(tplEdit.canvas_width) || 0
  const h = Number(tplEdit.canvas_height) || 0
  if (!w || !h) return ''
  const m = matchPaper(w, h)
  const dims = `${m.current.wMm.toFixed(1)}×${m.current.hMm.toFixed(1)}mm`
  if (m.fits) {
    const label = `${m.fits.paper.name} ${m.fits.orientation === 'landscape' ? '横向' : '纵向'}`
    return `≈ ${dims} @300dpi，最小需 ${label} 打印`
  }
  const near = `${m.nearest.paper.name} ${m.nearest.orientation === 'landscape' ? '横向' : '纵向'}`
  return `≈ ${dims} @300dpi，超出常规纸张，最接近 ${near}，需自定义裁切`
})

</script>

<template>
  <!-- 折叠态：细条，点击展开 -->
  <div v-if="!view.inspector" class="rail-strip" title="展开版式参数" @click="view.inspector = 1">
    <span class="vtxt">版式参数</span><span class="arr">‹</span>
  </div>
  <aside v-else class="insp">
    <div class="hd">
      <button class="clp" title="收起面板" @click="view.inspector = 0">‹</button>
      <b>版式参数</b>
      <input v-model="filter" type="text" placeholder="筛选…">
    </div>
    <!-- 作用域：全书 = 改书级默认值（影响所有未单独覆盖的单元）；本单元 = 只改当前单元，覆盖全书 -->
    <div class="scope">
      <div class="seg">
        <button :class="{ on: !unit }" @click="tplScope = 'book'">全书</button>
        <button :class="{ on: unit }" @click="tplScope = 'unit'">本单元</button>
      </div>
      <div class="scope-meta">
        <span class="sn">{{ scopeTitle }}</span>
        <span class="sub">{{ scopeSub }}</span>
      </div>
      <button
        v-if="unit && ovdCount"
        class="clr" :title="`清除本单元 ${ovdCount} 项覆盖，恢复跟随全书`"
        @click="clearAll"
      >清除覆盖 {{ ovdCount }}</button>
    </div>
    <div class="groups">
      <section v-for="c in CLUSTERS" :key="c.id" class="cluster" :data-cid="c.id">
        <details :open="clusterOpen(c)" class="clu">
          <summary @click.prevent="open[c.id] = !open[c.id]">
            <span class="ct">{{ c.title }}</span><span class="csub">{{ c.sub }}</span>
          </summary>
          <div class="cbody">
            <details v-for="g in c.groups" :key="g.id" :open="groupOpen(g)" class="grp">
              <summary @click.prevent="open[g.id] = !open[g.id]">{{ g.title }}</summary>
              <template v-if="g.id === 'paper'">
                <div class="row">
                  <!-- 纸张组皆为书级参数，来源徽标不显示；此处不放 .ph 占位，保证与其它行左对齐 -->
                  <label class="lb">常规尺寸</label>
                  <div class="ctl">
                    <select :value="currentPaperKey" @change="applyPaperSize">
                      <option value="">自定义</option>
                      <option v-for="o in paperOptions" :key="o.key" :value="o.key">{{ o.label }}</option>
                    </select>
                  </div>
                </div>
                <div class="paper-hint">{{ paperHint }}</div>
              </template>
              <div v-for="it in vis(g)" :key="it.k" class="row" :class="{ off: off(it) }" :title="it.tip || ''">
                <span
                  class="src" :class="srcInfo(it.k).cls"
                  :title="srcInfo(it.k).title"
                  @click="onSrcClick(it.k)"
                >{{ srcInfo(it.k).text }}</span>
                <label class="lb" :class="{ inhr: unit && !tplOverridden(it.k) }">{{ it.lb }}</label>
                <div class="ctl">
                  <template v-if="it.type === 'num'">
                    <input v-model.number="tplEdit[it.k]" type="number" :min="it.min" :max="it.max" :step="it.step">
                    <span v-if="it.unit" class="unit">{{ it.unit }}</span>
                  </template>
                  <template v-else-if="it.type === 'bool'">
                    <input v-if="it.link" type="checkbox"
                           :checked="tplEdit[it.link] === it.onval"
                           @change="tplEdit[it.link] = ($event.target as HTMLInputElement).checked ? (it.onval as string) : ''">
                    <input v-else v-model="tplEdit[it.k]" type="checkbox" :true-value="1" :false-value="0">
                  </template>
                  <template v-else-if="it.type === 'color'">
                    <input v-model="tplEdit[it.k]" type="color" class="color">
                    <span class="unit">{{ tplEdit[it.k] }}</span>
                  </template>
                  <template v-else-if="it.type === 'sel'">
                    <select v-model="tplEdit[it.k]">
                      <option v-for="o in it.opts" :key="o[0]" :value="o[0]">{{ o[1] }}</option>
                    </select>
                  </template>
                  <template v-else-if="it.type === 'seg'">
                    <div class="seg">
                      <button
                        v-for="o in it.opts" :key="o[0]"
                        :class="{ on: tplEdit[it.k] === o[0] }"
                        @click="tplEdit[it.k] = o[0]"
                      >{{ o[1] }}</button>
                    </div>
                  </template>
                  <template v-else-if="it.type === 'text'">
                    <input v-model="tplEdit[it.k]" type="text" :placeholder="it.ph">
                  </template>
                  <template v-else-if="it.type === 'fam'">
                    <FontPicker v-model="tplEdit[it.k]" />
                  </template>
                  <template v-else-if="it.type === 'asset'">
                    <button class="abtn" :disabled="picking === it.k" @click="pickAsset(it.k)">
                      {{ picking === it.k ? '导入中…' : '选择图片…' }}
                    </button>
                    <span v-if="tplEdit[it.k]" class="aname" :title="tplEdit[it.k]">{{ tplEdit[it.k] }}</span>
                    <button v-if="tplEdit[it.k]" class="ax" title="清除该项" @click="tplEdit[it.k] = ''">×</button>
                  </template>
                </div>
              </div>
            </details>
          </div>
        </details>
      </section>
    </div>
    <div class="ft">
      <button class="save" title="把当前图书的版式导入模板库（书名等书级内容不入库）" @click="saveAsTpl">存为模板…</button>
    </div>
  </aside>
</template>

<style scoped>
.insp { width: 300px; background: #faf9f6; border-left: 0.5px solid #d3d1c7; display: flex; flex-direction: column; overflow-x: hidden; }
.rail-strip { width: 26px; background: #faf9f6; border-left: 0.5px solid #d3d1c7; display: flex; flex-direction: column; align-items: center; padding: 10px 0; gap: 8px; cursor: pointer; user-select: none; }
.rail-strip:hover { background: #f1efe8; }
.rail-strip .vtxt { writing-mode: vertical-rl; font-size: 11px; letter-spacing: 3px; color: #6f6e68; }
.rail-strip .arr { font-size: 12px; color: #888780; }
.clp { border: 0; background: none; color: #888780; font-size: 14px; cursor: pointer; padding: 0 2px; }
.clp:hover { color: #0f6e56; }
.hd { padding: 8px 10px; border-bottom: 0.5px solid #e3e1d7; display: flex; align-items: center; gap: 6px; font-size: 13px; }
.ft { padding: 6px 8px; border-top: 0.5px solid #e3e1d7; }
.ft .save { width: 100%; border: 0.5px solid #d3d1c7; background: #fff; border-radius: 5px; font-size: 12px; padding: 4px 0; cursor: pointer; color: #55534d; }
.ft .save:hover { border-color: #0f6e56; color: #0f6e56; }
.hd input { flex: 1; min-width: 0; font-size: 12px; }
/* 作用域：全书（书级默认）/ 本单元（单元级覆盖） */
.scope { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 0.5px solid #e3e1d7; background: #f3f1ea; font-size: 11px; }
.scope .seg { flex: none; display: flex; }
.scope .seg button { border: 0; background: #fff; padding: 2px 9px; font-size: 11px; cursor: pointer; color: #5f5e5a; }
.scope .seg button.on { background: #0f6e56; color: #e1f5ee; }
.scope-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.scope .sn { color: #444; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scope .sub { color: #8a877c; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scope .clr { border: 0.5px solid #d3d1c7; background: #fff; border-radius: 4px; font-size: 11px; padding: 1px 6px; cursor: pointer; color: #8a5a2a; flex: none; }
.scope .clr:hover { border-color: #b4532a; color: #b4532a; }
/* 参数来源三态药丸：本单元（绿，可点击回退）/ 继承（灰）/ 书级（隐藏） */
.src { flex: none; font-style: normal; font-size: 10px; line-height: 1; padding: 2px 5px; border-radius: 8px; white-space: nowrap; }
.src.book { display: none; }
.src.unit-ov { background: #0f6e56; color: #e1f5ee; cursor: pointer; }
.src.unit-ov:hover { background: #0c5a46; }
.src.unit-inh { background: #e7e4d8; color: #8a877c; cursor: help; }
/* 占位：与来源药丸同宽，保持纸张组自定义行与参数行对齐 */
.ph { flex: none; width: 30px; }
/* 继承态 label 颜色变淡，与左侧「继承」药丸配合即可 */
.lb.inhr { color: #a09e95; }
.groups { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 6px; }
/* 簇：由外到内 / 由硬到软 的顶层分组；与组内分组（.grp）形成两级折叠 */
.cluster { margin-bottom: 6px; }
.clu { border: 0.5px solid #c9c6b8; border-radius: 7px; background: #f3f1ea; overflow: hidden; }
.clu > summary { padding: 6px 9px; font-size: 12.5px; font-weight: 600; cursor: pointer; user-select: none; color: #3a3a35; display: flex; align-items: baseline; gap: 7px; }
.clu > summary .ct { letter-spacing: 0.5px; }
.clu > summary .csub { font-size: 10px; font-weight: 400; color: #8a877c; }
.cbody { padding: 4px 4px 2px; }
.cbody .grp:last-child { margin-bottom: 1px; }
.grp { margin-bottom: 4px; border: 0.5px solid #e3e1d7; border-radius: 6px; background: #fff; }
.grp summary { padding: 5px 8px; font-size: 12px; font-weight: 500; cursor: pointer; user-select: none; color: #444; }
.row { display: flex; align-items: center; gap: 5px; padding: 2px 8px 2px 10px; font-size: 12px; }
.lb { flex: none; min-width: 60px; max-width: 110px; color: #5f5e5a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctl { flex: 1; display: flex; align-items: center; gap: 4px; min-width: 60px; }
/* 置灰：该档位下取值不生效（如手动字号档的字距比例） */
.row.off .ctl { opacity: .42; pointer-events: none; }
.row.off .lb { color: #a5a39c; }
.ctl input[type="number"], .ctl input[type="text"], .ctl select { width: 100%; max-width: 100%; min-width: 0; font-size: 12px; padding: 1px 4px; }
.unit { color: #888780; font-size: 11px; flex: none; }
.color { width: 26px; height: 20px; padding: 0; border: 0.5px solid #d3d1c7; background: none; }
/* 图片素材：选图按钮 + 文件名（长名省略，title 看全名）+ 清除 */
.abtn { flex: none; border: 0.5px solid #d3d1c7; background: #fff; border-radius: 4px; font-size: 11px; padding: 1px 7px; cursor: pointer; color: #55534d; }
.abtn:hover:not(:disabled) { border-color: #0f6e56; color: #0f6e56; }
.abtn:disabled { opacity: .55; cursor: default; }
.aname { flex: 1; min-width: 0; font-size: 11px; color: #0f6e56; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ax { flex: none; border: 0; background: none; color: #a09e95; font-size: 13px; line-height: 1; cursor: pointer; padding: 0 2px; }
.ax:hover { color: #b5342a; }
.seg { display: flex; flex-wrap: wrap; gap: 2px; }
.seg button { border: 0.5px solid #d3d1c7; background: #faf9f6; border-radius: 4px; font-size: 11px; padding: 1px 6px; cursor: pointer; color: #5f5e5a; }
.seg button.on { background: #0f6e56; border-color: #0f6e56; color: #e1f5ee; }
.paper-hint { font-size: 11px; color: #0f6e56; background: #eef7f3; border-radius: 4px; padding: 5px 10px; margin: 2px 8px 8px; line-height: 1.5; }
</style>
