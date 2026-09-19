<script setup lang="ts">
/* 图书项目切换器（侧栏顶部）：参照 mdx WorkspaceSwitcher 的交互。
 * 触发条显示当前项目名 + 目录名；下拉列出最近项目（当前项打勾、其它项可移除），
 * 底部两个入口：新建项目 / 打开其他目录。切换走 store.switchProject（先保存当前项目）。 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  proj, projectDir, recents, switchProject, removeRecentAt,
  openProjectDialog, refreshRecents, openProjectInfo, toast, saveProjectDialog,
} from '../stores/app'
import { openFolder } from '../platform/wails'
import NewProjectWizard from './NewProjectWizard.vue'

/* inBar=true 时作为 dragbar（40px 拖动条）上的常驻控件：缩小头像、加描边成「胶囊」、
   并声明 no-drag 让点击生效（dragbar 整体可拖动，控件区须豁免）。 */
const props = defineProps<{ inBar?: boolean }>()

const open = ref(false)
const wizardOpen = ref(false)
const busy = ref('')
const rootEl = ref<HTMLElement | null>(null)

const sub = computed(() =>
  projectDir.value ? projectDir.value.split('/').pop() : '示例（未保存）',
)

function toggle() {
  open.value = !open.value
  if (open.value) refreshRecents()
}

async function onSelect(dir: string) {
  if (busy.value) return
  if (dir === projectDir.value) { open.value = false; return }
  open.value = false
  busy.value = dir
  try { await switchProject(dir) } finally { busy.value = '' }
}

/* 下拉里的动作：先收起面板再执行（新建/打开会弹系统目录选择框） */
function runClose(fn: () => void) { open.value = false; fn() }
function openWizard() { open.value = false; wizardOpen.value = true }
function openInfo() { open.value = false; openProjectInfo() }

function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false
}

