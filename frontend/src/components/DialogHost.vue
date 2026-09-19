<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { dialog, dialogOk, dialogCancel } from '../stores/dialog'

const inputEl = ref<HTMLInputElement | null>(null)

/* prompt 弹出时聚焦并全选默认值 */
watch(dialog, async d => {
  if (d?.kind === 'prompt') {
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  }
}, { immediate: true })

function onKey(e: KeyboardEvent) {
  if (!dialog.value) return
  if (e.key === 'Enter') { e.preventDefault(); dialogOk() }
  else if (e.key === 'Escape') { e.preventDefault(); dialogCancel() }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div v-if="dialog" class="dlg-mask" @click.self="dialogCancel">
    <div class="dlg">
      <div class="msg">{{ dialog.message }}</div>
      <input
        v-if="dialog.kind === 'prompt'"
        ref="inputEl" v-model="dialog.value" class="inp"
        @keydown.enter.prevent="dialogOk"
      />
      <div class="btns">
        <button v-if="dialog.kind !== 'alert'" class="btn" @click="dialogCancel">取消</button>
        <button class="btn primary" @click="dialogOk">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dlg-mask {
  /* 需盖在欢迎页浮层（z-index 100）之上：切换项目时的确认/输入弹窗必须可见 */
  position: fixed; inset: 0; z-index: 200;
  background: rgba(44, 44, 42, .30);
  display: flex; align-items: center; justify-content: center;
}
.dlg {
  width: 340px; max-width: 90vw; background: #fffdf8;
  border: 0.5px solid #e2dfd4; border-radius: 12px;
  padding: 20px 20px 16px; box-shadow: 0 12px 40px rgba(60,52,36,.22);
}
.msg { font-size: 13px; color: #2c2c2a; line-height: 1.5; margin-bottom: 14px; }
.inp {
  width: 100%; box-sizing: border-box;
  border: 0.5px solid #d3d1c7; border-radius: 7px;
  padding: 7px 10px; font-size: 13px; color: #2c2c2a; background: #fff;
  outline: none; margin-bottom: 14px;
}
.inp:focus { border-color: #0f6e56; box-shadow: 0 0 0 2px rgba(15,110,86,.14); }
.btns { display: flex; justify-content: flex-end; gap: 8px; }
.btn {
  border: 0.5px solid #d3d1c7; background: #faf8f2; color: #444;
  border-radius: 7px; padding: 6px 16px; font-size: 13px; cursor: pointer;
}
.btn:hover { border-color: #0f6e56; color: #0f6e56; }
.btn.primary { background: #0f6e56; border-color: #0f6e56; color: #fff; }
.btn.primary:hover { background: #0c5e49; color: #fff; }
</style>
