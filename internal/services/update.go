package services

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"
)

// appVersion 是当前运行版本，作为更新器比较基线的“当前版本”。
// 它不再手写——由构建期通过 -ldflags 注入（build/darwin、build/windows 的
// Taskfile 会从 build/config.yml 的 info.version 读取后注入）。因此版本号的
// 唯一来源就是 build/config.yml，发版时只需改这一处（前端 __APP_VERSION__ 也同源）。
// 未注入时为空字符串，updatesConfigured 会据此判定为开发构建并跳过更新检查。
var appVersion string

// updateRepo 是托管 Release 的 GitHub 仓库 "owner/repo"。
// TODO: 替换为 GujiStudio 的真实仓库（例如 "yourname/GujiStudio"）。
// 在替换为真实仓库之前，自动/手动更新检查都会被安全跳过，不会报错。
const updateRepo = "dinstone/guji-studio"

var (
	appRef     *application.App
	updaterRef *updater.Updater

	autoMu      sync.Mutex
	autoStarted bool
)

// SetApp 把运行中的应用实例注入更新服务（main.go 在 updater 初始化后调用）。
func SetApp(app *application.App) { appRef = app }

// SetUpdater 把应用的 Updater 实例注入更新服务（main.go 在 updater 初始化后调用）。
func SetUpdater(u *updater.Updater) { updaterRef = u }

// AppVersion 返回当前构建版本（供 main.go 喂给 updater 作基线）。
func AppVersion() string { return appVersion }

// IsDevBuild 报告当前是否为开发构建（未通过 -ldflags 注入 appVersion）。
// 开发模式下点「立即更新」不应自动重启：wails dev watcher 不会接管被 helper 重启的
// dev 二进制，静默退出会让用户误以为崩溃；改为发 guji:update:dev-ready 事件提示手动重启。
func IsDevBuild() bool { return appVersion == "" }

// UpdateRepo 返回更新源仓库（供 main.go 构造 github provider）。
func UpdateRepo() string { return updateRepo }

func updatesConfigured() bool {
	return updateRepo != "" && updateRepo != "OWNER/GujiStudio"
}

// CheckUpdateResult 把更新检查结果带给前端。
type CheckUpdateResult struct {
	HasUpdate bool   `json:"hasUpdate"`
	Version   string `json:"version"`
	Name      string `json:"name"`
	Notes     string `json:"notes"`
	URL       string `json:"url"`
	// Error 非空表示检查本身失败（网络/解析/未配置）。前端据此展示，而非误判为「已是最新」。
	Error string `json:"error,omitempty"`
}

var (
	lastCheckMu sync.Mutex
	lastCheck   *CheckUpdateResult
)

func cacheResult(r *CheckUpdateResult) {
	lastCheckMu.Lock()
	lastCheck = r
	lastCheckMu.Unlock()
}
func getCachedResult() *CheckUpdateResult {
	lastCheckMu.Lock()
	defer lastCheckMu.Unlock()
	return lastCheck
}

// releaseURL 从 release 元数据里尽力拼出发布页地址。
func releaseURL(rel *updater.Release) string {
	if rel == nil {
		return ""
	}
	if u, ok := rel.Metadata["html_url"].(string); ok && u != "" {
		return u
	}
	return ""
}

// friendlyUpdateError 把 updater 抛出的技术化错误翻译成用户能懂的中文提示。
// 原始错误仍写进日志，前端只展示 friendly 文案。
func friendlyUpdateError(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	lower := strings.ToLower(msg)

	if errors.Is(err, context.DeadlineExceeded) || strings.Contains(lower, "context deadline exceeded") {
		return "下载超时，请检查网络连接或稍后重试"
	}
	if strings.Contains(lower, "client.timeout") && strings.Contains(lower, "reading body") {
		return "下载超时，请检查网络连接或稍后重试"
	}
	if strings.Contains(lower, "timeout") || strings.Contains(lower, "timed out") {
		return "网络连接超时，请检查网络后重试"
	}
	if strings.Contains(lower, "connection refused") {
		return "无法连接到更新服务器，请检查网络或代理设置"
	}
	if strings.Contains(lower, "connection reset") || strings.Contains(lower, "reset by peer") {
		return "网络连接被重置，请检查网络或稍后重试"
	}
	if strings.Contains(lower, "no such host") || strings.Contains(lower, "dial tcp") {
		return "无法访问更新服务器，请检查网络连接"
	}
	if strings.Contains(lower, "checksum") || strings.Contains(lower, "digest") || strings.Contains(lower, "verification failed") {
		return "更新包校验失败，请稍后重试"
	}
	if strings.Contains(lower, "signature") {
		return "更新包签名验证失败，请稍后重试"
	}
	if strings.Contains(lower, "no pending release") {
		return "未找到可下载的更新，请先检查更新"
	}
	if strings.Contains(lower, "not configured") || strings.Contains(lower, "updater not initialised") {
		return "更新器未初始化"
	}
	// 兜底：保留原始错误，避免信息丢失。
	return "更新失败：" + msg
}

