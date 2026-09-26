package services

import (
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"unicode/utf16"
)

// FontInfo 一个字体族条目。
// Family 是英文族名（CSS font-family / 渲染时使用，跨平台稳定）；
// Label 是本地化显示名（优先简体中文，如 Songti SC → 宋体-简），无本地化名时等于 Family。
type FontInfo struct {
	Family string `json:"family"`
	Label  string `json:"label"`
}

// FontService 枚举系统字体（纯 Go 解析字体 name 表，无外部命令、无 cgo）。
type FontService struct{}

func fontDirs() []string {
	if runtime.GOOS == "windows" {
		dirs := make([]string, 0, 2)
		if wd := os.Getenv("WINDIR"); wd != "" {
			dirs = append(dirs, filepath.Join(wd, "Fonts"))
		}
		if la := os.Getenv("LOCALAPPDATA"); la != "" { // 用户级安装的字体
			dirs = append(dirs, filepath.Join(la, "Microsoft", "Windows", "Fonts"))
		}
		if len(dirs) > 0 {
			return dirs
		}
	}
	home, _ := os.UserHomeDir()
	return []string{
		"/System/Library/Fonts",
		"/System/Library/Fonts/Supplemental",
		"/Library/Fonts",
		filepath.Join(home, "Library", "Fonts"),
	}
}

// List 返回去重排序后的字体列表。
// 显示名取字体 name 表的「本地化族名」（Windows 平台 zh-CN 记录优先，其次 zh-TW），
// 这样 macOS 上 Songti SC 显示为「宋体-简」、PingFang SC 显示为「苹方-简」，
// 与用户在 WPS / 系统字体面板里看到的名字一致；无中文记录的自定义字体回落英文族名。
func (s *FontService) List() ([]FontInfo, error) {
	seen := map[string]string{} // 英文族名 → 本地化显示名（首次非空为准）
	for _, dir := range fontDirs() {
		_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil // 权限不足等错误直接跳过
			}
			low := strings.ToLower(d.Name())
			if !strings.HasSuffix(low, ".ttf") && !strings.HasSuffix(low, ".otf") &&
				!strings.HasSuffix(low, ".ttc") && !strings.HasSuffix(low, ".otc") {
				return nil
			}
			f, err := os.Open(path)
			if err != nil {
				return nil
			}
			items := readFamilies(f)
			_ = f.Close()
			for _, it := range items {
				if it.Family == "" || strings.HasPrefix(it.Family, ".") { // 跳过 .xxx PUA 系统内部字体
					continue
				}
				if old, ok := seen[it.Family]; !ok || (old == "" && it.Label != "") {
					seen[it.Family] = it.Label
				}
			}
			return nil
		})
	}
	out := make([]FontInfo, 0, len(seen))
	for fam, lb := range seen {
		if lb == "" {
			lb = fam
		}
		out = append(out, FontInfo{Family: fam, Label: lb})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Label != out[j].Label {
			return out[i].Label < out[j].Label
		}
		return out[i].Family < out[j].Family
	})
	return out, nil
}

