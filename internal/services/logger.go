package services

import (
	"io"
	"log"
	"os"
	"path/filepath"
)

// InitLogger 把全局标准库 log 的输出同时重定向到 stderr 与本地日志文件，
// 让 update.go 等各处已有的 log.Printf 自动落盘，无需逐处改动。
//
// 日志文件路径：<用户配置目录>/GujiStudio/gujistudio.log
//   - macOS:   ~/Library/Application Support/GujiStudio/gujistudio.log
//   - Windows: %AppData%/GujiStudio/gujistudio.log
//   - Linux:   ~/.config/GujiStudio/gujistudio.log
//
// 文件超过 5MB 时重命名为 .old（仅保留最近一份），避免无限增长。
// 任何目录/文件不可写时回退到仅 stderr，绝不阻塞应用启动。
func InitLogger() {
	base, err := os.UserConfigDir()
	if err != nil {
		base = "."
	}
	appDir := filepath.Join(base, "GujiStudio")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		log.Printf("[logger] cannot create log dir %s: %v; fallback stderr only", appDir, err)
		return
	}
	logPath := filepath.Join(appDir, "gujistudio.log")

	if fi, stErr := os.Stat(logPath); stErr == nil && fi.Size() > 5*1024*1024 {
		_ = os.Rename(logPath, logPath+".old")
	}

	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Printf("[logger] cannot open log file %s: %v; fallback stderr only", logPath, err)
		return
	}
	log.SetOutput(io.MultiWriter(os.Stderr, f))
	log.Printf("[logger] logging to %s", logPath)
}