/* 点击目录名：在系统文件管理器（Finder / 资源管理器）中打开当前项目目录 */
async function revealDir() {
  if (!projectDir.value) { toast('项目尚未保存，无目录可打开'); return }
  try { await openFolder(projectDir.value) }
  catch (e) { toast('打开目录失败：' + String(e)) }
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="rootEl" class="ps" :class="{ 'ps--bar': props.inBar }">
    <button class="ps-trigger" :class="{ active: open }" title="图书项目 · 点击切换" @click="toggle">
      <span class="ps-avatar">
        <svg class="ps-avatar-ico" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      </span>
      <span v-if="!props.inBar" class="ps-meta">
        <span class="ps-name" :title="proj.name">{{ proj.name }}</span>
        <span class="ps-sub">{{ sub }}</span>
      </span>
      <span v-else class="ps-name" :title="proj.name">{{ proj.name }}</span>
      <svg class="ps-chevron" :class="{ open }" width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="18 15 12 9 6 15" />
      </svg>
    </button>
    <span v-if="props.inBar" class="ps-subbar" :title="projectDir ? '在文件管理器中打开：' + projectDir : ''"
      @click.stop="revealDir">{{ sub }}</span>

    <div v-if="open" class="ps-dropdown">
      <div class="ps-top">
        <button class="ps-btn" @click="openInfo">
          <span class="ico">ℹ</span>项目信息
        </button>
        <button class="ps-btn" @click="runClose(saveProjectDialog)">
          <span class="ico">💾</span>保存项目
        </button>
      </div>
      <div class="ps-dt">最近项目</div>
      <ul class="ps-list">
        <li
          v-for="r in recents" :key="r.dir"
          class="ps-item" :class="{ active: r.dir === projectDir }"
          :title="r.dir" @click="onSelect(r.dir)"
        >
          <span class="ps-item-name">{{ r.name }}{{ busy === r.dir ? '（打开中…）' : '' }}</span>
          <svg v-if="r.dir === projectDir" class="ps-check" width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <button
            v-else class="ps-item-remove" title="从最近列表移除（不删除磁盘文件）"
            @click.stop="removeRecentAt(r.dir)"
          >✕</button>
        </li>
        <li v-if="!recents.length" class="ps-empty">暂无最近项目</li>
      </ul>
      <div class="ps-foot">
        <button class="ps-btn" @click="openWizard">
          <span class="ico">✚</span>新建项目
        </button>
        <button class="ps-btn" @click="runClose(openProjectDialog)">
          <span class="ico">📂</span>打开其他…
        </button>
      </div>
    </div>
    <NewProjectWizard v-if="wizardOpen" @close="wizardOpen = false" />
  </div>
</template>

<style scoped>
.ps { position: relative; width: 100%; }
.ps-trigger {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 6px 6px; border: none; border-radius: 8px; background: transparent;
  cursor: pointer; text-align: left; transition: background .15s;
}
.ps-trigger:hover, .ps-trigger.active { background: #f1efe8; }
.ps-avatar {
  flex: none; width: 28px; height: 28px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  background: #e1f5ee; color: #0f6e56; font-size: 14px; font-weight: 600;
}
.ps-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ps-name { font-size: 13px; font-weight: 600; color: #2c2c2a; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps-sub { font-size: 11px; color: #8a877c; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps-chevron { flex: none; color: #9a978c; transition: transform .2s; }
.ps-chevron.open { transform: rotate(180deg); }

/* ---- 下拉面板（侧栏无 overflow 裁剪，可溢出显示） ---- */
.ps-dropdown {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 30;
  width: 232px; background: #fffdf8;
  border: 0.5px solid #dedbcf; border-radius: 10px;
  box-shadow: 0 10px 30px rgba(40,34,24,.18); padding: 8px;
}
.ps-dt { font-size: 11px; font-weight: 600; letter-spacing: .04em; color: #9a978c; padding: 4px 8px 6px; }
.ps-top { padding: 2px 0 8px; border-bottom: 0.5px solid #ece9df; }
.ps-list { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto; }
.ps-item {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 8px; border-radius: 8px; cursor: pointer; transition: background .15s;
}
.ps-item:hover { background: #f1efe8; }
.ps-item.active { background: #e9f5f0; }
.ps-item-name {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; color: #2c2c2a;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ps-check { flex: none; color: #0f6e56; }
.ps-item-remove {
  flex: none; width: 20px; height: 20px; border: 0; border-radius: 5px;
  background: none; color: #b6b3a8; font-size: 11px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity .15s, background .15s, color .15s;
}
.ps-item:hover .ps-item-remove { opacity: 1; }
.ps-item-remove:hover { background: #fbeae4; color: #b4532a; }
.ps-empty { font-size: 12px; color: #aaa79f; padding: 6px 8px; }
.ps-foot { margin-top: 6px; padding-top: 6px; border-top: 0.5px solid #ece9df; display: flex; flex-direction: column; gap: 2px; }
.ps-btn {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 8px; border: 0; border-radius: 8px; background: transparent;
  color: #4c4a44; font-size: 13px; cursor: pointer; text-align: left;
}
.ps-btn:hover { background: #f1f8f5; color: #0f6e56; }
.ps-btn .ico { width: 14px; text-align: center; font-size: 12px; }

/* ---- dragbar 常驻变体（inBar）：缩头像、描边成胶囊、豁免拖动以便点击 ---- */
.ps--bar {
  width: auto; max-width: 320px;
  display: inline-flex; align-items: center; gap: 8px;
  --wails-draggable: no-drag;
  --wails-non-client-region: none;
}
.ps--bar .ps-trigger {
  width: auto; padding: 3px 4px; background: transparent;
  border: none; border-radius: 0;
}
.ps--bar .ps-trigger:hover, .ps--bar .ps-trigger.active { background: #eef0ea; border-radius: 6px; }
.ps--bar .ps-avatar { width: 24px; height: 24px; font-size: 13px; }
.ps--bar .ps-name { max-width: 150px; }
/* 目录信息：从胶囊内「名字下方」移到胶囊「右侧」，点击可在文件管理器打开 */
.ps-subbar {
  font-size: 11px; color: #8a877c; line-height: 1.3; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 120px;
}
.ps-subbar:hover { color: #0f6e56; text-decoration: underline; }
</style>
