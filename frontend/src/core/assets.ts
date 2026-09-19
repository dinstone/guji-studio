/* 项目图片素材（assets/）取用缓存
 *
 * 素材的「真源」是项目文件夹里的 assets/<文件名>，版式参数里只存文件名 —— 因此项目可整体搬走。
 * 前端不持有原文件，只按「项目目录 + 文件名」缓存 dataURL + 固有尺寸：
 *   · 引擎渲染时同步读缓存：命中即内联 dataURL（同步解码、无网络请求、重渲不闪）；
 *   · 未命中返回 null（本帧不画），同时后台向 Go 要 base64 → 解码拿宽高 → 通知订阅者重渲。
 * 尺寸必须一起缓存：上版尺寸只给一维（宽），另一维按原图宽高比推导，渲染是同步的，来不及现解。
 * 预览与导出共用同一份缓存 —— 导出必须拿到 dataURL 才能光栅化。
 */

import { readProjectAsset } from '../platform/wails'

export interface AssetInfo {
  /** 可直接内联进 SVG 的 dataURL（读不到时为空串） */
  url: string
  /** 固有宽高（像素）；解码失败为 0 */
  w: number
  h: number
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
}
function mimeOf(name: string): string {
  const e = (name.split('.').pop() || '').toLowerCase()
  return MIME[e] || 'image/png'
}

const EMPTY: AssetInfo = { url: '', w: 0, h: 0 }
const cache = new Map<string, AssetInfo>()
const pending = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()
let dir = ''

function keyOf(name: string) { return dir + '\u0000' + name }

/** 切换项目目录：清空缓存 —— 换了项目，同名文件是另一张图 */
export function setAssetDir(d: string) {
  const nd = d || ''
  if (nd === dir) return
  dir = nd
  cache.clear()
  pending.clear()
}
export function assetDir() { return dir }

/** 订阅「素材就绪」：预热完成时触发，用于让预览重渲（返回取消订阅函数） */
export function onAssetReady(fn: () => void) {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** 同步取素材信息：命中返回 {url,w,h}；未命中返回 null 并后台预热（下一帧起可见） */
export function assetInfo(name: string): AssetInfo | null {
  if (!name) return null
  const hit = cache.get(keyOf(name))
  if (hit) return hit
  void ensureAsset(name)
  return null
}

/** 预热单个素材：Go 读 base64 → 浏览器解码取固有宽高 → 入缓存 → 通知重渲 */
export function ensureAsset(name: string): Promise<void> {
  if (!name || !dir) return Promise.resolve()
  const k = keyOf(name)
  if (cache.has(k)) return Promise.resolve()
  const running = pending.get(k)
  if (running) return running
  const p = readProjectAsset(dir, name)
    .then((b64: string) => new Promise<AssetInfo>((ok, bad) => {
      if (!b64) { ok(EMPTY); return }
      const url = 'data:' + mimeOf(name) + ';base64,' + b64
      const img = new Image()
      img.onload = () => ok({ url, w: img.naturalWidth || 0, h: img.naturalHeight || 0 })
      img.onerror = () => ok({ url, w: 0, h: 0 })   // 解不出尺寸：url 仍可用，只是算不了比例
      img.src = url
    }))
    .catch(() => EMPTY)   // 读不到就留空：不阻塞渲染，也不反复重试
    .then((info: AssetInfo) => {
      cache.set(k, info)
      pending.delete(k)
      if (info.url) listeners.forEach(fn => fn())
    })
  pending.set(k, p)
  return p
}

/** 预取一批素材（切模板 / 打开项目后调用，避免首帧缺图）；导出前也用它确保图已全部就绪 */
export async function ensureAssets(names: string[]): Promise<void> {
  await Promise.all(names.filter(Boolean).map(n => ensureAsset(n)))
}

/** 取图比例（高/宽）：未知返回 0，调用方可据此判断「本帧不画」 */
export function assetRatio(name: string): number {
  const i = cache.get(keyOf(name))
  if (!i || !i.w || !i.h) return 0
  return i.h / i.w
}

/** 丢弃某素材缓存（导入覆盖同名文件后强行重取） */
export function invalidateAsset(name: string) {
  cache.delete(keyOf(name))
}
