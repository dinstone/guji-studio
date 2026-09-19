/* 系统字体列表的模块级单例缓存。
 * Inspector 里字体字段有十余个，每个 FontPicker 实例各自调用 List() 会重复解析
 * 整个字体目录（Go 侧约 0.4s/次）——这里统一缓存，一次 IPC 供全部实例复用。
 * 用 Vue ref 暴露缓存，任何实例加载完成后，所有组件的显示名反查同步刷新。 */
import { ref } from 'vue'
import { listFonts, type FontInfo } from '../platform/wails'

export const sysFontsCache = ref<FontInfo[]>([])

let pending: Promise<FontInfo[]> | null = null

/** 取系统字体列表（已缓存则同步返回）。非桌面壳 / 读取失败时返回空数组。 */
export function sysFontsLoad(): Promise<FontInfo[]> {
  if (sysFontsCache.value.length) return Promise.resolve(sysFontsCache.value)
  if (!pending) {
    pending = listFonts()
      .then(r => { sysFontsCache.value = r; return r })
      .catch(() => { pending = null; return [] as FontInfo[] })
  }
  return pending
}

/** 已缓存则直接返回，否则 null（供同步的显示名反查用）。 */
export function sysFontsNow(): FontInfo[] | null {
  return sysFontsCache.value.length ? sysFontsCache.value : null
}

/** 英文族名 → 本地化显示名（未缓存 / 无中文名时返回原值）。 */
export function fontLabelOf(family: string): string {
  if (!family) return family
  const hit = sysFontsCache.value.find(f => f.family === family)
  return hit?.label || family
}
