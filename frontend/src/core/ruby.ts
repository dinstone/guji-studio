/* 注音生成：选中文字 → 逐字拼音 → `字^pīn^` 标记文本。
 *
 * 设计要点：
 * - 依赖 pinyin-pro（离线词库，MIT；ESM gzip ≈160KB）**动态 import** → 点第一次「拼音」才加载，
 *   应用启动零开销；打包为独立 chunk，Wails 的 `//go:embed all:frontend/dist` 一并嵌入。
 * - 库只负责「给什么拼音」；标记拼装/剥离/幂等是纯函数，与库解耦、可 node 探针验证。
 * - 词库准的是**现代标准普通话**：佛经音译词与古专名会错（般若 → bān ruò 应为 bō rě、
 *   南无 → nán wú 应为 nā mó、冒顿 → mào dùn 应为 mò dú、高句丽 → gāo jù lì 应为 gōu lí…
 *   实测古籍/专名 5/14）。故本功能定位为「生成初稿」，古读由用户手改标记文本。
 * - toneSandhi:false → 「不/一」保持原调（bù / yī），古籍注音惯例；默认的变调会写出 bú yì。
 */

/** 汉字区间（含扩展区），与 pinyin-pro 的 inZhRange 同口径；仅作独立判定用 */
export const ZH_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\u{20000}-\u{2FA1F}]/u

/** 标记的成对符号拆解（tag 形如 '^^' / '{}'） */
function pairOf(tag: string): [string, string] {
  const t = String(tag || '^^')
  return [t.charAt(0) || '^', t.charAt(1) || t.charAt(0) || '^']
}
function escRe(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** 剥离选区/文本内已有的注音标记。
 *  重注前必须先剥离 → 保证幂等（否则 `阿^ā^` 再注会产出 `阿^ā^^2^` 这类混乱）。 */
export function stripRuby(text: string, tag = '^^'): string {
  const [o, c] = pairOf(tag)
  if (o === c) return text.replace(new RegExp(escRe(o) + '[^' + escRe(o) + '\\n]*' + escRe(o), 'g'), '')
  return text.replace(new RegExp(escRe(o) + '[^\\n]*?' + escRe(c), 'g'), '')
}

export interface PySeg { origin: string; pinyin: string; isZh: boolean }

/** 纯拼装：只给汉字加 `^注^`，标点/数字/拉丁/空白原样保留（origin 回填）。
 *  注音直接紧跟汉字、无空格无换行 → 编辑器里读起来仍是原句。 */
export function buildRuby(segs: PySeg[], tag = '^^'): string {
  const [o, c] = pairOf(tag)
  let out = ''
  for (const s of segs) {
    const ch = s.origin
    if (!ch) continue
    if (s.isZh && s.pinyin) out += ch + o + s.pinyin + c
    else out += ch
  }
  return out
}

/** 自动注音（异步、懒加载词库）。返回新文本，不修改入参。 */
export async function autoRuby(text: string, tag = '^^'): Promise<string> {
  const clean = stripRuby(text, tag)
  if (!clean.trim()) return text
  const { pinyin } = await import('pinyin-pro')
  const segs = pinyin(clean, {
    type: 'all',
    toneType: 'symbol',
    toneSandhi: false,
  }) as unknown as PySeg[]
  return buildRuby(segs, tag)
}

/** 文本是否含注音标记（供 store 判定「自动」档；不依赖词库） */
export function hasRuby(text: string, tag = '^^'): boolean {
  const [o, c] = pairOf(tag)
  return new RegExp(escRe(o) + '[^' + escRe(o) + '\\n]+' + escRe(c)).test(String(text || ''))
}
