/* 字形子集化：把整份字体裁成「本书实际用到的字符」再交给 fontEmbed 内联。
 *
 * 为什么需要：
 *   导出时 SVG 是**独立图片文档**，字体只能整份 base64 内联（见 fontEmbed.ts 顶部），所以设了
 *   6MB 体积闸门。而 CJK 字体动辄 10~20MB——思源宋体 CN 10.74MB、Songti SC 20.8MB、苹方 11MB
 *   ——全部卡在闸门外，**用户选了什么字体都跟着走不了**，导出只能回退系统宋体。症状是导出
 *   面板报「字体未内联」，以及「导出的字不是选的那个」。
 *   而一本书实际用到的字通常只有一两千个：实测思源宋体按本书 1132 字裁完只剩 **345KB（3.1%）**，
 *   方正清刻本悦宋简 3.86MB → 445KB（11.3%），整份内联的体积问题就此消失。
 *
 * 实现：
 *   用 harfbuzz 官方子集器（harfbuzzjs 包里的 `harfbuzz-subset.wasm`）。它是**零 import 的
 *   独立 wasm**，可以直接 WebAssembly.instantiate，不需要 emscripten 胶水、也不需要 harfbuzzjs
 *   的 JS 封装（v1 的封装不含 subset API，只提供 wasm 资产，故这里自己写十几行胶水）。
 *
 * ⚠ **必须保留全部布局特性**：只按码位裁字形，会把 GSUB 里的连字一并丢掉。实测「——」在本册
 *   字体里是一个连字（两个 em dash 合成单字），丢掉后断成两个，竖排 advance 从 2000 掉到 1000，
 *   整行位置偏移。harfbuzz 默认即保留全部特性并做 layout closure（把被引用的字形一并留下），
 *   所以这里**刻意不设任何 subset flags**。换用 fontTools 时须显式 layout_features='*'。
 *
 * 位置：纯函数，不碰 DOM 以外的任何状态；失败一律返回 null，由调用方回退到原有「整字体 + 闸门」
 *   路径——子集化只是**优化**，任何一步不可用都不该让导出失败或变得更差。 */

import wasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url'

/* harfbuzz 的内存模式：READONLY 表示「不修改这块内存」，blob 直接引用我们 malloc 的区域。
 * （WRITABLE=2 会让 hb 认为可以就地改，且可能试图 free 我们给的指针。） */
const HB_MEMORY_MODE_READONLY = 1

/** wasm 导出的符号（只列用到的；名字与 harfbuzz C API 一致）。 */
interface HbExports {
  memory: WebAssembly.Memory
  malloc(n: number): number
  free(p: number): void
  _initialize?: () => void
  hb_blob_create(data: number, len: number, mode: number, userData: number, destroy: number): number
  hb_blob_destroy(b: number): void
  hb_blob_get_length(b: number): number
  hb_blob_get_data(b: number, lenPtr: number): number
  hb_face_create(blob: number, index: number): number
  hb_face_destroy(f: number): void
  hb_face_reference_blob(f: number): number
  hb_set_add(set: number, cp: number): void
  hb_subset_input_create_or_fail(): number
  hb_subset_input_destroy(input: number): void
  hb_subset_input_unicode_set(input: number): number
  hb_subset_or_fail(face: number, input: number): number
}

/* wasm 只在首次用到时加载一次。加载失败（老环境没有 WebAssembly、资源缺失）记成 null，
 * 之后不再重试——调用方会一直走回退路径。 */
let loading: Promise<HbExports | null> | null = null

function loadHb(): Promise<HbExports | null> {
  if (!loading) {
    loading = (async () => {
      try {
        const r = await fetch(wasmUrl)
        if (!r.ok) return null
        const { instance } = await WebAssembly.instantiate(await r.arrayBuffer(), {})
        const e = instance.exports as unknown as HbExports
        /* emscripten 的 standalone 构建需要显式跑一次初始化（没有也不会报错）。 */
        if (typeof e._initialize === 'function') e._initialize()
        return typeof e.hb_subset_or_fail === 'function' ? e : null
      } catch {
        return null
      }
    })()
  }
  return loading
}

/** 子集化是否可用（wasm 已加载且符号齐全）。仅供探针与诊断使用。 */
export async function subsetReady(): Promise<boolean> {
  return !!(await loadHb())
}

/** 按码位裁剪字体，返回裁剪后的 sfnt 字节；任何一步不成立都返回 null。
 *
 *  `cps` 是要保留的 Unicode 码位（**必须含**实际会用到的全部字符，漏掉的字会丢字形）。
 *  返回的字节格式与输入一致（OTF 进、OTF 出）。 */
export async function subsetFont(raw: Uint8Array, cps: readonly number[]): Promise<Uint8Array | null> {
  const e = await loadHb()
  if (!e || !raw.length || !cps.length) return null

  let fontPtr = 0, blob = 0, face = 0, input = 0, outFace = 0, outBlob = 0
  try {
    fontPtr = e.malloc(raw.length)
    if (!fontPtr) return null
    /* malloc 可能触发 wasm 内存增长，故写入前重新取一次视图（旧视图会 detach）。 */
    new Uint8Array(e.memory.buffer, fontPtr, raw.length).set(raw)

    blob = e.hb_blob_create(fontPtr, raw.length, HB_MEMORY_MODE_READONLY, 0, 0)
    if (!blob) return null
    face = e.hb_face_create(blob, 0)
    if (!face) return null

    input = e.hb_subset_input_create_or_fail()
    if (!input) return null
    const uset = e.hb_subset_input_unicode_set(input)
    for (const cp of cps) e.hb_set_add(uset, cp)

    outFace = e.hb_subset_or_fail(face, input)
    if (!outFace) return null
    outBlob = e.hb_face_reference_blob(outFace)
    if (!outBlob) return null

    const len = e.hb_blob_get_length(outBlob)
    const ptr = e.hb_blob_get_data(outBlob, 0)
    if (!len || !ptr) return null
    /* 必须立刻拷出来：wasm 内存里的这块区域在后续调用（含下一族的子集化）里会被复用。 */
    return new Uint8Array(e.memory.buffer, ptr, len).slice()
  } catch {
    return null
  } finally {
    /* 逆序释放。容量为零的句柄在 harfbuzz 里是「空对象」不是 NULL，但用 0 当哨兵足够：
     * 上面任何一步失败都会原样返回 null 走回退，泄漏一次内存也远好过抛错打断导出。 */
    if (outBlob) e.hb_blob_destroy(outBlob)
    if (outFace) e.hb_face_destroy(outFace)
    if (input) e.hb_subset_input_destroy(input)
    if (face) e.hb_face_destroy(face)
    if (blob) e.hb_blob_destroy(blob)
    if (fontPtr) e.free(fontPtr)
  }
}
