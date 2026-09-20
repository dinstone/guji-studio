<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  openProjectDialog, switchProject, removeRecentAt,
  recents, refreshRecents, watchExternalOpen, closeWelcome,
  projectDir,
} from '../stores/app'
import { openFromPaths } from '../stores/app'
import NewProjectWizard from './NewProjectWizard.vue'

/** dismissable：浮层模式（项目已加载，点系统栏「古」标呼出）——可点遮罩/✕/ESC 关闭 */
const props = withDefaults(defineProps<{ dismissable?: boolean }>(), { dismissable: false })

const dragOver = ref(false)
const busy = ref('')   // 正在打开的项目目录（防重复点击）
const wizardOpen = ref(false)  // 新建项目向导

onMounted(async () => {
  await refreshRecents()
  // 订阅拖放 / 双击 .gvs 打开（桌面壳内生效）
  watchExternalOpen()
  if (props.dismissable) document.addEventListener('keydown', onKey)
})
onUnmounted(() => { if (props.dismissable) document.removeEventListener('keydown', onKey) })

function onKey(e: KeyboardEvent) { if (e.key === 'Escape') closeWelcome() }

async function openRecent(dir: string) {
  if (busy.value) return
  busy.value = dir
  try { await switchProject(dir) } finally { busy.value = '' }
}

/* 拖入项目文件夹 / book.gvs：与卡片点击等价，直接切换（内部会先保存当前项目） */
async function onDrop(e: DragEvent) {
  dragOver.value = false
  const files = Array.from(e.dataTransfer?.files || []).map((f: any) => (f as any).path).filter(Boolean)
  if (files.length) await openFromPaths(files)
}
</script>

<template>
  <div class="welcome" :class="{ overlay: dismissable }">
    <!-- 浮层模式：半透明遮罩（可拖动窗口、点击/ESC 关闭）；启动常驻模式走全窗渐变背景 -->
    <div v-if="dismissable" class="mask" @click="closeWelcome" />
    <!-- Frameless 窗口拖动区（属性说明见 App.vue .dragbar） -->
    <div v-else class="dragbar">
      <span class="d-left"><i class="d-logo">龜</i>Guji Studio · 古籍工作室</span>
    </div>
    <div class="card"
      :class="{ over: dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <button v-if="dismissable" class="close" title="关闭（Esc）" @click="closeWelcome">✕</button>
      <div class="brand">
        <div class="logo">龜</div>
        <div>
          <h1>Guji Studio</h1>
          <p>古籍工作室</p>
        </div>
      </div>

      <p v-if="dismissable" class="hint">新建图书项目，或切换到最近打开的项目。<br>切换前会自动保存当前项目。</p>
      <p v-else class="hint">还没有图书项目。新建一个、打开已有的本地项目，<br>也可以直接把<b>项目文件夹</b>或 <code>book.gvs</code> 拖到这里。</p>

      <div class="actions">
        <button class="act primary" @click="wizardOpen = true">
          <span class="ico">✚</span>
          <span class="txt">
            <strong>新建图书项目</strong>
            <em>引导设置名称、目录与版式，生成 book.gvs</em>
          </span>
        </button>
        <button class="act" @click="openProjectDialog">
          <span class="ico">📂</span>
          <span class="txt">
            <strong>打开已有项目</strong>
            <em>选择含 book.gvs 的本地文件夹并加载</em>
          </span>
        </button>
      </div>

      <div v-if="recents.length" class="recents">
        <div class="rec-h">最近项目</div>
        <div v-for="r in recents" :key="r.dir" class="rec-row">
          <button
            class="rec" :class="{ on: r.dir === projectDir }"
            :title="r.dir" :disabled="!!busy" @click="openRecent(r.dir)"
          >
            <span class="rec-name">
              {{ r.name }}
              <i v-if="r.dir === projectDir" class="tag">当前</i>
              <i v-else-if="busy === r.dir" class="tag">打开中…</i>
            </span>
            <span class="rec-dir">{{ r.dir }}</span>
          </button>
          <button class="rec-del" title="从最近列表移除（不删除磁盘文件）" @click="removeRecentAt(r.dir)">✕</button>
        </div>
      </div>
    </div>
    <div class="foot">图书项目 = 一个文件夹，内含 <code>book.gvs</code> 与 <code>text/</code></div>
    <NewProjectWizard v-if="wizardOpen" @close="wizardOpen = false" />
  </div>
</template>

