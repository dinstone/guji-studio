<script setup lang="ts">
/* 项目信息对话框：编辑项目名称 / 图书名称 / 作者。
 * 直接绑定响应式 proj，由 stores/app 的 watch(proj,{deep}) 标脏 → 3s 自动落盘到 book.gvs。
 * 关闭时 closeProjectInfo 会刷新最近项目列表中的名称。 */
import { proj, closeProjectInfo } from '../stores/app'
</script>

<template>
  <div class="pi-mask" @click.self="closeProjectInfo">
    <div class="pi">
      <div class="pi-head">
        <h2>项目信息</h2>
        <button class="pi-x" @click="closeProjectInfo" title="关闭">✕</button>
      </div>
      <div class="pi-body">
        <label class="pi-field">
          <span class="pi-lab">项目名称</span>
          <input v-model="proj.name" class="pi-in" placeholder="未命名项目">
          <em class="pi-hint">用于「最近项目」列表与窗口标题；仅改内存名，不改磁盘目录名</em>
        </label>
        <label class="pi-field">
          <span class="pi-lab">图书名称</span>
          <input v-model="proj.meta.title" class="pi-in" placeholder="写入版心书名">
          <em class="pi-hint">留空则使用项目名称；封面/扉页默认沿用此名</em>
        </label>
        <label class="pi-field">
          <span class="pi-lab">作者</span>
          <input v-model="proj.meta.author" class="pi-in" placeholder="作者署名（可留空）">
          <em class="pi-hint">封面/扉页默认沿用此署名</em>
        </label>
      </div>
      <div class="pi-foot">
        <span class="pi-sp" />
        <button class="pi-btn primary" @click="closeProjectInfo">完成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pi-mask {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(40, 37, 30, .32);
  display: flex; align-items: center; justify-content: center;
}
.pi {
  width: 440px; max-width: 92vw; background: #fffdf8; border: 0.5px solid #e2dfd4;
  border-radius: 16px; padding: 22px 24px 18px; box-shadow: 0 18px 54px rgba(40,34,24,.30);
}
.pi-head { display: flex; align-items: center; justify-content: space-between; }
.pi-head h2 { margin: 0; font-size: 17px; color: #2c2c2a; }
.pi-x { width: 26px; height: 26px; border: 0; background: none; color: #9a978c; font-size: 14px; cursor: pointer; border-radius: 6px; }
.pi-x:hover { background: #f1efe8; color: #2c2c2a; }
.pi-body { display: flex; flex-direction: column; gap: 14px; margin: 18px 0 16px; }
.pi-field { display: flex; flex-direction: column; gap: 5px; }
.pi-lab { font-size: 12px; color: #6f6c63; }
.pi-in {
  border: 0.5px solid #d3d1c7; border-radius: 6px; padding: 8px 10px; font-size: 13px;
  background: #fff; color: #2c2c2a; outline: none; width: 100%;
}
.pi-in:focus { border-color: #0f6e56; box-shadow: 0 0 0 1px rgba(15,110,86,.15); }
.pi-hint { font-style: normal; font-size: 11px; color: #a7a399; }
.pi-foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.pi-sp { flex: 1; }
.pi-btn {
  border: 0.5px solid #d3d1c7; background: #faf8f2; border-radius: 7px;
  padding: 8px 18px; font-size: 13px; color: #2c2c2a; cursor: pointer;
}
.pi-btn.primary { background: #0f6e56; border-color: #0f6e56; color: #fff; }
.pi-btn.primary:hover { background: #0c5e49; }
</style>
