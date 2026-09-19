/* 字体竖向特性判定：独立于版式引擎，无 engine / DOM 强依赖，可 node 探针直接验证。
 * 仅负责「该字体是否提供 OpenType vert/vrt2 竖排字形」这一纯逻辑判断。 */

export function isGenericFont(f: string): boolean {
  return /^(serif|sans-serif|monospace|cursive|fantasy)$/i.test(f)
}

/* 已知缺 vert 竖排字形的中文字体黑名单。
 * 说明：纯前端运行时无法可靠探测 vert 表——CJK 全角字符横竖排都是 1em 见方、bbox 无差异；
 * 拉丁标点（— …）在 text-orientation:mixed 下又一律被浏览器几何旋转 90°，测不出字体有无 vert 替换字形。
 * 唯一可靠的是解析字体二进制找 vert 表（过重，不适合实时）。
 * 故采用黑名单：真正缺 vert 的中文常见字体就楷体系 / 仿宋系那几个；现代宋体 / 明体 / 思源
 * （Songti SC、Noto Serif CJK、Source Han Serif、PMingLiU、STSong、FZ* 等）都有 vert。
 * 不在名单的自定义字体乐观认为有 vert（少数缺的会横躺，用户可换字体），避免误用 rotate 改写真竖排字体。 */
const NO_VERT_FONTS = new Set([
  'Kaiti SC', 'STKaiti', 'Kaiti', 'KaiTi', 'Kaiti TC', '楷体', '楷体_GB2312',
  'STFangsong', 'FangSong', 'FangSong_GB2312', '仿宋', '仿宋_GB2312',
  'STSong-Light', // 个别老宋体变体缺 vrt2，按需补
])

/* 判断字体是否提供竖排字形。黑名单命中即判缺；通用族与未知自定义字体乐观认为有。 */
export function fontVertSupported(family: string): boolean {
  if (isGenericFont(family)) return true
  if (NO_VERT_FONTS.has(family)) return false
  return true
}
