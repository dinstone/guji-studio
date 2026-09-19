// Package services 提供 GujiStudio 桌面端原生能力：
// 图书项目文件夹读写、应用设置持久化、系统字体枚举。
package services

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"io/fs"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// ---------------------------------------------------------------- 数据模型（v3 三文件）
//
// 图书项目 = 一个文件夹：
//
//	book.gvs     书名/作者/书级版式默认/特殊页默认 + 封面·扉页·尾页 LeafSpec（字段式包装叶）
//	setting.json 排版设置：chapters 文章池（{id,title}，file 由 title 派生）+
//	             volumes 卷（逻辑分组，{id,title,chapters[],template 补丁}，title 空 = 默认卷）+
//	             guide/appendix 固定角色单元条目（{name,derived?,mode?,template 补丁}，
//	             目录缺省为「派生」不落盘，derived=false（手动）才写 guide/目录.txt）
//	publish.json 出版设置：册数组（title + front/chapters/back 三段式有序选组）
//	text/        文章池正文：全部章节平铺 <title>.txt（重名自动 -2，改名后旧文件进 trash/）
//	guide/       导读：序.txt（目录为派生属性，手动模式才有 目录.txt）
//	appendix/    附录：跋.txt、牌记.txt
//	assets/      图片素材：图章 / 水印等用户导入的图片（原图拷贝，重名自动 -2）
//	trash/       垃圾文件夹：删除/改名后的旧文件移入，可找回
//	output/      导出产物（前端生成）
//
// 归一化：正文/卷/册之间一切引用走章 id；导读/附录为固定角色单文件（不能改名，按文件名引用）。
// 册 = front（pack+guide 前辅文）+ chapters（按卷/章选取）+ back（appendix+pack 后辅文），
// 三段各自有序数组，段内组间顺序即装订顺序。

const (
	bookFile    = "book.gvs"
	settingFile = "setting.json"
	publishFile = "publish.json"
	textDir     = "text"
	guideDir    = "guide"
	appendixDir = "appendix"
	assetsDir   = "assets"
	trashDir    = "trash"
)

// 旧版遗留目录：保存时移入 trash/（text 由 texts 改名、pack 内联进 book.gvs、卷子目录已废除）
var legacyDirs = []string{"texts", "pack", "scrolls"}

// 包装叶 kind
const (
	leafCover    = "cover"
	leafFly      = "fly"
	leafColophon = "colophon"
)

// fixedBlockDef 固定角色单元（导读/附录）：单文件、至多一个、不能改名
type fixedBlockDef struct {
	Type string // preface|toc|postscript|imprint
	Name string
	ID   string
	Dir  string
	File string
	// Derived 目录专用：默认「派生」（正文由卷/章结构生成，不落盘）；
	// 用户切「手动」后正文才落到 Dir/File（与序/跋同形）。
	Derived bool
}

var fixedBlocks = []fixedBlockDef{
	{"preface", "序", "f:preface", guideDir, "序.txt", false},
	{"toc", "目录", "f:toc", guideDir, "目录.txt", true},
	{"postscript", "跋", "f:postscript", appendixDir, "跋.txt", false},
	{"imprint", "牌记", "f:imprint", appendixDir, "牌记.txt", false},
}

func uid() string { return fmt.Sprintf("%d%x", time.Now().UnixNano(), rand.Uint32()) }

// ---------------------------------------------------------------- 磁盘结构

// book.gvs 书级全局：书名/作者/书级版式默认/书级特殊页默认。
// 包装叶（封面/扉页/尾页）的覆盖 patch 属于排版设置，落在 setting.json.packs（与 guide/appendix 同组）。
// setting.json 排版设置：chapters 文章池（{id,title}，file 由 title 派生）+
type Patches = map[string]any

// PackPatches 包装三叶的 patch 字典：key 存在 = 该叶要输出（替代旧的 book.gvs.pack 键存在性表达），
// value = 扁平的 SpecialCfg 字段覆盖（与 guide/appendix 条目一样，单层对象，不分 template/fields）。
// omitempty + 指针让任意一叶缺席时都不写出该键（既不占文件体积，也保持"该叶不输出"语义）。
type PackPatches struct {
	Cover    *Patches `json:"cover,omitempty"`
	Fly      *Patches `json:"fly,omitempty"`
	Colophon *Patches `json:"colophon,omitempty"`
}

type BookMeta struct {
	Title  string `json:"title"`
	Author string `json:"author"`
}

// BookProject book.gvs：全局信息 + 书级版式默认 + 书级特殊页默认
type BookProject struct {
	Name     string         `json:"name"`
	Meta     BookMeta       `json:"meta"`
	Template map[string]any `json:"template,omitempty"` // 书级默认版式参数
	Special  map[string]any `json:"special,omitempty"`  // 书级默认特殊页
}

