package services

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sampleFlat() *BookProjectFlat {
	return &BookProjectFlat{
		Name:     "测试书",
		Meta:     BookMeta{Title: "測試書", Author: "某人"},
		Template: map[string]any{"title_text": "測試書", "rows": float64(9)},
		Special:  map[string]any{"coverTitle": "測試書"},
		Packs: &PackPatches{
			Cover:    &Patches{"coverTitle": "測試書"},
			Fly:      &Patches{"font": "kai"},
			Colophon: &Patches{"colophon": "牌記"},
		},
		Chapters: []ChapterFull{
			{ID: "sc1", Title: "第一章", Text: "正文甲"},
			{ID: "sc2", Title: "第二章", Text: "正文乙"},
		},
		Volumes: []VolumeFull{
			{ID: "s1", Title: "卷一", Template: map[string]any{"rows": float64(10)}, Chapters: []string{"sc1", "sc2"}},
		},
		Blocks: []BlockFull{
			{ID: "f:preface", Name: "序", Type: "preface", Chapter: &ChapterFull{ID: "f:preface", Title: "序", Text: "序文一"}},
			{ID: "f:toc", Name: "目录", Type: "toc", Derived: boolPtr(true)},
			{ID: "f:postscript", Name: "跋", Type: "postscript", Chapter: &ChapterFull{ID: "f:postscript", Title: "跋", Text: "跋文"}},
		},
		Pubs: []Publication{
			{
				Title:    "全书",
				Front:    []PubGroup{{Pack: "封面"}, {Pack: "扉页"}, {Guide: "序"}, {Guide: "目录"}},
				Chapters: []PubChapters{{Volume: "s1"}},
				Back:     []PubGroup{{Appendix: "跋"}, {Pack: "尾页"}},
			},
		},
	}
}

func TestSaveOpenRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := &ProjectService{}
	if err := s.Save(dir, sampleFlat()); err != nil {
		t.Fatalf("Save 失败: %v", err)
	}
	for _, p := range []string{"book.gvs", "setting.json", "publish.json",
		"text/第一章.txt", "text/第二章.txt", "guide/序.txt", "appendix/跋.txt"} {
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			t.Errorf("缺少文件 %s: %v", p, err)
		}
	}
	// 派生目录（目录单元）不落盘；旧布局目录不应存在
	for _, d := range []string{"guide/目录.txt", "texts", "pack", "scrolls"} {
		if _, err := os.Stat(filepath.Join(dir, d)); !os.IsNotExist(err) {
			t.Errorf("不应存在: %s", d)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "text/第一章.txt")); string(b) != "正文甲" {
		t.Errorf("正文错误: %q", string(b))
	}
	// setting.json：固定单元写为 guide/appendix 条目数组（无 blocks 旧字段）
	raw, err := os.ReadFile(filepath.Join(dir, "setting.json"))
	if err != nil {
		t.Fatalf("setting.json 缺失: %v", err)
	}
	var setting map[string]any
	if err := json.Unmarshal(raw, &setting); err != nil {
		t.Fatalf("setting.json 解析失败: %v", err)
	}
	if _, ok := setting["blocks"]; ok {
		t.Error("setting.json 不应再写出 blocks 旧字段")
	}
	guide, _ := setting["guide"].([]any)
	if len(guide) != 2 {
		t.Errorf("guide 条目错误: %v", setting["guide"])
	}
	appendix, _ := setting["appendix"].([]any)
	if len(appendix) != 1 {
		t.Errorf("appendix 条目错误: %v", setting["appendix"])
	}

	f, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open 失败: %v", err)
	}
	if f.Name != "测试书" || f.Meta.Title != "測試書" {
		t.Errorf("元信息丢失: %+v", f.Meta)
	}
	if len(f.Volumes) != 1 || f.Volumes[0].Title != "卷一" {
		t.Fatalf("卷结构错误: %+v", f.Volumes)
	}
	if len(f.Volumes[0].Chapters) != 2 ||
		f.Volumes[0].Chapters[0] != "sc1" || f.Volumes[0].Chapters[1] != "sc2" {
		t.Errorf("卷章 id 引用错误: %+v", f.Volumes[0].Chapters)
	}
	if len(f.Chapters) != 2 || f.Chapters[1].Text != "正文乙" || f.Chapters[1].Title != "第二章" {
		t.Errorf("文章池正文/标题错误: %+v", f.Chapters)
	}
	if f.Packs.Fly == nil || (*f.Packs.Fly)["font"] != "kai" {
		t.Errorf("包装扉页覆盖丢失: %+v", f.Packs.Fly)
	}
	if len(f.Blocks) != 3 ||
		f.Blocks[0].Type != "preface" || f.Blocks[0].Chapter.Text != "序文一" ||
		f.Blocks[1].Type != "toc" || !derivedOf(f.Blocks[1].Derived) ||
		f.Blocks[2].Type != "postscript" || f.Blocks[2].Chapter.Text != "跋文" {
		t.Errorf("固定角色单元错误: %+v", f.Blocks)
	}
	if len(f.Pubs) != 1 || f.Pubs[0].Title != "全书" ||
		len(f.Pubs[0].Front) != 4 ||
		len(f.Pubs[0].Chapters) != 1 || f.Pubs[0].Chapters[0].Volume != "s1" ||
		len(f.Pubs[0].Back) != 2 {
		t.Errorf("册定义错误: %+v", f.Pubs)
	}
}

