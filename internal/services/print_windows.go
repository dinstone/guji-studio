//go:build windows

package services

import (
	"fmt"
	"math"
	"os"
	"reflect"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

/* Windows 侧矢量导出：WebView2 ICoreWebView2_16::PrintToPdfStream。
 *
 * wails3 把 webview2 COM 包装放在 internal/webview2（internal 限制 import 不到），
 * 且其 _16 包装未暴露 PrintToPdf（文件版）。故此处拿原始 COM 指针裸调 vtable：
 *   chromium → controller.GetCoreWebView2 → QI(IID_ICoreWebView2_16) → PrintToPdfStream
 *   environment → QI(IID_ICoreWebView2Environment6) → CreatePrintSettings
 * 只有整数指针参数走裸调；float64 参数（页宽高/边距）按 amd64 ABI 传
 * math.Float64bits 单字（Go asm 会把前 4 个调用字镜像进 XMM0-3，与 wails 内部
 * putdouble_amd64.go 同法），故仅支持 amd64。
 *
 * 线程模型：WebView2 COM 必须在创建它的 UI 线程调用。绑定方法跑在后台 goroutine
 * （windowMessageBuffer 消费者），经 application.InvokeSyncWithError 派发主线程；
 * PrintToPdfStream 是异步 COM 调用（启动即返回），完成回调由主线程消息泵触发，
 * 经缓冲 channel 交回后台 goroutine——等待期不占主线程，无死锁。 */

// ---------- 原始 COM 调用 ----------

const comPtrSize = int(unsafe.Sizeof(uintptr(0)))

// comCall 调 COM 对象 obj 的 vtable 第 slot 项（0 基，含 IUnknown 三项）。
func comCall(obj uintptr, slot int, args ...uintptr) uintptr {
	vtbl := *(*uintptr)(unsafe.Pointer(obj))
	proc := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(slot*comPtrSize)))
	r1, _, _ := syscall.SyscallN(proc, append([]uintptr{obj}, args...)...)
	return r1
}

type comGuid struct {
	data1 uint32
	data2 uint16
	data3 uint16
	data4 [8]byte
}

var (
	iidWebView2_16  = comGuid{0x0EB34DC9, 0x9F91, 0x41E1, [8]byte{0x86, 0x39, 0x95, 0xCD, 0x59, 0x43, 0x90, 0x6B}}
	iidEnvironment6 = comGuid{0xE59EE362, 0xACBD, 0x4857, [8]byte{0x9A, 0x8E, 0xD3, 0x64, 0x4D, 0x94, 0x59, 0xA9}}
)

// comQueryInterface 对 COM 对象做 QI，返回新接口指针（调用方负责 Release）。
func comQueryInterface(obj uintptr, iid *comGuid) (uintptr, error) {
	var out uintptr
	hr := comCall(obj, 0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out)))
	if hr != 0 {
		return 0, fmt.Errorf("QueryInterface 失败: 0x%08x", hr)
	}
	if out == 0 {
		return 0, fmt.Errorf("QueryInterface 返回空指针")
	}
	return out, nil
}

// comRelease 释放引用（vtable slot 2）。
func comRelease(obj uintptr) {
	if obj != 0 {
		comCall(obj, 2)
	}
}

// ---------- 完成回调（手工 COM 对象） ----------

type pdfStreamResult struct {
	hr     uintptr // 完成回调的 HRESULT
	stream uintptr // IStream*（PDF 内容），消费完由本包 Release
}

var pdfStreamDone = make(chan pdfStreamResult, 1)

var pdfStreamHandlerVtbl = [4]uintptr{
	syscall.NewCallback(func(this, riid, out uintptr) uintptr {
		if out != 0 {
			*(*uintptr)(unsafe.Pointer(out)) = this
		}
		return 0 // S_OK（handler 只被 Invoke，QI 恒成功即可）
	}),
	syscall.NewCallback(func(this uintptr) uintptr { return 1 }),
	syscall.NewCallback(func(this uintptr) uintptr { return 1 }),
	syscall.NewCallback(func(this, errorCode, stream uintptr) uintptr {
		select {
		case pdfStreamDone <- pdfStreamResult{hr: errorCode, stream: stream}:
		default: // 丢弃旧的，保留最新结果
		}
		return 0
	}),
}

// ---------- IStream 读取（裸调：Read = slot 3） ----------