<style scoped>
.welcome {
  position: relative;
  height: 100vh; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 18px;
  background:
    radial-gradient(120% 120% at 50% 0%, #fbfaf6 0%, #f1efe7 60%, #e9e6dc 100%);
}
/* 浮层模式：盖在工作室之上（点系统栏「古」标呼出），遮罩可拖动窗口 */
.welcome.overlay {
  position: fixed; inset: 0; z-index: 100;
  background: transparent;
}
.welcome.overlay .mask {
  position: absolute; inset: 0;
  background: rgba(40, 37, 30, .28);
  --wails-draggable: drag;
  --wails-non-client-region: caption;
}
.welcome.overlay .card { position: relative; z-index: 1; box-shadow: 0 16px 50px rgba(40,34,24,.28); }
.welcome.overlay .foot { position: relative; z-index: 1; color: #6f6c63; }
.close {
  position: absolute; top: 12px; right: 12px;
  width: 24px; height: 24px; border: 0; border-radius: 6px;
  background: none; color: #9a978c; font-size: 13px; cursor: pointer;
}
.close:hover { background: #f1efe8; color: #2c2c2a; }
.dragbar {
  /* 高度取全局 --titlebar-h（App.vue :root），与 Windows 自绘窗口按钮同一真源 */
  position: absolute; top: 0; left: 0; right: 0; height: var(--titlebar-h, 40px);
  display: flex; align-items: center; padding: 0 14px;
  background: #f5f3ec; border-bottom: 0.5px solid #ddd9cc;
  --wails-draggable: drag;
  --wails-non-client-region: caption;
  user-select: none; cursor: default;
}
.dragbar .d-left { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #4c4a44; }
.dragbar .d-logo { font-style: normal; width: 22px; height: 22px; border-radius: 6px; background: #0f6e56; color: #f3f1ea; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; }
.card {
  width: 460px; max-width: 92vw; background: #fffdf8;
  border: 0.5px solid #e2dfd4; border-radius: 16px;
  padding: 30px 30px 26px; box-shadow: 0 10px 40px rgba(60,52,36,.10);
  transition: .15s;
}
/* 拖拽悬停高亮：桌面壳 EnableFileDrop 命中时窗口级事件也会触发本项目打开 */
.card.over {
  border-color: #0f6e56; background: #f1f8f5;
  box-shadow: 0 0 0 3px rgba(15,110,86,.18), 0 10px 40px rgba(60,52,36,.10);
}
.brand { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
.logo {
  width: 46px; height: 46px; border-radius: 12px; flex: none;
  display: flex; align-items: center; justify-content: center;
  background: #0f6e56; color: #f3f1ea; font-size: 24px; font-weight: 600;
}
.brand h1 { margin: 0; font-size: 21px; letter-spacing: .5px; color: #2c2c2a; }
.brand p { margin: 2px 0 0; font-size: 12px; color: #8a877c; }
.hint { margin: 0 0 18px; font-size: 13px; color: #6f6c63; }
.actions { display: flex; flex-direction: column; gap: 12px; }
.act {
  display: flex; align-items: center; gap: 14px; text-align: left;
  border: 0.5px solid #ddd9cc; background: #faf8f2; border-radius: 12px;
  padding: 14px 16px; cursor: pointer; transition: .15s;
}
.act:hover { border-color: #0f6e56; background: #f1f8f5; }
.act.primary { background: #0f6e56; border-color: #0f6e56; }
.act.primary:hover { background: #0c5e49; }
.act .ico { font-size: 20px; width: 26px; text-align: center; color: #2c2c2a; }
.act.primary .ico { color: #f3f1ea; }
.act .txt { display: flex; flex-direction: column; gap: 2px; }
.act strong { font-size: 14px; color: #2c2c2a; }
.act.primary strong { color: #fff; }
.act em { font-style: normal; font-size: 12px; color: #8a877c; }
.act.primary em { color: #cfe9e0; }
.recents { margin-top: 22px; border-top: 0.5px solid #ece9df; padding-top: 14px; }
.rec-h { font-size: 12px; color: #9a978c; margin-bottom: 8px; }
.rec-row { position: relative; }
.rec {
  display: flex; flex-direction: column; gap: 2px; width: 100%;
  border: 0; background: none; padding: 8px 10px; border-radius: 8px;
  cursor: pointer; text-align: left;
}
.rec:hover { background: #f1f8f5; }
.rec.on { background: #e9f5f0; }
.rec:disabled { opacity: .6; cursor: default; }
.rec-name { font-size: 13px; color: #2c2c2a; }
.rec .tag { font-style: normal; font-size: 10px; color: #0f6e56; background: #e1f5ee; border-radius: 4px; padding: 0 4px; margin-left: 5px; }
.rec-dir { font-size: 11px; color: #a7a399; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rec-del {
  position: absolute; top: 6px; right: 6px;
  width: 20px; height: 20px; border: 0; border-radius: 5px;
  background: none; color: #b6b3a8; font-size: 11px; cursor: pointer;
  opacity: 0; transition: opacity .15s;
}
.rec-row:hover .rec-del { opacity: 1; }
.rec-del:hover { background: #fbeae4; color: #b4532a; }
.foot { font-size: 11px; color: #a7a399; }
.foot code { background: #f3f1ea; padding: 1px 5px; border-radius: 4px; color: #6f6c63; }
</style>
