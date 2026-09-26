package services

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// TestFontIndexPrefersUprightOverItalic 守住「同族名的正体优先于斜体」。
//
// Times New Roman 在 /System/Library/Fonts/Supplemental 下有四个文件，族名完全相同：
//   Times New Roman Bold Italic.ttf / Times New Roman Bold.ttf /
//   Times New Roman Italic.ttf / Times New Roman.ttf
// 只按 usWeightClass 择优时，Italic(400) 与正体(400) 打平、`>=` 保留先遍历到的那个，
// 而字典序里 "Italic" 排在 ".ttf" 之前 → 索引留下**斜体文件**。导出时内联进 SVG 的就是
// 斜体字形（@font-face 未声明 font-style，浏览器当正体用）；预览走系统字体服务，
// 按 font-style 挑到正体 —— 于是「预览正体、导出斜体」。
func TestFontIndexPrefersUprightOverItalic(t *testing.T) {
	e, ok := fontIndexOf()["Times New Roman"]
	if !ok {
		t.Skip("本机索引无 Times New Roman，跳过")
	}
	t.Logf("Times New Roman → %s（weight=%d, italic=%v）", e.Path, e.Weight, e.Italic)
	if e.Italic {
		t.Fatalf("索引命中斜体文件：%s —— 同族名应取正体", e.Path)
	}
	if e.Weight != 400 {
		t.Errorf("字重应为 400（Regular），实得 %d", e.Weight)
	}

	// 审计：索引里还有多少族最终落在「斜体文件」上。修复后应当极少——只有那些
	// **本机确实只装了斜体**的族才会如此；若样本里出现「同时有正体可选」的族，说明择优仍漏。
	all := fontIndexOf()
	var samples []string
	hit := 0
	for fam, it := range all {
		if it.Italic {
			hit++
			samples = append(samples, fam+" → "+filepath.Base(it.Path))
		}
	}
	sort.Strings(samples)
	shown := samples
	if len(shown) > 6 {
		shown = shown[:6]
	}
	t.Logf("索引共 %d 族，命中斜体文件的 %d 个 %v", len(all), hit, shown)
}

/* 回归：集合文件（ttc/otc）里的表偏移是**相对文件开头**，不是相对子字体 base。
 *
 * 每个子字体各有自己的表目录（目录位置 = base+12+i*16，用 base），但目录里的表 offset
 * 一律从文件头算起。写成 base+off 时对普通文件（base=0）毫无差别，只有 .ttc 会暴露——
 * 会把隔壁子字体的表当成自己的，样式位整片串味：Bodoni 72.ttc 的 Regular 子字体被判成斜体，
 * 择优时反倒丢掉正体（本册 397 族里有 28 个族的字号/斜体判定就是被这个错基准带偏的）。
 * macOS 上宋体（Songti.ttc）、苹方、楷体全是 ttc，这个坑面很宽。 */
func TestTTCSubfontStyleUsesFileRelativeOffsets(t *testing.T) {
	p := "/System/Library/Fonts/Supplemental/Bodoni 72.ttc"
	f, err := os.Open(p)
	if err != nil {
		t.Skip("本机无 Bodoni 72.ttc，跳过")
	}
	defer f.Close()
	bases, err := ttcBases(f)
	if err != nil || len(bases) < 2 {
		t.Skip("ttc 集合头解析异常，跳过")
	}
	upright := 0
	for _, b := range bases {
		w, it := styleAt(f, b)
		t.Logf("base=%d weight=%d italic=%v", b, w, it)
		if !it && w == 400 {
			upright++
		}
	}
	if upright == 0 {
		t.Errorf("Bodoni 72.ttc 的 %d 个子字体里应有非斜体 Regular，实得 0 个（偏移基准可能又写错了）", len(bases))
	}
	e, ok := fontIndexOf()["Bodoni 72"]
	if !ok {
		t.Skip("索引里无 Bodoni 72，跳过择优选中的校验")
	}
	if e.Italic {
		t.Errorf("索引命中斜体子字体（offset=%d path=%s），应取同族的正体", e.Offset, filepath.Base(e.Path))
	}
}

// TestStyleAtDetectsItalic 直接校验 head.macStyle / OS/2 fsSelection 的斜体位读数，
// 不依赖择优逻辑：逐个文件判定，正体必须判 false、Italic 系列必须判 true。
func TestStyleAtDetectsItalic(t *testing.T) {
	cases := []struct {
		path   string
		italic bool
	}{
		{"/System/Library/Fonts/Supplemental/Times New Roman.ttf", false},
		{"/System/Library/Fonts/Supplemental/Times New Roman Italic.ttf", true},
		{"/System/Library/Fonts/Supplemental/Times New Roman Bold.ttf", false},
		{"/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf", true},
	}
	checked := 0
	for _, c := range cases {
		f, err := os.Open(c.path)
		if err != nil {
			continue // 本机没有该文件就跳过这一条
		}
		weight, italic := styleAt(f, 0)
		_ = f.Close()
		checked++
		if italic != c.italic {
			t.Errorf("%s: italic 应为 %v，实得 %v（weight=%d）", c.path, c.italic, italic, weight)
		}
	}
	if checked == 0 {
		t.Skip("本机无 Times New Roman 系列文件，跳过")
	}
	t.Logf("校验了 %d 个文件的斜体位", checked)
}