// TestManualTocRoundTrip 手动目录：正文落 guide/目录.txt；derived=false 必须能真实落盘
// （这正是 Derived 用 *bool 的原因——bool+omitempty 会把 false 吞掉，手动态读回变派生）；
// 切回派生时不写也不删旧文件，手改稿保留。
func TestManualTocRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := &ProjectService{}
	tocPath := filepath.Join(dir, "guide/目录.txt")

	// 1) 派生目录：不落盘
	if err := s.Save(dir, sampleFlat()); err != nil {
		t.Fatalf("Save 失败: %v", err)
	}
	if _, err := os.Stat(tocPath); !os.IsNotExist(err) {
		t.Fatalf("派生目录不应落盘: %v", err)
	}

	// 2) 切手动：正文 + 条目来源落盘，且 derived:false 显式写出
	flat := sampleFlat()
	flat.Blocks[1].Derived = boolPtr(false)
	flat.Blocks[1].Mode = "heading"
	flat.Blocks[1].Chapter = &ChapterFull{ID: "f:toc", Title: "目录", Text: "手改目录正文"}
	if err := s.Save(dir, flat); err != nil {
		t.Fatalf("Save2 失败: %v", err)
	}
	if b, err := os.ReadFile(tocPath); err != nil || string(b) != "手改目录正文" {
		t.Fatalf("手动目录正文未落盘: %q %v", string(b), err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "setting.json"))
	var setting struct {
		Guide []map[string]any `json:"guide"`
	}
	if err := json.Unmarshal(raw, &setting); err != nil {
		t.Fatalf("setting.json 解析失败: %v", err)
	}
	var tocEntry map[string]any
	for _, g := range setting.Guide {
		if g["name"] == "目录" {
			tocEntry = g
		}
	}
	if tocEntry == nil {
		t.Fatalf("guide 里没有目录条目: %v", setting.Guide)
	}
	if d, ok := tocEntry["derived"]; !ok || d != false {
		t.Errorf("手动目录必须显式落 derived:false（实际 %v，键存在=%v）", d, ok)
	}
	if tocEntry["mode"] != "heading" {
		t.Errorf("目录条目来源未落盘: %v", tocEntry["mode"])
	}

	// 3) 重新打开：手动态 + 正文 + 来源都能读回
	f, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open 失败: %v", err)
	}
	toc := findBlock(f.Blocks, "toc")
	if toc == nil || derivedOf(toc.Derived) {
		t.Fatalf("重新打开应仍为手动目录: %+v", toc)
	}
	if toc.Chapter == nil || toc.Chapter.Text != "手改目录正文" || toc.Mode != "heading" {
		t.Fatalf("手动目录正文/来源丢失: %+v %q", toc.Chapter, toc.Mode)
	}

	// 4) 切回派生：不写文件、也不删文件（旧手改稿保留，再切回手动可恢复）
	back := *f
	back.Blocks = append([]BlockFull{}, f.Blocks...)
	for i := range back.Blocks {
		if back.Blocks[i].Type == "toc" {
			back.Blocks[i].Derived = boolPtr(true)
			back.Blocks[i].Chapter = nil
		}
	}
	if err := s.Save(dir, &back); err != nil {
		t.Fatalf("Save3 失败: %v", err)
	}
	if b, err := os.ReadFile(tocPath); err != nil || string(b) != "手改目录正文" {
		t.Fatalf("切回派生不应动旧文件: %q %v", string(b), err)
	}
	f2, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open2 失败: %v", err)
	}
	toc2 := findBlock(f2.Blocks, "toc")
	if toc2 == nil || !derivedOf(toc2.Derived) || toc2.Chapter != nil {
		t.Errorf("切回派生后应为无正文的派生单元: %+v", toc2)
	}
}

