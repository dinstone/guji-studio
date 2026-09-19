<script setup lang="ts">
import { reactive } from 'vue'
import {
  proj, cur, selectUnit, selectChapter, selectLeaf, selectFolder,
  openUnitTemplate,
  importFilesToVolume,
  unitOverrideInfo, isTocUnit, isTocDerived, TOC_TPL, type Folder, type Block,
} from '../stores/app'
import { appPrompt, appConfirm, appAlert } from '../stores/dialog'

const FOLDERS: { key: Folder; label: string }[] = [
  { key: 'guide', label: '导读' },
  { key: 'scrolls', label: '正文' },
  { key: 'appendix', label: '附录' },
]
/* 自动保存状态指示（仅已打开真实项目时显示）；文案在 store 里与编辑器状态栏共用 */

function unitsOf(f: Folder) {
  if (f === 'guide') return proj.tree.guide
  if (f === 'scrolls') return proj.tree.scrolls
  return proj.tree.appendix
}

/* 卷行展开状态：默认展开；按 unit id 记忆 */
const expanded = reactive<Record<string, boolean>>({})
function isExpanded(u: any) { return expanded[u.id] ?? true }
function toggleExpand(u: any, e?: Event) {
  e?.stopPropagation()
  expanded[u.id] = !isExpanded(u)
}

/* ---- 单元（卷/导读/附录）增删改 ---- */
async function addVol() {
  const name = await appPrompt('卷名', '新卷')
  if (name === null) return
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  proj.tree.scrolls.push({ id, name: name || '未命名', chapters: [] })
  selectUnit('scrolls', proj.tree.scrolls.length - 1, 0)
}
function renUnit(f: Folder, ui: number) {
  const u = unitsOf(f)[ui]; if (!u) return
  appPrompt('名称', u.name).then(t => {
    if (t === null) return
    u.name = t || u.name
    /* 导读/附录 = 单文件单元：重命名单元时同步唯一章的标题（落盘文件名随之派生） */
    if (f !== 'scrolls' && u.chapters.length === 1) u.chapters[0].title = u.name
  })
}
async function delUnit(f: Folder, ui: number) {
  const arr = unitsOf(f); const u = arr[ui]; if (!u) return
  const n = u.chapters.length
  const msg = n > 1 ? `删除「${u.name}」及其 ${n} 个章节？` : `删除「${u.name}」？`
  if (!(await appConfirm(msg))) return
  arr.splice(ui, 1)
  if (cur.folder === f && cur.ui >= arr.length) selectFolder(f)
}

/* ---- 章节增删改 ---- */
/** 正文下直接加章：放入「默认卷」（name='' 的卷，树上扁平显示、不渲染卷行）；无则懒建，恒排其它卷之前 */
async function addDefaultChap() {
  let vi = proj.tree.scrolls.findIndex(v => !v.name)
  if (vi < 0) {
    proj.tree.scrolls.unshift({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name: '', chapters: [] })
    vi = 0
  }
  const v = proj.tree.scrolls[vi]
  const title = await appPrompt('章节标题', '新章节'); if (title === null) return
  v.chapters.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: title || '未命名', file: (title || '未命名') + '.txt', text: '' })
  selectChapter('scrolls', vi, v.chapters.length - 1)
}
async function addChap(f: Folder, ui: number) {
  const u = unitsOf(f)[ui]; if (!u) return
  const title = await appPrompt('章节标题', '新章节'); if (title === null) return
  u.chapters.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: title || '未命名', file: (title || '未命名') + '.txt', text: '' })
  selectChapter(f, ui, u.chapters.length - 1)
}
function renChap(f: Folder, ui: number, ci: number) {
  const u = unitsOf(f)[ui]; const c = u?.chapters[ci]; if (!c) return
  appPrompt('章节标题', c.title).then(t => { if (t !== null) c.title = t || c.title })
}
async function delChap(f: Folder, ui: number, ci: number) {
  const arr = unitsOf(f); const u = arr[ui]; if (!u) return
  const c = u.chapters[ci]; if (!c) return
  if (!(await appConfirm(`删除章节「${c.title}」？`))) return
  u.chapters.splice(ci, 1)
  /* 空的默认卷（无章无版式覆盖）随手清理，避免树上残留不可见单元 */
  if (f === 'scrolls' && !u.name && !u.chapters.length && !unitOverrideInfo(u).total) {
    arr.splice(ui, 1)
    if (cur.folder === f) selectFolder(f)
    return
  }
  if (cur.folder === f && cur.ui === ui) selectChapter(f, ui, Math.min(cur.ci, u.chapters.length - 1))
}

/* 导读/附录为固定角色单元（单文件）：导读 = 序 + 目录，附录 = 跋 + 牌记，各至多一个（已存在则不显示添加钮）。
 * 除派生的目录外，单元自带唯一一个章文件；不可再添加章。 */
