package services

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestFontBlobRoundtrip 验证 OpenFont + ReadFontChunk 拼回的字节与磁盘上字体文件逐字节一致。
// 前端靠这两步把字体内联进 SVG 的 @font-face，字节一旦被截断或错位，@font-face 会静默失效、
// 导出回退系统宋体（竖排标点变弯引号），因此必须守住往返完整性。
func TestFontBlobRoundtrip(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("字体目录路径按 macOS 书写")
	}
	svc := &FontService{}
	items, err := svc.List()
	if err != nil || len(items) == 0 {
		t.Fatalf("List: %v / %d", err, len(items))
	}

	const want = "方正清刻本悦宋简体" // 本机 ~/Library/Fonts 下已装
	var picked string
	for _, it := range items {
		if it.Family == want || it.Label == want {
			picked = it.Family
			break
		}
	}
	if picked == "" {
		// 退回列表第一项：本用例只验往返，不依赖具体字体
		picked = items[0].Family
	}
	t.Logf("取样字体族: %s", picked)

	blob, err := svc.OpenFont(picked)
	if err != nil {
		t.Fatalf("OpenFont(%s): %v", picked, err)
	}
	if blob.Chunks < 1 || blob.ChunkSize <= 0 || blob.Size <= 0 {
		t.Fatalf("OpenFont 返回的描述异常: %+v", blob)
	}

	dec := make([]byte, 0, blob.Size)
	for i := 0; i < blob.Chunks; i++ {
		s, err := svc.ReadFontChunk(picked, i)
		if err != nil {
			t.Fatalf("ReadFontChunk(%d): %v", i, err)
		}
		b, err := base64.StdEncoding.DecodeString(s)
		if err != nil {
			t.Fatalf("第 %d 块不是合法 base64: %v", i, err)
		}
		dec = append(dec, b...)
	}
	if len(dec) != blob.Size {
		t.Fatalf("拼回长度 %d ≠ 声明长度 %d", len(dec), blob.Size)
	}
	if _, err := svc.ReadFontChunk(picked, blob.Chunks); err == nil {
		t.Fatalf("越界分块 #%d 应当报错", blob.Chunks)
	}

	// 与磁盘文件比对（ttc 子字体只取区间，故只在本体为单字体时要求逐字节相等）
	entry, ok := fontIndexOf()[picked]
	if ok {
		raw, err := os.ReadFile(entry.Path)
		if err == nil && entry.Offset <= 0 {
			if len(raw) != len(dec) {
				t.Fatalf("磁盘文件 %d 字节 ≠ 拼回 %d 字节", len(raw), len(dec))
			}
			for i := range raw {
				if raw[i] != dec[i] {
					t.Fatalf("第 %d 字节不一致（磁盘 %02x ≠ 拼回 %02x）", i, raw[i], dec[i])
				}
			}
			t.Logf("逐字节一致（%d 字节）: %s", len(raw), filepath.Base(entry.Path))
		}
	}
}