// ChapterRef 文章池条目：file 由 title 派生，不落盘
type ChapterRef struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// VolumeSpec 卷（逻辑分组）：title 空 = 默认卷（恒排最前）
type VolumeSpec struct {
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Template map[string]any `json:"template,omitempty"`
	Chapters []string       `json:"chapters"`
}

// BlockSpec 固定角色单元条目（setting.json 的 guide/appendix 数组元素）：
// 目录可「派生」（正文由结构生成、不落盘）或「手动」（正文落 guide/目录.txt），其余对应 guide|appendix 下同名 txt；
// template = 版式补丁
type BlockSpec struct {
	Name string `json:"name"`
	// Derived 目录专用：nil/true = 派生（缺省即派生，兼容旧文件）；显式 false = 手动。
	// 必须用指针——bool + omitempty 会把 false 吞掉，手动状态无法落盘。
	Derived  *bool          `json:"derived,omitempty"`
	Mode     string         `json:"mode,omitempty"` // 目录条目来源：chapter=章名 / heading=##标题（仅 toc 用）
	Template map[string]any `json:"template,omitempty"`
}

// Setting setting.json：排版设置（chapters 池 + volumes 分组 + 固定角色单元 + 包装叶覆盖）
type Setting struct {
	Chapters []ChapterRef `json:"chapters"`
	Volumes  []VolumeSpec `json:"volumes"`
	Guide    []BlockSpec           `json:"guide,omitempty"`    // 导读：序、目录（派生）
	Appendix []BlockSpec           `json:"appendix,omitempty"` // 附录：跋、牌记
	Packs    *PackPatches          `json:"packs,omitempty"`    // 包装叶 patch：键存在 = 该叶要输出
	Blocks   map[string]*BlockSpec `json:"blocks,omitempty"`   // 旧版遗留字段：仅读取兼容，不再写出
}

// StrOrSlice 兼容「单值字符串」与「字符串数组（旧格式）」：序列化统一为单值字符串。
// 前端现已采用单值（{ "pack": "封面" }），但旧 publish.json 仍可能是数组，反序列化时取首个非空元素。
type StrOrSlice string

func (s *StrOrSlice) UnmarshalJSON(b []byte) error {
	var arr []string
	if err := json.Unmarshal(b, &arr); err == nil {
		for _, v := range arr {
			if v != "" {
				*s = StrOrSlice(v)
				break
			}
		}
		return nil
	}
	var str string
	if err := json.Unmarshal(b, &str); err == nil {
		*s = StrOrSlice(str)
		return nil
	}
	return fmt.Errorf("StrOrSlice: 无法解析 %s", string(b))
}

func (s StrOrSlice) MarshalJSON() ([]byte, error) {
	if s == "" {
		return []byte("null"), nil
	}
	return json.Marshal(string(s))
}

// PubGroup 册内一个选组：pack/guide/appendix 单值 = 该组选哪个（顺序完全由 front/back 数组顺序决定）
type PubGroup struct {
	Pack     StrOrSlice `json:"pack,omitempty"`     // 封面/扉页/尾页
	Guide    StrOrSlice `json:"guide,omitempty"`    // 序/目录
	Appendix StrOrSlice `json:"appendix,omitempty"` // 跋/牌记
}

// PubChapters 正文选取：整卷（Chapters 空）或卷内选章
type PubChapters struct {
	Volume   string   `json:"volume"`
	Chapters []string `json:"chapters,omitempty"`
}

// Publication 一册（物理装订视图）：front + chapters + back 三段式
type Publication struct {
	Title    string         `json:"title"`
	Template map[string]any `json:"template,omitempty"`
	Front    []PubGroup     `json:"front,omitempty"`
	Chapters []PubChapters  `json:"chapters,omitempty"`
	Back     []PubGroup     `json:"back,omitempty"`
}

// ---------------------------------------------------------------- 传输结构（正文内联）

type ChapterFull struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Text  string `json:"text"`
}

// BlockFull 固定角色单元（序/目录/跋/牌记）：0 或 1 个章
type BlockFull struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
	// Derived 目录专用：nil = 派生（无正文，不落盘）；显式 false = 手动（Chapter 里是手编目录正文）
	Derived  *bool          `json:"derived,omitempty"`
	Mode     string         `json:"mode,omitempty"` // 目录条目来源：chapter=章名 / heading=##标题（仅 toc 用）
	Template map[string]any `json:"template,omitempty"`
	Chapter  *ChapterFull   `json:"chapter,omitempty"`
}

type VolumeFull struct {
	ID       string         `json:"id"`
	Title    string         `json:"title"`
	Template map[string]any `json:"template,omitempty"`
	Chapters []string       `json:"chapters"`
}

