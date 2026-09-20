<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { closeAbout, toast, downloadVer, updateProgress } from '../stores/app'
import { fetchSponsors, type Sponsor, type SponsorsData } from '../core/sponsors'
import { openExternal } from '../platform/wails'
import { checkUpdate, installUpdate, type CheckUpdateResult } from '../platform/update'

function openHomepage() {
  openExternal(proj.value.homepage || HOMEPAGE)
}

// 项目主页（远程 sponsors.json 的 project.homepage 可覆盖）
const HOMEPAGE = 'https://github.com/dinstone/guji-studio'

const version = __APP_VERSION__
const checking = ref(false)
// 手动检查结果状态：idle 未检查 / latest 已是最新 / available 发现新版本 / error 检查失败
const updateStatus = ref<'idle' | 'latest' | 'available' | 'error'>('idle')
const updateInfo = ref<CheckUpdateResult | null>(null)

// 关于页「检查更新」按钮：即时检查，结果行内展示（不弹独立弹窗）。
// 发现新版本 → 行内显示版本号 + 「立即更新」按钮；否则显示「已是最新版本」。
async function checkForUpdate() {
  if (checking.value || updateProgress.value.active) return
  checking.value = true
  updateStatus.value = 'idle'
  try {
    const r = await checkUpdate()
    if (!r) return
    if (r.error) { updateStatus.value = 'error'; toast('更新检查失败：' + r.error); return }
    if (r.hasUpdate) { updateStatus.value = 'available'; updateInfo.value = r; downloadVer.value = r.version }
    else updateStatus.value = 'latest'
  } finally {
    checking.value = false
  }
}

// 关于页行内「立即更新」：后台下载安装，完成后 wails 自动重启。
async function doInlineUpdate() {
  if (!updateInfo.value || updateProgress.value.active) return
  try {
    await installUpdate()
  } catch (e: any) {
    toast('更新失败：' + (e?.message || e))
  }
}

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<SponsorsData | null>(null)

onMounted(load)

async function load() {
  loading.value = true
  error.value = null
  const r = await fetchSponsors()
  loading.value = false
  if (r.data) {
    data.value = r.data
  } else {
    error.value = r.error
  }
}

const proj = computed(() => data.value?.project ?? {})
const sorted = computed<Sponsor[]>(() =>
  [...(data.value?.sponsors ?? [])].sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0)))
</script>

