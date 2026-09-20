/* 前端统一错误桥接：把 webview 内的未捕获错误转发到 Go 端统一日志文件。
 * Wails v3 beta.4 没有公开的前端 console/error 捕获 API，官方推荐做法是
 * 前端捕获后通过事件回传 Go（dev/debug 模式才在 DevTools/终端可见）。
 * 这里捕获三类：window.onerror、unhandledrejection、console.error/warn。 */
import { Events } from '@wailsio/runtime'

interface FrontendErrorPayload {
  level: 'error' | 'warn'
  message: string
  source?: string
  line?: number
  col?: number
  stack?: string
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || v.message
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function installFrontendErrorLogging(): void {
  const report = (payload: FrontendErrorPayload) => {
    try {
      // 非 wails 壳（纯 vite 预览）下会抛错，忽略即可。
      Events.Emit('frontend:error', payload)
    } catch {
      /* ignore */
    }
  }

  window.addEventListener('error', (e: ErrorEvent) => {
    report({
      level: 'error',
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error?.stack,
    })
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const r = e.reason
    report({ level: 'error', message: 'unhandledrejection: ' + stringify(r) })
  })

  // 顺带转发 console.error / console.warn，便于排查（不递归调用原方法）。
  const forward = (level: 'error' | 'warn') => {
    const consoleRec = console as unknown as Record<string, (...a: unknown[]) => void>
    const orig = consoleRec[level].bind(console)
    consoleRec[level] = (...args: unknown[]) => {
      try {
        report({ level, message: args.map(stringify).join(' ') })
      } catch {
        /* ignore */
      }
      orig(...args)
    }
  }
  forward('error')
  forward('warn')
}