func TestChapterRenameAndOrphan(t *testing.T) {
	dir := t.TempDir()
	s := &ProjectService{}
	flat := sampleFlat()
	if err := s.Save(dir, flat); err != nil {
		t.Fatalf("Save 失败: %v", err)
	}
	// 改名：sc2 第二章 → 终章（file 由 title 派生，id 不变，卷引用不受影响）
	flat.Chapters[1] = ChapterFull{ID: "sc2", Title: "终章", Text: "正文乙"}
	// 删除：序 单元移除（文件应进 trash/）
	flat.Blocks = flat.Blocks[1:]
	if err := s.Save(dir, flat); err != nil {
		t.Fatalf("Save2 失败: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "text/第二章.txt")); !os.IsNotExist(err) {
		t.Error("改名后旧文件未移出 text/")
	}
	if _, err := os.Stat(filepath.Join(dir, "guide/序.txt")); !os.IsNotExist(err) {
		t.Error("删除序后文件未移出 guide/")
	}
	// 孤儿文件应移入 trash/（可找回）
	for _, name := range []string{"第二章.txt", "序.txt"} {
		matched := false
		entries, _ := os.ReadDir(filepath.Join(dir, "trash"))
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), name) {
				matched = true
			}
		}
		if !matched {
			t.Errorf("孤儿文件未移入 trash/: %s", name)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "text/终章.txt")); err != nil {
		t.Errorf("新文件名未落盘: %v", err)
	}
	f, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open 失败: %v", err)
	}
	if f.Volumes[0].Chapters[1] != "sc2" || f.Chapters[1].Title != "终章" {
		t.Errorf("改名后 id 引用/标题漂移: %+v %+v", f.Volumes[0].Chapters, f.Chapters[1])
	}
	if len(f.Blocks) != 2 || f.Blocks[0].Type != "toc" {
		t.Errorf("删除后固定单元错误: %+v", f.Blocks)
	}
}

