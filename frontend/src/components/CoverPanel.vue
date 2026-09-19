<script setup lang="ts">
import { computed, ref, reactive, onUnmounted, watch } from 'vue'
import {
  cur, spEdit, spScope, spOverridden, spRevert, spRevertAll, spOverrideCount, spSet,
  resolveLeafCfg, leafOverrideCount, projectDir, type SpKey,
} from '../stores/app'
import { renderHalfPreview, HALF_W, HALF_H, type SpecialKind } from '../core/special'
import { appConfirm, appAlert } from '../stores/dialog'
import { importImage } from '../platform/wails'
import { ensureAsset, ensureAssets, assetInfo, onAssetReady } from '../core/assets'

/* ---- 四个 tab：全书（书级默认 + 三叶总览）+ 封面 / 扉页 / 尾页（单叶覆盖） ----
 * 全书：编辑书级默认（三叶共用），舞台并排预览三叶；
 * 单叶：编辑该叶的覆盖，舞台只预览该叶。 */
type TabKey = 'book' | SpecialKind
const LEAF_KINDS = ['cover', 'fly', 'colophon'] as const
const LEAF_CN: Record<SpecialKind, string> = { cover: '封面', fly: '扉页', colophon: '尾页' }
const TABS: [TabKey, string][] = [['book', '全书'], ['cover', '封面'], ['fly', '扉页'], ['colophon', '尾页']]

/* tab 由 store 作用域派生（书级 → 全书；叶级 → 当前叶），故 write 侧只有 setTab 一处。 */
const tab = computed<TabKey>(() => (spScope.value === 'book' ? 'book' : LEAF_KINDS[cur.leaf] || 'cover'))
/** 切 tab：只改叶号 + 作用域，**不动 cur.folder** —— 图书视图的选区不受封装设计影响 */
function setTab(k: TabKey) {
  if (k === 'book') { spScope.value = 'book'; return }
  cur.leaf = Math.max(0, (LEAF_KINDS as readonly string[]).indexOf(k))
  spScope.value = 'leaf'
}

/* 覆盖计数：叶 tab 上带徽标，一眼看出哪一叶改过、改了几项 */
const counts = computed<Record<SpecialKind, number>>(() => ({
  cover: leafOverrideCount('cover'), fly: leafOverrideCount('fly'), colophon: leafOverrideCount('colophon'),
}))
const tabItems = computed(() => TABS.map(([k, lb]) => ({
  k, lb, n: k === 'book' ? 0 : counts.value[k as SpecialKind],
})))
const ovdCount = computed(() => (tab.value === 'book' ? 0 : spOverrideCount()))
const scopeName = computed(() => (tab.value === 'book' ? '全书' : LEAF_CN[tab.value as SpecialKind]))

async function clearAll() {
  if (!(await appConfirm(`清除「${scopeName.value}」的全部特殊页覆盖（${ovdCount.value} 项），恢复跟随全书？`))) return
  spRevertAll()
}

/* 字段行：k = SpecialCfg 键，lb = 标签，ph = 占位提示 */
const FIELDS: [SpKey, string, string][] = [
  ['coverTitle', '书名', ''],
  ['volLabel', '册名', '上下卷'],
  ['coverAuthor', '撰者', '魏王弼注'],
  ['imprint', '牌记', '光緒甲申年重刊'],
  ['colophon', '尾页文字', '栏用/分隔'],
]

const PAPERS: [string, string][] = [
  ['none', '无（透纸）'], ['#f6f1e4', '宣纸·微黄'], ['#faf6ec', '宣纸·白'], ['#efe6cf', '仿旧·深'],
]
const SLIPS: [string, string][] = [
  ['#f2ecdc', '浅签'], ['#e9e0c8', '旧签'], ['none', '无（透纸）'],
]