// fontEntry 一个族名对应的一份字体数据（ttc 记录子字体偏移，普通文件为 0）。
type fontEntry struct {
	Family string
	Path   string
	Offset int64
	Weight int  // OS/2 usWeightClass（400 = Regular），同族名多文件时用它择优
	Italic bool // head.macStyle / OS/2 fsSelection 的斜体位，同族名多文件时正体优先
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

/* rank 同族名多文件时的择优键，**越小越优**：正体一律优于斜体，其次看字重是否接近 400。
 *
 * 为什么必须把斜体单拎出来判：同一族的正体与斜体是**两个文件、族名完全相同**
 * （Times New Roman.ttf 与 Times New Roman Italic.ttf 都叫 "Times New Roman"），
 * 二者的 usWeightClass 又都是 400 —— 只比字重必然打平。而目录遍历按字典序、
 * "Italic" 恰好排在 ".ttf" 之前，于是索引留下**斜体文件**。内联进 SVG 时 @font-face
 * 不声明 font-style（浏览器按正体使用），结果是导出字形整体倾斜；预览走系统字体服务、
 * 按 font-style 挑到正体 —— 表现为「预览正体、导出斜体」（本册踩过：注音「xí」）。
 * 字重读不到时 weight=0 会得到 rank 400，与原「都是 0 时保留首个」的行为一致。 */
func (e fontEntry) rank() int { return pickRank(e.Weight, e.Italic) }

// pickRank 择优键本体（越小越优），供 fontEntry 与遍历中的临时项共用。
func pickRank(weight int, italic bool) int {
	dist := absInt(weight - 400)
	if italic {
		return 1<<20 + dist // 斜体无条件劣于任何同族正体
	}
	return dist
}

/* ---- 字体二进制读取：供导出时把字体内联进 SVG 的 @font-face ----
 * 导出走 new Image() → canvas 光栅化，SVG 此时是独立图片文档：既继承不到宿主文档的
 * @font-face，也不允许从外部 url 拉字体，自定义字体会回退成系统默认宋体（竖排标点形态
 * 一并失真）。唯一可靠的做法是把字体二进制 base64 内联进 SVG，故这里按族名定位文件、
 * 分块回传（Wails 单条 IPC 有体积上限，必须分片）。 */

// FontBlob 字体二进制的分块读取描述。
type FontBlob struct {
	Family    string `json:"family"`
	Size      int    `json:"size"`
	ChunkSize int    `json:"chunkSize"`
	Chunks    int    `json:"chunks"`
}

/* FontChunkSize 单个分块字节数。
 *
 * **必须能被 3 整除**：前端是把各分块的 base64 **字符串**直接首尾相接、再整体当一条 base64
 * 解码的（`s += readFontChunk(family, i)`）。而 base64 编码 3 字节 → 4 字符，末尾不足 3 字节
 * 时各自补 '='。分块字节数不是 3 的倍数时，每块结尾都有 '='，拼起来中间就冒出 '=' ——
 * 宽松解码器**解到第一个分块边界就停**，浏览器 atob 直接抛 InvalidCharacterError。
 * 后果极隐蔽：字体数据残缺 → 浏览器丢弃整条 @font-face → 静默回退系统默认中文字体，
 * 界面上只表现为「导出的字不是选的那个字体」，完全不报错（本册踩过：512K 余 2，
 * 一个 4MB 字体只有头 512KB 有效，导出字形一直是回退字体）。
 * 512K = 524288 余 2，故取 524286 = 512K - 2（仍是 512K 量级，IPC 体积无忧）。 */
const FontChunkSize = 512*1024 - (512*1024)%3

var (
	fontIndexOnce sync.Once
	fontIndex     map[string]fontEntry
	fontDataMu    sync.Mutex
	fontData      = map[string][]byte{}
)

// fontIndexOf 扫描字体目录建立「族名 → 字体文件」索引，进程内只扫一次。
func fontIndexOf() map[string]fontEntry {
	fontIndexOnce.Do(func() {
		m := map[string]fontEntry{}
		for _, dir := range fontDirs() {
			_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() {
					return nil
				}
				low := strings.ToLower(d.Name())
				if !strings.HasSuffix(low, ".ttf") && !strings.HasSuffix(low, ".otf") &&
					!strings.HasSuffix(low, ".ttc") && !strings.HasSuffix(low, ".otc") {
					return nil
				}
				f, err := os.Open(path)
				if err != nil {
					return nil
				}
				items := readEntries(f)
				_ = f.Close()
				for _, it := range items {
					if it.Family == "" || strings.HasPrefix(it.Family, ".") {
						continue
					}
					/* 同族名可能对应多个文件，择优顺序见 fontEntry.rank()：正体优先（排除
					 * "Times New Roman Italic" 这类同族名斜体文件），再取字重最接近 400 的
					 * （方正清刻本悦宋的 FZQingKBYSJW-EL.TTF(250) 与 -R.TTF(400) 族名都是
					 * FZQingKeBenYueSongS，按目录字典序取首个会命中超细体、比预览细一圈）。 */
					if old, ok := m[it.Family]; ok && pickRank(it.Weight, it.Italic) >= old.rank() {
						continue
					}
					m[it.Family] = fontEntry{Family: it.Family, Path: path, Offset: it.Offset, Weight: it.Weight, Italic: it.Italic}
				}
				return nil
			})
		}
		fontIndex = m
	})
	return fontIndex
}