// UpdateService 驱动后台更新检查并把「发现新版」推给前端。
// 实际的下载/安装由 Wails3 Updater 完成（main.go 持有，经 SetUpdater 注入）。
type UpdateService struct{}

// StartAutoCheck 在启动几秒后做一次后台更新检查，这样既不抢启动，也给前端
// 留出挂载并注册 "updater:available" 监听的时间。幂等：重复调用会被忽略。
// 发现新版本时向前端 emit "updater:available" 事件。
// 网络/解析错误被静默吞掉（后台检查本就该失败不扰民）。
// 未配置更新源（owner/repo 占位）时跳过，避免误报「有更新」。
func (s *UpdateService) StartAutoCheck() {
	autoMu.Lock()
	if autoStarted {
		autoMu.Unlock()
		return
	}
	autoStarted = true
	autoMu.Unlock()

	if !updatesConfigured() {
		log.Printf("[updater] auto-check skipped (update source not configured)")
		return
	}

	go func() {
		// 给应用与前端时间就位，再触发检查与推送。
		time.Sleep(3 * time.Second)
		s.checkNow(true)
	}()
}

// checkNow 执行一次同步检查。emit 为 true 且发现新版本时，向前端推送事件。
func (s *UpdateService) checkNow(emit bool) {
	if updaterRef == nil {
		log.Printf("[updater] check skipped: updater not initialised")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rel, err := updaterRef.Check(ctx)
	if err != nil {
		log.Printf("[updater] check failed: %v", err)
		return
	}
	if rel == nil {
		log.Printf("[updater] up to date (current %s)", appVersion)
		cacheResult(&CheckUpdateResult{HasUpdate: false})
		return
	}

	result := &CheckUpdateResult{
		HasUpdate: true,
		Version:   rel.Version,
		Name:      rel.Name,
		Notes:     rel.Notes,
		URL:       releaseURL(rel),
	}
	cacheResult(result)
	log.Printf("[updater] update available: %s", rel.Version)

	if emit && appRef != nil {
		appRef.Event.Emit("updater:available", rel.Version)
	}
}

// GetLastUpdate 返回最近一次后台检查的缓存结果；若尚无结果则先做一次检查。
// 供前端在收到 "updater:available" 事件后回取完整信息（版本/说明/发布页）。
func (s *UpdateService) GetLastUpdate() *CheckUpdateResult {
	if getCachedResult() == nil {
		s.checkNow(false)
	}
	return getCachedResult()
}

// InstallUpdate 下载并安装当前已发现的新版本，完成后由 wails 自动重启应用。
// 供更新弹窗 / 关于页「立即更新」按钮调用。
//
// 与早先实现不同，这里**不再**调用 CheckAndInstall：CheckAndInstall 在 builtin 模式下
// 会 openSession 另开一个独立原生 webview 更新窗口（见 wails pkg/updater/window.go 的
// openSession → host.OpenWindow），该窗口的 Open/Close 与原生 webview 的 cgo 调用在 goroutine
// 上和主窗口 webview 竞态，会 SIGSEGV（signal arrived during cgo execution, addr=0x18）。
// 由于 main.go 已将 Config.Window 设为 updater.WindowNone，wails 不再开自己的窗口；
// 这里直接 DownloadAndInstall（下载+校验+暂存，不碰 window）+ Restart（spawn helper 并 Quit，
// 由 helper 完成二进制替换并重启）即可。UI 完全由前端 Vue 弹窗承担。
//
// 必须在独立 goroutine 中执行：DownloadAndInstall/Restart 是长时间操作，且 Restart 会调用
// host.Quit() 触发应用退出；若在 webview 的 JS→Go cgo 调用栈（goroutine 1, locked to thread）
// 上同步执行会阻塞/竞态。改为 goroutine 后 InstallUpdate 立即返回，前端 await 立刻 resolve，
// 下载/重启在普通 goroutine 栈进行。失败仅记日志。
func (s *UpdateService) InstallUpdate() error {
	if updaterRef == nil {
		return fmt.Errorf("updater not initialised")
	}
	go func() {
		// 立刻通知前端「更新已开始」，让状态栏/按钮有反馈。
		if appRef != nil {
			appRef.Event.Emit("guji:update:started", nil)
		}
		ctx := context.Background()
		// pending release 由此前 Check（后台自动检查或关于页手动检查）写入；
		// 直接下载并安装。
		if err := updaterRef.DownloadAndInstall(ctx); err != nil {
			log.Printf("[updater] download/install failed: %v", err)
			if appRef != nil {
				appRef.Event.Emit("guji:update:finished", map[string]any{"error": friendlyUpdateError(err)})
			}
			return
		}
		if IsDevBuild() {
			// 开发模式不自动重启：dev 二进制会被替换成下载的 release 二进制，而 wails dev
			// watcher 不会接管被 helper 重启的进程，静默退出会让用户误以为崩溃。
			// 发事件提示手动重启（前端状态栏显示「已下载，请手动重启」）。
			log.Printf("[updater] dev build: update downloaded, skip auto-restart (restart manually)")
			if appRef != nil {
				appRef.Event.Emit("guji:update:finished", map[string]any{"devReady": true})
			}
			return
		}
		if err := updaterRef.Restart(ctx); err != nil {
			log.Printf("[updater] restart failed: %v", err)
			if appRef != nil {
				appRef.Event.Emit("guji:update:finished", map[string]any{"error": friendlyUpdateError(err)})
			}
		}
	}()
	return nil
}

// CheckUpdate 执行一次即时更新检查并直接返回结果（不推送事件）。
// 供「关于」页的「检查更新」按钮使用，让 UI 能明确展示「已是最新 / 发现新版本」，
// 并允许用户通过 InstallUpdate 应用更新。
func (s *UpdateService) CheckUpdate() *CheckUpdateResult {
	if !updatesConfigured() {
		return &CheckUpdateResult{Error: "更新源未配置（请在代码中填写 GitHub 仓库）"}
	}
	if updaterRef == nil {
		return &CheckUpdateResult{Error: "更新器未初始化"}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	rel, err := updaterRef.Check(ctx)
	if err != nil {
		log.Printf("[updater] check failed: %v", err)
		return &CheckUpdateResult{Error: friendlyUpdateError(err)}
	}
	if rel == nil {
		result := &CheckUpdateResult{HasUpdate: false}
		cacheResult(result)
		return result
	}

	result := &CheckUpdateResult{
		HasUpdate: true,
		Version:   rel.Version,
		Name:      rel.Name,
		Notes:     rel.Notes,
		URL:       releaseURL(rel),
	}
	cacheResult(result)
	log.Printf("[updater] update available: %s", rel.Version)
	return result
}

// UpdaterHTTPClient 返回针对 GitHub 在部分地区不稳定而调优的 *http.Client：
// 读取标准代理环境变量，并对瞬时失败（含 5xx）做退避重试。
//
// Timeout 设为 0（参考 ../mdx）：不使用 client 级别的 body 读超时，完全由调用方传入的
// context 控制取消。这样下载大更新包时不会因为读 body 慢而在 60 秒被截断，避免
// "context deadline exceeded (Client.Timeout or context cancellation while reading body)"。
func UpdaterHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 0,
		Transport: &retryTransport{
			next:    &http.Transport{Proxy: http.ProxyFromEnvironment},
			retries: 5,
		},
	}
}

// retryTransport 在底层 RoundTripper 之上包装指数退避重试。
type retryTransport struct {
	next    http.RoundTripper
	retries int
}

func (t *retryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var lastErr error
	backoff := 400 * time.Millisecond
	for i := 0; i <= t.retries; i++ {
		if i > 0 {
			time.Sleep(backoff)
			backoff *= 2
		}
		resp, err := t.next.RoundTrip(req)
		if err != nil {
			lastErr = err
			continue
		}
		// 5xx 视为瞬时失败，重试；4xx（含 404）不重试，直接返回。
		if resp.StatusCode >= 500 {
			resp.Body.Close()
			lastErr = fmt.Errorf("github server error %d", resp.StatusCode)
			continue
		}
		return resp, nil
	}
	return nil, lastErr
}