func readStreamBytes(stream uintptr) ([]byte, error) {
	buf := make([]byte, 1<<16)
	var out []byte
	for i := 0; i < 1<<16; i++ { // 防御性上限，正常远达不到
		var n uintptr
		hr := comCall(stream, 3, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n)))
		if hr != 0 && hr != 1 { // S_OK / S_FALSE（后者=到达流尾）
			return nil, fmt.Errorf("IStream::Read 失败: 0x%08x", hr)
		}
		out = append(out, buf[:n]...)
		if n == 0 || hr == 1 {
			return out, nil
		}
	}
	return out, nil
}

// ---------- 从 wails 窗口对象取内部指针 ----------

// structFieldPtr 读结构体非导出 *指针字段 的值（internal 类型无法命名，借 reflect+unsafe）。
// sv 必须是可地址化的结构体值。
func structFieldPtr(sv reflect.Value, field string) (uintptr, error) {
	if sv.Kind() != reflect.Struct {
		return 0, fmt.Errorf("期望结构体，得到 %v", sv.Kind())
	}
	f := sv.FieldByName(field)
	if !f.IsValid() || f.Kind() != reflect.Ptr {
		return 0, fmt.Errorf("对象无指针字段 %s（wails 版本不匹配？）", field)
	}
	// 非导出字段不能直接 Interface()，用 NewAt 绕过只读标记
	ro := reflect.NewAt(f.Type(), unsafe.Pointer(f.UnsafeAddr())).Elem()
	if ro.IsNil() {
		return 0, fmt.Errorf("字段 %s 尚未初始化（webview 未就绪？）", field)
	}
	return ro.Pointer(), nil
}

// ---------- 主线程阶段 ----------

// vtable 槽位（0 基含 IUnknown）：
//   Controller.GetCoreWebView2=25；Environment6.CreatePrintSettings=3；
//   _16.PrintToPdfStream=5；PrintSettings: PutOrientation=4, PutPageWidth=8,
//   PutPageHeight=10, PutMarginTop=12, PutMarginBottom=14, PutMarginLeft=16,
//   PutMarginRight=18, PutShouldPrintBackgrounds=20, PutShouldPrintSelectionOnly=22,
//   PutShouldPrintHeaderAndFooter=24。
//   PrintSettings 的 C double 参数按 amd64 ABI 传 Float64bits 单字。

func passDouble(v float64) (uintptr, bool) {
	if runtime.GOARCH != "amd64" {
		return 0, false // arm64 无法按 ABI 传 by-value double（见 golang.org/issue/62583）
	}
	return uintptr(math.Float64bits(v)), true
}

func putDouble(obj uintptr, slot int, v float64) error {
	w, ok := passDouble(v)
	if !ok {
		return fmt.Errorf("矢量导出当前仅支持 windows/amd64")
	}
	if hr := comCall(obj, slot, w); hr != 0 {
		return fmt.Errorf("PrintSettings 设置失败(slot %d): 0x%08x", slot, hr)
	}
	return nil
}