// OpenFont 定位并读取字体二进制，返回分块描述（数据暂存在后端，前端按块取）。
func (s *FontService) OpenFont(family string) (FontBlob, error) {
	e, ok := fontIndexOf()[family]
	if !ok {
		/* 找不到族**不是错误**：新版 macOS 的部分系统字体（如楷体 Kaiti SC）不在 fontDirs 的
		 * 四个目录里，由系统字体服务提供，索引里天然没有；而 SVG 图片文档里写系统族名照样能画。
		 * 调用方（导出的字体内联）拿到 Size/Chunks 为 0 的 blob 跳过内联即可——返回 error
		 * 只会让 Wails 在控制台打一行 ERR，把真正的问题淹掉。 */
		return FontBlob{Family: family}, nil
	}
	data, err := readFontData(e)
	if err != nil {
		/* 取不到数据同样是**可预期降级**，与「索引里没有该族」同等处理：彩色 emoji 这类
		 * 位图字体会超出单表上限，坏字体文件也会读失败。前端拿到空的 Size/Chunks 会跳过
		 * 内联、按系统族名走回退，行为正常；这里返回 error 只会在 Wails 控制台刷一行 ERR，
		 * 把真正的问题淹掉（本册 Kaiti SC 那次就是这么被淹的）。 */
		return FontBlob{Family: family}, nil
	}
	n := (len(data) + FontChunkSize - 1) / FontChunkSize
	fontDataMu.Lock()
	fontData[family] = data
	fontDataMu.Unlock()
	return FontBlob{
		Family:    family,
		Size:      len(data),
		ChunkSize: FontChunkSize,
		Chunks:    n,
	}, nil
}

// ReadFontChunk 回传字体第 i 个分块的 base64（前端拼回完整二进制）。
func (s *FontService) ReadFontChunk(family string, i int) (string, error) {
	fontDataMu.Lock()
	data := fontData[family]
	fontDataMu.Unlock()
	if data == nil {
		return "", fmt.Errorf("字体未打开: %s", family)
	}
	off := i * FontChunkSize
	if off >= len(data) {
		return "", fmt.Errorf("字体分块越界: %s #%d", family, i)
	}
	end := off + FontChunkSize
	if end > len(data) {
		end = len(data)
	}
	return base64.StdEncoding.EncodeToString(data[off:end]), nil
}

/* ttcSubfontData 把集合文件（ttc/otc）里的一个子字体重建成**独立的单字体 sfnt**。
 *
 * 为什么不能直接切 [base, 下一个 base) 那一段：ttc 里每个子字体各有表目录（目录位置用 base
 * 定位），但目录里的表 offset 一律**相对文件开头**，各子字体的表数据往往集中存放在文件别处
 * （子字体之间可能只隔几百字节）。直接切片得到的是无意义字节 —— 前端照样 base64 内联，
 * 浏览器解析失败后静默回退系统字体，整件事只表现为「导出的字不是选的字体」。
 * macOS 上宋体、苹方、楷体、冬青黑体全是 ttc，本册实测 130/130 个 ttc 族都切坏了。
 *
 * 做法：按子字体的表目录逐表取数据，重拼成 header + 表目录 + 表 的单字体文件，
 * 表 offset 重算成新文件内的位置，表的 checksum 原样保留（值只与表数据有关，未变）。
 * head 表的 checkSumAdjustment 保留原值：严格校验器才会看它，浏览器不校验。 */
