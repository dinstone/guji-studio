import { ref } from 'vue'

/**
 * 应用内弹窗（替代 window.prompt / window.confirm / window.alert）。
 *
 * 根因：Wails v3 macOS WKWebView 未实现 WKUIDelegate 的 JS 弹窗代理，
 * 桌面壳里 window.prompt() 恒返回 null、window.confirm() 恒返回 false、
 * window.alert() 静默无输出——导致新建项目等流程无声中断。
 * 这里用 Vue 响应式状态 + Promise 模拟同步弹窗语义，桌面/浏览器两端行为一致。
 */

export type DialogKind = 'prompt' | 'confirm' | 'alert'

interface DialogState {
  kind: DialogKind
  message: string
  value: string // prompt 的当前输入
  resolve: (v: any) => void
}

export const dialog = ref<DialogState | null>(null)

function open(kind: DialogKind, message: string, value: string): Promise<any> {
  return new Promise(resolve => {
    dialog.value = { kind, message, value, resolve }
  })
}

/** 输入弹窗；取消返回 null，确定返回输入串（可能为空串） */
export function appPrompt(message: string, def = ''): Promise<string | null> {
  return open('prompt', message, def)
}

/** 确认弹窗；确定 true / 取消 false */
export function appConfirm(message: string): Promise<boolean> {
  return open('confirm', message, '')
}

/** 提示弹窗（仅确定） */
export function appAlert(message: string): Promise<void> {
  return open('alert', message, '')
}

export function settle(v: any) {
  dialog.value?.resolve(v)
  dialog.value = null
}

/** 确定：prompt 回输入值，confirm/alert 回 true */
export function dialogOk() {
  const d = dialog.value
  if (!d) return
  settle(d.kind === 'prompt' ? d.value : true)
}

/** 取消：prompt 回 null，confirm/alert 回 false */
export function dialogCancel() {
  const d = dialog.value
  if (!d) return
  settle(d.kind === 'prompt' ? null : false)
}
