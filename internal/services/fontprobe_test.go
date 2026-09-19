package services

import (
	"strings"
	"testing"
)

func TestFontListSmoke(t *testing.T) {
	items, err := (&FontService{}).List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	zh := 0
	for _, it := range items {
		if it.Label != it.Family {
			zh++
		}
	}
	t.Logf("total families: %d，含本地化名: %d", len(items), zh)
	for i, it := range items {
		if i >= 8 {
			break
		}
		t.Logf("  %-28s %s", it.Family, it.Label)
	}
	// 抽查已知字体：macOS 上 Songti SC 的中文族名应为「宋体-简」
	for _, it := range items {
		if strings.EqualFold(it.Family, "Songti SC") {
			t.Logf("抽查 Songti SC → Label=%q", it.Label)
			if it.Label == "" || it.Label == it.Family {
				t.Errorf("Songti SC 未取到本地化名，Label=%q", it.Label)
			}
		}
	}
	if len(items) < 10 {
		t.Fatalf("too few families: %d", len(items))
	}
	if zh == 0 {
		t.Errorf("一条本地化名都没取到，name 表解析可能失效")
	}
}
