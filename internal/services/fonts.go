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

// FontChunkSize 单个分块字节数（对齐前端 saveBlobToOutput 的分块粒度）。
const FontChunkSize = 512 * 1024

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
					if _, ok := m[it.Family]; !ok {
						m[it.Family] = fontEntry{Family: it.Family, Path: path, Offset: it.Offset}
					}
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
		return FontBlob{}, fmt.Errorf("未找到字体族: %s", family)
	}
	data, err := readFontData(e)
	if err != nil {
		return FontBlob{}, err
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

// readFontData 取字体数据：普通文件整读；ttc 只取该子字体所在的连续区间。
func readFontData(e fontEntry) ([]byte, error) {
	f, err := os.Open(e.Path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if e.Offset <= 0 {
		return io.ReadAll(f)
	}
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	bases, err := ttcBases(f)
	if err != nil {
		return nil, err
	}
	end := st.Size()
	for _, b := range bases {
		if b > e.Offset && b < end {
			end = b
		}
	}
	n := end - e.Offset
	if n <= 0 {
		n = st.Size()
	}
	data := make([]byte, n)
	if _, err := f.ReadAt(data, e.Offset); err != nil {
		return nil, err
	}
	return data, nil
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
		out = append(out, fontNameEntry{FontInfo: FontInfo{Family: en, Label: zh}, Offset: base})
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
