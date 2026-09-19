package services

import (
	"encoding/binary"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
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

// readFamilies 读出字体文件内全部子字体的 (英文族名, 本地化显示名)。
// 支持 ttf / otf / ttc / otc：ttc 先读集合头拿到各子字体的 sfnt 偏移。
func readFamilies(f *os.File) []FontInfo {
	head := make([]byte, 12)
	if _, err := f.ReadAt(head, 0); err != nil {
		return nil
	}
	var bases []int64
	switch string(head[:4]) {
	case "ttcf":
		n := int64(binary.BigEndian.Uint32(head[8:12]))
		if n <= 0 || n > 512 {
			return nil
		}
		offs := make([]byte, n*4)
		if _, err := f.ReadAt(offs, 12); err != nil {
			return nil
		}
		for i := int64(0); i < n; i++ {
			bases = append(bases, int64(binary.BigEndian.Uint32(offs[i*4:])))
		}
	case "\x00\x01\x00\x00", "OTTO", "true": // TrueType / CFF / 旧 Apple TrueType
		bases = []int64{0}
	default:
		return nil
	}

	var out []FontInfo
	for _, base := range bases {
		en, zh := familyNamesAt(f, base)
		if en == "" && zh == "" {
			continue
		}
		if en == "" {
			en = zh
		}
		out = append(out, FontInfo{Family: en, Label: zh})
	}
	return out
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
