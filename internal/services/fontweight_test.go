package services

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

/* 回归：同族名多字重时必须选字重最接近 Regular(400) 的那份。
 *
 * 背景：方正清刻本悦宋的 FZQingKBYSJW-EL.TTF（ExtraLight）与 FZQingKBYSJW-R.TTF（Regular）
 * 族名都叫 FZQingKeBenYueSongS。旧逻辑按 WalkDir 的目录字典序取首个，恰好命中 -EL，
 * 于是导出内联的是超细体，字形比预览细一圈——预览走系统字体服务，按 Regular 权重挑的是 -R。
 * 本机没装这两个文件时跳过（该字体是用户自装字体）。 */
func TestFontIndexPrefersRegularWeight(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("字体目录路径按 macOS 书写")
	}
	home, _ := os.UserHomeDir()
	reg := filepath.Join(home, "Library", "Fonts", "FZQingKBYSJW-R.TTF")
	el := filepath.Join(home, "Library", "Fonts", "FZQingKBYSJW-EL.TTF")
	for _, p := range []string{reg, el} {
		if _, err := os.Stat(p); err != nil {
			t.Skipf("本机缺 %s，跳过", filepath.Base(p))
		}
	}

	fr, err := os.Open(reg)
	if err != nil {
		t.Fatal(err)
	}
	defer fr.Close()
	fe, err := os.Open(el)
	if err != nil {
		t.Fatal(err)
	}
	defer fe.Close()

	wr := weightAt(fr, 0)
	we := weightAt(fe, 0)
	t.Logf("OS/2 usWeightClass: -R=%d  -EL=%d", wr, we)
	if wr != 400 {
		t.Errorf("Regular 的 usWeightClass 应为 400，实得 %d", wr)
	}
	if we >= wr {
		t.Errorf("ExtraLight 字重应小于 Regular（EL=%d，R=%d）", we, wr)
	}

	// 索引必须命中 Regular 那一份
	e, ok := fontIndexOf()["FZQingKeBenYueSongS"]
	if !ok {
		t.Fatalf("索引里没有 FZQingKeBenYueSongS")
	}
	if filepath.Base(e.Path) != "FZQingKBYSJW-R.TTF" {
		t.Errorf("同族名多字重时应选 Regular，实得 %s（weight=%d）", filepath.Base(e.Path), e.Weight)
	}
}

/* 回归：找不到族**不是错误**。
 *
 * 新版 macOS 的部分系统字体（如楷体 Kaiti SC）不在 fontDirs 的四个目录里，由系统字体服务
 * 提供，索引里天然没有；而 SVG 图片文档里写系统族名照样能画。导出侧拿到 Size/Chunks 为 0
 * 的 blob 自行跳过内联即可。若这里返回 error，Wails 会在控制台打一行 ERR（实际表现为
 * 「未找到字体族: Kaiti SC」），把真正的问题淹掉。 */
func TestOpenFontMissingFamilyIsNotError(t *testing.T) {
	blob, err := (&FontService{}).OpenFont("GujiNoSuchFamily-TestOnly")
	if err != nil {
		t.Fatalf("找不到族不该返回 error，实得 %v", err)
	}
	if blob.Size != 0 || blob.Chunks != 0 || blob.ChunkSize != 0 {
		t.Errorf("找不到族应返回空 blob，实得 %+v", blob)
	}
	if blob.Family != "GujiNoSuchFamily-TestOnly" {
		t.Errorf("回显族名不符：%q", blob.Family)
	}
}
