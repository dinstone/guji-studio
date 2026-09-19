<script setup lang="ts">
import { view, openWelcome, openAbout } from '../stores/app'

const appVersion = __APP_VERSION__

const RAILS: [string, string, string][] = [
  ['book', '书', '图书创作'],
  ['layout', '版', '版式设计'],
  ['cover', '封', '封装设计'],
  ['pub', '出', '出版发行'],
]
function pick(id: string) {
  if (id === 'book' && view.rail === 'book') {
    view.sidebar = view.sidebar ? 0 : 1      // 已在图书视图：折叠/展开项目面板
    return
  }
  view.rail = id
}
</script>

<template>
  <aside class="rail">
    <!-- 点 logo 呼出欢迎页：新建 / 打开 / 切换图书项目 -->
    <img class="logo" src="/appicon.png" alt="Guji Studio" title="图书项目 · 新建 / 打开 / 切换" @click="openWelcome" />
    <span class="ver" title="当前版本">v{{ appVersion }}</span>
    <div class="grp">
      <div
        v-for="[id, lb, tip] in RAILS" :key="id"
        class="item" :class="{ on: view.rail === id }"
        :title="tip"
        @click="pick(id)"
      >{{ lb }}</div>
    </div>
    <div class="sp" />
    <div class="item sponsor" title="关于 / 赞助" @click="openAbout">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
        <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
      </svg>
    </div>
  </aside>
</template>

<style scoped>
/* 参照 mdx：浅色系统栏，顶部 logo，图标组留白舒适，底部工具 */
.rail { width: 56px; background: #f5f4ef; border-right: 0.5px solid #d9d7cd; display: flex; flex-direction: column; align-items: center; padding: 12px 0 14px; }
.logo { width: 34px; height: 34px; border-radius: 9px; object-fit: cover; display: block; cursor: pointer; user-select: none; transition: box-shadow .15s; }
.logo:hover { box-shadow: 0 0 0 2px #0f6e56; }
/* 版本号：仿 mdx，logo 正下方一行小字，弱化显示 */
.ver { font-size: 9px; line-height: 1.2; color: #9a988f; opacity: .85; margin-top: 4px; margin-bottom: 14px; user-select: none; letter-spacing: .02em; }
.grp { margin-top: 0; display: flex; flex-direction: column; gap: 16px; }
.item { width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 14px; color: #6f6e68; cursor: pointer; user-select: none; transition: background 0.15s, color 0.15s; }
.item:hover { background: #e9e7df; }
.item.on { background: #0f6e56; color: #ffffff; }
/* 赞助入口：实心红底白心，经典「喜欢/赞助」语义色，醒目且与绿色导航项区分 */
.item.sponsor { background: #e0404f; color: #fff; box-shadow: 0 0 0 1px rgba(224,64,79,.35); }
.item.sponsor:hover { background: #c83342; box-shadow: 0 0 0 1px rgba(224,64,79,.55); }
.item.todo { opacity: 0.4; cursor: not-allowed; }
.item.todo:hover { background: none; }
.sp { flex: 1; }
</style>