func TestChapterFileNameDedupe(t *testing.T) {
	dir := t.TempDir()
	s := &ProjectService{}
	flat := sampleFlat()
	// 两篇文章同名 → 后者自动去重
	flat.Chapters[1] = ChapterFull{ID: "sc2", Title: "第一章", Text: "正文乙"}
	if err := s.Save(dir, flat); err != nil {
		t.Fatalf("Save 失败: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "text/第一章.txt")); err != nil {
		t.Errorf("第一篇文件缺失: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "text/第一章-2.txt")); err != nil {
		t.Errorf("重名文章未去重: %v", err)
	}
	// Open 用同一派生规则：读回正文不串
	f, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if f.Chapters[0].Text != "正文甲" || f.Chapters[1].Text != "正文乙" {
		t.Errorf("重名去重后正文错位: %+v", f.Chapters)
	}
}

// TestEnsureNewProject 新建项目只落盘 book.gvs（项目身份证），其余结构随编辑逐步长出；
// 覆盖已有项目时旧数据进 trash/，不留残留。
func TestEnsureNewProject(t *testing.T) {
	dir := t.TempDir()
	s := &ProjectService{}
	if err := s.EnsureNewProject(dir, "新书", "測試書", nil); err != nil {
		t.Fatalf("EnsureNewProject: %v", err)
	}
	// 只应有 book.gvs
	if _, err := os.Stat(filepath.Join(dir, "book.gvs")); err != nil {
		t.Errorf("新项目缺少 book.gvs: %v", err)
	}
	for _, p := range []string{"setting.json", "publish.json", "text", "guide", "appendix"} {
		if _, err := os.Stat(filepath.Join(dir, p)); !os.IsNotExist(err) {
			t.Errorf("新项目不该预建 %s（应随编辑逐步生成）", p)
		}
	}
	// Open 可读，且是空项目（包装三叶由 Open 兜底）
	f, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if f.Name != "新书" || f.Meta.Title != "測試書" {
		t.Errorf("书级信息错误: %+v", f.Meta)
	}
	if len(f.Chapters) != 0 || len(f.Volumes) != 0 || len(f.Blocks) != 0 || len(f.Pubs) != 0 {
		t.Errorf("新项目应为空结构: chaps=%d vols=%d blocks=%d pubs=%d", len(f.Chapters), len(f.Volumes), len(f.Blocks), len(f.Pubs))
	}
	if f.Packs == nil || f.Packs.Cover == nil {
		t.Errorf("Open 应兜底补默认包装三叶: %+v", f.Packs)
	}
}

// TestEnsureNewProjectClearsOld 在已有项目目录上新建：旧三文件与正文目录移入 trash/，
// 否则打开新项目会读到上一本书的残留。
func TestEnsureNewProjectClearsOld(t *testing.T) {
	dir := t.TempDir()
	s := &ProjectService{}
	if err := s.Save(dir, sampleFlat()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := s.EnsureNewProject(dir, "新书", "測試書", nil); err != nil {
		t.Fatalf("EnsureNewProject: %v", err)
	}
	for _, p := range []string{"setting.json", "publish.json", "text", "guide", "appendix"} {
		if _, err := os.Stat(filepath.Join(dir, p)); !os.IsNotExist(err) {
			t.Errorf("覆盖新建后 %s 仍残留", p)
		}
	}
	entries, err := os.ReadDir(filepath.Join(dir, "trash"))
	if err != nil || len(entries) == 0 {
		t.Fatalf("旧数据未移入 trash/: %v", err)
	}
	f, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if len(f.Chapters) != 0 || len(f.Pubs) != 0 {
		t.Errorf("覆盖新建后不是空项目: chaps=%d pubs=%d", len(f.Chapters), len(f.Pubs))
	}
}

// TestSaveEmptyOmitsSettingPublish 空项目保存时不写 setting.json / publish.json；
// 已有旧文件时清空后必须删掉，否则重开会读到幽灵数据。
func TestSaveEmptyOmitsSettingPublish(t *testing.T) {
	dir := t.TempDir()
	s := &ProjectService{}
	if err := s.EnsureNewProject(dir, "空书", "", nil); err != nil {
		t.Fatalf("EnsureNewProject: %v", err)
	}
	if err := s.Save(dir, &BookProjectFlat{Name: "空书"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	for _, p := range []string{"setting.json", "publish.json"} {
		if _, err := os.Stat(filepath.Join(dir, p)); !os.IsNotExist(err) {
			t.Errorf("空项目保存后不该有 %s", p)
		}
	}
	// 有内容 → 写；再删空 → 删
	if err := s.Save(dir, sampleFlat()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	for _, p := range []string{"setting.json", "publish.json"} {
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			t.Errorf("有内容时应写 %s: %v", p, err)
		}
	}
	if err := s.Save(dir, &BookProjectFlat{Name: "空书"}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	for _, p := range []string{"setting.json", "publish.json"} {
		if _, err := os.Stat(filepath.Join(dir, p)); !os.IsNotExist(err) {
			t.Errorf("清空后应删除 %s", p)
		}
	}
	f, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if len(f.Chapters) != 0 || len(f.Pubs) != 0 {
		t.Errorf("清空后重开读到幽灵数据: chaps=%d pubs=%d", len(f.Chapters), len(f.Pubs))
	}
}

// TestOpenSeedsDefaultPack pack 三叶全空（历史迁移丢失）时 Open 补默认叶，封面设计视图可用
func TestOpenSeedsDefaultPack(t *testing.T) {
	dir := t.TempDir()
	s := &ProjectService{}
	if err := s.Save(dir, sampleFlat()); err != nil {
		t.Fatalf("Save: %v", err)
	}
	// 模拟 pack 数据丢失的项目：book.gvs 不含 pack 键
	book, _ := os.ReadFile(filepath.Join(dir, "book.gvs"))
	var m map[string]any
	if err := json.Unmarshal(book, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	delete(m, "pack")
	raw, _ := json.MarshalIndent(m, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "book.gvs"), raw, 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	f, err := s.Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if f.Packs.Cover == nil || f.Packs.Fly == nil || f.Packs.Colophon == nil {
		t.Errorf("pack 空时未补默认叶: %+v", f.Packs)
	}
}

func TestSafeFileName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"道德經-2026-09-08.pdf", "道德經-2026-09-08.pdf"},
		{"guji.pdf", "guji.pdf"},
		{"../../etc/passwd", "passwd"},
		{"..", "guji-export.pdf"},
		{".", "guji-export.pdf"},
		{"...", "guji-export.pdf"},
		{"", "guji-export.pdf"},
		{"a:b*c?d\"e<f>g|h.pdf", "abcdefgh.pdf"},
		{"tab\there.pdf", "tabhere.pdf"},
		{"  spaced.pdf  ", "spaced.pdf"},
	}
	for _, c := range cases {
		if got := safeFileName(c.in); got != c.want {
			t.Errorf("safeFileName(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

// TestMigrateOldBookPack 旧版 book.gvs.pack.{cover|fly|colophon}.{template, fields} → setting.json.packs 同名叶
// 一次迁移把两嵌套 map 合成扁平 Patches；老 book.gvs 保存后不含 pack 字段。
func TestMigrateOldBookPack(t *testing.T) {
	dir := t.TempDir()
	// 写旧版 book.gvs：含 pack.{cover:{template:{font:'kai'}}, fly:{fields:{coverTitle:'上册'}}}
	oldBook := `{
  "name": "旧版",
  "meta": {"title": "旧版"},
  "template": {"row_num": 10},
  "special": {"fs": 150},
  "pack": {
    "cover": { "template": {"font": "kai", "fs": 180}, "fields": {"imprint": ""} },
    "fly":   { "fields": {"coverTitle": "上册", "volLabel": "上册"} },
    "colophon": { "template": {"paper": "#fff"} }
  }
}`
	if err := os.WriteFile(filepath.Join(dir, "book.gvs"), []byte(oldBook), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "setting.json"), []byte(`{"chapters":[],"volumes":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	f, err := (&ProjectService{}).Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if f.Packs == nil {
		t.Fatal("迁移后 setting.Packs 仍 nil")
	}
	if (*f.Packs.Cover)["font"] != "kai" || (*f.Packs.Cover)["fs"] != float64(180) || (*f.Packs.Cover)["imprint"] != "" {
		t.Errorf("封面合并错误: %+v", *f.Packs.Cover)
	}
	if (*f.Packs.Fly)["coverTitle"] != "上册" || (*f.Packs.Fly)["volLabel"] != "上册" {
		t.Errorf("扉页字段迁移错误: %+v", *f.Packs.Fly)
	}
	if (*f.Packs.Colophon)["paper"] != "#fff" {
		t.Errorf("尾页迁移错误: %+v", *f.Packs.Colophon)
	}
	/* 重新保存后 book.gvs 不再含 pack 字段 */
	if err := (&ProjectService{}).Save(dir, f); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "book.gvs"))
	if strings.Contains(string(raw), `"pack"`) {
		t.Errorf("保存后 book.gvs 仍含 pack 字段:\n%s", string(raw))
	}
	raw, _ = os.ReadFile(filepath.Join(dir, "setting.json"))
	if !strings.Contains(string(raw), `"packs"`) {
		t.Errorf("setting.json 未写出 packs 字段:\n%s", string(raw))
	}
}

// TestTrimAlphaPNG 图片入库前裁掉四周透明边：堂号章一类素材常带等距透明边，
// 不裁会让「占中缝宽的百分比」与实际视觉严重不符（实测 94×404 画布内印体仅 61×370）。
func TestTrimAlphaPNG(t *testing.T) {
	/* 40×60 画布，四周 5px 全透明，内容 30×50 */
	src := image.NewNRGBA(image.Rect(0, 0, 40, 60))
	for y := 5; y < 55; y++ {
		for x := 5; x < 35; x++ {
			src.SetNRGBA(x, y, color.NRGBA{R: 200, G: 30, B: 30, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, src); err != nil {
		t.Fatalf("encode: %v", err)
	}
	got, err := png.Decode(bytes.NewReader(trimAlphaPNG(buf.Bytes())))
	if err != nil {
		t.Fatalf("trim 后无法解码（产出了坏 PNG）: %v", err)
	}
	if b := got.Bounds(); b.Dx() != 30 || b.Dy() != 50 {
		t.Errorf("裁后尺寸 = %d×%d，期望 30×50", b.Dx(), b.Dy())
	}

	/* 本来就没有透明边 → 字节原样返回，不做无谓重编码 */
	flat := image.NewNRGBA(image.Rect(0, 0, 8, 8))
	for y := 0; y < 8; y++ {
		for x := 0; x < 8; x++ {
			flat.SetNRGBA(x, y, color.NRGBA{R: 9, G: 9, B: 9, A: 255})
		}
	}
	var fb bytes.Buffer
	if err := png.Encode(&fb, flat); err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !bytes.Equal(trimAlphaPNG(fb.Bytes()), fb.Bytes()) {
		t.Error("无透明边时不应改动字节")
	}

	/* 整幅透明 / 非 PNG → 原样返回：宁可不动，也不能把素材弄丢 */
	blank := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	var bb bytes.Buffer
	if err := png.Encode(&bb, blank); err != nil {
		t.Fatalf("encode: %v", err)
	}
	if !bytes.Equal(trimAlphaPNG(bb.Bytes()), bb.Bytes()) {
		t.Error("整幅透明时不应改动字节")
	}
	junk := []byte("not a png at all")
	if !bytes.Equal(trimAlphaPNG(junk), junk) {
		t.Error("非 PNG 应原样返回")
	}
}

// TestDedupeName 素材文件名去重保留扩展名（与只服务 .txt 的 dedupeFileName 区分）
func TestDedupeName(t *testing.T) {
	used := map[string]bool{}
	for _, want := range []string{"logo.png", "logo-2.png", "logo-3.png"} {
		if got := dedupeName("logo.png", used); got != want {
			t.Errorf("dedupeName = %q，期望 %q", got, want)
		}
	}
	used2 := map[string]bool{"图.jpg": true}
	if got := dedupeName("图.jpg", used2); got != "图-2.jpg" {
		t.Errorf("带中文名去重 = %q，期望 图-2.jpg", got)
	}
}
