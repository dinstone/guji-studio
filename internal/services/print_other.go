//go:build !darwin

package services

import "fmt"

// exportPDFNative：非 macOS 平台暂未实装（Windows 走 WebView2 PrintToPdf，待做）。
func (s *PrintService) exportPDFNative(path string, wMM, hMM float64) error {
	return fmt.Errorf("矢量打印导出目前仅支持 macOS，Windows 版待实现")
}
