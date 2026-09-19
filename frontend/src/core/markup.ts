/* 清除格式：去掉文本内的全部排版标记，保留可读文字。
 * 与编辑器「美化」装饰互为逆操作——美化把标记渲染成样式，
 * 清除格式把样式对应的标记符从源文里物理删除（针对选中文本）。
 * 纯函数，不依赖 DOM，可用 node 探针验证。
 *
 * 与 editorDeco.ts 的装饰口径一致：
 *   - 标题：行首 #{1,2}\s*（与 engine / editorDeco 的标题判定一致）
 *   - 夹注： 【…】  / 徽标： {…} / 强调： […]
 *   - 注音： 字^pīn^（分隔符取自 tag_ruby，保留基字、去拼音）
 *   - 独立标记： @ % $ & ~（古籍 DSL 保留符，纯视觉噪音） */
function pairOf(tag: string): [string, string] {
  const t = String(tag || '^^')
  return [t.charAt(0) || '^', t.charAt(1) || t.charAt(0) || '^']
}
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function clearMarkup(text: string, rubyTag = '^^'): string {
  if (!text) return text
  let out = text
  // 1) 行首标题标记 # / ##（与 engine / editorDeco 口径一致：#{1,2}\s*）
  out = out.split('\n').map(l => l.replace(/^#{1,2}\s*/, '')).join('\n')
  // 2) 包裹类括号：保留内容，去掉括号本身（允许跨行，故在整篇文本上处理）
  out = out.replace(/【([^】]*)】/g, '$1')
  out = out.replace(/\{([^}]*)\}/g, '$1')
  out = out.replace(/\[([^\]]*)\]/g, '$1')
  // 3) 注音：保留基字（汉字），去掉 ^拼音^（分隔符取自 tag_ruby，与 editorDeco 一致）
  const [o, c] = pairOf(rubyTag)
  const rubyRe = new RegExp(
    '([\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3007]+)' + escRe(o) + '[^' + escRe(c) + '\\n]+?' + escRe(c), 'g')
  out = out.replace(rubyRe, (_m: string, base: string) => base)
  // 4) 独立标记 @ % $ & ~（古籍 DSL 保留符，纯视觉噪音）
  out = out.replace(/[@%$&~]/g, '')
  return out
}
