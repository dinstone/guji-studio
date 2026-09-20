import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { installFrontendErrorLogging } from './platform/log'

// 尽早安装全局错误捕获（window.onerror / unhandledrejection / console.error|warn），
// 通过 Wails 事件回传 Go 端统一日志文件。
installFrontendErrorLogging()

createApp(App).use(createPinia()).mount('#app')
