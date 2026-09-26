package services

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

/* 这一族断言守的是「字体分块 base64 拼接」这条链，起因是一次极隐蔽的线上问题：
 *
 *   导出的 PDF 里字形不是用户选的那个字体，界面**完全不报错**。
 *   根因：FontChunkSize 曾是 512*1024 = 524288，而 524288 % 3 == 2。base64 是 3 字节 → 4 字符，
 *   末尾不足 3 字节时各自补 '='；前端又是把各块的 base64 **字符串**直接首尾相接再整体解码的
 *   （`s += await readFontChunk(family, i)`）。于是拼接串中间混进 '=' —— 宽松解码器解到第一个
 *   分块边界就停、浏览器 atob 直接抛 InvalidCharacterError。4MB 的字体只有头 512KB 有效，
 *   浏览器拿到残缺数据后**静默丢弃整条 @font-face 并回退系统默认中文字体**。
 *   症状与「字体内联没生效」完全一样，但此前一直被「SVG 体积涨了 5MB」误判成生效。
 *
 * 所以：分块字节数必须是 3 的倍数，且这条不变量由测试钉住，不能再靠人记住。 */

func TestFontChunkSizeIsMultipleOfThree(t *testing.T) {
	if FontChunkSize%3 != 0 {
		t.Fatalf("FontChunkSize = %d，不是 3 的倍数：非末块的 base64 会各自补 '=', "+
			"前端拼接后中间出现 '=', 解码在第一个分块边界断裂（字体会静默回退）", FontChunkSize)
	}
	if FontChunkSize < 64*1024 {
		t.Fatalf("FontChunkSize = %d 太小：分块数激增，IPC 往返次数与总耗时都会明显变差", FontChunkSize)
	}
}

// putFontData 把一段数据挂到后端的分块缓存里，返回清理函数。
func putFontData(t *testing.T, family string, data []byte) func() {
	t.Helper()
	fontDataMu.Lock()
	fontData[family] = data
	fontDataMu.Unlock()
	return func() {
		fontDataMu.Lock()
		delete(fontData, family)
		fontDataMu.Unlock()
	}
}

// concatChunks 完全按前端的做法走一遍：逐块取 base64 → 字符串首尾相接 → 整体解码。
// 中间任何补位 '=' 都会让整体解码失败，这正是它要抓的东西。
func concatChunks(t *testing.T, data []byte) []byte {
	t.Helper()
	const fam = "\x00fontchunk-test"
	defer putFontData(t, fam, data)()
	svc := &FontService{}
	chunks := (len(data) + FontChunkSize - 1) / FontChunkSize
	var sb strings.Builder
	for i := 0; i < chunks; i++ {
		s, err := svc.ReadFontChunk(fam, i)
		if err != nil {
			t.Fatalf("读第 %d/%d 块失败: %v", i+1, chunks, err)
		}
		sb.WriteString(s)
	}
	out, err := base64.StdEncoding.DecodeString(sb.String())
	if err != nil {
		t.Fatalf("拼接后的 base64 整体解码失败：%v（症状：分块边界不是 3 的倍数，中间混入了 '='）", err)
	}
	return out
}

// 非末块的 base64 绝不可以 '=' 结尾——这是「拼接后仍是一条合法 base64」的充要条件。
func TestNonLastChunkBase64HasNoPadding(t *testing.T) {
	data := make([]byte, FontChunkSize*2+7) // 3 块，末块 7 字节
	const fam = "\x00fontchunk-test"
	defer putFontData(t, fam, data)()
	svc := &FontService{}
	chunks := 3
	for i := 0; i < chunks-1; i++ {
		s, err := svc.ReadFontChunk(fam, i)
		if err != nil {
			t.Fatalf("读第 %d 块失败: %v", i, err)
		}
		if strings.HasSuffix(s, "=") {
			t.Fatalf("第 %d 块（共 %d 块）的 base64 以 '=' 结尾：说明它是自行补位的，"+
				"前端拼接后中间会出现 '='，整体解码将在该处断裂", i, chunks)
		}
		if len(s)%4 != 0 {
			t.Fatalf("第 %d 块的 base64 长度 %d 不是 4 的倍数（不是合法 base64 片段）", i, len(s))
		}
	}
}

// 跨多块拼接后必须逐字节还原（长度故意不整除，覆盖末块补位）。
func TestFontChunksConcatToSameBytes(t *testing.T) {
	n := FontChunkSize*2 + 12345
	data := make([]byte, n)
	for i := range data {
		data[i] = byte(i*31 + 7)
	}
	got := concatChunks(t, data)
	if len(got) != n {
		t.Fatalf("拼接解码后 %d 字节 ≠ 原始 %d 字节（分块边界未对齐 3 字节）", len(got), n)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("拼接解码后的内容与原始数据不一致")
	}
}

// 真机字体走一遍完整链路：索引 → 读二进制 → 分块 → 拼接 → 解码。
// 顺带把「命中的是哪个文件、多少字节、几块」打进日志，便于核对字重择优是否生效。
func TestRealFontChunksRoundTrip(t *testing.T) {
	e, ok := fontIndexOf()["FZQingKeBenYueSongS"]
	if !ok {
		t.Skip("本机未安装 FZQingKeBenYueSongS，跳过")
	}
	data, err := readFontData(e)
	if err != nil {
		t.Fatalf("读字体数据失败: %v", err)
	}
	t.Logf("族 FZQingKeBenYueSongS → %s（%d 字节，%d 块，weight=%d）",
		e.Path, len(data), (len(data)+FontChunkSize-1)/FontChunkSize, e.Weight)
	if len(data) < 2*FontChunkSize {
		t.Skipf("该字体仅 %d 字节（单块内），无法验证跨块拼接", len(data))
	}
	got := concatChunks(t, data)
	if !bytes.Equal(got, data) {
		t.Fatalf("真机字体拼接后 %d 字节 ≠ 原始 %d 字节", len(got), len(data))
	}
	switch string(got[:4]) { // 还原出来的必须是合法 sfnt 头，否则浏览器同样会丢弃
	case "\x00\x01\x00\x00", "OTTO", "true", "ttcf":
	default:
		t.Fatalf("还原后的头 4 字节是 %q，不是合法 sfnt 魔数", got[:4])
	}
}