/* 预览：每片叶各自用其解析后的生效配置渲染 */
const cfg = spEdit
/* 宣纹开关：打开=底图用宣纸纹理（textures/xuan.jpg），关闭=恢复纯色（与「底图」字段同步） */
function onXuan(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  cfg.bg = on ? 'textures/xuan.jpg' : ''
}
/* 底图：与图章/插图一致，经系统选图对话框（importImage）存进项目 assets/，配置只存文件名；
 * 预览经 core/assets 缓存解析为 dataURL，导出前 warmAssets 一并预热。清除 = 恢复纯色（bg 置空）。 */
async function pickBg() {
  if (!projectDir.value) {
    await appAlert('请先把项目保存到磁盘：图片素材会存进项目的 assets/ 目录，随项目一起搬走。')
    return
  }
  try {
    const names = await importImage(projectDir.value)
    if (!names.length) return                          // 用户取消
    cfg.bg = names[0]                                  // 只存文件名（落盘路径由 assets 缓存解析）
    await ensureAsset(names[0])                        // 立刻解码预热，预览下一帧即可见
  } catch (e: any) {
    await appAlert('导入底图失败：' + (e?.message || e))
  }
}
const isCustomBg = computed(() => !!cfg.bg && cfg.bg !== 'textures/xuan.jpg')
/* 扉页图章 / 尾页插图：经系统选图对话框（importImage）存进项目 assets/，配置只存文件名；
 * 位置/缩放用归一化默认，预览中拖动调位置、拖右下角缩放。仅在该叶 tab 可上传（图章只归扉页、插图只归尾页）。 */
async function pickImg(key: 'stamp' | 'illus') {
  if (!projectDir.value) {
    await appAlert('请先把项目保存到磁盘：图片素材会存进项目的 assets/ 目录，随项目一起搬走。')
    return
  }
  try {
    const names = await importImage(projectDir.value)
    if (!names.length) return                          // 用户取消
    ;(cfg as any)[key] = names[0]                       // 只存文件名（落盘路径由 assets 缓存解析）
    await ensureAsset(names[0])                         // 立刻解码预热，预览下一帧即可见
  } catch (e: any) {
    await appAlert('导入图片失败：' + (e?.message || e))
  }
}

/* 素材预热异步：就绪后重渲一次（图章/插图文件名 → 项目 assets 缓存 dataURL） */
const assetTick = ref(0)
const offAsset = onAssetReady(() => { assetTick.value++ })
onUnmounted(() => offAsset())
/* 三叶清单：watch（immediate 同步执行）与 previews 都依赖它，故声明必须早于 watch */
const ALL: { k: SpecialKind; cap: string }[] = [
  { k: 'cover', cap: '封面 · 题签式' },
  { k: 'fly', cap: '扉页 · 居中大字' },
  { k: 'colophon', cap: '尾页 · 跋尾（/ 分栏）' },
]
/* 预览依赖的素材立即预热 */
watch(
  () => ALL.map(p => {
    const c = resolveLeafCfg(p.k)
    /* dataURL（旧版兼容）与相对路径（内置宣纸纹理）不进 assets 缓存；只预热项目 assets/ 文件名 */
    return [c.stamp, c.illus, c.bg].filter(s => s && !String(s).startsWith('data:') && !String(s).includes('/')).join(',')
  }).join(','),
  s => { if (s) ensureAssets(s.split(',').filter(Boolean)) },
  { immediate: true },
)
/* 表单缩略图：文件名 → 缓存 dataURL（未就绪时先空，assetTick 触发补出） */
function thumbOf(s: string): string {
  if (!s) return ''
  if (s.startsWith('data:')) return s
  return assetInfo(s)?.url || ''
}
const stampThumb = computed(() => { void assetTick.value; return thumbOf((cfg as any).stamp) })
const illusThumb = computed(() => { void assetTick.value; return thumbOf((cfg as any).illus) })
const bgThumb = computed(() => { void assetTick.value; return thumbOf((cfg as any).bg) })

/* 预览拖动调整位置 / 缩放：
 * 位置——归一化坐标（0..1），屏幕位移 ÷ 卡片显示宽高 → 归一化增量，相对按下起点累计避免浮点漂移；
 * 缩放——拖右下角，以起点显示宽度算倍数（基准正方形框 × 倍数），中心锚定不动。
 * 松手即落参（spSet 写当前叶覆盖）。 */
