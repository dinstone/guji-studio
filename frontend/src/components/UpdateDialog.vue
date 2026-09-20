<script setup lang="ts">
import { ref } from 'vue'
import { updateResult, closeUpdate, toast } from '../stores/app'
import { installUpdate } from '../platform/update'
import { openExternal } from '../platform/wails'

const version = __APP_VERSION__
const installing = ref(false)

async function doUpdate() {
  installing.value = true
  // 点击下载后立即关闭提示框：更新在后台进行，下载完成后 wails 自动重启应用
  closeUpdate()
  try {
    // CheckAndInstall 下载安装后会自动重启应用，通常不再返回
    await installUpdate()
  } catch (e: any) {
    toast('更新失败：' + (e?.message || e))
  }
}

function openRelease() {
  const u = updateResult.value?.url
  if (u) openExternal(u)
}
</script>

<template>
  <div class="ud-mask" @click.self="!installing && closeUpdate()">
    <div class="ud">
      <div class="ud-head">
        <div class="ud-icon">↑</div>
        <div class="ud-titles">
          <h2>发现新版本</h2>
          <p class="ud-sub">v{{ version }} → v{{ updateResult?.version }}</p>
        </div>
        <button class="ud-x" @click="closeUpdate" :disabled="installing" title="稍后">✕</button>
      </div>

      <div class="ud-body">
        <p v-if="updateResult?.name" class="ud-name">{{ updateResult.name }}</p>
        <pre v-if="updateResult?.notes" class="ud-notes">{{ updateResult.notes }}</pre>
        <p v-else class="ud-notes empty">（无更新说明）</p>

        <!-- 微信赞赏码：更新触点常驻曝光，用户无需点击即可扫码赞助 -->
        <div class="ud-wx-wrap">
          <img class="ud-wx" src="/wxsponor.jpg" alt="微信赞赏码" />
          <p class="ud-wx-tip">如果这个工具帮到了你，更新之余不妨请作者喝杯茶 ☕</p>
        </div>
      </div>

      <div class="ud-foot">
        <button class="ud-btn ghost" @click="openRelease" v-if="updateResult?.url">查看发布页</button>
        <span class="ud-sp" />
        <button class="ud-btn ghost" @click="closeUpdate" :disabled="installing">稍后</button>
        <button class="ud-btn primary" @click="doUpdate" :disabled="installing">
          {{ installing ? '正在下载安装…' : '立即更新' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ud-mask {
  position: fixed; inset: 0; z-index: 210;
  background: rgba(40, 37, 30, .32);
  display: flex; align-items: center; justify-content: center;
}
.ud {
  width: 460px; max-width: 92vw; max-height: 86vh; display: flex; flex-direction: column;
  background: #fffdf8; border: 0.5px solid #e2dfd4; border-radius: 16px;
  padding: 20px 22px 16px; box-shadow: 0 18px 54px rgba(40,34,24,.30);
}
.ud-head { display: flex; align-items: center; gap: 12px; }
.ud-icon {
  width: 38px; height: 38px; border-radius: 10px; flex: none;
  background: #0f6e56; color: #f3f1ea; font-size: 20px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}
.ud-titles { flex: 1; min-width: 0; }
.ud-head h2 { margin: 0; font-size: 17px; color: #2c2c2a; }
.ud-sub { margin: 2px 0 0; font-size: 12px; color: #0f6e56; }
.ud-x { width: 26px; height: 26px; border: 0; background: none; color: #9a978c; font-size: 14px; cursor: pointer; border-radius: 6px; }
.ud-x:hover:not(:disabled) { background: #f1efe8; color: #2c2c2a; }
.ud-x:disabled { opacity: .4; cursor: default; }

.ud-body { overflow: auto; flex: 1; margin-top: 14px; }
.ud-name { font-size: 13px; font-weight: 600; color: #2c2c2a; margin: 0 0 8px; }
.ud-notes {
  font-size: 12px; line-height: 1.6; color: #4a4843; white-space: pre-wrap; word-break: break-word;
  background: #f7f5ef; border-radius: 9px; padding: 10px 12px; margin: 0 0 14px; max-height: 180px; overflow: auto;
}
.ud-notes.empty { color: #a7a399; text-align: center; }

.ud-wx-wrap { display: flex; flex-direction: column; align-items: center; margin-top: 4px; }
.ud-wx { display: block; width: 168px; border-radius: 8px; border: 0.5px solid #e2dfd4; }
.ud-wx-tip { font-size: 11px; color: #a7a399; margin: 8px 0 0; text-align: center; }

.ud-foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.ud-sp { flex: 1; }
.ud-btn { border: 0.5px solid #d3d1c7; background: #faf8f2; border-radius: 7px; padding: 8px 16px; font-size: 13px; color: #2c2c2a; cursor: pointer; }
.ud-btn:hover:not(:disabled) { border-color: #0f6e56; color: #0f6e56; }
.ud-btn:disabled { opacity: .5; cursor: default; }
.ud-btn.primary { background: #0f6e56; color: #fff; border-color: #0f6e56; }
.ud-btn.primary:hover:not(:disabled) { background: #0c5a46; color: #fff; }
</style>