type BookProjectFlat struct {
	Name     string         `json:"name"`
	Meta     BookMeta       `json:"meta"`
	Template map[string]any `json:"template,omitempty"`
	Special  map[string]any `json:"special,omitempty"`
	Packs    *PackPatches   `json:"packs,omitempty"`         // 包装叶覆盖 patch（取代旧 tree.pack）
	Chapters []ChapterFull  `json:"chapters"`                // 文章池（正文内联）
	Volumes  []VolumeFull   `json:"volumes"`
	Blocks   []BlockFull    `json:"blocks,omitempty"`        // 序/目录/跋/牌记（存在的才出现）
	Pubs     []Publication  `json:"pubs,omitempty"`
}

// ---------------------------------------------------------------- 对话框

// ChooseProjectDir 弹出文件夹选择框（打开/另存项目共用）
func (s *ProjectService) ChooseProjectDir(title string) (string, error) {
	path, err := application.Get().Dialog.OpenFile().
		CanChooseDirectories(true).
		CanChooseFiles(false).
		CanCreateDirectories(true).
		SetTitle(title).
		PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	return path, nil
}

// ---------------------------------------------------------------- 服务

type ProjectService struct{}

func safeFileName(name string) string {
	safe := strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\x00':
			return -1
		}
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, filepath.Base(name))
	safe = strings.TrimSpace(safe)
	if strings.Trim(safe, ".") == "" {
		return "guji-export.pdf"
	}
	return safe
}

// chapFileName 由文章名派生合法 .txt 文件名（清洗 + 补扩展名）
func chapFileName(name string) string {
	name = safeFileName(name)
	if name == "" || strings.Trim(name, ".") == "" {
		name = "未命名"
	}
	if !strings.HasSuffix(strings.ToLower(name), ".txt") {
		name += ".txt"
	}
	return name
}

// dedupeFileName 在 used 集合内去重：重名追加 -2/-3 序号
func dedupeFileName(name string, used map[string]bool) string {
	base := strings.TrimSuffix(name, ".txt")
	for i := 2; used[name]; i++ {
		name = fmt.Sprintf("%s-%d.txt", base, i)
	}
	used[name] = true
	return name
}

// poolFileNames 按池顺序为每章派生唯一文件名（Open/Save 用同一规则，保证文件映射一致）
func poolFileNames(chapters []ChapterRef) []string {
	used := map[string]bool{}
	out := make([]string, len(chapters))
	for i, c := range chapters {
		out[i] = dedupeFileName(chapFileName(c.Title), used)
	}
	return out
}

// OpenTempFile 把前端生成的文件（base64）写入系统临时目录并用系统默认程序打开
func (s *ProjectService) OpenTempFile(name string, dataB64 string) (string, error) {
	safe := safeFileName(name)
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return "", fmt.Errorf("base64 解码失败: %w", err)
	}
	dir := filepath.Join(os.TempDir(), "GujiStudio")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, safe)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return path, fmt.Errorf("打开文件失败: %w", err)
	}
	go cmd.Wait()
	return path, nil
}

// SaveExportFileChunk 分块写入导出文件：create=true 时创建/截断，否则追加到已有文件。
// 用于绕过 Wails 单条 IPC 调用体体积上限——前端把大文件（整本 PDF / 整张大图）切成若干块逐次调用。
// 返回 output 目录路径（每次调用都返回，便于取最终落盘目录）。
func (s *ProjectService) SaveExportFileChunk(dir, name, dataB64 string, create bool) (string, error) {
	safe := safeFileName(name)
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return "", fmt.Errorf("base64 解码失败: %w", err)
	}
	outDir := filepath.Join(dir, "output")
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(outDir, safe)
	flag := os.O_CREATE | os.O_WRONLY
	if create {
		flag |= os.O_TRUNC
	} else {
		flag |= os.O_APPEND
	}
	f, err := os.OpenFile(path, flag, 0o644)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return "", err
	}
	return outDir, nil
}

// OpenFolder 在文件管理器中打开指定目录（项目目录 / 导出后的 output/）
func (s *ProjectService) OpenFolder(path string) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("目录路径为空")
	}
	if st, err := os.Stat(path); err != nil || !st.IsDir() {
		return fmt.Errorf("目录不存在：%s", path)
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("explorer", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开目录失败: %w", err)
	}
	go cmd.Wait()
	return nil
}

// ImportFile 导入文件结果：Name 为去扩展名的文件名（用作章节标题），Content 为 UTF-8 文本。
type ImportFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// textExts 导入时接受的文本扩展名（小写，含前导点）
var textExts = map[string]bool{".txt": true, ".md": true, ".text": true, ".markdown": true}

