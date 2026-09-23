package services

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// AppSettings 应用级设置，存于用户配置目录（~/Library/Application Support/GujiStudio/）。
type AppSettings struct {
	LastProjectDir string        `json:"last_project_dir"` // 上次打开的项目目录
	Recents        []RecentEntry `json:"recents"`          // 最近项目（新在前，≤10 条）
	// EditorFontSize 正文编辑器字号（px）；0 = 未设置（前端用默认值）。
	// 属「用户级偏好」，与项目无关，故不写进项目文件。
	EditorFontSize int `json:"editor_font_size,omitempty"`
}

type RecentEntry struct {
	Dir  string `json:"dir"`
	Name string `json:"name"`
}

func settingsPath() (string, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cfg, "GujiStudio")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

type SettingsService struct{}

// Get 读取设置；无文件时返回空设置（不报错）。
func (s *SettingsService) Get() (*AppSettings, error) {
	path, err := settingsPath()
	if err != nil {
		return nil, err
	}
	st := &AppSettings{}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return st, nil // 首次启动
		}
		// 其他读错误（权限等）也回落空，不阻断启动/打开流程。
		log.Printf("[settings] 读取 %s 失败，回落空设置: %v", path, err)
		return st, nil
	}
	if err := json.Unmarshal(raw, st); err != nil {
		// 文件损坏（如上次写入被中断）：先备份原字节便于人工恢复，再回落空设置。
		// 不在此直接覆盖——后续 Set 会在原子写时写出完整内容修复。
		log.Printf("[settings] 解析 %s 失败，回落空设置: %v", path, err)
		if berr := backupCorrupt(path, raw); berr != nil {
			log.Printf("[settings] 备份损坏文件失败（不影响运行）: %v", berr)
		}
		return st, nil
	}
	return st, nil
}

// Set 保存设置（原子写：先写同目录临时文件，再 rename 覆盖，
// 避免写入中途崩溃/被杀留下半截文件导致下次启动解析失败）。
func (s *SettingsService) Set(st *AppSettings) error {
	path, err := settingsPath()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	body := append(raw, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".settings-*.json.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// backupCorrupt 把损坏的设置原字节另存为 settings.json.corrupt[.N]，便于人工恢复，
// 不覆盖上一次备份。仅当确实存在损坏内容时调用，权限沿用 0o644。
func backupCorrupt(path string, raw []byte) error {
	bak := path + ".corrupt"
	for i := 1; ; i++ {
		if _, err := os.Stat(bak); err != nil {
			if os.IsNotExist(err) {
				break
			}
			return err
		}
		bak = fmt.Sprintf("%s.corrupt.%d", path, i)
	}
	return os.WriteFile(bak, raw, 0o644)
}

// SetEditorFontSize 单独设置正文编辑器字号（读-改-写）。
// 之所以不复用 Set：前端若要保存一个偏好就得回传整个 AppSettings，
// 期间若有 TouchRecent 落盘，就会用旧快照把「最近项目」冲掉。
func (s *SettingsService) SetEditorFontSize(px int) (*AppSettings, error) {
	if px < 0 {
		px = 0
	} else if px > 40 {
		px = 40
	}
	st, err := s.Get()
	if err != nil {
		st = &AppSettings{}
	}
	st.EditorFontSize = px
	return st, s.Set(st)
}

// RemoveRecent 从最近项目列表中移除一条（仅移除记录，不动磁盘项目）。
// 移除的是当前项目时，LastProjectDir 一并清空，避免下次启动又打开已移除的项目。
func (s *SettingsService) RemoveRecent(dir string) (*AppSettings, error) {
	st, err := s.Get()
	if err != nil {
		st = &AppSettings{}
	}
	out := make([]RecentEntry, 0, len(st.Recents))
	for _, r := range st.Recents {
		if r.Dir != dir {
			out = append(out, r)
		}
	}
	st.Recents = out
	if st.LastProjectDir == dir {
		st.LastProjectDir = ""
	}
	return st, s.Set(st)
}
func (s *SettingsService) TouchRecent(dir, name string) (*AppSettings, error) {
	st, err := s.Get()
	if err != nil {
		st = &AppSettings{}
	}
	st.LastProjectDir = dir
	out := make([]RecentEntry, 0, len(st.Recents)+1)
	out = append(out, RecentEntry{Dir: dir, Name: name})
	for _, r := range st.Recents {
		if r.Dir != dir {
			out = append(out, r)
		}
	}
	if len(out) > 10 {
		out = out[:10]
	}
	st.Recents = out
	return st, s.Set(st)
}