// startPrintToPdfStream 在主线程执行：取 COM 指针、配打印参数、启动异步打印。
func startPrintToPdfStream(ww *application.WebviewWindow, wMM, hMM float64) error {
	wwv := reflect.ValueOf(ww).Elem()
	if wwv.Kind() != reflect.Struct {
		return fmt.Errorf("窗口对象异常")
	}
	chromiumPtr, err := structFieldPtr(wwv, "chromium")
	if err != nil {
		return err
	}
	// chromium 指向 internal edge.Chromium 结构，借其字段类型重建可地址化视图
	cv := wwv.FieldByName("chromium")
	chromiumStruct := reflect.NewAt(cv.Type().Elem(), unsafe.Pointer(chromiumPtr)).Elem()
	controller, err := structFieldPtr(chromiumStruct, "controller")
	if err != nil {
		return fmt.Errorf("取 WebView2 controller 失败: %w", err)
	}
	environment, err := structFieldPtr(chromiumStruct, "environment")
	if err != nil {
		return fmt.Errorf("取 WebView2 environment 失败: %w", err)
	}

	// webview = controller.GetCoreWebView2()
	var webview uintptr
	if hr := comCall(controller, 25, uintptr(unsafe.Pointer(&webview))); hr != 0 || webview == 0 {
		return fmt.Errorf("GetCoreWebView2 失败: 0x%08x", hr)
	}
	defer comRelease(webview)

	// ICoreWebView2_16
	v16, err := comQueryInterface(webview, &iidWebView2_16)
	if err != nil {
		return fmt.Errorf("WebView2 运行时过旧，不支持 PrintToPdfStream（需 WebView2 Runtime ≥ 98）: %w", err)
	}
	defer comRelease(v16)

	// ICoreWebView2Environment6 → CreatePrintSettings
	env6, err := comQueryInterface(environment, &iidEnvironment6)
	if err != nil {
		return fmt.Errorf("取 Environment6 失败: %w", err)
	}
	defer comRelease(env6)

	var settings uintptr
	if hr := comCall(env6, 3, uintptr(unsafe.Pointer(&settings))); hr != 0 || settings == 0 {
		return fmt.Errorf("CreatePrintSettings 失败: 0x%08x", hr)
	}
	defer comRelease(settings)

	// 纸张：页宽高单位为英寸。与 macOS 桥同策略——纸张纵归一（宽=min、高=max），
	// 宽>高时 orientation=1（横向），阅读器侧呈现即叶子物理尺寸。
	wIn, hIn := wMM/25.4, hMM/25.4
	orientation := uintptr(0) // 0=Portrait
	pw, ph := wIn, hIn
	if wIn > hIn {
		orientation = 1 // Landscape
		pw, ph = hIn, wIn
	}
	puts := []struct {
		slot int
		val  float64
	}{
		{8, pw}, {10, ph},           // PageWidth / PageHeight
		{12, 0}, {14, 0}, {16, 0}, {18, 0}, // 四边边距 0
	}
	for _, p := range puts {
		if err := putDouble(settings, p.slot, p.val); err != nil {
			return err
		}
	}
	for _, set := range []struct {
		slot int
		val  uintptr
	}{
		{4, orientation},                 // Orientation
		{20, 1},                          // ShouldPrintBackgrounds（底色/印章必须）
		{22, 0},                          // ShouldPrintSelectionOnly
		{24, 0},                          // ShouldPrintHeaderAndFooter
	} {
		if hr := comCall(settings, set.slot, set.val); hr != 0 {
			return fmt.Errorf("PrintSettings 设置失败(slot %d): 0x%08x", set.slot, hr)
		}
	}

	// 清空可能残留的旧结果，启动异步打印（handler 由 WebView2 持有，完成/失败都会回调）
	select {
	case <-pdfStreamDone:
	default:
	}
	handler := &pdfStreamHandler{vtbl: &pdfStreamHandlerVtbl}
	if hr := comCall(v16, 5, settings, uintptr(unsafe.Pointer(handler))); hr != 0 {
		return fmt.Errorf("PrintToPdfStream 启动失败: 0x%08x", hr)
	}
	return nil
}

// pdfStreamHandler：手工 COM 对象，首字段必须是 vtbl 指针（COM ABI 只看这 8 字节）。
type pdfStreamHandler struct {
	vtbl *[4]uintptr
}

// ---------- 服务入口 ----------

func (s *PrintService) exportPDFNative(path string, wMM, hMM float64) error {
	if runtime.GOARCH != "amd64" {
		return fmt.Errorf("矢量导出当前仅支持 windows/amd64")
	}
	app := application.Get()
	if app == nil {
		return fmt.Errorf("应用未初始化")
	}
	win := app.Window.Current()
	if win == nil {
		return fmt.Errorf("未找到可打印窗口")
	}
	ww, ok := win.(*application.WebviewWindow)
	if !ok || ww == nil {
		return fmt.Errorf("当前窗口不支持打印")
	}

	// 阶段一（主线程）：启动打印
	if err := application.InvokeSyncWithError(func() error {
		return startPrintToPdfStream(ww, wMM, hMM)
	}); err != nil {
		return err
	}

	// 阶段二（后台 goroutine）：等完成回调（主线程消息泵负责触发，不占主线程）
	select {
	case res := <-pdfStreamDone:
		if res.hr != 0 {
			return fmt.Errorf("PrintToPdfStream 完成但报错: 0x%08x", res.hr)
		}
		if res.stream == 0 {
			return fmt.Errorf("PrintToPdfStream 未返回数据流")
		}
		defer comRelease(res.stream)

		// 阶段三（主线程读流，IStream 遵循宿主线程序约束）
		var data []byte
		if err := application.InvokeSyncWithError(func() error {
			var e error
			data, e = readStreamBytes(res.stream)
			return e
		}); err != nil {
			return err
		}
		if len(data) == 0 {
			return fmt.Errorf("PDF 数据为空")
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return fmt.Errorf("写文件失败: %w", err)
		}
		return nil
	case <-time.After(120 * time.Second):
		return fmt.Errorf("矢量导出超时（120s）")
	}
}
