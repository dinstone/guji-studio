package services

import (
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

/* PrintService：矢量打印通道（与位图导出并列的第二种输出方式）。
 *
 * 原理：预览的逐叶 SVG 本就活在 document 上下文里，WebKit 直接解析系统字体；
 * 打印时同一批 SVG 走 WebKit 打印管线（print media 样式重新分页布局），
 * 字体零内联、输出矢量 PDF（文字可选中可搜索）。
 *
 * 分工：前端在 PublishExport.vue 维护常驻 #print-root（teleport 到 body，
 * 屏显 display:none，@media print 才显示，内含逐叶 SVG 与固定毫米尺寸）；
 * 本服务只负责触发打印。用户在系统打印对话框里选「存储为 PDF」即得矢量 PDF。
 *
 * 后续（未做）：静默出文件的定制打印桥——Wails 内置 Print() 弹对话框，
 * 且 beta.25 的 windowPrint 用 sharedPrintInfo（横向、30 边距），要精确控制
 * 纸张尺寸需自己写 printOperationWithPrintInfo + NSPrintSaveJob。
 * 注意 wails 源码注释的坑：WKWebView 下 [printOperation runOperation] 无效，
 * 必须走 runOperationModalForWindow。 */

// PrintService 提供窗口打印能力（跨平台方法；macOS 走 WKWebView printOperation，
// Windows 走 WebView2 ShowPrintUI，由 wails 各自实现）。
type PrintService struct{}

// Print 对当前主窗口发起打印：弹出系统打印对话框。
// 前端需保证 #print-root（打印专用 DOM）已就绪——打印时 WebKit 应用
// @media print 样式，应用 UI 被隐藏、仅打印容器参与分页。
func (s *PrintService) Print() error {
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
	return ww.Print()
}

// ExportPDF 静默矢量导出：不经对话框，直接把 #print-root 打印成 PDF 落到 path。
// wMM/hMM = 叶子物理尺寸（毫米）；纸张按此设置、边距 0、不缩放，每叶恰好一页。
// 输出为矢量 PDF（文字为字形对象，任意缩放清晰）；字体由 WebKit 直接解析系统字体，
// 零内联——预览用什么字体，导出就是什么字体。
func (s *PrintService) ExportPDF(path string, wMM, hMM float64) error {
	if wMM <= 0 || hMM <= 0 {
		return fmt.Errorf("纸张尺寸无效: %v×%v mm", wMM, hMM)
	}
	return s.exportPDFNative(path, wMM, hMM)
}