func ttcSubfontData(f *os.File, base int64) ([]byte, error) {
	hdr := make([]byte, 12)
	if _, err := f.ReadAt(hdr, base); err != nil {
		return nil, err
	}
	sig := append([]byte(nil), hdr[:4]...)
	numTables := int(binary.BigEndian.Uint16(hdr[4:6]))
	if numTables <= 0 || numTables > 1024 {
		return nil, fmt.Errorf("ttc 子字体表数异常: %d", numTables)
	}
	dir := make([]byte, numTables*16)
	if _, err := f.ReadAt(dir, base+12); err != nil {
		return nil, err
	}
	type tbl struct {
		tag  [4]byte
		csum uint32
		data []byte
	}
	tbls := make([]tbl, 0, numTables)
	for i := 0; i < numTables; i++ {
		r := dir[i*16 : i*16+16]
		off := int64(binary.BigEndian.Uint32(r[8:12]))
		ln := int64(binary.BigEndian.Uint32(r[12:16]))
		if ln <= 0 || ln > 1<<26 { // 单表上限 64MB，防坏文件
			return nil, fmt.Errorf("表 %s 长度异常: %d", r[:4], ln)
		}
		b := make([]byte, ln)
		if _, err := f.ReadAt(b, off); err != nil {
			return nil, err
		}
		var t tbl
		copy(t.tag[:], r[:4])
		t.csum = binary.BigEndian.Uint32(r[4:8])
		t.data = b
		tbls = append(tbls, t)
	}

	head := 12 + numTables*16
	total := head
	for _, t := range tbls {
		total += (len(t.data) + 3) &^ 3 // 每表 4 字节对齐
	}
	out := make([]byte, total)
	copy(out[:4], sig)
	binary.BigEndian.PutUint16(out[4:6], uint16(numTables))
	es := 0
	for 1<<(es+1) <= numTables {
		es++
	}
	sr := 16 << es
	binary.BigEndian.PutUint16(out[6:8], uint16(sr))                // searchRange
	binary.BigEndian.PutUint16(out[8:10], uint16(es))               // entrySelector
	binary.BigEndian.PutUint16(out[10:12], uint16(numTables*16-sr)) // rangeShift
	pos := head
	for i, t := range tbls {
		rec := out[12+i*16 : 12+i*16+16]
		copy(rec[:4], t.tag[:])
		binary.BigEndian.PutUint32(rec[4:8], t.csum)
		binary.BigEndian.PutUint32(rec[8:12], uint32(pos))
		binary.BigEndian.PutUint32(rec[12:16], uint32(len(t.data)))
		copy(out[pos:], t.data)
		pos += (len(t.data) + 3) &^ 3
	}
	return out, nil
}

