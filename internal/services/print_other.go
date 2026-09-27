//go:build !darwin && !windows

package services

import "fmt"

// exportPDFNative：macOS（WKWebView）与 Windows（WebView2 PrintToPdfStream）之外的平台未实装。
func (s *PrintService) exportPDFNative(path string, wMM, hMM float64) error {
	return fmt.Errorf("矢量打印导出目前支持 macOS 与 Windows")
}
