<script setup lang="ts">
import {
  editorStatus, previewLayout, saveState, saveLabel, bookCharCount,
  editorFontSize, setEditorFontSize, ED_FS_MIN, ED_FS_MAX, ED_FS_DEFAULT,
} from '../stores/app'
import { groupNum } from '../core/textstat'
</script>

<template>
  <footer class="sb">
    <div class="col editor">
      <div class="row">
        <span title="全书字数：不含目录等派生内容">全书 <b>{{ groupNum(bookCharCount) }}</b></span>
        <span class="dot">·</span>
        <span title="本章字数：不计空白与排版标记（# @ % $ ^ 与成对括号）">
          字数 <b>{{ groupNum(editorStatus.chars) }}</b>
        </span>
        <span class="dot">·</span>
        <span>行 <b>{{ editorStatus.lines }}</b></span>
        <span class="dot">·</span>
        <span class="fs">
          <button
            :disabled="editorFontSize <= ED_FS_MIN" title="缩小字号"
            @click="setEditorFontSize(editorFontSize - 1)"
          >A−</button>
          <button class="fsval" title="点击复位为默认字号" @click="setEditorFontSize(ED_FS_DEFAULT)">{{ editorFontSize }}px</button>
          <button
            :disabled="editorFontSize >= ED_FS_MAX" title="放大字号"
            @click="setEditorFontSize(editorFontSize + 1)"
          >A+</button>
          <span class="dot">·</span>
          <span title="光标所在行 / 列">Ln <b>{{ editorStatus.line }}</b> · Col <b>{{ editorStatus.col }}</b></span>
        </span>
      </div>
      <div class="row">
        <span v-if="saveLabel" class="savestate" :class="saveState">{{ saveLabel }}</span>
        <span v-else class="savestate muted">未打开项目</span>
      </div>
    </div>
    <div class="col preview">
      <div class="row">
        <span>内容区 <b>{{ previewLayout.contentW }}<small>×</small>{{ previewLayout.contentH }}</b></span>
        <span class="dot">·</span>
        <span>中缝 <b>{{ previewLayout.gutter }}</b></span>
        <span class="dot">·</span>
        <span>每半叶 <b>{{ previewLayout.cols }} 列 × {{ previewLayout.rows }} 字</b></span>
        <span class="dot">·</span>
        <span>列宽 <b>{{ previewLayout.colW }}</b></span>
        <span class="dot">·</span>
        <span>行高 <b>{{ previewLayout.rowH }}</b></span>
        <span class="dot">·</span>
        <span>字格 <b>{{ previewLayout.cellH }}</b></span>
      </div>
      <div class="row">
        <span>正文 <b>{{ previewLayout.textFamily }} {{ previewLayout.textSize }}</b></span>
        <span class="dot">·</span>
        <span>夹注 <b>{{ previewLayout.commentFamily }} {{ previewLayout.commentSize }}</b></span>
        <span class="dot">·</span>
        <span>强调 <b>{{ previewLayout.accentFamily }} {{ previewLayout.accentSize }}</b></span>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.sb {
  flex: none; height: 44px;
  display: flex; align-items: stretch;
  padding: 4px 10px;
  background: #fff; border-top: 0.5px solid #d3d1c7;
  font-size: 11.5px; color: #5f5e5a;
}
.col { display: flex; flex-direction: column; justify-content: center; gap: 2px; min-width: 0; }
.col.editor { flex: none; min-width: 320px; max-width: 46%; }
.col.preview { flex: 1; min-width: 0; }
.row { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.editor .row { justify-content: flex-start; }
.preview .row { justify-content: flex-end; }
.dot { color: #d3d1c7; user-select: none; }
b { font-weight: 600; color: #3b3a35; font-variant-numeric: tabular-nums; }
small { font-weight: 400; color: #9a988f; margin: 0 1px; }
.savestate { white-space: nowrap; }
.savestate.saved { color: #0f6e56; }
.savestate.dirty { color: #b07d1a; }
.savestate.error { color: #b3261e; }
.savestate.muted { color: #888780; }
.fs { display: inline-flex; align-items: center; gap: 2px; }
.fs button { border: 0.5px solid #d3d1c7; background: #faf9f6; border-radius: 4px; font-size: 11px; padding: 1px 6px; cursor: pointer; color: #5f5e5a; }
.fs button:hover:not(:disabled) { border-color: #0f6e56; color: #0f6e56; }
.fs button:disabled { opacity: .4; cursor: not-allowed; }
.fs .fsval { min-width: 42px; text-align: center; font-variant-numeric: tabular-nums; }
</style>
