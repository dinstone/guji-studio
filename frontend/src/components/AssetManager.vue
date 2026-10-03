<script setup lang="ts">
/**
 * AssetManager — 图书项目素材（assets/）管理浮层
 *
 * 参考 mdx apps/web MediaManager：按「正常引用 / 孤立」分组，显示缩略图、大小、
 * 单条删除、批量清理孤立。删除走后端 moveToTrash（进 trash/ 可找回），不直接 rm。
 */
import { computed, onMounted, ref } from 'vue'
import { useProjectAssets, type AssetItem } from '../composables/useProjectAssets'
import { projectDir, toast } from '../stores/app'

const emit = defineEmits<{ close: [] }>()

const { items, loading, error, lastScanMs, scan, deleteAsset, cleanupOrphans } = useProjectAssets()

const search = ref('')
const q = computed(() => search.value.trim().toLowerCase())
function matchName(it: AssetItem): boolean {
  return !q.value || it.name.toLowerCase().includes(q.value)
}

const referenced = computed(() => items.value.filter((it) => !it.isOrphan && matchName(it)))
const orphan = computed(() => items.value.filter((it) => it.isOrphan && matchName(it)))

const totalSize = computed(() => items.value.reduce((s, it) => s + (it.size || 0), 0))
const assetDir = computed(() => (projectDir.value ? projectDir.value.replace(/\/+$/, '') + '/assets' : ''))

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

async function onDelete(it: AssetItem) {
  try {
    await deleteAsset(it.name)
    toast(`已删除 ${it.name}（移入 trash/，可找回）`)
  } catch (e: any) {
    toast('删除失败：' + (e?.message || e))
  }
}

async function onCleanup() {
  const n = orphan.value.length
  if (n === 0) return
  try {
    const moved = await cleanupOrphans()
    toast(`已清理 ${moved.length} 个孤立素材（移入 trash/，可找回）`)
  } catch (e: any) {
    toast('清理失败：' + (e?.message || e))
  }
}

onMounted(() => scan())
</script>

