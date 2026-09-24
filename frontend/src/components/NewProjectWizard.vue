<script setup lang="ts">
/* 新建项目向导（3 步）
 * ① 基本信息：项目名 + 书名 + 存储目录
 * ② 版式：模板（带 SVG 预览）或 自定义（纸张/页边距/列数/字数/字体），右侧实时预览
 * ③ 确认摘要 → createProject 把版式写进 book.gvs.Template 并打开 */
import { computed, reactive, ref, watch } from 'vue'
import {
  PAPER_SIZES, buildTemplate, pagePreviewSVG, templateSummary, diffFromDefault,
} from '../core/templates'
import { BUILTIN_TPLS } from '../core/presets'
import { createProject } from '../stores/app'
import { chooseProjectDir } from '../platform/wails'
import FontPicker from './FontPicker.vue'

const emit = defineEmits<{ (e: 'close'): void }>()

const step = ref(1)
const name = ref('未命名项目')
const title = ref('')
const dir = ref('')
const layoutMode = ref<'template' | 'custom'>('template')
// 向导模板 tab 只展示纸张开本类（cat==='paper'），其余（风格/目录）不进向导
const builtinForWizard = BUILTIN_TPLS.filter((t) => t.cat === 'paper')
const presetId = ref(builtinForWizard[0]?.id || '')

const custom = reactive({
  paperId: 'a4h',
  canvas_width: 3508, canvas_height: 2480,
  margins_top: 240, margins_bottom: 80, margins_left: 70, margins_right: 70,
  leaf_col: 16, row_num: 22, text_font_family: 'song_tc',
})

const busy = ref(false)

function applyPaper(id = custom.paperId) {
  const p = PAPER_SIZES.find((x) => x.id === id)
  if (p && p.id !== 'custom') {
    custom.canvas_width = p.w
    custom.canvas_height = p.h
  }
}
watch(() => custom.paperId, () => applyPaper())

/* 当前预览参数（完整模板 map） */
const previewParams = computed<Record<string, any>>(() => {
  if (layoutMode.value === 'template') {
    const t = builtinForWizard.find((x) => x.id === presetId.value) || builtinForWizard[0]
    return t ? t.params : buildTemplate({})
  }
  const o: Record<string, any> = {
    canvas_width: custom.canvas_width, canvas_height: custom.canvas_height,
    margins_top: custom.margins_top, margins_bottom: custom.margins_bottom,
    margins_left: custom.margins_left, margins_right: custom.margins_right,
    leaf_col: custom.leaf_col, row_num: custom.row_num, text_font_family: custom.text_font_family,
    // 自定义开本同样开启自适应定位，书名/页码/鱼尾随纸幅落位
    fish_auto: 1, title_y_auto: 1, pager_y_auto: 1,
  }
  return buildTemplate(o)
})
const previewSvg = computed(() => pagePreviewSVG(previewParams.value))
const summary = computed(() => templateSummary(previewParams.value))

async function chooseDir() {
  const d = await chooseProjectDir('新建项目：选择文件夹')
  if (d) dir.value = d
}
function next1() {
  if (!name.value.trim()) { alert('请填写项目名'); return }
  if (!dir.value) { alert('请选择存储目录'); return }
  step.value = 2
}
function back() { if (step.value > 1) step.value-- }
async function doCreate() {
  if (busy.value) return
  busy.value = true
  try {
    const ok = await createProject(dir.value, name.value.trim(), title.value.trim(), diffFromDefault(previewParams.value))
    if (ok) { emit('close'); return }
  } finally { busy.value = false }
}
function close() { emit('close') }

const steps = ['基本信息', '版式设置', '确认创建']
</script>