// readFontData 取字体数据：普通文件整读；ttc 子字体重建为单字体 sfnt（见 ttcSubfontData）。
func readFontData(e fontEntry) ([]byte, error) {
	f, err := os.Open(e.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if e.Offset <= 0 {
		return io.ReadAll(f)
	}
	return ttcSubfontData(f, e.Offset)
}

// readFamilies 读出字体文件内全部子字体的 (英文族名, 本地化显示名)。
// 支持 ttf / otf / ttc / otc：ttc 先读集合头拿到各子字体的 sfnt 偏移。
func readFamilies(f *os.File) []FontInfo {
	out := make([]FontInfo, 0, 4)
	for _, it := range readEntries(f) {
		out = append(out, FontInfo{Family: it.Family, Label: it.Label})
	}
	return out
}

// fontNameEntry 带 sfnt 偏移的子字体名项（ttc 内偏移非零）。
type fontNameEntry struct {
	FontInfo
	Offset int64
	Weight int
	Italic bool
}

// readEntries 读出字体文件内全部子字体的族名与显示名，附 ttc 子字体偏移。
func readEntries(f *os.File) []fontNameEntry {
	head := make([]byte, 12)
	if _, err := f.ReadAt(head, 0); err != nil {
		return nil
	}
	var bases []int64
	switch string(head[:4]) {
	case "ttcf":
		b, err := ttcBases(f) // 集合头解析失败即视为坏文件
		if err != nil || len(b) == 0 {
			return nil
		}
		bases = b
	case "\x00\x01\x00\x00", "OTTO", "true": // TrueType / CFF / 旧 Apple TrueType
		bases = []int64{0}
	default:
		return nil
	}

	var out []fontNameEntry
	for _, base := range bases {
		en, zh := familyNamesAt(f, base)
		if en == "" && zh == "" {
			continue
		}
		if en == "" {
			en = zh
		}
		weight, italic := styleAt(f, base)
		out = append(out, fontNameEntry{
			FontInfo: FontInfo{Family: en, Label: zh},
			Offset:   base,
			Weight:   weight,
			Italic:   italic,
		})
	}
	return out
}

// ttcBases 读 ttcf 集合头，返回各子字体的 sfnt 偏移；非 ttc 返回空。
func ttcBases(f *os.File) ([]int64, error) {
	head := make([]byte, 12)
	if _, err := f.ReadAt(head, 0); err != nil {
		return nil, err
	}
	if string(head[:4]) != "ttcf" {
		return nil, nil
	}
	n := int64(binary.BigEndian.Uint32(head[8:12]))
	if n <= 0 || n > 512 {
		return nil, nil
	}
	offs := make([]byte, n*4)
	if _, err := f.ReadAt(offs, 12); err != nil {
		return nil, err
	}
	bases := make([]int64, 0, n)
	for i := int64(0); i < n; i++ {
		bases = append(bases, int64(binary.BigEndian.Uint32(offs[i*4:])))
	}
	return bases, nil
}

// familyNamesAt 定位子字体的 name 表，返回 (英文族名, 本地化族名)。
// 族名优先取 typographic family(16)（不含字重后缀，如「方正清刻本悦宋 简」），
// 缺失时回落 family(1)（可能带字重后缀，如「方正清刻本悦宋 简 R」）。
func familyNamesAt(f *os.File, base int64) (en, zh string) {
	hdr := make([]byte, 12)
	if _, err := f.ReadAt(hdr, base); err != nil {
		return
	}
	numTables := int(binary.BigEndian.Uint16(hdr[4:6]))
	if numTables <= 0 || numTables > 1024 {
		return
	}
	dir := make([]byte, numTables*16)
	if _, err := f.ReadAt(dir, base+12); err != nil {
		return
	}
	var nameOff, nameLen int64
	for i := 0; i < numTables; i++ {
		r := dir[i*16 : i*16+16]
		if string(r[:4]) == "name" {
			nameOff = int64(binary.BigEndian.Uint32(r[8:12]))
			nameLen = int64(binary.BigEndian.Uint32(r[12:16]))
			break
		}
	}
	if nameOff <= 0 || nameLen <= 0 || nameLen > 1<<22 { // 上限 4MB，防坏文件
		return
	}
	nd := make([]byte, nameLen)
	if _, err := f.ReadAt(nd, nameOff); err != nil {
		return
	}
	recs := parseNameRecords(nd)

	// 本地化显示名：简体中文优先，其次繁体
	zh = pickName(recs, 0x0804)
	if zh == "" {
		zh = pickName(recs, 0x0404)
	}
	// 英文族名：Windows en-US 优先；再退 Mac 平台 ASCII 记录
	en = pickName(recs, 0x0409)
	if en == "" {
		for _, r := range recs {
			if r.pid == 1 && r.nid == 1 && r.val != "" {
				en = r.val
				break
			}
		}
	}
	if en == "" {
		en = zh
	}
	return
}

// styleAt 一次读 OS/2 与 head 两张表，返回 (usWeightClass, 是否斜体)。
//
// 字重取 OS/2 表的 usWeightClass（400 = Regular）；斜体位**两处取或**：head 表 macStyle
// 的 bit 1，与 OS/2 表 fsSelection 的 bit 0（offset 62）。只认一处会漏判部分字体。
// 读不到的表按中性值处理（weight 0 / 非斜体），坏文件不会因误判成斜体而被择优丢弃。
//
// ⚠ **表数据的偏移是相对「文件开头」**，不是相对子字体 base —— 集合文件（ttc/otc）里
// 每个子字体各有表目录，但目录里的 offset 一律从文件头算起（OpenType 字体集合规范）。
// base 只用于定位**表目录本身**（base+12+i*16）。对普通文件 base=0 两者等价，所以
// 只有 .ttc 会暴露：按 base+off 读会把隔壁子字体的表当自己的，样式位整片串味
// （本册实测 Bodoni 72.ttc 的 Regular 子字体被读成斜体，择优时反而丢掉正体）。
func styleAt(f *os.File, base int64) (weight int, italic bool) {
	hdr := make([]byte, 12)
	if _, err := f.ReadAt(hdr, base); err != nil {
		return 0, false
	}
	numTables := int(binary.BigEndian.Uint16(hdr[4:6]))
	if numTables <= 0 || numTables > 1024 {
		return 0, false
	}
	dir := make([]byte, numTables*16)
	if _, err := f.ReadAt(dir, base+12); err != nil {
		return 0, false
	}
	var os2Off, headOff int64 = -1, -1
	for i := 0; i < numTables; i++ {
		r := dir[i*16 : i*16+16]
		switch string(r[:4]) {
		case "OS/2":
			os2Off = int64(binary.BigEndian.Uint32(r[8:12]))
		case "head":
			headOff = int64(binary.BigEndian.Uint32(r[8:12]))
		}
	}
	if os2Off >= 0 {
		b := make([]byte, 6) // version(2) + xAvgCharWidth(2) + usWeightClass(2)
		if _, err := f.ReadAt(b, os2Off); err == nil {
			weight = int(binary.BigEndian.Uint16(b[4:6]))
		}
		sel := make([]byte, 2) // fsSelection 在 OS/2 偏移 62（v0 起布局稳定）
		if _, err := f.ReadAt(sel, os2Off+62); err == nil && binary.BigEndian.Uint16(sel)&0x0001 != 0 {
			italic = true
		}
	}
	if headOff >= 0 {
		b := make([]byte, 2) // macStyle 在 head 偏移 44
		if _, err := f.ReadAt(b, headOff+44); err == nil && binary.BigEndian.Uint16(b)&0x0002 != 0 {
			italic = true
		}
	}
	return weight, italic
}

type nameRec struct {
	pid, eid, lang, nid uint16
	val                 string
}

// pickName 在指定 Windows 语言记录里取族名：typographic family(16) 优先，回落 family(1)。
func pickName(recs []nameRec, lang uint16) string {
	for _, nid := range []uint16{16, 1} {
		for _, r := range recs {
			if r.pid == 3 && r.lang == lang && r.nid == nid && r.val != "" {
				return r.val
			}
		}
	}
	return ""
}

// parseNameRecords 解析 name 表全部记录（格式 0/1 的记录布局一致）。
func parseNameRecords(b []byte) []nameRec {
	if len(b) < 6 {
		return nil
	}
	count := int(binary.BigEndian.Uint16(b[2:4]))
	strOff := int(binary.BigEndian.Uint16(b[4:6]))
	if count <= 0 || count > 8192 {
		return nil
	}
	out := make([]nameRec, 0, count)
	for i := 0; i < count; i++ {
		p := 6 + i*12
		if p+12 > len(b) {
			break
		}
		pid := binary.BigEndian.Uint16(b[p : p+2])
		ln := int(binary.BigEndian.Uint16(b[p+8 : p+10]))
		of := int(binary.BigEndian.Uint16(b[p+10 : p+12]))
		s := strOff + of
		if s < 0 || ln <= 0 || s+ln > len(b) {
			continue
		}
		r := nameRec{
			pid:  pid,
			eid:  binary.BigEndian.Uint16(b[p+2 : p+4]),
			lang: binary.BigEndian.Uint16(b[p+4 : p+6]),
			nid:  binary.BigEndian.Uint16(b[p+6 : p+8]),
			val:  decodeName(pid, b[s:s+ln]),
		}
		if r.val != "" {
			out = append(out, r)
		}
	}
	return out
}

// decodeName 解码 name 记录字符串：Unicode/Windows 平台为 UTF-16BE；
// Mac 平台编码因字体而异（中文多为 GB2312 等非 MacRoman），只接受纯 ASCII 以避免乱码名。
func decodeName(pid uint16, raw []byte) string {
	switch pid {
	case 0, 3:
		u := make([]uint16, 0, len(raw)/2)
		for i := 0; i+1 < len(raw); i += 2 {
			u = append(u, binary.BigEndian.Uint16(raw[i:i+2]))
		}
		return cleanName(string(utf16.Decode(u)))
	case 1:
		for _, c := range raw {
			if c < 0x20 || c > 0x7e {
				return ""
			}
		}
		return cleanName(string(raw))
	}
	return ""
}

func cleanName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Map(func(r rune) rune {
		if r == '\uFFFD' || (r < 0x20 && r != '\t') {
			return -1
		}
		return r
	}, s)
	return s
}