<template>
  <Teleport to="body">
    <div class="am-overlay" @click.self="emit('close')">
      <div class="am-panel">
        <header class="am-header">
          <h3>素材管理</h3>
          <div class="am-actions">
            <button class="am-btn" :disabled="loading" @click="scan">↻ 刷新</button>
            <button class="am-btn am-close" @click="emit('close')">✕</button>
          </div>
        </header>

        <div class="am-pathrow">
          <span class="am-pathlabel">存储</span>
          <code class="am-path" :title="assetDir">{{ assetDir || '未打开项目' }}</code>
        </div>

        <div class="am-toolbar">
          <input v-model="search" class="am-search" type="text" placeholder="搜索文件名…" />
          <span class="am-summary">
            共 {{ items.length }} 个 · {{ formatSize(totalSize) }} · 扫描 {{ lastScanMs }} ms
          </span>
        </div>

        <div v-if="error" class="am-error">扫描出错：{{ error }}</div>

        <div class="am-body">
          <div v-if="!loading && items.length === 0" class="am-empty">当前项目没有已导入的图片素材。</div>

          <section v-if="referenced.length" class="am-group">
            <div class="am-gtitle">✓ 正常引用 ({{ referenced.length }}) · 被本书配置使用</div>
            <div class="am-grid">
              <div v-for="it in referenced" :key="it.name" class="am-card">
                <img v-if="it.url" :src="it.url" class="am-thumb" alt="" />
                <div v-else class="am-thumb am-thumb--broken">?</div>
                <div class="am-info">
                  <div class="am-name" :title="it.name">{{ it.name }}</div>
                  <div class="am-sub">{{ formatSize(it.size) }}</div>
                </div>
                <button class="am-del" title="删除" @click="onDelete(it)">🗑</button>
              </div>
            </div>
          </section>

          <section v-if="orphan.length" class="am-group am-group--warn">
            <div class="am-gtitle">
              ⚠ 孤立素材 ({{ orphan.length }}) · 没有任何配置引用
              <button class="am-btn am-btn--danger" @click="onCleanup">一键清理孤立</button>
            </div>
            <div class="am-grid">
              <div v-for="it in orphan" :key="it.name" class="am-card am-card--orphan">
                <img v-if="it.url" :src="it.url" class="am-thumb" alt="" />
                <div v-else class="am-thumb am-thumb--broken">?</div>
                <div class="am-info">
                  <div class="am-name" :title="it.name">{{ it.name }}</div>
                  <div class="am-sub am-sub--warn">孤立 · 可安全删除</div>
                  <div class="am-sub">{{ formatSize(it.size) }}</div>
                </div>
                <button class="am-del" title="删除" @click="onDelete(it)">🗑</button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.am-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 24px;
  box-sizing: border-box;
}
.am-panel {
  width: 100%;
  max-width: 760px;
  max-height: 84vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary, #fff);
  border: 1px solid var(--border-light, #e5e5e5);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  overflow: hidden;
  color: var(--text-primary, #1a1a1a);
}
.am-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-light, #eee);
}
.am-header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.am-actions {
  display: flex;
  gap: 8px;
}
.am-btn {
  border: 1px solid var(--border-light, #ddd);
  background: transparent;
  color: var(--text-primary, #1a1a1a);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.am-btn:hover {
  background: var(--bg-hover, #f2f2f2);
}
.am-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.am-close {
  font-size: 14px;
  line-height: 1;
}
.am-pathrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border-light, #eee);
  background: var(--bg-secondary, #fafafa);
}
.am-pathlabel {
  flex: none;
  width: 44px;
  font-size: 11px;
  color: var(--text-secondary, #888);
}
.am-path {
  flex: 1;
  min-width: 0;
  font-family: ui-monospace, monospace;
  font-size: 11.5px;
  color: var(--text-primary, #333);
  background: var(--bg-primary, #fff);
  border: 1px solid var(--border-light, #eee);
  border-radius: 6px;
  padding: 3px 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border-light, #eee);
}
.am-search {
  flex: 0 0 220px;
  border: 1px solid var(--border-light, #ddd);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  background: var(--bg-secondary, #fff);
  color: var(--text-primary, #1a1a1a);
  outline: none;
}
.am-search:focus {
  border-color: #0f6e56;
}
.am-summary {
  font-size: 12px;
  color: var(--text-secondary, #888);
  margin-left: auto;
}
.am-error {
  margin: 12px 18px 0;
  padding: 8px 12px;
  background: rgba(214, 69, 69, 0.1);
  color: #d64545;
  border-radius: 8px;
  font-size: 13px;
}
.am-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px 20px;
}
.am-empty {
  text-align: center;
  color: var(--text-secondary, #999);
  font-size: 13px;
  padding: 40px 0;
}
.am-group {
  margin-bottom: 18px;
}
.am-gtitle {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #555);
  margin-bottom: 10px;
  display: flex;
  align-items: center;
}
.am-group--warn .am-gtitle {
  color: #d64545;
}
.am-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.am-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--border-light, #eee);
  border-radius: 10px;
  background: var(--bg-page, #fff);
  position: relative;
}
.am-card--orphan {
  border-color: rgba(214, 69, 69, 0.3);
  background: rgba(214, 69, 69, 0.03);
}
.am-thumb {
  width: 46px;
  height: 46px;
  border-radius: 8px;
  object-fit: cover;
  flex: 0 0 46px;
  background: var(--bg-hover, #f2f2f2);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  color: var(--text-secondary, #888);
}
.am-thumb--broken {
  color: var(--text-tertiary, #bbb);
}
.am-info {
  min-width: 0;
  flex: 1;
}
.am-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #1a1a1a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.am-sub {
  font-size: 11px;
  color: var(--text-secondary, #888);
  margin-top: 2px;
}
.am-sub--warn {
  color: #d64545;
}
.am-btn--danger {
  border-color: rgba(214, 69, 69, 0.4);
  color: #d64545;
  margin-left: 12px;
}
.am-btn--danger:hover {
  background: rgba(214, 69, 69, 0.1);
}
.am-del {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
  opacity: 0.5;
  padding: 4px;
  border-radius: 6px;
  transition: all 0.15s ease;
}
.am-del:hover {
  opacity: 1;
  background: rgba(214, 69, 69, 0.12);
}
</style>
