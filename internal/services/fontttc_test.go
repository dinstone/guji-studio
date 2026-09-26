package services

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* 审计：索引里来自**集合文件**（ttc/otc）的族，按 readFontData 切出来的数据能不能用作
 * @font-face 的字体源。
 *
 * 背景：ttc 的每个子字体各有表目录（目录位置 = base+12+i*16），但目录里的表 offset 是
 * **相对文件开头**的。readFontData 对 ttc 取的是 [base, 下一个子字体 base) 这段连续区间——
 * 若该子字体的表数据并不落在这个区间里（macOS 的集合文件常把各子字体的表集中存放、子字体
 * 之间只隔几百字节），切出来的就是一段无意义的字节。此时前端照样 base64 内联，
 * fontB64Ok 只看头 4 字节魔数，也可能放行，最终交付一个浏览器无法解析的"字体"，
 * 浏览器静默回退系统字体——正是「导出的字不是选的字体」的另一种成因。
 *
 * 本测试的判据：把切片的表目录逐个表的 offset+len 与本切片长度比对，越界即不可用。 */
func ttcEntryUsable(data []byte) (bool, string) {
	if len(data) < 12 {
		return false, "太短"
	}
	if m := string(data[:4]); m != "\x00\x01\x00\x00" && m != "OTTO" && m != "true" {
		return false, "魔数不是 sfnt"
	}
	numTables := int(binary.BigEndian.Uint16(data[4:6]))
	if numTables <= 0 || numTables > 1024 {
		return false, "表数为 0 或异常"
	}
	if 12+numTables*16 > len(data) {
		return false, "表目录越界"
	}
	for i := 0; i < numTables; i++ {
		r := data[12+i*16 : 12+i*16+16]
		off := int64(binary.BigEndian.Uint32(r[8:12]))
		ln := int64(binary.BigEndian.Uint32(r[12:16]))
		if off < 0 || ln < 0 || off+ln > int64(len(data)) {
			return false, "表 " + string(r[:4]) + " 数据落在切片之外"
		}
	}
	return true, ""
}

func TestTTCFontDataIsUsable(t *testing.T) {
	idx := fontIndexOf()
	total, broken, unreadable := 0, 0, 0
	var samples []string
	for fam, e := range idx {
		low := strings.ToLower(e.Path)
		if !strings.HasSuffix(low, ".ttc") && !strings.HasSuffix(low, ".otc") {
			continue
		}
		total++
		data, err := readFontData(e)
		if err != nil {
			/* 读取失败（表超限、坏文件）是**可接受的降级**：OpenFont 会返回空 blob，
			 * 前端跳过内联走系统族回退。真正要守的是「读出来了但结构坏」——那会被
			 * fontB64Ok 的头 4 字节魔数检查放过，静默交付一个浏览器无法解析的"字体"。 */
			unreadable++
			continue
		}
		if ok, why := ttcEntryUsable(data); !ok {
			broken++
			if len(samples) < 8 {
				samples = append(samples, fam+"："+why)
			}
		}
	}
	t.Logf("索引里来自 ttc/otc 的族 %d 个：结构坏 %d 个，读取失败（可接受降级）%d 个 %v",
		total, broken, unreadable, samples)
	if total == 0 {
		t.Skip("本机索引里没有 ttc/otc 族")
	}
	if broken > 0 {
		t.Errorf("有 %d/%d 个 ttc 族切出的字体**结构损坏**（会被静默内联交付，必须为 0）", broken, total)
	}
}

/* 把重建出的单字体写到磁盘，供**外部字体解析器**（fontTools / CoreText）校验。
 * 本仓库的判据只能证明「表目录自洽」，证明不了「解析器认得」——而浏览器正是解析器。
 * 默认跳过，需要时：
 *   mkdir -p /tmp/guji-ttc && GUJI_TTC_DUMP=/tmp/guji-ttc go test -run TestDumpTTC -v ./internal/services
 * 再用 fontTools 打开、读 numGlyphs 与 cmap 覆盖数。 */
func TestDumpTTCForExternalCheck(t *testing.T) {
	dir := os.Getenv("GUJI_TTC_DUMP")
	if dir == "" {
		t.Skip("未设置 GUJI_TTC_DUMP")
	}
	idx := fontIndexOf()
	for _, fam := range []string{"PingFang SC", "Songti SC", "Bodoni 72", "Times New Roman"} {
		e, ok := idx[fam]
		if !ok {
			t.Logf("索引里没有 %s", fam)
			continue
		}
		data, err := readFontData(e)
		if err != nil {
			t.Logf("%s 读取失败: %v", fam, err)
			continue
		}
		p := filepath.Join(dir, strings.ReplaceAll(fam, " ", "_")+".ttf")
		if err := os.WriteFile(p, data, 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("%s → %s（%d 字节；源 %s offset=%d）", fam, p, len(data), filepath.Base(e.Path), e.Offset)
	}
}