// listTextFiles 递归收集目录下所有文本文件，按路径排序（保证导入顺序稳定）
func listTextFiles(dir string) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(p string, e fs.DirEntry, err error) error {
		if err != nil || e.IsDir() {
			return nil
		}
		if textExts[strings.ToLower(filepath.Ext(p))] {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

// ImportFiles 弹出「导入文件」对话框，用户可多选文件或文件夹；
// 选中的文件夹会展开其下所有文本文件。取消选择时返回空切片（非错误）。
// 返回每项 {Name(去扩展名), Content(UTF-8)}，供前端作为章节追加到当前卷。
func (s *ProjectService) ImportFiles() ([]ImportFile, error) {
	paths, err := application.Get().Dialog.OpenFile().
		CanChooseFiles(true).
		CanChooseDirectories(true).
		CanCreateDirectories(false).
		AddFilter("文本文件", "*.txt;*.md;*.text;*.markdown").
		SetTitle("导入到当前卷：选择文件或文件夹").
		PromptForMultipleSelection()
	if err != nil {
		return nil, err
	}
	var out []ImportFile
	for _, p := range paths {
		info, statErr := os.Stat(p)
		if statErr != nil {
			continue
		}
		var files []string
		if info.IsDir() {
			files = listTextFiles(p)
		} else {
			files = []string{p}
		}
		for _, f := range files {
			data, rerr := os.ReadFile(f)
			if rerr != nil {
				continue
			}
			name := strings.TrimSuffix(filepath.Base(f), filepath.Ext(f))
			out = append(out, ImportFile{Name: name, Content: string(data)})
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- 图片素材（assets/）
//
// 图片不进前端内存：导入时由 Go 直接拷进 项目/assets/，只把「文件名」回给前端存进版式参数；
// 预览/导出时前端按「项目目录 + 文件名」向 Go 要 base64 → dataURL，与项目文件夹整体可搬走。

// imageExts 允许导入的图片扩展名
var imageExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".webp": true,
	".gif": true, ".bmp": true, ".svg": true,
}

// ImportImage 弹出「选择图片」对话框，把选中的图片拷贝进项目 assets/ 目录（重名自动 -2），
// 返回落盘后的文件名切片（不含目录，可直接写进版式参数）。用户取消时返回空切片（非错误）。
func (s *ProjectService) ImportImage(dir string) ([]string, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, fmt.Errorf("项目尚未保存到磁盘，无法导入图片")
	}
	paths, err := application.Get().Dialog.OpenFile().
		CanChooseFiles(true).
		CanChooseDirectories(false).
		CanCreateDirectories(false).
		AddFilter("图片", "*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp").
		SetTitle("导入图片到项目 assets/ 目录").
		PromptForMultipleSelection()
	if err != nil {
		return nil, err
	}
	if len(paths) == 0 {
		return nil, nil
	}
	dst := filepath.Join(dir, assetsDir)
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return nil, err
	}
	used := map[string]bool{}
	if ents, derr := os.ReadDir(dst); derr == nil {
		for _, e := range ents {
			if !e.IsDir() {
				used[e.Name()] = true
			}
		}
	}
	var out []string
	for _, p := range paths {
		data, rerr := os.ReadFile(p)
		if rerr != nil {
			continue
		}
		name := safeFileName(filepath.Base(p))
		if !imageExts[strings.ToLower(filepath.Ext(name))] {
			continue
		}
		/* PNG 去掉四周透明留白：堂号章一类素材常带等距透明边（实测 94×404 画布内印体仅 61×370），
		   不去掉会让「占叶宽百分比」的尺寸与视觉严重不符 */
		if strings.EqualFold(filepath.Ext(name), ".png") {
			data = trimAlphaPNG(data)
		}
		name = dedupeName(name, used)
		if werr := os.WriteFile(filepath.Join(dst, name), data, 0o644); werr != nil {
			continue
		}
		out = append(out, name)
	}
	return out, nil
}

// ReadProjectAsset 读项目 assets/ 里的图片，返回 base64（不带 data: 前缀，由前端拼 dataURL）。
func (s *ProjectService) ReadProjectAsset(dir, name string) (string, error) {
	if strings.TrimSpace(dir) == "" || strings.TrimSpace(name) == "" {
		return "", nil
	}
	/* filepath.Base 兜住 ../ 穿越：参数里只允许出现文件名，不接受任何目录成分 */
	p := filepath.Join(dir, assetsDir, filepath.Base(name))
	data, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// ListProjectAssets 列出项目 assets/ 里的图片文件名，供面板复用已导入素材。
// 目录不存在视为「暂无素材」，返回空切片而非错误。
func (s *ProjectService) ListProjectAssets(dir string) ([]string, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, nil
	}
	ents, err := os.ReadDir(filepath.Join(dir, assetsDir))
	if err != nil {
		return nil, nil
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() || !imageExts[strings.ToLower(filepath.Ext(e.Name()))] {
			continue
		}
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out, nil
}

// trimAlphaPNG 裁掉 PNG 四周完全透明的边（内容边界 = alpha bbox），返回重新编码的 PNG。
// 非 PNG、解码失败、整幅透明或本来就没有透明边时原样返回 —— 宁可不动，不能弄丢素材。
func trimAlphaPNG(data []byte) []byte {
	src, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return data
	}
	b := src.Bounds()
	minX, minY := b.Max.X, b.Max.Y
	maxX, maxY := b.Min.X-1, b.Min.Y-1
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if _, _, _, a := src.At(x, y).RGBA(); a > 0x0800 { // ≈3% 不透明即算内容，滤掉极淡抗锯齿
				if x < minX {
					minX = x
				}
				if x > maxX {
					maxX = x
				}
				if y < minY {
					minY = y
				}
				if y > maxY {
					maxY = y
				}
			}
		}
	}
	if maxX < minX || maxY < minY {
		return data
	}
	nb := image.Rect(0, 0, maxX-minX+1, maxY-minY+1)
	if nb.Dx() == b.Dx() && nb.Dy() == b.Dy() {
		return data
	}
	dst := image.NewNRGBA(nb)
	draw.Draw(dst, nb, src, image.Pt(minX, minY), draw.Src)
	var buf bytes.Buffer
	if err := png.Encode(&buf, dst); err != nil {
		return data
	}
	return buf.Bytes()
}