<template>
  <div class="np-mask" @click.self="close">
    <div class="np">
      <div class="np-head">
        <h2>新建图书项目</h2>
        <button class="np-x" @click="close" title="取消">✕</button>
      </div>

      <!-- 步骤条 -->
      <div class="np-steps">
        <div v-for="(s, i) in steps" :key="i" class="np-step" :class="{ on: step === i + 1, done: step > i + 1 }">
          <span class="np-dot">{{ step > i + 1 ? '✓' : i + 1 }}</span>
          <span class="np-stxt">{{ s }}</span>
        </div>
      </div>

      <!-- ① 基本信息 -->
      <div v-if="step === 1" class="np-body">
        <label class="np-field">
          <span class="np-lab">项目名称</span>
          <input v-model="name" class="np-in" placeholder="未命名项目" @keyup.enter="next1">
          <em class="np-hint">将作为默认书名</em>
        </label>
        <label class="np-field">
          <span class="np-lab">图书名称</span>
          <input v-model="title" class="np-in" placeholder="写入版心书名（可留空）">
          <em class="np-hint">留空则使用项目名</em>
        </label>
        <label class="np-field">
          <span class="np-lab">存储目录</span>
          <div class="np-dir">
            <input :value="dir" class="np-in" readonly placeholder="请选择文件夹">
            <button class="np-btn sm" @click="chooseDir">选择目录</button>
          </div>
          <em class="np-hint">项目 = 一个文件夹，内含 book.gvs 与 text/</em>
        </label>
      </div>

      <!-- ② 版式设置 -->
      <div v-else-if="step === 2" class="np-body two">
        <div class="np-left">
          <div class="np-tabs">
            <button :class="{ on: layoutMode === 'template' }" @click="layoutMode = 'template'">模板</button>
            <button :class="{ on: layoutMode === 'custom' }" @click="layoutMode = 'custom'">自定义</button>
          </div>

          <!-- 模板 -->
          <div v-if="layoutMode === 'template'" class="np-presets">
            <button
              v-for="p in builtinForWizard" :key="p.id"
              class="np-preset" :class="{ on: presetId === p.id }"
              @click="presetId = p.id"
            >
              <div class="np-pthumb" v-html="pagePreviewSVG(p.params)" />
              <div class="np-ptext">
                <div class="np-pname">{{ p.name }}</div>
                <div class="np-pdesc">{{ p.note }}</div>
              </div>
            </button>
          </div>

          <!-- 自定义 -->
          <div v-else class="np-custom">
            <div class="np-row">
              <span class="np-lab">纸张</span>
              <select v-model="custom.paperId" class="np-in">
                <option v-for="p in PAPER_SIZES" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <div v-if="custom.paperId === 'custom'" class="np-row2">
              <label>宽<input v-model.number="custom.canvas_width" class="np-in xs" type="number"></label>
              <label>高<input v-model.number="custom.canvas_height" class="np-in xs" type="number"></label>
              <span class="np-unit">px @300dpi</span>
            </div>
            <div class="np-row" style="align-items:flex-start">
              <span class="np-lab" style="padding-top:6px">页边距</span>
              <div class="np-margs">
                <div class="np-mrow"><label>上<input v-model.number="custom.margins_top" class="np-in xs" type="number"></label></div>
                <div class="np-mrow">
                  <label>左<input v-model.number="custom.margins_left" class="np-in xs" type="number"></label>
                  <label>右<input v-model.number="custom.margins_right" class="np-in xs" type="number"></label>
                </div>
                <div class="np-mrow"><label>下<input v-model.number="custom.margins_bottom" class="np-in xs" type="number"></label></div>
              </div>
            </div>
            <div class="np-row">
              <span class="np-lab">列数</span>
              <input v-model.number="custom.leaf_col" class="np-in xs" type="number" min="1" max="40">
              <span class="np-unit">半叶列数</span>
            </div>
            <div class="np-row">
              <span class="np-lab">字数</span>
              <input v-model.number="custom.row_num" class="np-in xs" type="number" min="4" max="80">
              <span class="np-unit">每列字数</span>
            </div>
            <div class="np-row">
              <span class="np-lab">正文字体</span>
              <FontPicker v-model="custom.text_font_family" />
            </div>
          </div>
        </div>

        <!-- 预览 -->
        <div class="np-right">
          <div class="np-pvwrap">
            <div class="np-pv" v-html="previewSvg" />
          </div>
          <div class="np-pvmeta">
            <div>{{ summary.paper }}</div>
            <div>{{ summary.layout }}</div>
            <div>{{ summary.font }}</div>
          </div>
        </div>
      </div>

      <!-- ③ 确认 -->
      <div v-else class="np-body">
        <div class="np-confirm">
          <div class="np-cfleft">
            <div class="np-pvwrap sm"><div class="np-pv" v-html="previewSvg" /></div>
          </div>
          <dl class="np-cfinfo">
            <div><dt>项目名称</dt><dd>{{ name || '未命名项目' }}</dd></div>
            <div><dt>图书名称</dt><dd>{{ title || '（使用项目名）' }}</dd></div>
            <div><dt>存储目录</dt><dd class="mono">{{ dir }}</dd></div>
            <div><dt>纸张</dt><dd>{{ summary.paper }}</dd></div>
            <div><dt>页边距</dt><dd>{{ summary.margins }}</dd></div>
            <div><dt>版式</dt><dd>{{ summary.layout }}</dd></div>
            <div><dt>字体</dt><dd>{{ summary.font }}</dd></div>
          </dl>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="np-foot">
        <button v-if="step > 1" class="np-btn" @click="back">上一步</button>
        <span class="np-sp" />
        <button v-if="step < 3" class="np-btn primary" @click="step === 1 ? next1() : step++">下一步</button>
        <button v-else class="np-btn primary" :disabled="busy" @click="doCreate">
          {{ busy ? '创建中…' : '创建项目' }}
        </button>
        <button class="np-btn ghost" @click="close">{{ step === 1 ? '取消' : '中止' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.np-mask {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(40, 37, 30, .32);
  display: flex; align-items: center; justify-content: center;
  --wails-draggable: drag;
  --wails-non-client-region: caption;
}
.np {
  width: 600px; max-width: 94vw; max-height: 90vh; overflow: auto;
  background: #fffdf8; border: 0.5px solid #e2dfd4; border-radius: 16px;
  padding: 22px 24px 18px; box-shadow: 0 18px 54px rgba(40,34,24,.30);
}
.np-head { display: flex; align-items: center; justify-content: space-between; --wails-draggable: no-drag; }
.np-head h2 { margin: 0; font-size: 17px; color: #2c2c2a; }
.np-x { width: 26px; height: 26px; border: 0; background: none; color: #9a978c; font-size: 14px; cursor: pointer; border-radius: 6px; }
.np-x:hover { background: #f1efe8; color: #2c2c2a; }
.np-steps { display: flex; gap: 6px; margin: 16px 0 18px; --wails-draggable: no-drag; }
.np-step { display: flex; align-items: center; gap: 6px; flex: 1; font-size: 12px; color: #a7a399; }
.np-step:not(:last-child)::after { content: ''; flex: 1; height: 1px; background: #e6e3d8; }
.np-dot { width: 20px; height: 20px; border-radius: 50%; background: #ece9df; color: #8a877c; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; flex: none; }
.np-step.on .np-dot { background: #0f6e56; color: #fff; }
.np-step.on .np-stxt { color: #2c2c2a; }
.np-step.done .np-dot { background: #0f6e56; color: #fff; }
.np-body { --wails-draggable: no-drag; }
.np-body.two { display: flex; gap: 16px; align-items: stretch; }
.np-left { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.np-right { width: 200px; flex: none; display: flex; flex-direction: column; gap: 8px; }
.np-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
.np-lab { font-size: 12px; color: #6f6c63; }
.np-in {
  border: 0.5px solid #d3d1c7; border-radius: 6px; padding: 7px 9px; font-size: 13px;
  background: #fff; color: #2c2c2a; outline: none; width: 100%;
}
.np-in:focus { border-color: #0f6e56; box-shadow: 0 0 0 1px rgba(15,110,86,.15); }
.np-hint { font-style: normal; font-size: 11px; color: #a7a399; }
.np-dir { display: flex; gap: 8px; }
.np-dir .np-in { flex: 1; }
.np-btn {
  border: 0.5px solid #d3d1c7; background: #faf8f2; border-radius: 7px;
  padding: 8px 16px; font-size: 13px; color: #2c2c2a; cursor: pointer;
}
.np-btn:hover { border-color: #0f6e56; background: #f1f8f5; }
.np-btn.primary { background: #0f6e56; border-color: #0f6e56; color: #fff; }
.np-btn.primary:hover { background: #0c5e49; }
.np-btn.primary:disabled { opacity: .6; cursor: default; }
.np-btn.ghost { background: none; border-color: transparent; color: #9a978c; }
.np-btn.sm { padding: 0 12px; flex: none; }
.np-tabs { display: flex; gap: 4px; margin-bottom: 12px; }
.np-tabs button { border: 0.5px solid #d3d1c7; background: #faf8f2; border-radius: 6px 6px 0 0; padding: 6px 14px; font-size: 12px; cursor: pointer; color: #6f6c63; }
.np-tabs button.on { background: #fff; border-bottom-color: #fff; color: #2c2c2a; font-weight: 500; }
.np-presets { display: flex; flex-direction: column; gap: 8px; max-height: min(420px, 52vh); overflow-y: auto; overflow-x: hidden; padding-right: 4px; }
.np-preset {
  text-align: left; border: 0.5px solid #e2dfd4; background: #fff; border-radius: 10px;
  padding: 8px 10px; cursor: pointer; transition: .12s;
  display: flex; align-items: center; gap: 10px;
}
.np-preset:hover { border-color: #0f6e56; }
.np-preset.on { border-color: #0f6e56; box-shadow: 0 0 0 2px rgba(15,110,86,.18); }
.np-pthumb { width: 76px; height: 56px; flex: none; background: #f6f4ec; border-radius: 6px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.np-pthumb :deep(svg) { width: 100%; height: 100%; }
.np-ptext { flex: 1; min-width: 0; }
.np-pname { font-size: 13px; color: #2c2c2a; font-weight: 500; }
.np-pdesc { font-size: 11px; color: #8a877c; margin-top: 2px; line-height: 1.35; }
.np-custom { display: flex; flex-direction: column; gap: 11px; max-height: min(420px, 52vh); overflow-y: auto; overflow-x: hidden; padding-right: 4px; }
/* 滚动条可见化：桌面壳（WKWebView）默认 overlay 滚动条不常显，这里显式画一条 */
.np-presets::-webkit-scrollbar, .np-custom::-webkit-scrollbar { width: 8px; }
.np-presets::-webkit-scrollbar-track, .np-custom::-webkit-scrollbar-track { background: transparent; }
.np-presets::-webkit-scrollbar-thumb, .np-custom::-webkit-scrollbar-thumb { background: #d3d1c7; border-radius: 4px; }
.np-presets::-webkit-scrollbar-thumb:hover, .np-custom::-webkit-scrollbar-thumb:hover { background: #b9b6a8; }
.np-row { display: flex; align-items: center; gap: 8px; }
.np-row .np-lab { width: 56px; flex: none; }
.np-row .np-in { flex: 1; width: auto; }
.np-row2 { display: flex; align-items: center; gap: 8px; padding-left: 64px; }
.np-row2 label { display: flex; align-items: center; gap: 4px; font-size: 12px; color: #6f6c63; }
.np-margs { display: flex; flex-direction: column; gap: 6px; }
.np-mrow { display: flex; gap: 8px; align-items: center; }
.np-margs label { display: flex; align-items: center; gap: 3px; font-size: 11px; color: #8a877c; width: 90px; }
.np-in.xs { width: 62px; flex: none; padding: 5px 6px; font-size: 12px; }
.np-unit { font-size: 11px; color: #a7a399; }
.np-pvwrap { background: #f6f4ec; border: 0.5px solid #e6e3d8; border-radius: 8px; padding: 8px; display: flex; align-items: center; justify-content: center; }
.np-pv { width: 100%; max-height: 300px; }
.np-pv :deep(svg) { display: block; margin: 0 auto; }
.np-pvwrap.sm { width: 160px; flex: none; }
.np-pvmeta { font-size: 11px; color: #6f6c63; line-height: 1.6; text-align: center; }
.np-confirm { display: flex; gap: 18px; align-items: flex-start; }
.np-cfinfo { flex: 1; margin: 0; display: flex; flex-direction: column; gap: 7px; }
.np-cfinfo > div { display: flex; gap: 10px; font-size: 12px; }
.np-cfinfo dt { width: 64px; flex: none; color: #8a877c; }
.np-cfinfo dd { margin: 0; color: #2c2c2a; }
.np-cfinfo .mono { font-family: ui-monospace, Menlo, monospace; word-break: break-all; font-size: 11px; }
.np-foot { display: flex; align-items: center; gap: 8px; margin-top: 18px; --wails-draggable: no-drag; }
.np-sp { flex: 1; }
</style>
