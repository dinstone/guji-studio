package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProjectRoundtrip(t *testing.T) {
	dir := t.TempDir()

	// 保存一个含卷文/导读/附录的项目
	in := &BookProjectFlat{
		Name:     "道德经",
		Meta:     BookMeta{Title: "道德經", Author: "老子"},
		Template: map[string]any{"row_num": 18, "title_text": "道德經"},
		Packs: &PackPatches{
			Cover: &Patches{"coverTitle": "道德經"},
		},
		Chapters: []ChapterFull{
			{ID: "sc1", Title: "一章 体道", Text: "道可道非常道"},
			{ID: "sc2", Title: "卅八章 上德", Text: "上德不德是以有德"},
		},
		Volumes: []VolumeFull{
			{ID: "s1", Title: "卷一", Chapters: []string{"sc1"}},
			{ID: "s2", Title: "卷二", Chapters: []string{"sc2"}},
		},
		Blocks: []BlockFull{
			{ID: "f:preface", Name: "序", Type: "preface", Chapter: &ChapterFull{ID: "f:preface", Title: "序", Text: "道可道非常道"}},
			{ID: "f:postscript", Name: "跋", Type: "postscript", Chapter: &ChapterFull{ID: "f:postscript", Title: "跋", Text: "跋文"}},
		},
		Pubs: []Publication{
			{
				Title:    "全书",
				Front:    []PubGroup{{Pack: "封面"}, {Pack: "扉页"}, {Guide: "序"}},
				Chapters: []PubChapters{{Volume: "s1"}},
				Back:     []PubGroup{{Appendix: "跋"}},
			},
		},
	}
	if err := (&ProjectService{}).Save(dir, in); err != nil {
		t.Fatalf("Save: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(dir, "book.gvs"))
	if err != nil {
		t.Fatalf("book.gvs missing: %v", err)
	}
	if len(raw) > 0 && raw[0] != '{' {
		t.Fatal("book.gvs not json")
	}
	if _, err := os.Stat(filepath.Join(dir, "setting.json")); err != nil {
		t.Fatalf("setting.json missing: %v", err)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "guide", "序.txt"))
	if string(b) != "道可道非常道" {
		t.Fatalf("序 content = %q", b)
	}
	b, _ = os.ReadFile(filepath.Join(dir, "text", "一章 体道.txt"))
	if string(b) != "道可道非常道" {
		t.Fatalf("一章 content = %q", b)
	}

	out, err := (&ProjectService{}).Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if out.Name != "道德经" || out.Meta.Title != "道德經" || out.Template["row_num"] != float64(18) && out.Template["row_num"] != 18 {
		t.Fatalf("roundtrip meta mismatch: %+v", out)
	}
	if len(out.Volumes) != 2 || out.Volumes[1].Chapters[0] != "sc2" {
		t.Fatalf("roundtrip volumes mismatch: %+v", out.Volumes)
	}
	if len(out.Chapters) != 2 || out.Chapters[1].Text != "上德不德是以有德" {
		t.Fatalf("roundtrip chapters mismatch: %+v", out.Chapters)
	}

	// 未引用的旧文章文件应被清理（删除卷二后其章 txt 应被清理进 trash/）
	stray := filepath.Join(dir, "text", "stray.txt")
	os.WriteFile(stray, []byte("x"), 0o644)
	in.Volumes = in.Volumes[:1]
	in.Chapters = in.Chapters[:1]
	in.Pubs[0].Chapters = []PubChapters{{Volume: "s1"}}
	if err := (&ProjectService{}).Save(dir, in); err != nil {
		t.Fatalf("Save2: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "text", "stray.txt")); !os.IsNotExist(err) {
		t.Fatal("stray txt not cleaned")
	}
	if _, err := os.Stat(filepath.Join(dir, "text", "卅八章 上德.txt")); !os.IsNotExist(err) {
		t.Fatal("removed chapter txt not cleaned")
	}
}

func TestSettingsTouchRecent(t *testing.T) {
	t.Setenv("HOME", t.TempDir()) // macOS UserConfigDir 基于 HOME
	s := &SettingsService{}
	if _, err := s.TouchRecent("/a/one", "one"); err != nil {
		t.Fatalf("touch1: %v", err)
	}
	if _, err := s.TouchRecent("/b/two", "two"); err != nil {
		t.Fatalf("touch2: %v", err)
	}
	st, err := s.Get()
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if st.LastProjectDir != "/b/two" || len(st.Recents) != 2 || st.Recents[0].Name != "two" {
		t.Fatalf("settings mismatch: %+v", st)
	}
	if _, err := s.TouchRecent("/a/one", "one"); err != nil {
		t.Fatal(err)
	}
	st, _ = s.Get()
	if st.Recents[0].Dir != "/a/one" || len(st.Recents) != 2 {
		t.Fatalf("dedup/move-to-front failed: %+v", st.Recents)
	}
}