// dedupeName 在 used 内去重，保留原扩展名（重名追加 -2/-3）。
// 与 dedupeFileName 的区别：后者写死 .txt，只能给章节用；素材（图片）文件名各异，故另立。
func dedupeName(name string, used map[string]bool) string {
	if !used[name] {
		used[name] = true
		return name
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s-%d%s", base, i, ext)
		if !used[c] {
			used[c] = true
			return c
		}
	}
}

// Open 读取项目文件夹：book.gvs + setting.json + publish.json + text|guide|appendix 平铺正文。
func (s *ProjectService) Open(dir string) (*BookProjectFlat, error) {
	if dir == "" {
		return nil, fmt.Errorf("未指定项目目录")
	}
	raw, err := os.ReadFile(filepath.Join(dir, bookFile))
	if err != nil {
		return nil, fmt.Errorf("读取 %s 失败: %w", bookFile, err)
	}
	var book BookProject
	if err := json.Unmarshal(raw, &book); err != nil {
		return nil, fmt.Errorf("解析 %s 失败: %w", bookFile, err)
	}
	var setting Setting
	if raw, err := os.ReadFile(filepath.Join(dir, settingFile)); err == nil {
		if err := json.Unmarshal(raw, &setting); err != nil {
			return nil, fmt.Errorf("解析 %s 失败: %w", settingFile, err)
		}
	}
	// 一次性迁移：旧版 book.gvs.pack.{cover|fly|colophon}.{template, fields} → setting.json.packs 同名叶
	// 旧结构里 template 是样式、fields 是文字，分两个 map 落盘；新结构扁平合并到同一个 map。
	// 迁移完成后下次 Save 时 book.gvs 不再写 pack，setting.json 写出 packs，原数据无损。
	migratePackPatches(dir, &setting)
	// 无任何包装叶 patch（迁移后或全新项目）时补默认三叶：保证封面设计视图可用
	if setting.Packs == nil {
		setting.Packs = &PackPatches{}
	}
	if setting.Packs.Cover == nil && setting.Packs.Fly == nil && setting.Packs.Colophon == nil {
		mk := func() *Patches { return &Patches{} }
		setting.Packs.Cover, setting.Packs.Fly, setting.Packs.Colophon = mk(), mk(), mk()
	}
	var pubs []Publication
	if raw, err := os.ReadFile(filepath.Join(dir, publishFile)); err == nil {
		if err := json.Unmarshal(raw, &pubs); err != nil {
			return nil, fmt.Errorf("解析 %s 失败: %w", publishFile, err)
		}
	}

	// 文章池：按池顺序派生文件名并读入正文
	names := poolFileNames(setting.Chapters)
	chapters := []ChapterFull{}
	for i, ref := range setting.Chapters {
		text, _ := os.ReadFile(filepath.Join(dir, textDir, names[i]))
		chapters = append(chapters, ChapterFull{ID: ref.ID, Title: ref.Title, Text: string(text)})
	}

	// 卷（id 原样保留，引用不漂移）
	volumes := []VolumeFull{}
	for _, v := range setting.Volumes {
		volumes = append(volumes, VolumeFull{ID: v.ID, Title: v.Title, Template: v.Template, Chapters: v.Chapters})
	}

	// 固定角色单元：条目（guide/appendix 数组按 name 匹配）或文件存在即出现，顺序恒为 序→目录 / 跋→牌记
	byName := map[string]*BlockSpec{}
	for i := range setting.Guide {
		byName[setting.Guide[i].Name] = &setting.Guide[i]
	}
	for i := range setting.Appendix {
		byName[setting.Appendix[i].Name] = &setting.Appendix[i]
	}
	blocks := []BlockFull{}
	for _, def := range fixedBlocks {
		spec := byName[def.Name]
		if spec == nil {
			spec = setting.Blocks[def.Type] // 旧版 blocks map（按 type 键）兜底
		}
		// 目录「派生」（条目缺省 / derived 缺省）：不落盘，只登记一个无正文的单元
		if def.Derived && derivedOf(specDerived(spec)) {
			if spec == nil {
				continue
			}
			blocks = append(blocks, BlockFull{
				ID: def.ID, Name: def.Name, Type: def.Type, Derived: boolPtr(true),
				Mode: spec.Mode, Template: spec.Template,
			})
			continue
		}
		// 手动目录 / 序跋牌记：正文读 Dir/File（文件缺失但条目存在时正文为空）
		text, rerr := os.ReadFile(filepath.Join(dir, def.Dir, def.File))
		if rerr != nil && spec == nil {
			continue
		}
		bf := BlockFull{
			ID: def.ID, Name: def.Name, Type: def.Type,
			Template: specTemplate(spec),
			Chapter:  &ChapterFull{ID: def.ID, Title: def.Name, Text: string(text)},
		}
		if def.Derived {
			bf.Derived = boolPtr(false) // 显式 false = 手动，前端据此可编辑
			bf.Mode = spec.Mode
		}
		blocks = append(blocks, bf)
	}

	return &BookProjectFlat{
		Name: book.Name, Meta: book.Meta, Template: book.Template, Special: book.Special,
		Packs:    setting.Packs,
		Chapters: chapters,
		Volumes:  volumes,
		Blocks:   blocks,
		Pubs:     pubs,
	}, nil
}