const FIXED_UNITS: Record<string, { name: string; derived?: boolean; first?: boolean }> = {
  preface: { name: '序', first: true },      // 导读·序：插最前（目录之前）
  toc: { name: '目录', derived: true },      // 导读·目录：派生单元，由正文结构生成，无手编文件
  postscript: { name: '跋', first: true },   // 附录·跋：插最前（牌记之前）
  imprint: { name: '牌记' },                 // 附录·牌记：排最后
}
function hasUnitType(f: Folder, t: string) {
  return unitsOf(f).some((u: any) => u?.type === t)
}

/** 卷行可见性：正文 = 命名卷/有版式覆盖的默认卷；导读/附录一律不渲染单元行（目录也是文件行，
 *  与序完全一致，仅派生属性不可编辑内容）；空单元兜底显示可删 */
function showUnitRow(f: Folder, u: any): boolean {
  if (f === 'scrolls') return !!u.name || unitOverrideInfo(u).total > 0
  return !u.chapters.length && !isTocUnit(u)
}
async function addFixedUnit(f: Folder, type: string) {
  const s = FIXED_UNITS[type]; if (!s) return
  const arr = f === 'guide' ? proj.tree.guide : proj.tree.appendix
  const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  const u: Block = { id, name: s.name, type, chapters: [] }
  if (s.derived) {
    u.derived = true
    // 派生目录默认套用目录专用版式（版心放宽 / 标题加大 / 行距宽松），走「本单元」覆盖，可在 Inspector 微调
    if (Object.keys(TOC_TPL).length) u.template = { ...TOC_TPL }
  } else {
    // 单文件单元：自带唯一章（文件名随单元名派生）
    u.chapters.push({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: s.name, file: s.name + '.txt', text: '' })
  }
  if (s.first) arr.unshift(u); else arr.push(u)
  selectUnit(f, s.first ? 0 : arr.length - 1, 0)
}

</script>

