package services

// 版式模板库：~/Library/Application Support/GujiStudio/templates/<id>.json
//
// 内置模板与用户模板同库存、同结构，仅以 builtin 标记区分：
//   · builtin=true  出厂预设，由前端首次启动时播种（Seed），不可改名、不可删除；
//   · builtin=false 用户自建，由「把当前图书版式导入为模板」产生（Import）。
// 库内模板一律只读预览，不做参数编辑；更新既有模板的唯一途径是同名导入（覆盖）。

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// TplEntry 库内一枚模板（磁盘结构）。
type TplEntry struct {
	ID      string         `json:"id"`      // 稳定标识，也是文件名
	Name    string         `json:"name"`    // 显示名
	Note    string         `json:"note"`    // 一句话说明
	Builtin bool           `json:"builtin"` // 出厂预设 = true
	Order   int            `json:"order"`   // 内置排序位（用户模板为 0）
	Ver     int            `json:"ver"`     // 预设版本号，用于播种升级
	Updated string         `json:"updated"` // RFC3339
	Params  map[string]any `json:"params"`  // 完整版式参数快照（已剥离内容字段）
}

// TplSummary 列表项（不含参数，避免列表请求过大）。
type TplSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Note    string `json:"note"`
	Builtin bool   `json:"builtin"`
	Order   int    `json:"order"`
	Ver     int    `json:"ver"`
	Updated string `json:"updated"`
	Digest  string `json:"digest"` // 一行摘要：纸幅 · 行列 · 鱼尾 · 书口
}

type TemplateService struct{}

func tplDir() (string, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cfg, "GujiStudio", "templates")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// digest 一行摘要，与前端 summarize() 口径一致（纸幅 · 行列 · 鱼尾 · 书口）。
func digest(p map[string]any) string {
	get := func(k string) string { return fmt.Sprintf("%v", p[k]) }
	fish := map[string]string{"none": "无鱼尾", "single": "单鱼尾", "double": "双鱼尾"}
	seam := map[string]string{"none": "无书口", "single": "单象鼻", "double": "双象鼻"}
	parts := []string{
		get("canvas_width") + "×" + get("canvas_height"),
		get("row_num") + "字×" + get("leaf_col") + "列",
		fish[get("fish_mode")],
		seam[get("if_seam")],
	}
	out := make([]string, 0, len(parts)+2)
	for _, s := range parts {
		if s != "" && !strings.Contains(s, "<nil>") {
			out = append(out, s)
		}
	}
	if truthy(p["text_comma_zhu"]) || truthy(p["comment_comma_zhu"]) {
		out = append(out, "朱色句读")
	}
	if get("text_comma_mode") == "none" {
		out = append(out, "白文")
	}
	return strings.Join(out, " · ")
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		return t != 0
	case string:
		return t != "" && t != "0"
	}
	return false
}

func readEntry(path string) (TplEntry, error) {
	var e TplEntry
	raw, err := os.ReadFile(path)
	if err != nil {
		return e, err
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		return e, fmt.Errorf("解析模板 %s 失败: %w", filepath.Base(path), err)
	}
	e.ID = strings.TrimSuffix(filepath.Base(path), ".json")
	return e, nil
}

func writeEntry(dir string, e TplEntry) error {
	raw, err := json.MarshalIndent(e, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, e.ID+".json"), append(raw, '\n'), 0o644)
}

// List 列出库内全部模板：内置按 Order 升序在前，用户模板按导入时间倒序在后。
func (s *TemplateService) List() ([]TplSummary, error) {
	dir, err := tplDir()
	if err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	bi := make([]TplSummary, 0, len(files))
	us := make([]TplSummary, 0, len(files))
	for _, f := range files {
		e, err := readEntry(f)
		if err != nil {
			continue // 坏文件跳过，不影响库的其余部分
		}
		sm := TplSummary{
			ID: e.ID, Name: e.Name, Note: e.Note, Builtin: e.Builtin,
			Order: e.Order, Ver: e.Ver, Updated: e.Updated, Digest: digest(e.Params),
		}
		if e.Builtin {
			bi = append(bi, sm)
		} else {
			us = append(us, sm)
		}
	}
	sort.SliceStable(bi, func(i, j int) bool { return bi[i].Order < bi[j].Order })
	sort.SliceStable(us, func(i, j int) bool { return us[i].Updated > us[j].Updated })
	return append(bi, us...), nil
}