// migratePackPatches 旧版 book.gvs.pack:{cover|fly|colophon}.{template, fields} → setting.Packs 同名叶
// 一次性合两个 map（fields 是 string，template 是 any）成扁平 Patches（map[string]any）。
// 旧 LeafSpec 不再保留——template/fields 区分在 SpecialCfg 层面无意义（所有字段最后 Object.assign 同一 base）。
// 此函数仅在新结构首次落盘前的旧项目上执行一次；新项目无 pack 字段直接 return。
func migratePackPatches(dir string, setting *Setting) {
	raw, err := os.ReadFile(filepath.Join(dir, bookFile))
	if err != nil {
		return
	}
	// 旧版内联类型：仅此处使用，不导出
	var old struct {
		Pack *struct {
			Cover    *struct {
				Template map[string]any    `json:"template,omitempty"`
				Fields   map[string]string `json:"fields,omitempty"`
			} `json:"cover,omitempty"`
			Fly *struct {
				Template map[string]any    `json:"template,omitempty"`
				Fields   map[string]string `json:"fields,omitempty"`
			} `json:"fly,omitempty"`
			Colophon *struct {
				Template map[string]any    `json:"template,omitempty"`
				Fields   map[string]string `json:"fields,omitempty"`
			} `json:"colophon,omitempty"`
		} `json:"pack"`
	}
	if err := json.Unmarshal(raw, &old); err != nil || old.Pack == nil {
		return
	}
	merge := func(leaf *struct {
		Template map[string]any    `json:"template,omitempty"`
		Fields   map[string]string `json:"fields,omitempty"`
	}) *Patches {
		if leaf == nil {
			return nil
		}
		out := Patches{}
		for k, v := range leaf.Template {
			out[k] = v
		}
		for k, v := range leaf.Fields {
			out[k] = v
		}
		return &out
	}
	if setting.Packs == nil {
		setting.Packs = &PackPatches{}
	}
	if setting.Packs.Cover == nil {
		setting.Packs.Cover = merge(old.Pack.Cover)
	}
	if setting.Packs.Fly == nil {
		setting.Packs.Fly = merge(old.Pack.Fly)
	}
	if setting.Packs.Colophon == nil {
		setting.Packs.Colophon = merge(old.Pack.Colophon)
	}
	// book 是 Open 的局部变量，下次 Save 用 BookProject{} 重建（不含 Pack 字段），旧格式自然消亡
}

