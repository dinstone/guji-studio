/**
 * useProjectAssets — 图书项目素材（assets/）管理 composable
 *
 * 职责（镜像 mdx 的 useMedia，但引用模型不同）：
 *   - scan()            列出 assets/ 全部图片，调后端 FindOrphanAssets 反查配置，
 *                       计算「正常引用 / 孤立」分组，并取 base64 缩略图 + 大小
 *   - deleteAsset()     安全删除单条（后端 moveToTrash，可找回）
 *   - cleanupOrphans()  一键清理孤立图片（后端批量移入 trash/）
 *
 * 与 mdx 的差异：mdx 用内容寻址 hash + Markdown 里 img:// 正则提取引用；
 * GujiStudio 的引用是「文件名」散落在 book.gvs/setting.json/publish.json（JSON），
 * 孤儿判定由后端 grep 完成，前端只拿到结果。
 */
import { ref, shallowRef } from 'vue'
import {
  listProjectAssets,
  findOrphanAssets,
  deleteProjectAsset,
  cleanOrphanAssets,
  readProjectAsset,
} from '../platform/wails'
import { projectDir } from '../stores/app'

export interface AssetItem {
  /** 文件名（assets/ 下的真名，也是配置里引用的标识） */
  name: string
  /** 缩略图 dataURL；读不到为 '' */
  url: string
  /** 字节数（由 base64 长度反推） */
  size: number
  /** 是否存在于 assets/ 但没有任何配置引用 */
  isOrphan: boolean
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
}
function mimeOf(name: string): string {
  const e = (name.split('.').pop() || '').toLowerCase()
  return MIME[e] || 'image/png'
}

export function useProjectAssets() {
  const items = shallowRef<AssetItem[]>([])
  const loading = ref(false)
  const error = ref('')
  const lastScanMs = ref(0)

  async function scan(): Promise<void> {
    const dir = projectDir.value
    if (!dir) {
      items.value = []
      return
    }
    loading.value = true
    error.value = ''
    const t0 = performance.now()
    try {
      const [all, orphans] = await Promise.all([
        listProjectAssets(dir),
        findOrphanAssets(dir),
      ])
      const orphanSet = new Set(orphans)
      const result: AssetItem[] = []
      for (const name of all) {
        let url = ''
        let size = 0
        try {
          const b64 = await readProjectAsset(dir, name)
          if (b64) {
            url = 'data:' + mimeOf(name) + ';base64,' + b64
            size = Math.round((b64.length * 3) / 4)
          }
        } catch {
          /* 读不到：仍列出，只是无缩略图 */
        }
        result.push({ name, url, size, isOrphan: orphanSet.has(name) })
      }
      items.value = result
      lastScanMs.value = Math.round(performance.now() - t0)
    } catch (e: any) {
      error.value = e?.message || String(e)
    } finally {
      loading.value = false
    }
  }

  async function deleteAsset(name: string): Promise<void> {
    const dir = projectDir.value
    if (!dir) return
    await deleteProjectAsset(dir, name)
    await scan()
  }

  async function cleanupOrphans(): Promise<string[]> {
    const dir = projectDir.value
    if (!dir) return []
    const moved = await cleanOrphanAssets(dir)
    await scan()
    return moved
  }

  return { items, loading, error, lastScanMs, scan, deleteAsset, cleanupOrphans }
}
