<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/**
 * Windows 无框窗口（main.go: Frameless = runtime.GOOS == "windows"）的自绘窗口控制按钮。
 *
 * 原生标题栏被去掉后，最小化 / 最大化 / 关闭按钮也随之消失，必须由前端补上：
 *  - 按钮自行 `--wails-draggable: no-drag` 豁免拖动，否则 mousedown 会被拖动逻辑吞掉、点击无效；
 *  - 拖动本身仍由各视图标题栏（.dragbar）上的 `--wails-draggable: drag` 负责，本组件只做控制。
 *
 * macOS 保持原生隐藏式标题栏（左上交通灯），故本组件在非 Windows 下不渲染任何内容。
 */
const isWindows = /Windows/i.test(navigator.userAgent || '')

const isMax = ref(false)
let ctrl: any = null

/** 按需加载 @wailsio/runtime：Window 是其导出的「当前窗口」单例（web 端不会打进包体）。 */
async function getWindow(): Promise<any> {
  if (ctrl) return ctrl
  try {
    const mod: any = await import('@wailsio/runtime')
    ctrl = mod.Window ?? mod.default ?? null
  } catch {
    ctrl = null
  }
  return ctrl
}

async function minimise() {
  const w = await getWindow()
  if (w) await w.Minimise()
}

async function toggleMaximise() {
  const w = await getWindow()
  if (!w) return
  if (await w.IsMaximised()) await w.UnMaximise()
  else await w.Maximise()
  await syncMaximised()
}

async function closeWindow() {
  const w = await getWindow()
  if (w) await w.Close()
}

/** 最大化态决定第二个按钮画「最大化」还是「向下还原」图标。 */
async function syncMaximised() {
  const w = await getWindow()
  if (!w) return
  try { isMax.value = !!(await w.IsMaximised()) } catch { /* 非桌面壳：忽略 */ }
}

onMounted(() => {
  if (!isWindows) return
  syncMaximised()
  window.addEventListener('resize', syncMaximised)
})
onUnmounted(() => window.removeEventListener('resize', syncMaximised))
</script>

<template>
  <div v-if="isWindows" class="win-ctrl">
    <button class="wc-btn" title="最小化" aria-label="最小化" @click="minimise">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </button>
    <button class="wc-btn" :title="isMax ? '向下还原' : '最大化'" :aria-label="isMax ? '向下还原' : '最大化'" @click="toggleMaximise">
      <svg v-if="!isMax" width="12" height="12" viewBox="0 0 12 12">
        <rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.1" />
      </svg>
      <svg v-else width="12" height="12" viewBox="0 0 12 12">
        <rect x="2.5" y="3.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.1" />
        <path d="M4.5 3.5V2h5v5H8" fill="none" stroke="currentColor" stroke-width="1.1" />
      </svg>
    </button>
    <button class="wc-btn wc-btn--close" title="关闭" aria-label="关闭" @click="closeWindow">
      <svg width="12" height="12" viewBox="0 0 12 12">
        <line x1="2.6" y1="2.6" x2="9.4" y2="9.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        <line x1="9.4" y1="2.6" x2="2.6" y2="9.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* 固定贴死窗口右上角，高度与各视图标题栏（.dragbar）一致：--titlebar-h 是全局唯一的标题栏高度。 */
.win-ctrl {
  position: fixed; top: 0; right: 0; z-index: 400;
  display: flex; height: var(--titlebar-h, 40px);
}
.wc-btn {
  --wails-draggable: no-drag;   /* 关键：不豁免拖动则点击被拖动逻辑吞掉 */
  width: 46px; height: 100%; padding: 0; border: 0;
  display: flex; align-items: center; justify-content: center;
  background: transparent; color: #4c4a44; cursor: default;
  transition: background .12s, color .12s;
}
.wc-btn:hover { background: rgba(0, 0, 0, .07); color: #2c2c2a; }
.wc-btn--close:hover { background: #e81123; color: #fff; }
</style>