// Save 将完整项目写回文件夹：book.gvs + setting.json + publish.json + 平铺正文。
func (s *ProjectService) Save(dir string, p *BookProjectFlat) error {
	if dir == "" {
		return fmt.Errorf("未指定项目目录")
	}
	if p.Name == "" {
		return fmt.Errorf("项目名不能为空")
	}
	// 目录（text/ guide/ appendix/）一律按需创建：空项目不该在磁盘上留下一堆空文件夹，
	// 建目录的动作推迟到真正要写文件时（见下）。

	// book.gvs：书级全局（无 pack——包装叶 patch 改放 setting.json.packs）
	book := BookProject{Name: p.Name, Meta: p.Meta, Template: p.Template, Special: p.Special}
	if raw, err := json.MarshalIndent(&book, "", "  "); err != nil {
		return err
	} else if err := os.WriteFile(filepath.Join(dir, bookFile), append(raw, '\n'), 0o644); err != nil {
		return fmt.Errorf("写 %s 失败: %w", bookFile, err)
	}

	// 文章池：id 去重 → 按池顺序派生文件名 → 写正文
	usedIDs := map[string]bool{}
	refs := make([]ChapterRef, 0, len(p.Chapters))
	for _, c := range p.Chapters {
		id := c.ID
		if id == "" || usedIDs[id] {
			id = uid()
			for usedIDs[id] {
				id = uid()
			}
		}
		usedIDs[id] = true
		refs = append(refs, ChapterRef{ID: id, Title: c.Title})
	}
	names := poolFileNames(refs)
	if len(p.Chapters) > 0 {
		if err := os.MkdirAll(filepath.Join(dir, textDir), 0o755); err != nil {
			return fmt.Errorf("创建 %s 目录失败: %w", textDir, err)
		}
	}
	for i, c := range p.Chapters {
		if err := os.WriteFile(filepath.Join(dir, textDir, names[i]), []byte(c.Text), 0o644); err != nil {
			return fmt.Errorf("写正文 %s 失败: %w", names[i], err)
		}
	}

	// 卷
	volumes := make([]VolumeSpec, 0, len(p.Volumes))
	for _, v := range p.Volumes {
		id := v.ID
		if id == "" {
			id = uid()
		}
		chaps := append([]string{}, v.Chapters...)
		volumes = append(volumes, VolumeSpec{ID: id, Title: v.Title, Template: v.Template, Chapters: chaps})
	}

	// 固定角色单元：存在的写文件并登记 guide/appendix 条目（派生目录只登记条目不写文件），
	// 缺席的旧文件移入 trash/
	guideSpecs, appendixSpecs := []BlockSpec{}, []BlockSpec{}
	have := map[string]bool{}
	for _, b := range p.Blocks {
		have[b.Type] = true
		sp := BlockSpec{Name: blockName(b.Type), Derived: b.Derived, Mode: b.Mode, Template: b.Template}
		if b.Type == "preface" || b.Type == "toc" {
			guideSpecs = append(guideSpecs, sp)
		} else {
			appendixSpecs = append(appendixSpecs, sp)
		}
	}
	for _, def := range fixedBlocks {
		b := findBlock(p.Blocks, def.Type)
		// 派生目录不落盘（正文由结构生成）；同时保留磁盘上旧 guide/目录.txt 不动，
		// 这样「派生 → 手动」切回来还能恢复上次手改的正文。单元被整个删掉时才回收旧文件。
		if def.Derived && b != nil && derivedOf(b.Derived) {
			continue
		}
		path := filepath.Join(def.Dir, def.File)
		if have[def.Type] {
			text := ""
			if b != nil && b.Chapter != nil {
				text = b.Chapter.Text
			}
			if err := os.MkdirAll(filepath.Join(dir, def.Dir), 0o755); err != nil {
				return fmt.Errorf("创建 %s 目录失败: %w", def.Dir, err)
			}
			if err := os.WriteFile(filepath.Join(dir, path), []byte(text), 0o644); err != nil {
				return fmt.Errorf("写 %s 失败: %w", path, err)
			}
		} else if _, err := os.Stat(filepath.Join(dir, path)); err == nil {
			moveToTrash(dir, path)
		}
	}

	// publish.json / setting.json：内容为空时不落盘（空项目磁盘上只有 book.gvs，
	// 结构随编辑逐步长出）。已有旧文件必须删掉——否则"删光所有章/册"后重开会读到幽灵数据。
	pubRaw, err := json.MarshalIndent(p.Pubs, "", "  ")
	if err != nil {
		return err
	}
	if err := writeOrRemove(dir, publishFile, pubRaw, len(p.Pubs) > 0); err != nil {
		return err
	}

	setting := Setting{Chapters: refs, Volumes: volumes, Guide: guideSpecs, Appendix: appendixSpecs, Packs: p.Packs}
	setRaw, err := json.MarshalIndent(&setting, "", "  ")
	if err != nil {
		return err
	}
	keepSetting := !settingEmpty(refs, volumes, guideSpecs, appendixSpecs, p.Packs)
	if err := writeOrRemove(dir, settingFile, setRaw, keepSetting); err != nil {
		return err
	}

	// text/ 中不再被引用的 .txt（删章/改名后的孤儿）移入 trash/
	cleanupTexts(dir, fileSet(names))
	// 旧版遗留目录移入 trash/
	for _, d := range legacyDirs {
		moveToTrash(dir, d)
	}
	return nil
}

// writeOrRemove 落盘一个 json：keep=false 时改为删除文件（项目结构为空时不留空壳，
// 也避免"删光后重开又冒出旧数据"）。文件不存在时删除静默跳过。
func writeOrRemove(dir, file string, raw []byte, keep bool) error {
	path := filepath.Join(dir, file)
	if !keep {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("清理 %s 失败: %w", file, err)
		}
		return nil
	}
	if err := os.WriteFile(path, append(raw, '\n'), 0o644); err != nil {
		return fmt.Errorf("写 %s 失败: %w", file, err)
	}
	return nil
}

