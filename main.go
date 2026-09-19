package main

import (
	"embed"
	"log"
	"runtime"

	"gujistudio/internal/services"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"github.com/wailsapp/wails/v3/pkg/updater"
	"github.com/wailsapp/wails/v3/pkg/updater/providers/github"
)

// Wails uses Go's `embed` package to embed the frontend files into the binary.
// Any files in the frontend/dist folder will be embedded into the binary and
// made available to the frontend.

//go:embed all:frontend/dist
var assets embed.FS

// main initializes the application, registers the native services
// (project / settings / fonts) and opens the main window.
func main() {
	app := application.New(application.Options{
		Name:        "Guji Studio",
		Description: "古籍工作室",
		Services: []application.Service{
			application.NewService(&services.ProjectService{}),
			application.NewService(&services.SettingsService{}),
			application.NewService(&services.FontService{}),
			application.NewService(&services.TemplateService{}),
			application.NewService(&services.UpdateService{}),
		},
		// 注册 .gvs 文件关联：双击项目文件即可在 GujiStudio 打开
		FileAssociations: []string{".gvs"},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// --- 应用内更新器（Wails3 pkg/updater，GitHub Releases 作为更新源）---
	// 更新源：GitHub Releases（内置 github provider），仓库见 services.updateRepo。
	// Release 资产文件名需包含 windows/darwin/linux + amd64/arm64 以匹配平台，
	// 可选附带 SHA256SUMS 校验和侧车做完整性校验。
	ghProvider, ghErr := github.New(github.Config{
		Repository:    services.UpdateRepo(),
		HTTPClient:    services.UpdaterHTTPClient(),
		ChecksumAsset: "SHA256SUMS",
	})
	if ghErr != nil {
		log.Fatalf("updater: github.New: %v", ghErr)
	}
	if err := app.Updater.Init(updater.Config{
		CurrentVersion: services.AppVersion(),
		Providers:      []updater.Provider{ghProvider},
	}); err != nil {
		log.Fatalf("updater: Init: %v", err)
	}
	// 把运行中的应用与 Updater 注入 UpdateService，驱动启动后后台检查并向前端推送可用性。
	services.SetApp(app)
	services.SetUpdater(app.Updater)

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:          "GujiStudio · 古籍工作室",
		Width:          1440,
		Height:         880,
		MinWidth:       800,
		MinHeight:      450,
		EnableFileDrop: true, // 欢迎页支持拖入文件夹 / .gvs 文件直接打开
		Mac: application.MacWindow{
			InvisibleTitleBarHeight: 50,
			Backdrop:                application.MacBackdropTranslucent,
			TitleBar:                application.MacTitleBarHiddenInset,
		},
		BackgroundColour: application.NewRGB(247, 245, 240),
		URL:              "/",
	})

	// 拖放：拿到拖入的真实文件路径，转交前端解析并打开
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
		files := event.Context().DroppedFiles()
		app.Event.Emit("files-dropped", map[string]any{"files": files})
	})

	// 双击 .gvs 文件关联启动：缓存路径并通知前端（应用已运行则直接弹事件；
	// 冷启动时前端尚未订阅，路径由 services.TakePendingOpen 兜底）
	app.Event.OnApplicationEvent(events.Common.ApplicationOpenedWithFile, func(e *application.ApplicationEvent) {
		files := e.Context().OpenedFiles()
		services.AddPendingOpen(files)
		app.Event.Emit("files-dropped", map[string]any{"files": files})
	})

	// 自定义应用菜单：把系统菜单的「关于」替换为打开应用内的「关于 / 赞助」对话框
	// （Wails 默认 About 会弹出其自带简陋对话框，这里桥接事件到前端的 AboutDialog）
	setupAppMenu(app, win)

	err := app.Run()
	if err != nil {
		log.Fatal(err)
	}
}

// setupAppMenu 构建并安装自定义应用菜单。
// macOS：菜单栏（application menu），第一个子菜单即应用名菜单（含关于 / 退出）。
// Windows / Linux：窗口级菜单（win.SetMenu）。
// 其余标准菜单（文件 / 编辑 / 视图 / 窗口 / 帮助）沿用 Wails 内置角色，仅替换「关于」项。
func setupAppMenu(app *application.App, win *application.WebviewWindow) {
	m := application.NewMenu()
	appSub := m.AddSubmenu("Guji Studio")
	appSub.Add("关于 Guji Studio").OnClick(func(_ *application.Context) {
		// 通知前端打开「关于 / 赞助」对话框（前端监听 open-about 事件）
		app.Event.Emit("open-about", nil)
	})
	appSub.AddSeparator()
	if runtime.GOOS == "darwin" {
		appSub.AddRole(application.Hide)
		appSub.AddRole(application.HideOthers)
		appSub.AddRole(application.UnHide)
		appSub.AddSeparator()
	}
	appSub.AddRole(application.Quit)
	m.AddRole(application.FileMenu)
	m.AddRole(application.EditMenu)
	m.AddRole(application.ViewMenu)
	m.AddRole(application.WindowMenu)
	m.AddRole(application.HelpMenu)

	if runtime.GOOS == "darwin" {
		app.Menu.SetApplicationMenu(m)
	} else {
		win.SetMenu(m)
	}
}