<template>
  <div class="ab-mask" @click.self="closeAbout">
    <div class="ab">
      <div class="ab-head">
        <div class="ab-title">
          <img class="ab-logo" src="/appicon.png" alt="Guji Studio" />
          <div>
            <h2>{{ proj.name || 'Guji Studio · 古籍工作室' }}</h2>
            <p class="ab-ver">v{{ version }} · {{ proj.tagline || '可视化古籍排版' }}</p>
          </div>
        </div>
        <button class="ab-x" @click="closeAbout" title="关闭">✕</button>
      </div>

      <div class="ab-body">
        <section class="ab-sec">
          <p class="ab-lead">
            Guji Studio 是一款<strong>免费、开源</strong>的古籍可视化排版工具，
            面向个人与公益场景永久免费。如果你觉得它有用，欢迎通过赞助支持持续开发。
          </p>
          <p class="ab-note">
            企业如需闭源集成或定制，请通过项目主页联系获取商业授权。
          </p>
          <ul class="ab-list">
            <li><span>许可证</span><b>{{ proj.license || 'AGPL-3.0' }}</b>（个人非商业永久免费）</li>
            <li class="ab-ver-row">
              <span>当前版本</span>
              <div class="ab-ver-cell">
                <div class="ab-ver-base">
                  <b>v{{ version }}</b>
                  <button class="ab-btn ghost" @click="checkForUpdate" :disabled="checking || updateProgress.active || updateStatus === 'available'">{{ checking ? '检查中…' : '检查更新' }}</button>
                </div>
                <template v-if="updateStatus === 'available'">
                  <span class="ab-ver-arrow">→</span>
                  <div class="ab-ver-action">
                    <b class="ab-ver-new">v{{ updateInfo?.version }}</b>
                    <button v-if="!updateProgress.active" class="ab-btn primary" @click="doInlineUpdate">立即更新</button>
                    <span v-else class="ab-latest">{{ updateProgress.stage || '更新下载中…' }}</span>
                  </div>
                </template>
                <span v-else-if="updateStatus === 'latest' || updateStatus === 'error'" class="ab-latest">
                  {{ updateStatus === 'latest' ? '已是最新版本' : '更新检查失败，请稍后重试' }}
                </span>
              </div>
            </li>
            <li><span>项目主页</span><a href="#" @click.prevent="openHomepage">{{ proj.homepage || HOMEPAGE }}</a></li>
          </ul>

          <!-- 微信赞赏码：始终展示，不依赖远程拉取，用户无需点击即可扫码赞助 -->
          <div class="ab-wx-wrap">
            <img class="ab-wx" src="/wxsponor.jpg" alt="微信赞赏码" />
          </div>

          <div class="ab-thanks">
            <h3>感谢以下赞助者 <span class="ab-count">（{{ sorted.length }}）</span></h3>
            <div v-if="loading" class="ab-state">正在拉取赞助者名单…</div>
            <div v-else-if="error" class="ab-state err">
              {{ error }}
              <button class="ab-retry" @click="load">重试</button>
            </div>
            <ul v-else-if="sorted.length" class="ab-sp">
              <li v-for="(s, i) in sorted" :key="i">
                <div class="ab-sp-left">
                  <a v-if="s.link" :href="s.link" target="_blank" rel="noopener" class="ab-sp-name">{{ s.name }}</a>
                  <span v-else class="ab-sp-name">{{ s.name }}</span>
                  <span v-if="s.tier" class="ab-sp-tier">{{ s.tier }}</span>
                  <span v-if="s.amount" class="ab-sp-amt">¥{{ s.amount }}</span>
                </div>
                <span v-if="s.date" class="ab-sp-date">{{ s.date }}</span>
                <p v-if="s.message" class="ab-sp-msg">“{{ s.message }}”</p>
              </li>
            </ul>
            <p v-else class="ab-state">还没有赞助者，成为第一个吧 ☕</p>
          </div>
        </section>
      </div>

      <div class="ab-foot">
        <span class="ab-sp" />
        <button class="ab-btn" @click="closeAbout">完成</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ab-mask {
  position: fixed; inset: 0; z-index: 200;
  background: rgba(40, 37, 30, .32);
  display: flex; align-items: center; justify-content: center;
}
.ab {
  width: 480px; max-width: 92vw; max-height: 86vh; display: flex; flex-direction: column;
  background: #fffdf8; border: 0.5px solid #e2dfd4; border-radius: 16px;
  padding: 20px 22px 16px; box-shadow: 0 18px 54px rgba(40,34,24,.30);
}
.ab-head { display: flex; align-items: center; justify-content: space-between; }
.ab-title { display: flex; align-items: center; gap: 12px; }
.ab-logo { width: 40px; height: 40px; border-radius: 10px; }
.ab-title h2 { margin: 0; font-size: 17px; color: #2c2c2a; }
.ab-ver { margin: 2px 0 0; font-size: 11px; color: #9a978c; }
.ab-x { width: 26px; height: 26px; border: 0; background: none; color: #9a978c; font-size: 14px; cursor: pointer; border-radius: 6px; }
.ab-x:hover { background: #f1efe8; color: #2c2c2a; }

.ab-body { overflow: auto; flex: 1; }
.ab-sec { padding: 4px 2px 8px; }
.ab-lead { font-size: 13px; line-height: 1.7; color: #4a4843; margin: 0 0 14px; }
.ab-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
.ab-list li { display: flex; gap: 10px; font-size: 13px; color: #4a4843; }
/* 仅匹配「标签列」直接子 span，避免污染版本行里嵌套的箭头 span（否则箭头会被 72px 撑宽） */
.ab-list li > span { width: 72px; color: #9a978c; flex: none; }
.ab-list a { color: #0f6e56; word-break: break-all; }
.ab-note { font-size: 11px; color: #a7a399; margin: 7px 0; line-height: 1.6; }

.ab-state { font-size: 13px; color: #9a978c; padding: 14px 0; text-align: center; }
.ab-state.err { color: #b05a4a; }
.ab-retry { margin-left: 10px; border: 0.5px solid #d3d1c7; background: #faf8f2; border-radius: 6px; padding: 3px 12px; font-size: 12px; color: #2c2c2a; cursor: pointer; }

.ab-wx-wrap { display: flex; justify-content: center; margin-top: 18px; margin-bottom: 16px; }
.ab-wx { display: block; width: 180px; border-radius: 8px; border: 0.5px solid #e2dfd4; }

.ab-thanks h3 { font-size: 13px; color: #2c2c2a; margin: 4px 0 10px; }
.ab-count { color: #9a978c; font-weight: 400; }
.ab-sp { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.ab-sp li { background: #f7f5ef; border-radius: 9px; padding: 9px 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ab-sp-left { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
.ab-sp-name { font-size: 13px; font-weight: 600; color: #2c2c2a; }
.ab-sp-tier { font-size: 11px; color: #0f6e56; background: #e7f1ec; border-radius: 5px; padding: 1px 7px; }
.ab-sp-amt { font-size: 12px; color: #b08900; }
.ab-sp-msg { width: 100%; font-size: 12px; color: #6f6c63; margin: 2px 0 0; line-height: 1.5; }
.ab-sp-date { font-size: 11px; color: #a7a399; margin-left: auto; }

.ab-foot { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.ab-sp { flex: 1; }
.ab-btn { border: 0.5px solid #d3d1c7; background: #faf8f2; border-radius: 7px; padding: 8px 18px; font-size: 13px; color: #2c2c2a; cursor: pointer; }
.ab-btn:hover { border-color: #0f6e56; color: #0f6e56; }
.ab-btn:disabled { opacity: 0.5; cursor: default; }
.ab-ver-row { display: flex; gap: 10px; align-items: center; }
.ab-ver-cell { display: flex; align-items: center; gap: 12px; flex: 1; }
.ab-ver-cell b { color: #2c2c2a; }
/* 单元一：当前版本 + 检查更新按钮（内部紧排） */
.ab-ver-base { display: flex; align-items: center; gap: 6px; }
/* 单元二：箭头 + 新版本 + 立即更新按钮（内部紧排） */
.ab-ver-action { display: flex; align-items: center; gap: 4px; }
/* 版本行按钮紧凑化；两个按钮都是 4 个等宽汉字，天然等宽，无需定宽 */
.ab-ver-cell .ab-btn { padding: 5px 10px; font-size: 12px; }
.ab-btn.ghost { background: #f3f1ea; }
.ab-btn.primary { background: #0f6e56; color: #fff; border-color: #0f6e56; }
.ab-btn.primary:hover:not(:disabled) { background: #0c5a46; color: #fff; }
.ab-latest { font-size: 13px; color: #0f6e56; }
.ab-ver-arrow { color: #9a978c; font-size: 12px; width: 16px; text-align: center; flex: none; }
.ab-ver-new { color: #0f6e56; }
</style>