// settingEmpty 判断 setting.json 是否无内容可写：无章、无卷、无导读附录条目，
// 且包装三叶没有任何覆盖 patch（三叶全空时 Open 会自动补默认三叶，无需落盘）。
func settingEmpty(refs []ChapterRef, volumes []VolumeSpec, guide, appendix []BlockSpec, packs *PackPatches) bool {
	if len(refs) > 0 || len(volumes) > 0 || len(guide) > 0 || len(appendix) > 0 {
		return false
	}
	if packs == nil {
		return true
	}
	for _, m := range []*Patches{packs.Cover, packs.Fly, packs.Colophon} {
		if m != nil && len(*m) > 0 {
			return false
		}
	}
	return true
}

func findBlock(blocks []BlockFull, typ string) *BlockFull {
	for i := range blocks {
		if blocks[i].Type == typ {
			return &blocks[i]
		}
	}
	return nil
}

func boolPtr(b bool) *bool { return &b }

// derivedOf 目录「派生」判定：nil（旧文件缺省）或显式 true = 派生；显式 false = 手动
func derivedOf(p *bool) bool { return p == nil || *p }

// specDerived 取条目的 derived（条目可能为 nil：磁盘上有孤立 txt 而 setting.json 无条目）
func specDerived(spec *BlockSpec) *bool {
	if spec == nil {
		return nil
	}
	return spec.Derived
}

// specTemplate 取条目的版式补丁（同上，spec 可能为 nil）
func specTemplate(spec *BlockSpec) map[string]any {
	if spec == nil {
		return nil
	}
	return spec.Template
}

// blockName 固定单元 type → 显示名/文件名（序/目录/跋/牌记）
func blockName(t string) string {
	for _, d := range fixedBlocks {
		if d.Type == t {
			return d.Name
		}
	}
	return t
}

func fileSet(names []string) map[string]bool {
	m := make(map[string]bool, len(names))
	for _, n := range names {
		m[n] = true
	}
	return m
}

// moveToTrash 把项目内相对路径 rel（文件或目录）移入 trash/ 垃圾文件夹（方便后悔找回）；
// 重名追加时间戳后缀。任何失败都静默（垃圾回收不该阻塞保存）。
func moveToTrash(dir, rel string) {
	src := filepath.Join(dir, rel)
	if _, err := os.Stat(src); err != nil {
		return
	}
	trashBase := filepath.Join(dir, trashDir)
	if err := os.MkdirAll(trashBase, 0o755); err != nil {
		return
	}
	name := filepath.Base(rel)
	stamp := time.Now().Format("0102-150405")
	dst := filepath.Join(trashBase, name+"."+stamp)
	for i := 2; ; i++ {
		if _, err := os.Lstat(dst); err != nil {
			break
		}
		dst = filepath.Join(trashBase, fmt.Sprintf("%s.%s-%d", name, stamp, i))
	}
	_ = os.Rename(src, dst)
}

// cleanupTexts 把 text/ 下不再被引用的 .txt（章被删除或改名后的孤儿文件）移入 trash/
func cleanupTexts(dir string, keep map[string]bool) {
	entries, err := os.ReadDir(filepath.Join(dir, textDir))
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".txt") || keep[e.Name()] {
			continue
		}
		moveToTrash(dir, filepath.Join(textDir, e.Name()))
	}
}

// EnsureNewProject 在 dir 初始化一个最小新项目：**只写 book.gvs**（项目身份证）。
//
// 章 / 卷 / 册 / 导读附录一律不预建：项目结构由用户在编辑过程中逐步完善，
// 首次保存时才按需生成 setting.json / publish.json / text/ 等（见 Save）。
// 覆盖已有项目时，旧的三文件与正文目录整体移入 trash/（可找回），
// 否则打开时会读到上一本书的残留内容。
func (s *ProjectService) EnsureNewProject(dir, name, title string, template map[string]any) error {
	if dir == "" {
		return fmt.Errorf("未指定项目目录")
	}
	if name == "" {
		return fmt.Errorf("项目名不能为空")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建项目目录失败: %w", err)
	}
	for _, rel := range []string{settingFile, publishFile, textDir, guideDir, appendixDir} {
		moveToTrash(dir, rel)
	}
	book := BookProject{Name: name, Meta: BookMeta{Title: title}, Template: template}
	raw, err := json.MarshalIndent(&book, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, bookFile), append(raw, '\n'), 0o644); err != nil {
		return fmt.Errorf("写 %s 失败: %w", bookFile, err)
	}
	return nil
}

// ListRecent 不放这里——最近项目在 SettingsService。

// ---------------------------------------------------------------- 启动期文件关联打开（双击 .gvs）

var pendingOpen []string

func AddPendingOpen(paths []string) {
	if len(paths) == 0 {
		return
	}
	pendingOpen = append(pendingOpen, paths...)
}

func (s *ProjectService) TakePendingOpen() []string {
	out := pendingOpen
	pendingOpen = nil
	return out
}