const RATIO = HALF_H / HALF_W
const SCALE_MIN = 0.2, SCALE_MAX = 4
function boxFrac(key: 'stamp' | 'illus') { return key === 'stamp' ? 0.16 : 0.46 }
function leafEl(e: PointerEvent): HTMLElement {
  let el = e.target as HTMLElement
  while (el && !el.classList.contains('leaf')) el = el.parentElement as HTMLElement
  return el || (e.target as HTMLElement).parentElement as HTMLElement
}
const dragState = reactive({ on: false, mode: 'move' as 'move' | 'resize', key: '' as 'stamp' | 'illus', sx: 0, sy: 0, ox: 0, oy: 0, oScale: 1 })
function startMove(e: PointerEvent, key: 'stamp' | 'illus') {
  dragState.on = true; dragState.mode = 'move'; dragState.key = key
  dragState.sx = e.clientX; dragState.sy = e.clientY
  dragState.ox = (cfg as any)[key + 'X'] ?? (key === 'stamp' ? 0.78 : 0.5)
  dragState.oy = (cfg as any)[key + 'Y'] ?? (key === 'stamp' ? 0.86 : 0.45)
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function startResize(e: PointerEvent, key: 'stamp' | 'illus') {
  e.stopPropagation()
  dragState.on = true; dragState.mode = 'resize'; dragState.key = key
  dragState.sx = e.clientX
  dragState.oScale = (cfg as any)[key + 'Scale'] ?? 1
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}
function moveDrag(e: PointerEvent) {
  if (!dragState.on) return
  const w = leafEl(e).clientWidth || 380
  const key = dragState.key
  if (dragState.mode === 'move') {
    const dx = (e.clientX - dragState.sx) / w
    const dy = (e.clientY - dragState.sy) / (w * RATIO)
    spSet((key + 'X') as SpKey, Math.min(1, Math.max(0, dragState.ox + dx)))
    spSet((key + 'Y') as SpKey, Math.min(1, Math.max(0, dragState.oy + dy)))
  } else {
    const startDispW = boxFrac(key) * dragState.oScale * w
    const factor = (startDispW + (e.clientX - dragState.sx)) / startDispW
    spSet((key + 'Scale') as SpKey, Math.min(SCALE_MAX, Math.max(SCALE_MIN, dragState.oScale * factor)))
  }
}
function endDrag(e: PointerEvent) {
  if (!dragState.on) return
  dragState.on = false
  ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
}
/** 拖动框在预览卡片中的像素矩形（与 special.ts 渲染框同尺寸、同位置、同缩放） */
function dragStyle(p: any) {
  const d = p.drag, w = p.w
  const fw = d.fw * (d.scale || 1), fh = d.fh * (d.scale || 1)
  return {
    left: (d.cx - fw / 2) * w + 'px',
    top: (d.cy - fh / 2) * (w * RATIO) + 'px',
    width: fw * w + 'px',
    height: fh * (w * RATIO) + 'px',
  }
}
const previews = computed(() => {
  void assetTick.value                              // 素材就绪后重渲
  const w = tab.value === 'book' ? 262 : 380      // 三页并排缩到 262，单叶放大到 380 看细节
  return ALL.map(p => {
    const c = resolveLeafCfg(p.k)
    const key = p.k === 'fly' ? 'stamp' : p.k === 'colophon' ? 'illus' : ''
    let drag: any = null
    if (key && (c as any)[key]) {
      const bf = boxFrac(key)                        // 占 HALF_W 比例（正方形框，与 special.ts 渲染一致）
      drag = {
        key,
        cx: (c as any)[key + 'X'] ?? (key === 'stamp' ? 0.78 : 0.5),
        cy: (c as any)[key + 'Y'] ?? (key === 'stamp' ? 0.86 : 0.45),
        fw: bf, fh: bf * HALF_W / HALF_H,
        scale: (c as any)[key + 'Scale'] ?? 1,
      }
    }
    return {
      ...p, lb: LEAF_CN[p.k], w, svg: renderHalfPreview(p.k, c, w),
      transparent: c.paper === 'none', drag,
    }
  })
})
const shown = computed(() => (tab.value === 'book' ? previews.value : previews.value.filter(p => p.k === tab.value)))
/* 扉页分栏线只对扉页有效：全书 tab（写书级默认）与扉页 tab 可改，封面/尾页 tab 置灰 */
const flyLinesOn = computed(() => tab.value === 'book' || tab.value === 'fly')
</script>

<template>
  <div class="cover-view">
    <div class="tabs">
      <button
        v-for="t in tabItems" :key="t.k" class="tab" :class="{ on: tab === t.k }"
        @click="setTab(t.k)"
      >
        {{ t.lb }}<span v-if="t.n" class="badge">{{ t.n }}</span>
      </button>
      <span class="cur">{{ scopeName }} · {{ tab === 'book' ? '书级默认（三叶共用）' : '本叶覆盖（只改这一叶）' }}</span>
      <span class="sp"></span>
      <button
        v-if="ovdCount" class="clr"
        :title="`清除本叶 ${ovdCount} 项覆盖，恢复跟随全书`"
        @click="clearAll"
      >清除覆盖 {{ ovdCount }}</button>
    </div>

    <div class="body">
      <aside class="form">
        <div class="grp">文字</div>
        <div v-for="[k, lb, ph] in FIELDS" :key="k" class="row">
          <i
            class="ovd" :class="{ on: spOverridden(k) }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert(k)"
          >●</i>
          <label>{{ lb }}</label>
          <input v-model="cfg[k]" type="text" :placeholder="ph">
        </div>

        <div class="grp">样式</div>
        <div class="row">
          <i
            class="ovd" :class="{ on: spOverridden('font') }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert('font')"
          >●</i>
          <label>字体</label>
          <select v-model="cfg.font">
            <option value="song">宋体（题签/版心通行）</option>
            <option value="kai">楷体（扉页常用）</option>
          </select>
        </div>
        <div class="row">
          <i
            class="ovd" :class="{ on: spOverridden('fs') }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert('fs')"
          >●</i>
          <label>大字字号</label>
          <input v-model.number="cfg.fs" type="range" min="110" max="220" step="2">
          <span class="v">{{ cfg.fs }}</span>
        </div>
        <div class="row">
          <i
            class="ovd" :class="{ on: spOverridden('frame') }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert('frame')"
          >●</i>
          <label>边框</label>
          <input v-model="cfg.frame" type="checkbox">
          <span class="hint">书衣双框，内缩跟随正文页边距</span>
        </div>
        <div class="row" :class="{ dis: !flyLinesOn }">
          <i
            class="ovd" :class="{ on: spOverridden('flyLines') }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert('flyLines')"
          >●</i>
          <label for="inp-flylines">扉页分栏线</label>
          <input id="inp-flylines" v-model="cfg.flyLines" type="checkbox" :disabled="!flyLinesOn">
          <span class="hint">
            {{ flyLinesOn ? '内框内画两条竖线，左中右三栏' : '仅对扉页有效，请切到扉页' }}
          </span>
        </div>
        <div class="row">
          <i
            class="ovd" :class="{ on: spOverridden('paper') }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert('paper')"
          >●</i>
          <label>纸色</label>
          <select v-model="cfg.paper">
            <option v-for="[v, lb] in PAPERS" :key="v" :value="v">{{ lb }}</option>
          </select>
        </div>
        <div class="row">
          <i
            class="ovd" :class="{ on: spOverridden('slipbg') }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert('slipbg')"
          >●</i>
          <label>签底色</label>
          <select v-model="cfg.slipbg">
            <option v-for="[v, lb] in SLIPS" :key="v" :value="v">{{ lb }}</option>
          </select>
        </div>
        <div class="row">
          <i
            class="ovd" :class="{ on: spOverridden('bg') }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert('bg')"
          >●</i>
          <label>宣纹</label>
          <input type="checkbox" :checked="cfg.bg === 'textures/xuan.jpg'" @change="onXuan">
          <span class="hint">宣纸纹理底</span>
        </div>
        <div class="row">
          <i
            class="ovd" :class="{ on: spOverridden('bg') }"
            title="本叶已覆盖此项 · 点击恢复跟随全书"
            @click="spRevert('bg')"
          >●</i>
          <label>底图</label>
          <button class="up" @click="pickBg">选择图片</button>
          <button v-if="isCustomBg" class="upx" @click="cfg.bg = ''">清除</button>
          <img v-if="bgThumb" :src="bgThumb" class="thumb" alt="底图预览">
        </div>
        <div class="row" v-if="tab === 'fly'">
          <i class="ind"></i>
          <label>图章</label>
          <button class="up" @click="pickImg('stamp')">上传图章</button>
          <button v-if="cfg.stamp" class="upx" @click="cfg.stamp = ''">清除</button>
          <img v-if="stampThumb" :src="stampThumb" class="thumb" alt="图章预览">
        </div>
        <div class="row" v-if="tab === 'fly' && cfg.stamp">
          <i class="ind"></i>
          <span class="hint">右侧预览中拖动调位置、拖右下角缩放（原图存项目 assets/，配置只存文件名）</span>
        </div>
        <div class="row" v-if="tab === 'colophon'">
          <i class="ind"></i>
          <label>插图</label>
          <button class="up" @click="pickImg('illus')">上传插图</button>
          <button v-if="cfg.illus" class="upx" @click="cfg.illus = ''">清除</button>
          <img v-if="illusThumb" :src="illusThumb" class="thumb" alt="插图预览">
        </div>
        <div class="row" v-if="tab === 'colophon' && cfg.illus">
          <i class="ind"></i>
          <span class="hint">右侧预览中拖动调位置、拖右下角缩放</span>
        </div>
        <div class="tip">
          留空 = 沿用全书：书名取项目书名、撰者取项目撰者、卷数默认取叶名。<br>
          「全书」改的是三叶共用的书级默认；「封面／扉页／尾页」改的是本叶覆盖（页签上的数字 = 该叶覆盖项数），点 ● 可恢复跟随全书。
        </div>
      </aside>
      <div class="stage">
        <figure v-for="p in shown" :key="p.k">
          <div class="leaf" :class="{ transparent: p.transparent }">
            <div class="card" v-html="p.svg"></div>
            <div
              v-if="p.drag && tab !== 'book'"
              class="dragbox" :style="dragStyle(p)"
              @pointerdown.prevent="startMove($event, p.drag.key)"
              @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag"
            ><div class="grip" title="拖动缩放" @pointerdown.stop.prevent="startResize($event, p.drag.key)"></div></div>
          </div>
          <figcaption>{{ p.cap }}</figcaption>
        </figure>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cover-view { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.tabs { flex: none; display: flex; align-items: center; gap: 6px; padding: 7px 12px; background: #faf9f6; border-bottom: 0.5px solid #d3d1c7; }
.tabs .tab { display: inline-flex; align-items: center; gap: 5px; border: 0.5px solid #d3d1c7; background: #fff; color: #5f5e5a; font-size: 12px; padding: 4px 14px; border-radius: 6px; cursor: pointer; }
.tabs .tab:hover { border-color: #0f6e56; color: #0f6e56; }
.tabs .tab.on { background: #0f6e56; border-color: #0f6e56; color: #e1f5ee; }
.tabs .tab.on:hover { color: #e1f5ee; }
.tabs .badge { background: #b8862a; color: #fff; border-radius: 8px; font-size: 10px; line-height: 1; padding: 2px 5px; }
.tabs .tab.on .badge { background: #e1f5ee; color: #0c4a3a; }
.tabs .cur { font-size: 11px; color: #888780; margin-left: 4px; }
.tabs .sp { flex: 1; }
.tabs .lnk { border: 0.5px solid #d3d1c7; background: #fff; border-radius: 5px; font-size: 11px; padding: 4px 8px; cursor: pointer; color: #0f6e56; flex: none; }
.tabs .lnk:hover { border-color: #0f6e56; }
.tabs .lnk .n { color: #b8862a; }
.tabs .clr { border: 0.5px solid #d3d1c7; background: #fff; border-radius: 5px; font-size: 11px; padding: 4px 8px; cursor: pointer; color: #8a5a2a; flex: none; }
.tabs .clr:hover { border-color: #b4532a; color: #b4532a; }
.row .up { flex: none; border: 0.5px solid #0f6e56; background: #0f6e56; color: #e1f5ee; border-radius: 4px; font-size: 11px; padding: 2px 9px; cursor: pointer; }
.row .up:hover { background: #0c5e49; }
.row .upx { flex: none; border: 0.5px solid #d3d1c7; background: #fff; border-radius: 4px; font-size: 11px; padding: 2px 8px; cursor: pointer; color: #b4532a; }
.row .upx:hover { border-color: #b4532a; }
.row .thumb { width: 34px; height: 34px; object-fit: cover; border: 0.5px solid #d3d1c7; border-radius: 3px; flex: none; }
.body { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.form { width: 250px; flex: none; background: #faf9f6; border-right: 0.5px solid #d3d1c7; overflow: auto; padding: 10px; }
.grp { font-size: 12px; font-weight: 600; color: #6b6a63; margin: 10px 0 4px; border-bottom: 0.5px dashed #d3d1c7; padding-bottom: 3px; }
.grp:first-child { margin-top: 0; }
.row { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 12px; }
.row > label { width: 56px; flex: none; color: #5f5e5a; }
.row input[type="text"], .row select { flex: 1; min-width: 0; font-size: 12px; padding: 2px 5px; }
.row input[type="range"] { flex: 1; accent-color: #0f6e56; }
.row input[type="checkbox"] { width: 14px; height: 14px; cursor: pointer; flex: none; }
.row.dis { opacity: 0.55; pointer-events: none; }
.v { width: 30px; text-align: right; color: #888780; }
.hint { color: #888780; }
.ovd { flex: none; width: 9px; font-style: normal; color: #b8862a; font-size: 10px; line-height: 1; visibility: hidden; }
/* 无覆盖语义的行（图章/插图/说明）用等宽占位补齐，保证各行的 label 与控件左边缘对齐 */
.row .ind { flex: none; width: 9px; }
.ovd.on { visibility: visible; cursor: pointer; }
.ovd.on:hover { color: #b4532a; }
.tip { font-size: 11px; color: #888780; line-height: 1.7; margin-top: 12px; border-top: 0.5px dashed #d3d1c7; padding-top: 8px; }
.stage { flex: 1; overflow: auto; display: flex; gap: 26px; align-items: flex-start; justify-content: center;
  justify-content: safe center; padding: 30px; flex-wrap: wrap; background: #faf9f6; }
figure { margin: 0; text-align: center; }
.leaf { position: relative; line-height: 0; }
.card { background: #fff; box-shadow: 0 2px 12px rgba(0, 0, 0, 0.14); line-height: 0; }
.dragbox { position: absolute; z-index: 2; border: 1.5px dashed rgba(15, 110, 86, 0.7); border-radius: 4px; cursor: move; }
.dragbox:hover { border-color: #0f6e56; background: rgba(15, 110, 86, 0.06); }
.dragbox .grip { position: absolute; right: -6px; bottom: -6px; width: 14px; height: 14px; border-radius: 3px; background: #0f6e56; border: 1.5px solid #fff; cursor: nwse-resize; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3); }
.card.transparent {
  background-color: #f3f1ea;
  background-image:
    linear-gradient(45deg, #e3e0d4 25%, transparent 25%),
    linear-gradient(-45deg, #e3e0d4 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #e3e0d4 75%),
    linear-gradient(-45deg, transparent 75%, #e3e0d4 75%);
  background-size: 12px 12px;
  background-position: 0 0, 0 6px, 6px -6px, -6px 0;
}
.card :deep(svg) { display: block; }
figcaption { font-size: 12px; color: #888780; margin-top: 8px; line-height: 1.4; }
</style>
