<script setup lang="ts">
import SystemRail from './components/SystemRail.vue'
import SidebarPanel from './components/SidebarPanel.vue'
import EditorPanel from './components/EditorPanel.vue'
import PreviewPanel from './components/PreviewPanel.vue'
import InspectorPanel from './components/InspectorPanel.vue'
import StatusBar from './components/StatusBar.vue'
import LayoutPanel from './components/LayoutPanel.vue'
import CoverPanel from './components/CoverPanel.vue'
import PublishExport from './components/PublishExport.vue'
import WelcomeScreen from './components/WelcomeScreen.vue'
import DialogHost from './components/DialogHost.vue'
import ProjectInfoDialog from './components/ProjectInfoDialog.vue'
import AboutDialog from './components/AboutDialog.vue'
import UpdateDialog from './components/UpdateDialog.vue'
import UpdateProgressDialog from './components/UpdateProgressDialog.vue'
import ProjectSwitcher from './components/ProjectSwitcher.vue'
import { view, toastMsg, boot, projectLoaded, booting, welcomeOpen, editorWidth, projectInfoOpen, closeProjectInfo, aboutOpen, updateOpen, downloadOpen } from './stores/app'

/* macOS 左上角有红黄绿「交通灯」窗口控制按钮（约占据窗口左起 0~70px），
 * dragbar 上的左侧控件需留出左内边距规避其遮蔽；Windows 控制按钮在右上，无需左侧留白。 */
const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')

/* ?view=layout|cover|export 直达视图；?sidebar=0 / ?inspector=0 预置折叠态（调试/深链用） */
const q = new URLSearchParams(location.search)
const qv = q.get('view')
if (qv) view.rail = qv === 'export' ? 'pub' : qv   // 旧深链 ?view=export 并入出版视图
if (q.get('sidebar') === '0') view.sidebar = 0
if (q.get('inspector') === '0') view.inspector = 0

/* 启动：播种并载入模板库 → 打开待处理路径（双击 .gvs）或恢复上次项目 → 订阅外部打开。
 * 顺序由 stores/app.ts 的 boot() 统一保证，避免两条 openProjectAt 并发抢最后状态。 */
boot()

/* 编辑器宽度拖拽：在 EditorPanel 与 PreviewPanel 之间的分隔条上按住拖动。
 * 用增量算法（startW + dx）；边界按「侧栏 + Inspector + 分隔条 + 预览最小宽」实时量取，
 * 不受二者折叠态影响，保证预览始终 ≥ 400px。 */
function startResize(e: MouseEvent) {
  e.preventDefault()
  const body = document.querySelector('.body') as HTMLElement | null
  const bodyW = body?.clientWidth || window.innerWidth
  const sideW = (document.querySelector('.side') as HTMLElement | null)?.clientWidth || 0
  const inspW = (document.querySelector('.insp, .rail-strip') as HTMLElement | null)?.clientWidth
    || (view.inspector ? 300 : 26)
  const startX = e.clientX
  const startW = editorWidth.value
  const minW = 280                                    // 编辑器最小宽
  const maxW = Math.max(minW, bodyW - sideW - inspW - 5 - 400)  // 保证预览 ≥ 400px
  const move = (ev: MouseEvent) => {
    editorWidth.value = Math.min(maxW, Math.max(minW, startW + (ev.clientX - startX)))
  }
  const up = () => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
  }
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'col-resize'
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
</script>