<template>
  <aside class="side">
    <div class="tree">
      <!-- 导读 / 卷文 / 附录 -->
      <template v-for="f in FOLDERS" :key="f.key">
        <div class="fhdr">
          {{ f.label }}
          <span class="adds">
            <!-- 正文：＋章（入默认卷） / ＋卷 -->
            <template v-if="f.key === 'scrolls'">
              <button class="add" title="新增章（放入默认卷）" @click="addDefaultChap">＋ 章</button>
              <button class="add" title="新增卷目录" @click="addVol">＋ 卷</button>
            </template>
            <!-- 导读：至多 序 + 目录，已存在则不显示 -->
            <template v-else-if="f.key === 'guide'">
              <button v-if="!hasUnitType('guide', 'preface')" class="add" title="新增序" @click="addFixedUnit('guide', 'preface')">＋ 序</button>
              <button v-if="!hasUnitType('guide', 'toc')" class="add" title="新增目录（由正文结构派生的两级目录）" @click="addFixedUnit('guide', 'toc')">＋ 目录</button>
            </template>
            <!-- 附录：至多 跋 + 牌记，已存在则不显示 -->
            <template v-else>
              <button v-if="!hasUnitType('appendix', 'postscript')" class="add" title="新增跋" @click="addFixedUnit('appendix', 'postscript')">＋ 跋</button>
              <button v-if="!hasUnitType('appendix', 'imprint')" class="add" title="新增牌记" @click="addFixedUnit('appendix', 'imprint')">＋ 牌记</button>
            </template>
          </span>
        </div>
        <template v-for="(u, ui) in unitsOf(f.key)" :key="u.id">
          <!-- 卷行：正文=命名卷/有覆盖的默认卷；导读/附录一律不渲染（文件行直挂标题下），空单元兜底可删 -->
          <div
            v-if="showUnitRow(f.key, u)"
            class="vol" :class="{ on: cur.folder === f.key && cur.ui === ui, open: isExpanded(u) }"
            @click="selectUnit(f.key, ui, 0)"
          >
            <span
              v-if="f.key === 'scrolls'"
              class="chev" :class="{ open: isExpanded(u) }"
              title="展开/折叠章节"
              @click.stop="toggleExpand(u, $event)"
            >{{ isExpanded(u) ? '▾' : '▸' }}</span>
            <span class="t">{{ u.name || '（默认卷）' }}</span>
            <i
              v-if="unitOverrideInfo(u).total" class="ovd"
              :title="`${u.name || '默认卷'} 已覆盖 ${unitOverrideInfo(u).total} 项版式 · 点击打开版式`"
              @click.stop="openUnitTemplate(f.key, ui)"
            >●{{ unitOverrideInfo(u).total }}</i>
            <span class="acts">
              <button title="版式设置" @click.stop="openUnitTemplate(f.key, ui)">⚙</button>
              <button v-if="f.key === 'scrolls'" title="添加章节" @click.stop="addChap(f.key, ui)">＋</button>
              <button v-if="f.key === 'scrolls'" title="从本地文件导入到本卷" @click.stop="importFilesToVolume(ui)">⇪</button>
              <button title="重命名" @click.stop="renUnit(f.key, ui)">✎</button>
              <button title="删除" @click.stop="delUnit(f.key, ui)">×</button>
            </span>
          </div>
          <!-- 目录：同为文件行；派生 = 正文由结构生成（不可编辑），手动 = 正文落 guide/目录.txt（可编辑） -->
          <div
            v-if="isTocUnit(u)"
            class="chap" :class="{ on: cur.folder === f.key && cur.ui === ui }"
            @click="selectUnit(f.key, ui, 0)"
          >
            <span class="t">{{ u.name }}（{{ isTocDerived(u) ? '派生' : '手动' }}）</span>
            <i
              v-if="unitOverrideInfo(u).total" class="ovd"
              :title="`${u.name} 已覆盖 ${unitOverrideInfo(u).total} 项版式 · 点击打开版式`"
              @click.stop="openUnitTemplate(f.key, ui)"
            >●{{ unitOverrideInfo(u).total }}</i>
            <span class="acts">
              <button title="版式设置" @click.stop="openUnitTemplate(f.key, ui)">⚙</button>
              <button title="删除文件" @click.stop="delUnit(f.key, ui)">×</button>
            </span>
          </div>
          <!-- 正文卷：章节列表可折叠 -->
          <div v-if="f.key === 'scrolls' && !isTocUnit(u)" v-show="isExpanded(u)" class="chaps">
            <div
              v-for="(c, ci) in u.chapters" :key="c.id"
              class="chap" :class="{ on: cur.folder === f.key && cur.ui === ui && cur.ci === ci }"
              @click="selectChapter(f.key, ui, ci)"
            >
              <span class="t">{{ c.title }}</span>
              <span class="acts">
                <button title="重命名" @click.stop="renChap(f.key, ui, ci)">✎</button>
                <button title="删除" @click.stop="delChap(f.key, ui, ci)">×</button>
              </span>
            </div>
          </div>
          <!-- 导读/附录文件行（单文件单元）：不折叠 -->
          <div
            v-if="f.key !== 'scrolls' && !isTocUnit(u)"
            v-for="(c, ci) in u.chapters" :key="c.id"
            class="chap" :class="{ on: cur.folder === f.key && cur.ui === ui && cur.ci === ci }"
            @click="selectChapter(f.key, ui, ci)"
          >
            <span class="t">{{ c.title }}</span>
            <i
              v-if="unitOverrideInfo(u).total" class="ovd"
              :title="`${u.name} 已覆盖 ${unitOverrideInfo(u).total} 项版式 · 点击打开版式`"
              @click.stop="openUnitTemplate(f.key, ui)"
            >●{{ unitOverrideInfo(u).total }}</i>
            <span class="acts">
              <button title="版式设置" @click.stop="openUnitTemplate(f.key, ui)">⚙</button>
              <button title="删除文件" @click.stop="delUnit(f.key, ui)">×</button>
            </span>
          </div>
        </template>
        <div v-if="!unitsOf(f.key).length" class="empty">{{ f.label }}（空）</div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.side { width: 190px; background: #faf9f6; border-right: 0.5px solid #d3d1c7; display: flex; flex-direction: column; }
.tree { flex: 1; overflow: auto; padding: 6px 6px; }
.fhdr { font-size: 11px; color: #6b6a63; margin: 8px 4px 2px; display: flex; align-items: center; justify-content: space-between; font-weight: 600; }
.adds { display: inline-flex; gap: 2px; }
.fhdr .add { border: 0; background: none; color: #0f6e56; cursor: pointer; font-size: 11px; padding: 0 4px; }
.fhdr .add:hover { text-decoration: underline; }
.vol { display: flex; align-items: center; padding: 5px 6px; margin: 3px 0; background: #f1efe8; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; color: #3b3a35; }
.vol.on { background: #e1f5ee; color: #0f6e56; }
.chev { flex: none; width: 14px; text-align: center; font-size: 10px; color: #888780; margin-right: 2px; cursor: pointer; user-select: none; }
.chev.open { color: #5f5e5a; }
.chaps { margin-left: 10px; padding-left: 8px; border-left: 1.5px solid #e3e1d7; }
.chap { display: flex; align-items: center; padding: 3px 6px 3px 16px; border-radius: 5px; cursor: pointer; font-size: 12px; color: #5f5e5a; }
.chap.on { background: #e1f5ee; color: #0f6e56; }
.t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ovd { flex: none; font-style: normal; font-size: 9px; color: #b8862a; margin-left: 3px; cursor: pointer; letter-spacing: -0.3px; }
.ovd:hover { color: #b4532a; }
.acts { display: none; gap: 2px; flex: none; }
.vol:hover .acts, .chap:hover .acts { display: inline-flex; }
.acts button { border: 0; background: none; color: inherit; cursor: pointer; font-size: 12px; padding: 0 2px; opacity: 0.7; }
.acts button:hover { opacity: 1; }
.empty { font-size: 11px; color: #aaa79f; padding: 2px 6px; }
</style>