// Get 取单枚模板（含完整参数）。
func (s *TemplateService) Get(id string) (*TplEntry, error) {
	dir, err := tplDir()
	if err != nil {
		return nil, err
	}
	e, err := readEntry(filepath.Join(dir, filepath.Base(id)+".json"))
	if err != nil {
		return nil, err
	}
	return &e, nil
}

// Seed 播种出厂预设：不存在或版本更新时写入，同版本已存在则跳过。
// 同时清理库中已经不在本次内置列表里的出厂预设（如本版重命名/移除的预设），
// 避免旧内置 JSON 残留在模板库。
// 返回是否发生了写入/删除，便于前端判断是否需要重拉列表。
func (s *TemplateService) Seed(items []TplEntry) (bool, error) {
	dir, err := tplDir()
	if err != nil {
		return false, err
	}
	changed := false
	keep := make(map[string]bool)
	for _, it := range items {
		if it.ID == "" || len(it.Params) == 0 {
			continue
		}
		keep[it.ID] = true
		it.Builtin = true
		path := filepath.Join(dir, it.ID+".json")
		if old, err := readEntry(path); err == nil && old.Ver >= it.Ver {
			continue // 已是最新（或更新）版本
		}
		it.Updated = time.Now().Format(time.RFC3339)
		if err := writeEntry(dir, it); err != nil {
			return changed, err
		}
		changed = true
	}
	// 清理已移除的出厂内置
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	for _, f := range files {
		if e, err := readEntry(f); err == nil && e.Builtin && !keep[e.ID] {
			if os.Remove(f) == nil {
				changed = true
			}
		}
	}
	return changed, nil
}

// Import 导入（或同名覆盖）一枚用户模板，返回入库后的条目。
// name 为空时回落到「未命名模板」。
func (s *TemplateService) Import(name string, params map[string]any) (*TplEntry, error) {
	dir, err := tplDir()
	if err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "未命名模板"
	}
	if len(params) == 0 {
		return nil, fmt.Errorf("模板参数为空")
	}

	// 同名覆盖：沿用原 id，实现「在书里改好再导回」的更新路径
	id := ""
	if exist, err := s.List(); err == nil {
		for _, e := range exist {
			if !e.Builtin && e.Name == name {
				id = e.ID
				break
			}
		}
	}
	if id == "" {
		id = "t" + fmt.Sprintf("%x", time.Now().UnixNano())
	}

	e := TplEntry{
		ID: id, Name: name, Builtin: false,
		Updated: time.Now().Format(time.RFC3339), Params: params,
	}
	if err := writeEntry(dir, e); err != nil {
		return nil, err
	}
	return &e, nil
}

// Rename 重命名用户模板（内置模板拒绝）。
func (s *TemplateService) Rename(id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("模板名不能为空")
	}
	dir, err := tplDir()
	if err != nil {
		return err
	}
	e, err := readEntry(filepath.Join(dir, filepath.Base(id)+".json"))
	if err != nil {
		return err
	}
	if e.Builtin {
		return fmt.Errorf("内置模板不可重命名")
	}
	e.Name = name
	e.Updated = time.Now().Format(time.RFC3339)
	return writeEntry(dir, e)
}

// Delete 删除用户模板（内置模板拒绝）。
func (s *TemplateService) Delete(id string) error {
	dir, err := tplDir()
	if err != nil {
		return err
	}
	path := filepath.Join(dir, filepath.Base(id)+".json")
	e, err := readEntry(path)
	if err != nil {
		return err
	}
	if e.Builtin {
		return fmt.Errorf("内置模板不可删除")
	}
	return os.Remove(path)
}
