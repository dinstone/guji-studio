<script setup lang="ts">
/* 字体选择器（WPS 式可搜索下拉）
 * - 主触发区永远显示当前选中的字体友好名（中文本地化名 / 内置别名），不随搜索改变。
 * - 点击后浮层顶部是独立搜索框，仅用于过滤下方分组列表；搜索不影响主显示值。
 * - 分组：① 内置逻辑名（走 engine 预设回退栈）② 本机字体（Go FontService.List 枚举）。
 * - 本机字体显示「本地化名」（如 Songti SC → 宋体-简），写入值仍为英文族名。
 * - 面板用 position:fixed 浮层（父级 .groups 是滚动容器，absolute 会被裁剪）。 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FAMS } from '../core/schema'
import { LayoutEngine } from '../core/engine'
import { sysFontsLoad, sysFontsCache } from '../core/fontlist'
import type { FontInfo } from '../platform/wails'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const root = ref<HTMLElement | null>(null)
const triggerEl = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)
const popEl = ref<HTMLElement | null>(null)

const open = ref(false)
const q = ref('')              // 面板内搜索词（仅过滤）
const hi = ref(0)              // 高亮项（键盘 / 悬停共用）
const loaded = ref(false)
const loading = ref(false)

const CN = LayoutEngine.FONT_CN
/* 当前值友好显示：内置键 → 中文别名；本机英文族名 → 本地化名；否则原串 */
const display = computed(() => {
  const v = props.modelValue || ''
  if (CN[v]) return CN[v]
  const hit = sysFontsCache.value.find(f => f.family === v)
  return hit?.label || v
})

interface Item { k: string; lb: string; fam: string; sub: string; title: string; group: 'builtin' | 'sys' | 'custom' }

const items = computed<Item[]>(() => {
  const s = q.value.trim().toLowerCase()
  const hit = (...xs: string[]) => !s || xs.some(x => x.toLowerCase().includes(s))
  const out: Item[] = []
  for (const [k, lb] of FAMS) {
    const stack = (LayoutEngine.FONT_STACKS as Record<string, string>)[k] || ''
    if (hit(lb, k, stack)) out.push({ k, lb, fam: stack, sub: '', title: stack, group: 'builtin' })
  }
  if (loaded.value) {
    for (const f of sysFontsCache.value) {
      const lb = f.label || f.family
      if (!hit(lb, f.family)) continue
      out.push({
        k: f.family, lb, fam: LayoutEngine.familyStack(f.family, 'song_tc'),
        sub: lb === f.family ? '' : f.family, title: f.family, group: 'sys',
      })
    }
  }
  return out.slice(0, 400)
})

const hasExactMatch = computed(() => items.value.some(it => it.k === props.modelValue))
const customTip = computed(() => {
  const s = q.value.trim()
  if (!s || hasExactMatch.value) return null
  return s
})

/* 浮层定位：优先向下，空间不足向上 */
const rect = ref({ left: 0, top: 0, width: 0, maxH: 260 })
function place() {
  const el = triggerEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const H = 320, below = window.innerHeight - r.bottom - 8
  const up = below < H && r.top > H
  rect.value = {
    left: r.left,
    top: up ? r.top - (Math.min(H, r.top - 8)) - 4 : r.bottom + 2,
    width: r.width,
    maxH: Math.min(H, up ? r.top - 12 : below),
  }
}

async function loadSys() {
  if (loaded.value || loading.value) return
  loading.value = true
  try {
    await sysFontsLoad()
    loaded.value = true
  } finally { loading.value = false }
}

function toggle() {
  open.value = !open.value
  if (open.value) {
    q.value = ''
    hi.value = 0
    loadSys()
    nextTick(() => { place(); searchEl.value?.focus() })
  }
}
function close() {
  open.value = false
  q.value = ''
  hi.value = 0
}

function onSearchInput(e: Event) {
  q.value = (e.target as HTMLInputElement).value
  hi.value = 0
}
function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    hi.value = Math.min(hi.value + 1, items.value.length - 1 + (customTip.value ? 1 : 0))
    scrollHi()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    hi.value = Math.max(hi.value - 1, 0)
    scrollHi()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const total = items.value.length + (customTip.value ? 1 : 0)
    if (hi.value < items.value.length) {
      const it = items.value[hi.value]
      if (it) pick(it.k)
    } else if (customTip.value) {
      pick(customTip.value)
    }
  } else if (e.key === 'Escape') {
    close()
    triggerEl.value?.focus()
  }
}
function onTriggerKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    toggle()
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!open.value) toggle()
    else { hi.value = Math.min(hi.value + 1, items.value.length - 1); scrollHi() }
  } else if (e.key === 'Escape' && open.value) {
    close()
  }
}

