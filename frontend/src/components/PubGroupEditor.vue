<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { type PubGroup } from '../stores/app'

const props = defineProps<{
  groups: PubGroup[]
  packItems: string[]
  guideItems: string[]
  appendixItems: string[]
}>()
const emit = defineEmits<{ (e: 'update:groups', v: PubGroup[]): void }>()

type Cat = 'pack' | 'guide' | 'appendix'
const CATS: { key: Cat; label: string }[] = [
  { key: 'pack', label: '包装叶' },
  { key: 'guide', label: '导读' },
  { key: 'appendix', label: '附录' },
]
const CAT_ORDER: Cat[] = ['pack', 'guide', 'appendix']
const catLabel = (c: Cat) => CATS.find(x => x.key === c)!.label
function itemsOf(key: Cat): string[] {
  return key === 'pack' ? props.packItems : key === 'guide' ? props.guideItems : props.appendixItems
}

/** 把 PubGroup[] 展平成有序条目（每段内 pack→guide→appendix，段间按数组顺序）——即最终装订顺序 */
function entriesOf(groups: PubGroup[]): { cat: Cat; name: string }[] {
  const out: { cat: Cat; name: string }[] = []
  for (const g of groups) {
    for (const cat of CAT_ORDER) {
      const raw = (g as any)[cat] as string | string[] | undefined
      if (!raw) continue
      // 兼容旧磁盘格式（字段为 string[]）：展开为多个单条目
      const names = Array.isArray(raw) ? raw : [raw]
      for (const n of names) if (n) out.push({ cat, name: n })
    }
  }
  return out
}
const entries = computed(() => entriesOf(props.groups))
/** 把扁平条目重建为 PubGroup[]（每条目一个单成员组，导出侧按组顺序依次拼装，零改动） */
function rebuild(list: { cat: Cat; name: string }[]): PubGroup[] {
  return list.map(e => ({ [e.cat]: e.name } as PubGroup))
}

function addEntry(cat: Cat, name: string) {
  if (!name) return
  emit('update:groups', rebuild([...entries.value, { cat, name }]))
}
function removeAt(i: number) {
  const l = entries.value.slice(); l.splice(i, 1); emit('update:groups', rebuild(l))
}
function moveAt(i: number, d: number) {
  const j = i + d
  if (j < 0 || j >= entries.value.length) return
  const l = entries.value.slice(); [l[i], l[j]] = [l[j], l[i]]; emit('update:groups', rebuild(l))
}

/* 添加器：类别 + 内容 两个联动下拉 */
const selCat = ref<Cat>('pack')
const selName = ref<string>('')
watch(selCat, () => { selName.value = '' })
function onAdd() { addEntry(selCat.value, selName.value) }
</script>

<template>
  <div class="grp-editor">
    <ol class="ents">
      <li v-for="(e, i) in entries" :key="i" class="ent">
        <span class="badge" :class="e.cat">{{ catLabel(e.cat) }}</span>
        <span class="nm">{{ e.name }}</span>
        <span class="acts">
          <button @click="moveAt(i, -1)" :disabled="i === 0" title="上移">↑</button>
          <button @click="moveAt(i, 1)" :disabled="i === entries.length - 1" title="下移">↓</button>
          <button class="x" @click="removeAt(i)" title="移除">×</button>
        </span>
      </li>
    </ol>
    <div v-if="!entries.length" class="hint">从下方选择「类别 + 内容」后点「添加」，加入的条目按此处顺序装订（可上下调序）。</div>

    <div class="adder">
      <select v-model="selCat" class="sel">
        <option v-for="c in CATS" :key="c.key" :value="c.key">{{ c.label }}</option>
      </select>
      <select v-model="selName" class="sel">
        <option v-for="n in itemsOf(selCat)" :key="n" :value="n">{{ n }}</option>
      </select>
      <button class="add" @click="onAdd" :disabled="!selName">＋ 添加</button>
      <span v-if="!itemsOf(selCat).length" class="noopt">该类别暂无可选项（去对应视图先建立）</span>
    </div>
  </div>
</template>

<style scoped>
.grp-editor { display: flex; flex-direction: column; gap: 8px; }
.ents { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.ent { display: flex; align-items: center; gap: 8px; background: #fff; border: 0.5px solid #e3e1d8; border-radius: 6px; padding: 5px 8px; }
.badge { font-size: 11px; padding: 1px 7px; border-radius: 10px; flex: none; }
.badge.pack { background: #e1f5ee; color: #0c4a3a; }
.badge.guide { background: #fbf2dc; color: #8a6d1c; }
.badge.appendix { background: #ecebe6; color: #6b6a63; }
.nm { flex: 1; font-size: 13px; color: #2c2c2a; }
.acts button { border: 0.5px solid #d9d7cd; background: #faf9f6; width: 22px; height: 20px; border-radius: 5px; cursor: pointer; color: #5f5e5a; font-size: 12px; }
.acts button:disabled { opacity: 0.35; cursor: default; }
.acts button.x { color: #b4452f; }
.hint { font-size: 11px; color: #888780; line-height: 1.6; background: #fff; border: 0.5px dashed #e3e1d8; border-radius: 6px; padding: 6px 8px; }
.adder { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sel { border: 0.5px solid #d3d1c7; background: #fff; border-radius: 6px; padding: 4px 6px; font-size: 12px; color: #2c2c2a; }
.add { border: 0.5px solid #0f6e56; background: #0f6e56; color: #e1f5ee; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.add:disabled { opacity: 0.4; cursor: default; }
.noopt { font-size: 11px; color: #b4452f; }
</style>
