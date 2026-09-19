/* 应用内更新桥接层：包装 wails 生成的 UpdateService 绑定（JS + JSDoc），对 UI 暴露强类型异步接口。
 * 自动更新走 Wails3 pkg/updater（GitHub Releases 作为更新源）。
 * UI 组件只 import 这里，不直接 import bindings。
 * 注：首次需 `wails3 generate bindings` 生成 updateservice.js；@ts-ignore 仅为在未生成时让 tsc 通过。 */
/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore 生成的绑定是 JSDoc JS，无独立声明文件
import * as UpdateSvc from '../../bindings/gujistudio/internal/services/updateservice.js'

/** 一次更新检查结果（与 Go 端 CheckUpdateResult 对应） */
export interface CheckUpdateResult {
  hasUpdate: boolean
  version: string
  name: string
  notes: string
  url: string
  error?: string
}

/** 启动后让 Go 端延迟做后台自动检查（发现新版会 emit updater:available 事件） */
export async function startAutoCheck(): Promise<void> {
  try { await (UpdateSvc as any).StartAutoCheck() } catch { /* 非 wails 壳忽略 */ }
}
/** 即时检查更新（关于页「检查更新」按钮用），返回完整结果 */
export async function checkUpdate(): Promise<CheckUpdateResult | null> {
  try { return await (UpdateSvc as any).CheckUpdate() } catch (e: any) {
    return { hasUpdate: false, version: '', name: '', notes: '', url: '', error: String(e) }
  }
}
/** 取最近一次后台检查的缓存结果（收到 updater:available 事件后回取完整信息用） */
export async function getLastUpdate(): Promise<CheckUpdateResult | null> {
  try { return await (UpdateSvc as any).GetLastUpdate() } catch { return null }
}
/** 下载并安装更新（更新弹窗「立即更新」按钮用） */
export async function installUpdate(): Promise<void> {
  return (UpdateSvc as any).InstallUpdate()
}