function pick(k: string) {
  emit('update:modelValue', k)
  close()
  triggerEl.value?.focus()
}
function scrollHi() {
  nextTick(() => {
    const el = popEl.value?.querySelector('.fp-it.on') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  })
}

watch(items, () => { if (hi.value >= items.value.length + (customTip.value ? 1 : 0)) hi.value = 0 })
function onScroll() { if (open.value) place() }
function onDocDown(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (root.value?.contains(t) || popEl.value?.contains(t)) return
  close()
}
onMounted(() => {
  loadSys()
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('resize', onScroll)
  document.addEventListener('mousedown', onDocDown)
})
onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll, true)
  window.removeEventListener('resize', onScroll)
  document.removeEventListener('mousedown', onDocDown)
})
</script>

<template>
  <div ref="root" class="fp">
    <div
      ref="triggerEl"
      class="fp-trigger"
      tabindex="0"
      :title="props.modelValue"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="fp-txt">{{ display || '选择字体…' }}</span>
      <span class="fp-ar">▾</span>
    </div>
    <Teleport to="body">
      <div
        v-if="open"
        ref="popEl"
        class="fp-pop"
        :style="{
          left: rect.left + 'px', top: rect.top + 'px',
          width: rect.width + 'px', maxHeight: rect.maxH + 'px',
        }"
      >
        <div class="fp-search">
          <span class="fp-search-icon">⌕</span>
          <input
            ref="searchEl"
            type="text"
            :value="q"
            placeholder="搜索字体…"
            @input="onSearchInput"
            @keydown="onSearchKeydown"
          >
        </div>
        <div v-if="!items.length && !customTip" class="fp-empty">
          {{ loading ? '读取本机字体…' : '无匹配字体' }}
        </div>
        <template v-for="(it, i) in items" :key="it.k">
          <div v-if="i === 0 || items[i - 1].group !== it.group" class="fp-hd">
            {{ it.group === 'builtin' ? '内置字体' : '本机字体' }}
          </div>
          <div
            class="fp-it" :class="{ on: i === hi }"
            :style="{ fontFamily: it.fam }"
            :title="it.title"
            @mousedown.prevent="pick(it.k)"
            @mousemove="hi = i"
          >{{ it.lb }}<em v-if="it.sub" class="fp-sub">{{ it.sub }}</em></div>
        </template>
        <div
          v-if="customTip"
          class="fp-it fp-custom"
          :class="{ on: hi === items.length }"
          @mousedown.prevent="pick(customTip)"
          @mousemove="hi = items.length"
        >
          使用 "{{ customTip }}" 作为自定义字体
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.fp { position: relative; display: flex; align-items: center; width: 100%; min-width: 0; }
.fp-trigger {
  width: 100%; min-width: 0; display: flex; align-items: center;
  font-size: 13px; line-height: 20px; padding: 2px 18px 2px 6px;
  border: 0.5px solid #d3d1c7; border-radius: 4px; background: #fff;
  cursor: pointer; outline: none;
}
.fp-trigger:focus { border-color: #0f6e56; box-shadow: 0 0 0 1px rgba(15,110,86,.15); }
.fp-txt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fp-ar { position: absolute; right: 4px; font-size: 9px; color: #9a988f; pointer-events: none; }
.fp-pop {
  position: fixed; z-index: 1000; overflow-y: auto;
  background: #fff; border: 0.5px solid #d3d1c7; border-radius: 6px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, .14);
  display: flex; flex-direction: column;
  min-height: 120px;
}
.fp-search {
  position: sticky; top: 0; z-index: 1;
  display: flex; align-items: center; gap: 4px;
  padding: 4px 6px; background: #fff; border-bottom: 0.5px solid #eae8df;
}
.fp-search-icon { font-size: 12px; color: #9a988f; }
.fp-search input {
  flex: 1; min-width: 0; border: none; outline: none;
  font-size: 13px; line-height: 20px; background: transparent;
}
.fp-hd { font-size: 11px; line-height: 18px; color: #9a988f; padding: 6px 8px 3px; }
.fp-it {
  font-size: 13px; line-height: 20px; min-height: 24px; padding: 5px 8px; cursor: pointer;
  color: #3b3a35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.fp-it.on { background: #eef7f3; color: #0f6e56; }
.fp-custom { color: #6f6d65; font-style: italic; border-top: 0.5px solid #f0efe9; }
/* 英文族名副显示：始终用 UI 字体，不受字体预览渲染影响 */
.fp-sub { font-family: -apple-system, 'PingFang SC', sans-serif; font-style: normal; font-size: 10px; color: #a8a59c; margin-left: 7px; }
.fp-empty { font-size: 11px; color: #9a988f; padding: 8px; text-align: center; }
</style>
