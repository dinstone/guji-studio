package services

import "fmt"

/* PrintService：矢量打印通道（与位图导出并列的第二种输出方式）。
 *
 * 原理：预览的逐叶 SVG 本就活在 document 上下文里，WebKit 直接解析系统字体；
 * 打印时同一批 SVG 走 WebKit 打印管线（print media 样式重新分页布局），
 * 字体零内联、输出矢量 PDF（文字可选中可搜索）。
 *
 * 分工：前端在 PublishExport.vue 维护常驻 #print-root（teleport 到 body，
 * 屏显 display:none，@media print 才显示，内含逐叶 SVG 与固定毫米尺寸）；
 * 本服务把 #print-root 静默打印成 PDF 文件。
 *
 * 注意：没有「打印对话框」通道——wails 内置 win.Print() 用 sharedPrintInfo
 * （横向 + 30pt 边距），前端 @page margin:0 压不住，每叶后必溢出一页空白
 * （2026-09-27 实测 68 页里 34 页全空），不可修，勿再加回。 */

// PrintService 提供矢量 PDF 导出能力（macOS 走 WKWebView printOperation，
// Windows 走 WebView2 PrintToPdfStream，见 print_darwin.go / print_windows.go）。
type PrintService struct{}

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
