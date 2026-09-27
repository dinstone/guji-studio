package services

// 关闭闸门（2026-09-27）：窗口关闭前给前端一次 flushSave 的机会。
// 背景：自动保存 3s 轮询，改动后立刻退出会丢最后一次修改（删册复活 bug 的补强）。
//
// 机制（wails3 beta.25 实测源码）：
//   - 用户点关闭（macOS 红灯 / Windows WM_CLOSE / 菜单退出→win.Close）最终都发 Common.WindowClosing；
//   - 该事件带一个「内部默认监听器」（NewWindow 里注册）直接销毁窗口，但 RegisterHook 的
//     钩子先于监听器执行，且 e.Cancel() 能拦下整批监听器 —— 这是我们能拦截关闭的关键；
//   - App.Quit()（Cmd+Q 菜单角色）直接销毁应用、不经过窗口关闭事件，必须把菜单「退出」
//     改成 win.Close() 才能进闸门（见 main.go setupAppMenu）。
//
// 流程：首次关闭 → 钩子 Cancel 拦下 + 发 "app:close-requested" 给前端 →
// 前端 flushSave() 完成后调 ConfirmClose 绑定 → 置放行位并再次 win.Close()（这次放行）。
// 前端未加载 / 卡死时由看门狗超时强制放行，绝不困住用户。

import (
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

const closeGateTimeout = 4 * time.Second

// CloseGateService 只暴露一个绑定：ConfirmClose（前端 flush 完成后回话放行）。
type CloseGateService struct{}

var (
	closeGateMu  sync.Mutex
	closeGateOK  bool                      // true = 放行，钩子不再拦
	closeGateApp *application.App          // 发 "app:close-requested" 用
	closeGateWin *application.WebviewWindow // 放行后的再次 Close 用
)

// InstallCloseGate 在主窗口挂关闭闸门钩子。app.Run 之前调用（窗口 impl 未建也能挂）。
func InstallCloseGate(app *application.App, win *application.WebviewWindow) {
	closeGateApp = app
	closeGateWin = win
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		closeGateMu.Lock()
		ok := closeGateOK
		closeGateMu.Unlock()
		if ok {
			return // 已放行：内部默认监听器照常销毁窗口
		}
		e.Cancel() // 拦下本次关闭（钩子先于内部销毁监听器，Cancel 即不销毁）
		if closeGateApp != nil {
			closeGateApp.Event.Emit("app:close-requested", nil)
		}
		// 看门狗：前端没回话（页面卡死 / 尚未加载 / 非 wails 环境）也强制放行
		time.AfterFunc(closeGateTimeout, forceCloseGate)
	})
}

// forceCloseGate 看门狗 / 兜底：置放行位并补一次 Close（幂等，窗口已毁则 Close 自行早退）。
func forceCloseGate() {
	closeGateMu.Lock()
	closeGateOK = true
	win := closeGateWin
	closeGateMu.Unlock()
	if win != nil {
		win.Close()
	}
}

// ConfirmClose 前端保存完成后回话。幂等：看门狗与前端双触发安全。
func (s *CloseGateService) ConfirmClose() {
	forceCloseGate()
}

// closeGateReset 仅供测试：恢复未放行初态。
func closeGateReset() {
	closeGateMu.Lock()
	closeGateOK = false
	closeGateApp = nil
	closeGateWin = nil
	closeGateMu.Unlock()
}