<template>
  <!-- 启动态：boot 完成前只显示载入态，避免首帧闪一下欢迎页（再切到项目） -->
  <div v-if="booting" class="booting-splash">
    <i class="b-logo">龜</i>
    <span>正在初始化…</span>
  </div>
  <!-- 欢迎页：启动无项目时常驻；有项目时点系统栏「古」标呼出浮层版（新建/切换项目，底下工作室保持挂载） -->
  <WelcomeScreen v-else-if="!projectLoaded" />
  <div v-else class="studio">
    <!-- 40px 拖动 header（Frameless 窗口拖动区；同时声明 wails-draggable 与 non-client-region 以兼容 macOS/Windows）。
       左：项目切换器（every view 可见当前项目）；中：标题；右：占位。项目切换器须 no-drag 以可点击。 -->
    <header class="dragbar" :class="{ 'is-mac': isMac }">
      <div class="d-left"><ProjectSwitcher in-bar /></div>
      <span class="d-title"><i class="d-logo">龜</i>Guji Studio · 古籍工作室 可视化排版</span>
      <span class="d-right"></span>
    </header>
    <div class="body">
      <SystemRail />
      <template v-if="view.rail === 'book'">
        <div class="book-view">
          <div class="book-main">
            <SidebarPanel v-if="view.sidebar" />
            <!-- 版式参数展开时隐藏编辑器 + 拖拽条，预览与 Inspector 占据其空间（专注调版式） -->
            <EditorPanel v-if="!view.inspector" :style="{ flex: '0 0 ' + editorWidth + 'px', width: editorWidth + 'px' }" />
            <div v-if="!view.inspector" class="split-x" title="拖拽调整编辑框宽度" @mousedown="startResize" />
            <PreviewPanel />
            <InspectorPanel />
          </div>
          <StatusBar />
        </div>
      </template>
      <LayoutPanel v-else-if="view.rail === 'layout'" />
      <CoverPanel v-else-if="view.rail === 'cover'" />
      <PublishExport v-else-if="view.rail === 'pub'" />
      <div v-else class="todo-view">该视图后续开放</div>
    </div>
  </div>
  <!-- 全局层：toast 与应用内弹窗在任何分支（含欢迎页）都可见 -->
  <WelcomeScreen v-if="welcomeOpen && projectLoaded" dismissable />
  <ProjectInfoDialog v-if="projectInfoOpen" />
  <AboutDialog v-if="aboutOpen" />
  <UpdateDialog v-if="updateOpen" />
  <UpdateProgressDialog v-if="downloadOpen" />
  <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
  <DialogHost />
</template>

<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body { margin: 0; font-family: -apple-system, 'PingFang SC', sans-serif; font-size: 13px; color: #2c2c2a; }
.studio { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
.body { flex: 1; display: flex; overflow: hidden; position: relative; }
/* 图书视图：纵向列布局——上方横向排各面板，底部状态栏为正常 flex 项，仅在此视图出现 */
.book-view { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.book-main { flex: 1; display: flex; min-width: 0; min-height: 0; overflow: hidden; }
/* Frameless 窗口拖动 header：--wails-draggable 走 DOM 拖动（macOS 有效），
   --wails-non-client-region 走 Windows 原生命中测试（NonClientRegionSupport）。
   子元素会继承这两个属性，需要交互的控件须用 no-drag 覆盖。 */
.dragbar {
  height: 40px; flex: none; position: relative; z-index: 40;
  display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  gap: 12px; padding: 0 14px;
  background: #f5f3ec; border-bottom: 0.5px solid #ddd9cc;
  --wails-draggable: drag;
  --wails-non-client-region: caption;
  user-select: none; cursor: default;
}
/* 左侧单元：项目切换器居左；macOS 留出左内边距规避左上角交通灯（约 0~70px）遮蔽 */
.d-left { display: flex; align-items: center; min-width: 0; }
.is-mac .d-left { padding-left: 70px; }
.d-right { min-width: 0; }
.dragbar .d-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; color: #4c4a44; justify-self: center; white-space: nowrap; }
.dragbar .d-logo { font-style: normal; width: 22px; height: 22px; border-radius: 6px; background: #0f6e56; color: #f3f1ea; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; }
input, select, button { font-family: inherit; }
.todo-view { flex: 1; display: flex; align-items: center; justify-content: center; color: #888780; background: #f3f1ea; }
/* 编辑框 / 预览之间可拖拽分隔条：1px 极淡细线（默认几乎不可见），两侧透明热区扩命中；hover/拖动时浮现 2px 主题绿细线 */
.split-x { position: relative; flex: 0 0 1px; cursor: col-resize; background: #e6e4da; transition: background .12s, box-shadow .12s; }
.split-x::before { content: ''; position: absolute; top: 0; bottom: 0; left: -4px; right: -4px; }
.split-x:hover, .split-x:active { background: #0f6e56; box-shadow: 0 0 0 0.5px #0f6e56; }
/* 启动载入态：boot 期间占位，首帧即显示、不闪欢迎页 */
.booting-splash { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; background: #f3f1ea; color: #8a877c; }
.booting-splash .b-logo { width: 40px; height: 40px; border-radius: 10px; background: #0f6e56; color: #f3f1ea; font-style: normal; font-size: 22px; display: inline-flex; align-items: center; justify-content: center; }
.booting-splash span { font-size: 13px; }
/* 全局 toast：所有视图共用（原挂在 SidebarPanel 内，图书视图外不可见） */
.toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); background: #2c2c2a; color: #fff; font-size: 12px; padding: 7px 14px; border-radius: 7px; z-index: 300; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
</style>
