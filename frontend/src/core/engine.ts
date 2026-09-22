/* ==========================================================================
 * GujiStudio engine · 古籍版式计算引擎
 * 纯函数、无 DOM 依赖，可直接被 Vue / Node 复用
 * 计算链：纸张 -> 页边距 -> 版框(内外线) -> 版心(中缝/列) -> 行线 -> 字号
 * 由原型期 vrain engine 迁入，逻辑与 tools 验证套件保持一致
 * ========================================================================== */
// @ts-nocheck — 原型期纯 JS 迁入，暂不做全量类型化；UI 迁移期逐步补接口类型
'use strict';

  var FONT_STACKS = {
    song_sc: "'Songti SC','STSong','SimSun','Noto Serif CJK SC',serif",
    /* song_tc 优先 Songti SC：实测 Songti TC / PMingLiU 的竖排标点（vert 替换字形）
       ink 居中于 em（0.35em），而 Songti SC / Noto Serif 的 ink 贴 em 顶（0.08em）——
       后者才符合「标点紧贴前字」的青简效果。繁体文本由 Songti SC 渲染无碍。 */
    song_tc: "'Songti SC','Noto Serif CJK SC','Songti TC','PMingLiU','MingLiU',serif",
    kai: "'Kaiti SC','STKaiti','KaiTi','Noto Serif CJK SC',serif",
    hei: "'Heiti SC','SimHei','Noto Sans CJK SC',sans-serif",
    fang: "'STFangsong','FangSong','Noto Serif CJK SC',serif",
    /* 注音（拼音）专用拉丁栈：注音一律横排，故优先西文衬线体（Times/Georgia 跨 macOS+
       Windows 均随系统自带），末尾回落中文衬线族防缺字。不出现在正文字体选项里。 */
    ruby_serif: "'Times New Roman',Times,Georgia,'Palatino Linotype',Palatino,'Songti SC',serif"
  };
  /* 注音让位的实测墨迹系数（PIL 逐字量 ink bbox @size 400，见记忆「注音几何实测」）：
     RUBY_RUBY_INK_HZ = 汉字墨迹高 / 字号（Songti 國書永天大都 ≥0.92，取最密字 0.922）；
     BOX    = 注音预留盒高 / 注音字号（Times 实测：声调字母上沿 0.61~0.70、降部 0.217，
              取「上 0.695 + 下 0.175」= 0.87 —— 让位公式只用这个总量）；
     ASC/DESC = 预留盒在基线之上/之下的拆分（和 = BOX）——落位时靠它算盒的上下边界，
              再按 ruby_bias 在字间净空带内分配（0 = 居中 / 1 = 盒底贴本字上沿），
              不再像旧版那样「盒底按呼吸间距吊在本字上方」（那会让注音恒贴上方的字）。 */
  var RUBY_RUBY_RUBY_INK_HZ = 0.922, RUBY_BOX = 0.87, RUBY_ASC = 0.695, RUBY_DESC = 0.175;
  /* 闭合标点（尾标点）字符集：正文 / 强调 / 夹注三套竖排标点共用。
     竖排下不可置于列首（避头点）：正文/强调在列满时按「**标点压缩**」处理——闭号不新起列，
     全尺寸排在末字之后、列底「下底线→版框底」这段余白里（放不下才等比缩到放得下）；
     夹注另参与折行均衡与挤挂判定（见 paginate）。
     开引号类（“ ‘ 《 〈）不在此列——它们可以居列首，无需避头。
     半角直引号 " ' 亦不列入：语义中性（既可开亦可闭），列入会误判开引号。 */
  var CLOSE_PUNCT = '」』）〉》…—”’';
  /* 标点压缩门槛用：竖排形态「沿列方向」的墨迹高（×字号）与「墨迹中心距 em 盒顶」的比例。
     ① 决定列底余白放不放得下（放不下才等比缩，故常见闭号都是全尺寸）；
     ② 落位按**墨迹心**而非盒心——标点字形在盒内并不居中（竖排 》 墨迹心在盒顶下 0.42em，
        按盒心落位会整体下沉去压底线/版框）。
     数值取自 CJK 标点通行字形设计（方正清刻本悦宋实测）；缺 vert 走 rotate(90) 兜底时口径一致
     （沿列墨迹 = 横排字形墨迹宽）。nop 类（直立）的 ctr 沿用引擎既有 0.36 偏移口径（0.5+0.36）。 */
  var PUNCT_INK = {
    '》': [0.425, 0.424], '〉': [0.326, 0.401], '」': [0.227, 0.431], '』': [0.315, 0.428],
    '）': [0.247, 0.421], '”': [0.315, 0.428], '’': [0.227, 0.431],
    '…': [0.781, 0.500], '—': [1.019, 0.501],
    '。': [0.289, 0.860], '，': [0.248, 0.860], '、': [0.250, 0.860],
    '！': [0.778, 0.860], '？': [0.778, 0.860], '：': [0.474, 0.860], '；': [0.607, 0.860]
  };
  /* 内置逻辑字体 → 中文别名（唯一真源；Inspector 预设、检查列表别名均引用此处）。
     真名（Songti SC 等英文）才是系统字体注册名、渲染以真名为准；别名仅供 UI 友好显示。 */
  var FONT_CN = { song_sc: '宋体·简', song_tc: '宋体·繁', kai: '楷体', hei: '黑体', fang: '仿宋', ruby_serif: '西文衬线（注音）' };
  /* 字体解析：内置键（song_sc/song_tc/kai/hei/fang）→ 预设回退栈；
     其它非空值视为自定义 font-family——即本机已安装字体名（支持逗号分隔多级回退，
     裸名单名自动加引号），渲染时由浏览器按名解析，找不到时回落 serif */
  function familyStack(v, fb) {
    if (v && FONT_STACKS[v]) return FONT_STACKS[v];
    var s = String(v || '').trim();
    if (!s) return FONT_STACKS[fb || 'song_tc'];
    if (/^(serif|sans-serif|monospace|cursive|fantasy)$/i.test(s)) return s;
    if (!/^['"]/.test(s) && s.indexOf(',') < 0) s = "'" + s.replace(/['\\]/g, '') + "'";
    return s + ',serif';
  }
  /* 汉字墨迹相对 em 框中心的下沉量（em）。`dominant-baseline="central"` 居中的是 **em 框**
     （由字体 hhea/OS2 的 ascent/descent 定义），而汉字墨迹中心并不在 em 框中心。PIL 量字体表实测：
       Songti SC/TC、STSong：ascent/descent = 1060/340（STSong 860/140）
         → central 落点在基线上方 0.360em，而汉字墨迹中心只到 0.300em → **下沉 0.060em**
       PingFang SC / Heiti SC：墨迹中心 0.354em → 下沉仅 0.006em
     补偿 = 把字形 y 上移 δ×字号，字身才真正居中于格。不补偿时块状元素（夹注块）呈
     「上净空 > 下净空」，差值 = 0.122×字号（中间档恒等式，推导见 skill「guji-layout-probe」§11bis）。
     适用范围：正文 / 章题 / 夹注的**汉字字形**。标点（已按实测手工调位）、注音（alphabetic 基线）、
     版心装饰（鱼尾 / 书名 / 页码）与徽标不走这份补偿。 */
  var INK_SINK = {
    'Songti SC': 0.060, 'Songti TC': 0.060, 'STSong': 0.060, 'Songti': 0.060,
    'Kaiti SC': 0.060, 'Kaiti TC': 0.060, 'STKaiti': 0.060, 'KaiTi': 0.060,
    'STFangsong': 0.060, 'FangSong': 0.060,
    'PingFang SC': 0.006, 'PingFang TC': 0.006, 'PingFang HK': 0.006,
    'Heiti SC': 0.006, 'Heiti TC': 0.006, 'STHeiti': 0.006,
    'Hiragino Sans GB': 0.006, 'Microsoft YaHei': 0.006, 'SimHei': 0.006
  };
  var inkSinkCache = {};
  /** 字体栈首选名的下沉系数（em）；未登记时按字形族粗判（黑体系/无衬线 → 0.006，其余按宋体系 0.060） */
  function inkSink(stack) {
    var s = String(stack || '');
    if (inkSinkCache[s] !== undefined) return inkSinkCache[s];
    var first = s.split(',')[0].replace(/^["'\s]+|["'\s]+$/g, '');
    var v = Object.prototype.hasOwnProperty.call(INK_SINK, first)
      ? INK_SINK[first]
      : (/hei|ping|sans|gothic|yahei/i.test(s) ? 0.006 : 0.060);
    inkSinkCache[s] = v;
    return v;
  }

  /* 图片素材解析器：由上层（stores/app）注入 core/assets.ts 的 assetInfo 实现。
     engine 因此保持纯函数、不 import 具体实现；resolver 返回 {url,w,h} 或 null，
     null = 素材尚未就绪 —— 本帧不画，预热完成后上层会触发重渲。 */
  var assetResolver = null;
  function setAssetResolver(fn) { assetResolver = fn; }
  function assetOf(name) { return (assetResolver && name) ? assetResolver(name) : null; }
  /** 图片素材上版的统一几何：只给一维尺寸（宽 w），高按原图宽高比推导（不变形） */
  function assetBox(name, cx, cy, w) {
    var info = assetOf(name);
    if (!info || !info.url || !info.w || !info.h) return null;
    var h = w * info.h / info.w;
    return { url: info.url, x: cx - w / 2, y: cy - h / 2, w: w, h: h };
  }
  /** 图片素材的 <image> 元素（preserveAspectRatio=none：宽高已按真实比例算好，无需再让浏览器适配） */
  function assetEl(box, opacity, cls) {
    return '<image class="' + cls + '" x="' + f(box.x) + '" y="' + f(box.y) +
      '" width="' + f(box.w) + '" height="' + f(box.h) + '" href="' + esc(box.url) + '"' +
      (opacity != null && opacity < 1 ? ' opacity="' + f(opacity) + '"' : '') +
      ' preserveAspectRatio="none"/>';
  }
  function clamp01(v, d) { var n = num(v, d); return n < 0 ? 0 : (n > 1 ? 1 : n); }

  /* ---------------------------------------------------------------- 默认值 */
  var DEFAULT_TEMPLATE = {
    /* 纸张：A4 横向 @300dpi = 3508 × 2480 px */
    canvas_width: 3508, canvas_height: 2480,
    canvas_color: '#e9e2d0', canvas_background_image: '',
    /* 页边距 */
    margins_top: 240, margins_bottom: 80, margins_left: 70, margins_right: 70,
    /* 版框：外粗线 + 内细线 */
    outline_width: 10, outline_color: '#1a1a1a',
    inline_width: 1, inline_color: '#1a1a1a',
    outline_hmargin: 6, outline_vmargin: 6,
    if_vline: 1, vline_width: 1, vline_color: '#1a1a1a',
    /* 版心 / 中缝 */
    leaf_col: 16, leaf_center_width: 150,
    fish_line_color: '#1a1a1a', fish_line_width: 2, fish_line_margin: 4,
    /* 书口：象鼻（中缝中线竖线）+ 上/下书口横线（位置随分割线 Y），与鱼尾开关无关 */
    if_seam: 'double',         // 书口样式：none（无）| single（单象鼻）| double（双象鼻）
    seam_color: '#1a1a1a', seam_width: 2,
    seam_top_linewidth: 18, seam_btm_linewidth: 18,
    /* 鱼尾 */
    fish_mode: 'double',       // none | single | double
    fish_shape: 'flower',    // triangle | arc | flower
    fish_decor: 1,
    fish_top_y: 600, fish_top_color: '#1a1a1a',
    fish_top_rectheight: 66, fish_top_triaheight: 40,
    fish_btm_y: 1907, fish_btm_color: '#1a1a1a',   // 下鱼尾：固定尖朝上（删除方向开关）
    fish_btm_rectheight: 66, fish_btm_triaheight: 40,
    fish_mid_direction: 0, fish_mid_pos: 0.5, fish_mid_rectheight: 66, fish_mid_triaheight: 40, fish_mid_color: '#1a1a1a',   // 中鱼尾（仅三鱼尾）：direction 0 朝下（默认，同上下鱼尾）| 1 朝上；pos = 内容区高度比例 0..1
    /* 鱼尾 / 书名 / 页码 纵向定位：1=随内容区自动（换纸张高度时鱼尾贴内框、书名/页码按比例落位），0=用下方绝对值 */
    fish_auto: 0, title_y_auto: 1, pager_y_auto: 1,   // 书名默认 0.20（上—中）、页码默认 0.70（卷次下）
    /* 自动档的「离内框留白」（px）：fish_top_pad 自上内框下移、fish_btm_pad 自下内框上移。
       大幅纸张（如 A3）需比默认更大，故做成参数而非硬编码。 */
    fish_top_pad: 100, fish_btm_pad: 200,
    /* 行与正文 */
    row_num: 22, row_start_auto: 1, row_top_pad: 36,
    row_start_y: 347, row_end_auto: 1, row_end_y: 2374, row_delta_y: 14,
    text_size_auto: 1, text_font1_size: 90, text_ydis: 1.05,
    text_size_fitcol: 1, text_col_ratio: 0.96,   // 自动字号同时受列宽约束：字号 ≤ 列宽 × 0.96
    text_font_color: '#141414', text_font_family: 'song_tc',
    /* 夹注：comment_ydis 默认跟随正文行距 → 双行夹注严格占 1 个正文字位（栅格锁前提） */
    comment_size_auto: 1, comment_size_ratio: 0.5, comment_font1_size: 45,
    comment_ydis: 1.05, comment_font_color: '#3a3a3a', comment_font_family: 'song_tc',
    /* 版心文字 */
    title_text: '图书名称', title_postfix: '卷X', title_volnames: '', if_tpcenter: 1,
    title_font_size: 96, title_y: 1013, title_ydis: 1.05, title_color: '#141414',
    title_font_family: 'song_tc', pager_font_family: 'song_tc',
    pager_font_size: 44, pager_y: 827, pager_color: '#141414', pager_style: 'cn',
    vol_y_auto: 1, vol_y: 1500,   // 卷次纵向位置：auto=内容区高度比例 0.62；手动填绝对值 px
    /* 标点（青简同款：正文 / 夹注各 全角 / 半角 / 悬空 / 无 + 朱色） */
    comment_comma_fullwidth: 1,
    /* 正文标点模式：full=占 1 字位；hang=0 宽、挂前字右下角外；none=不渲染（half 0.5 格已移除） */
    text_comma_mode: 'full',
    /* 夹注标点模式（同上） */
    comment_comma_mode: 'full',
    /* 朱色标点（套印本句读圈点） */
    text_comma_zhu: 0, comment_comma_zhu: 0,
    /* 悬空微调（正文 / 夹注独立设置，青简同款语义）：
       hang_scale=字号缩放(.38)；*_hang_x/*_hang_y = 青简 --hang-x/--hang-y
       （.02/.06：标点字框右缘贴前字格右缘内 0.02em、底缘离格底 0.06em）
       旧键 hang_x/hang_y 仍兼容读取（fallback），新模板只写新键 */
    hang_scale: 0.38,
    text_hang_x: 0.02, text_hang_y: 0.06,
    comment_hang_x: 0.02, comment_hang_y: 0.06,
    /* 句读（judou）模式专用：圈点形态参数。
       读点（、）复用 hang_scale；句圈为矢量自绘（不依赖字体 ○ 字形：各字体直径 0.6~0.9em 不等且可能缺字）。
       jd_ring_scale=圈外直径（×字号）；jd_ring_stroke=圈线宽（×字号），0 = 实心圈 */
    jd_ring_scale: 0.26, jd_ring_stroke: 0.05,
    /* 标点落位微调（× 字号）：竖排字形本身已落字格右上角，默认 0 即青简效果；仅微调用 */
    text_comma_right: 0, text_comma_up: 0,
    comment_comma_right: 0, comment_comma_up: 0,
    /* 句读类标点（nop）占格落位：right=右上四分位（em 框置于字格右上 1/4 区，墨迹落右上角，GB/T 15834 竖排惯例）；center=格心居中 */
    text_comma_pos: 'right', comment_comma_pos: 'right',
    /* 标点字符集（哪些算标点）：90=竖排需旋转/立变的括号引号类。
       正文与夹注默认同集（含书名号《》〈〉、弯引号“”‘’、半角引号 " '、箭头 →）——
       这些字符横躺时与竖排正文格格不入，且开合方向本身携带行文结构；
       占格与普通汉字同为 1 格（rot 不额外占位），故换列位置不变。
       闭号（》〉”’）另受 CLOSE_PUNCT 保护：夹不满本列时挤挂末字，不居列首 */
    text_comma_nop: '、，。：；！？', text_comma_90: `「」『』〔〕…—（）()《》〈〉“”‘’"'→`,
    comment_comma_nop: '、，。：；！？', comment_comma_90: `「」『』〔〕…—（）()《》〈〉“”‘’"'→`,
    text_comma_color: '#141414',
    /* 章节标题（行首 # 标记，占整列大字；# 一级 / ## 二级 / ### 三级 / #### 四级；字号=正文+偏移px，对齐默认顶对齐） */
    chapter_font_color: '#141414',
    chapter1_font_delta: 12, chapter1_font_family: 'song_tc', chapter1_bold: 1, chapter1_align: 'top',
    chapter2_font_delta: 8,  chapter2_font_family: 'song_tc', chapter2_bold: 0, chapter2_align: 'top',
    chapter3_font_delta: 4,  chapter3_font_family: 'song_tc', chapter3_bold: 1, chapter3_align: 'top',
    chapter4_font_delta: 0,  chapter4_font_family: 'song_tc', chapter4_bold: 0, chapter4_align: 'top',
    /* 章节标点独立模式：标点永远整格占位，仅支持「旋转90°」一个开关（不随正文标点四模式） */
    chapter_punct_90: 1,
    /* 注释徽标（{} 标记：随文牌记式带图案小徽标，正文与夹注内均可用） */
    badge_show: 1, badge_color: '#a8322a', badge_font_family: 'kai',
    badge_size: 0, badge_decor: 1,   // size 0 = 自动（随正文字号；夹注内随注字号）
    /* 标记符号 */
    tag_comment: '【】', tag_accent: '[]', tag_newpage: '%', tag_halfpage: '$',
    tag_lastcol: '&', tag_space: '@', tag_ruby: '^^', tag_colend: '~',
    /* 注音（`字^pīn^`）：横排小字落在「字与字的空隙」里，不占字位；
       开启时只缩小「绘制字号」、格子与占位一律不动 → 每列字数/分页/页码/目录全不变 */
    ruby_show: 2,              // 0=关 / 1=开 / 2=自动（全书不含 ^..^ 时不缩字号、不渲染）
    ruby_size_ratio: 0.18,     // 注音字号 / 正文字号（缩小后的字身）
    ruby_gap: 2,               // 注音与上下汉字墨迹的最小呼吸（px）；字体不同可微调
    /* 注音盒在「字间净空带」内的纵向偏置：0 = 上下居中 / 1 = 盒底完全贴本字墨迹上沿。
       注音是注给「下方本字」的，故默认 0.3（上:下 ≈ 1.86:1）——比居中更靠近本字一点。 */
    ruby_bias: 0.3,
    ruby_font_family: 'ruby_serif',
    ruby_color: '',            // 空 = 跟随正文颜色
    /* 版心堂号：中缝上的图片素材（与鱼尾/书名/页码并列，src 空 = 不输出）。
       只用「内容区高度比例 + 中缝宽比例」两个锚点，两者都是 computeMetrics 算出的
       计算值 → 换纸张 / 改边距自动跟随，不需要绝对像素，也就不需要「自动档」开关。 */
    seam_stamp_src: '',
    seam_stamp_pos: 0.5,       // 0 = 内容区顶，1 = 内容区底
    seam_stamp_w: 0.6,         // 占中缝宽的比例（中缝窄的模板自动缩小）
    seam_stamp_opacity: 0.9,
    /* 叶面水印：图片素材压在版框与文字之下（src 空 = 不输出）。
       x / y = 图心在纸张上的比例位置，w = 占纸张宽的比例（高按原图比推导）。 */
    watermark_src: '',
    watermark_x: 0.5,
    watermark_y: 0.5,
    watermark_w: 0.5,
    watermark_opacity: 0.12
  };

  /* ------------------------------------------------------------------ 工具 */
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function f(n) { return Math.round(n * 100) / 100; }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function setOf(str) { var s = {}; var a = String(str || '').split(''); for (var i = 0; i < a.length; i++) s[a[i]] = 1; return s; }

  /* 注音是否启用：`_rubyOn` 是 store 解析出的「瞬时」标志（ruby_show=2 自动档按「全书是否含
     ^..^」判定后覆写成 0/1，不落盘、不进 book.gvs）。无该键时退化为「显式开启」——
     自动档在拿不到全书信息时按「关」处理，保证旧项目一字不变。 */
  function rubyActive(t) {
    if (t && t._rubyOn != null) return num(t._rubyOn, 0) > 0;
    return num(t.ruby_show, 2) === 1;
  }

  /* 青简方式渲染标点：foreignObject 内嵌 HTML + writing-mode:vertical-rl，
     由浏览器排版引擎自动替换竖排字形（vert）——标点形态与青简完全一致。
     (x,y)=字形占位槽中心（青简 text-align:center 模型：字形全尺寸在槽内居中）；
     size=字号（字形盒=字号见方，保证 ink 不被 foreignObject 裁剪）；
     halt=悬空标点（青简 ::before 同款 font-feature-settings）。
     div 带 xmlns 保证 PNG 导出（SVG 序列化为 XML）时合法。
     当字体缺失 vert 时，对 rot 类标点自动 fallback 到 SVG rotate(90)，保证效果统一。 */
  function firstFamily(stack) {
    return (String(stack || '').split(',')[0] || '').replace(/^['"]|['"]$/g, '').trim();
  }
  function foPunct(t, x, y, size, color, fontFamily, ch, cls, halt) {
    var h = size / 2;
    var vertMap = t && t._vert_supported;
    var fam = firstFamily(fontFamily);
    var isRot = cls.indexOf('v-t90') >= 0 || cls.indexOf('v-c90') >= 0;
    if (isRot && vertMap && vertMap[fam] === false) {
      /* 缺 vert 字形：用 SVG transform 兜底旋转，中心点与 foPunct 一致 */
      return '<text class="' + cls + '" x="' + f(x) + '" y="' + f(y) + '" font-size="' + f(size) +
        '" fill="' + color + '" font-family="' + esc(fontFamily) + '"' +
        ' text-anchor="middle" dominant-baseline="central"' +
        ' transform="rotate(90,' + f(x) + ',' + f(y) + ')">' + esc(ch) + '</text>';
    }
    return '<foreignObject class="' + cls + '" x="' + f(x - h) + '" y="' + f(y - h) + '" width="' + f(size) + '" height="' + f(size) + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;margin:0;padding:0;display:flex;align-items:center;justify-content:center">' +
      '<span style="display:inline-block;writing-mode:vertical-rl;line-height:1;' +
      (halt ? "font-feature-settings:'halt','palt';" : '') +
      'font-family:' + esc(fontFamily) + ';font-size:' + f(size) + 'px;color:' + color + '">' + esc(ch) + '</span>' +
      '</div></foreignObject>';
  }

  /* 半角标点 -> 全角（用于夹注标点转全角） */
  var HALF_TO_FULL = { ',':'，','.':'。',';':'；',':':'：','!':'！','?':'？','(':'（',')':'）','[':'［',']':'］','<':'〈','>':'〉' };
  function toFullwidthPunct(s) {
    return String(s).replace(/[,.;:!?()\[\]<>]/g, function (c) { return HALF_TO_FULL[c]; });
  }

  /* ------------------------------------------------------------ 句读（judou）
   * 现代标点 → 古籍圈点的形态映射。只在渲染期生效，源文件与 token 永不改写：
   * layout 的避头点/闭合标点判定仍按原字符（「。」）走，天然正确。
   *   读（短停顿）：，、；： → 顿点「、」
   *   句（完整句）：。！？ → 句圈（矢量自绘圆环）
   * rot 类（「」『』（）…—《》）不进映射：引号括号是行文结构，仍走原路径整格占位。
   */
  var JUDOU_DOT = '、';
  var JUDOU_RING = '○';            // 仅作自绘判定标记，不做字体渲染
  var JUDOU_MAP = {
    '，': JUDOU_DOT, '、': JUDOU_DOT, '；': JUDOU_DOT, '：': JUDOU_DOT,
    '。': JUDOU_RING, '！': JUDOU_RING, '？': JUDOU_RING
  };
  function judouGlyph(c) { return JUDOU_MAP[c] || c; }

  /* 矢量句圈：以 (x,y) 为圆心自绘，规避字体 ○ 字形不可控与缺字风险（导出光栅化时尤其）。
     stroke<=0 时画实心圈。 */
  function ringSvg(x, y, d, stroke, color, cls) {
    var solid = !(stroke > 0);
    return '<circle class="' + cls + '" cx="' + f(x) + '" cy="' + f(y) + '" r="' + f(d / 2) +
      '" fill="' + (solid ? color : 'none') + '" stroke="' + (solid ? 'none' : color) +
      '" stroke-width="' + f(solid ? 0 : stroke) + '"/>';
  }

  /** 阿拉伯数字 -> 中文数字 */
  function cn(n) {
    n = Math.floor(n);
    if (n <= 0) return '〇';
    var d = '〇一二三四五六七八九';
    if (n < 10) return d[n];
    if (n < 20) return '十' + (n % 10 ? d[n % 10] : '');
    if (n < 100) return d[Math.floor(n / 10)] + '十' + (n % 10 ? d[n % 10] : '');
    if (n < 1000) {
      var h = d[Math.floor(n / 100)], r = n % 100;
      if (!r) return h + '百';
      if (r < 10) return h + '百〇' + d[r];
      return h + '百' + cn(r);
    }
    return String(n);
  }

  /* ------------------------------------------------------- 1. 版式度量计算 */
  /**
   * 由模板参数推导全部几何量
   * 纸张 -> 页边距 -> 版框 -> 内容区 -> 中缝 -> 半叶 -> 列宽 -> 行线 -> 字号
   */
  function computeMetrics(t) {
    var W = num(t.canvas_width, 2480), H = num(t.canvas_height, 1860);
    var mt = num(t.margins_top, 0), mb = num(t.margins_bottom, 0),
        ml = num(t.margins_left, 0), mr = num(t.margins_right, 0);

    // 版框外缘（外粗线路径所在矩形）
    var frame = { x: ml, y: mt, w: Math.max(W - ml - mr, 20), h: Math.max(H - mt - mb, 20) };

    // 外粗线占内外各一半 + 内外线间距 + 内细线一半 = 内容区相对版框的内缩量
    var ow = num(t.outline_width, 0), iw = num(t.inline_width, 0);
    var insetH = ow / 2 + num(t.outline_hmargin, 0) + iw / 2;
    var insetV = ow / 2 + num(t.outline_vmargin, 0) + iw / 2;

    // 内细线包围的区域 = 可书写内容区
    var content = {
      x0: frame.x + insetH, y0: frame.y + insetV,
      x1: frame.x + frame.w - insetH, y1: frame.y + frame.h - insetV
    };
    content.w = content.x1 - content.x0;
    content.h = content.y1 - content.y0;

    // 中缝（版心）水平居中
    var centerW = Math.max(0, Math.min(num(t.leaf_center_width, 0), content.w * 0.6));
    var centerX = content.x0 + content.w / 2;

    // 半叶宽 -> 列宽
    var cols = Math.max(1, Math.round(num(t.leaf_col, 12)));
    var halfW = (content.w - centerW) / 2;
    var colW = halfW / cols;

    // 行起始线 / 结束线
    var rowStartY = t.row_start_auto
      ? content.y0 + num(t.row_top_pad, 0)
      : num(t.row_start_y, content.y0);
    var rowEndY = t.row_end_auto
      ? content.y1 - num(t.row_delta_y, 0)
      : num(t.row_end_y, content.y1);
    if (rowEndY < rowStartY + 20) rowEndY = rowStartY + 20;
    var rowH = rowEndY - rowStartY;

    // 字号：由「行高 / 每列字数 / 字距比例」反推
    var rowNum = Math.max(1, Math.round(num(t.row_num, 30)));
    var ydis = Math.max(0.5, num(t.text_ydis, 1.05));
    var fontSize = t.text_size_auto
      ? rowH / (rowNum * ydis)
      : Math.max(4, num(t.text_font1_size, 50));
    // 列宽约束：汉字字身宽约等于字号，字号不得撑破列宽（列数调大时自动收字号）
    if (t.text_size_auto && num(t.text_size_fitcol, 1))
      fontSize = Math.min(fontSize, colW * Math.max(0.2, num(t.text_col_ratio, 0.96)));
    /* 字格锁定（唯一真源，与档位无关）：cellH = 行高 ÷ 每列字数
       —— 自动档：字号 = cellH / ydis ⇒ ydis 只改字号（= 字的疏密），每列字数、
          分页点、页数、行高占用全部不变；字号被列宽上限钳住时也只是「缝变大」，
          不再反过来缩格（旧式会列尾留白 + 字压字）。
       —— 手动档：字号自定、ydis 退出（若仍按旧式 cellH = 字号 × ydis，字距一大
          整列就压出内容区、一小则列尾留白）⇒ 手动档调字号即调疏密。
       旧式 cellH = 字号 × ydis 已废弃。 */
    var cellH = rowH / rowNum;

    /* 注音让位（关键：只缩「绘制字号」，格子与占位一律不动）
       —— cellH 沿用今天口径（= rowH/row_num，见上），故每列字数、分页点、总页数、页码、
       目录条目全部不变；只把字形墨迹乘一个系数 k，让出字与字之间本来就空着的那道缝。
       容差条件： 汉字墨迹 + 拼音墨迹 + 呼吸 ≤ cellH
                fs·RUBY_RUBY_INK_HZ + (fs·k)·r·BOX + gap ≤ cellH
       → fs·k ≤ (cellH − gap) / (RUBY_RUBY_INK_HZ + BOX·r)   （默认 r=0.18 / gap=2 → 缩约 4.7%）
       gap 是「上下合计呼吸」，落位时按 ruby_bias 在字间净空带内分配（见 drawColumn）。
       注：k 只对「正文字形（含正文标点、强调、自动尺寸徽标）」生效；章节标题、夹注、徽标占格
       仍按原字号算，避免 chapterPerCol / 夹注块高变化引起分页漂移。 */
    var rubyK = 1, rubySize = 0;
    var rubyOn = rubyActive(t) ? 1 : 0;
    if (rubyOn && t.text_size_auto) {
      var rRatio = Math.max(0.05, Math.min(1, num(t.ruby_size_ratio, 0.18)));
      var rGap = Math.max(0, num(t.ruby_gap, 2));
      var fsFit = (cellH - rGap) / (RUBY_RUBY_RUBY_INK_HZ + RUBY_BOX * rRatio);
      if (fsFit < fontSize) rubyK = Math.max(0.5, fsFit / fontSize);
      rubySize = fontSize * rubyK * rRatio;
    }

    /* 规范点正文字号（2026-09-15 二稿）：字距比例 = 1 时的字号，即「字身恰好占满字格」那一点；
       含列宽封顶（封顶是纸张 / 栏格的固有量，与字距无关）。夹注的字号与占格都锚在它上面。 */
    /* 规范点正文字号（2026-09-15 二稿）：字距比例 = 1 时、字身恰好占满字格的字号；
       含列宽封顶（封顶是纸张 / 栏格的固有量，与字距无关）。夹注的占格与字号都锚在它上面。 */
    var normFs = num(t.text_size_fitcol, 1)
      ? Math.min(cellH, colW * Math.max(0.2, num(t.text_col_ratio, 0.96)))
      : cellH;
    var cRatio = Math.max(0.1, num(t.comment_size_ratio, 0.5));
    var cYdis = Math.max(0.5, num(t.comment_ydis, 1));
    /* 注字格高 = 夹注块内的字格高，同时是「块占格」基准（二稿：与 text_ydis 彻底解耦）
       自动档锚规范点：注字格高 = 正文字格 × 比例 → 块占格 = ⌈行数 × 比例⌉，
       即「每两个夹注字占一个正文字格」；它与 text_ydis **和** comment_ydis 都无关，
       于是调任何字距比例，夹注块的占格 / 落位 / 行距都纹丝不动。
       手动档（正文字号或夹注字号为绝对 px，本身与 text_ydis 无关）沿用实际值，与旧版逐字节一致。 */
    var commentCellNorm = (t.comment_size_auto && t.text_size_auto) ? normFs * cRatio : null;
    /* 注字号：自动档 = 注字格高 ÷ 夹注字距比例 —— comment_ydis 因此名实相符（行距 ÷ 字号）：
       调大 → 行距不变、字变小 → 视觉更疏朗；调小 → 字变大。手动档为绝对 px。 */
    var commentSize = t.comment_size_auto
      ? (commentCellNorm != null ? commentCellNorm / cYdis : fontSize * cRatio)
      : Math.max(4, num(t.comment_font1_size, 25));
    var commentCellH = commentSize * cYdis;
    /* 手动档没有「规范点」可言 → 基准退化为实际注格高（旧行为）。
       历史注记：旧写法 max(commentCellH, normFs × 比例) 的两支不同源，在 ydis = comment_ydis 处
       留了 5% 台阶（49.80 → 47.43），恰好把 ⌈⌉ 推过进位边界 → span 3→2，
       视觉上就是「夹注填满整列 → 填不满」；二稿改为单一来源，全档恒定。 */
    if (commentCellNorm == null) commentCellNorm = commentCellH;

    return {
      W: W, H: H, frame: frame, insetH: insetH, insetV: insetV,
      content: content, centerX: centerX, centerW: centerW,
      cols: cols, halfW: halfW, colW: colW,
      rowStartY: rowStartY, rowEndY: rowEndY, rowH: rowH,
      rowNum: rowNum, ydis: ydis, fontSize: fontSize, cellH: cellH, normFs: normFs,
      textFs: fontSize * rubyK,   // 正文字形实际绘制字号（注音开启时 = fontSize × rubyK）
      rubyOn: rubyOn, rubyK: rubyK, rubySize: rubySize,
      commentSize: commentSize, commentCellH: commentCellH, commentCellNorm: commentCellNorm,
      capPerCol: rowNum, capPerHalf: rowNum * cols, capPerLeaf: rowNum * cols * 2
    };
  }

  /** 列坐标（按阅读顺序：右半叶自右向左，再左半叶自右向左） */
  function columns(m) {
    var out = [], i;
    for (i = 0; i < m.cols; i++) out.push({ x: m.content.x1 - (i + 1) * m.colW, half: 0, k: i });
    for (i = 0; i < m.cols; i++) out.push({ x: m.centerX - m.centerW / 2 - (i + 1) * m.colW, half: 1, k: i });
    return out;
  }

  /** 章节标题字号：正文字号 + 该级偏移，上限=列宽（不越列） */
  function chapterSize(t, m, level) {
    var delta = num(t['chapter' + level + '_font_delta'], [12, 8, 4, 0][level - 1]);
    return Math.max(4, Math.min(m.fontSize + delta, m.colW * 0.96));
  }
  /** 规范点章题字号（2026-09-15 三稿）：章题在「字距比例 = 1」那一点上的字号，
      即 `规范点正文字号(m.normFs) + 该级偏移`，仍受列宽上限约束。
      与 `text_ydis` 无关 —— 用作章题的**占位基准**（每列字数 / 跨列切分 / 列内格高）。 */
  function chapterSizeNorm(t, m, level) {
    var delta = num(t['chapter' + level + '_font_delta'], [12, 8, 4, 0][level - 1]);
    return Math.max(4, Math.min(m.normFs + delta, m.colW * 0.96));
  }
  /** 章题字格高（**分页口径**，2026-09-15 三稿定稿）：自动档锚规范点 → 章题每列字数
      与跨列切分不再随字距比例漂（旧式 `chapterSize × ydis` 会让一级每列容量 21→17）。
      同夹注配方：**只有占位锚规范点，绘制字号仍走 `chapterSize`（随正文缩）**，
      于是「章题 = 正文字号 + N」的语义不变，调字距只是正文字形（含章题字形）一起缩。
      手动档的正文字号是绝对 px、本与 ydis 无关，沿用 chapterSize，与旧版逐字节一致。 */
  function chapterCellH(t, m, level) {
    return t.text_size_auto ? chapterSizeNorm(t, m, level) : chapterSize(t, m, level);
  }
  /** 每列可容章节标题字数（按章题字格高反推） */
  function chapterPerCol(t, m, level) {
    return Math.max(1, Math.floor(m.rowH / chapterCellH(t, m, level)));
  }

  /* ------------------------------------------------------------- 2. 切词 */
  /* 把文本按 {徽标} 切成 字符/徽标对象 混合序列（夹注内容用）；无闭符的 { 视为普通字符。
     同时返回 poses：每个元素在 s 中的下标（徽标对象用其 { 的下标）。供联动给每个渲染字回带源文偏移。 */
  function splitBadge(s, show) {
    var arr = [], poses = [], buf = '', bufStart = -1;
    function flush() { for (var q = 0; q < buf.length; q++) arr.push(buf.charAt(q)), poses.push(bufStart + q); buf = ''; bufStart = -1; }
    for (var p = 0; p < s.length; p++) {
      var ch = s.charAt(p);
      if (ch === '{') {
        var e = s.indexOf('}', p + 1);
        var bt = e > p ? s.slice(p + 1, e) : '';
        if (bt && bt.indexOf('{') < 0) {
          flush();
          bt = bt.trim();
          if (bt && show) { arr.push({ badge: bt }); poses.push(p); }
          p = e; continue;
        }
      }
      if (bufStart < 0) bufStart = p;
      buf += ch;
    }
    flush();
    return { chars: arr, poses: poses };
  }
  function tokenize(text, t) {
    var src = String(text || '').replace(/\r\n?/g, '\n');
    var tagC = String(t.tag_comment || '【】');
    var open = tagC.charAt(0), close = tagC.charAt(1) || '】';
    var tagA = String(t.tag_accent || '[]');
    var aOpen = tagA.charAt(0), aClose = tagA.charAt(1) || ']';
    var tagR = String(t.tag_ruby || '^^');
    var rOpen = tagR.charAt(0) || '^', rClose = tagR.charAt(1) || '^';
    var toks = [], i = 0, lineStart = true;
    while (i < src.length) {
      var ch = src.charAt(i);
      if (ch === '\n') { toks.push({ t: 'br', pos: i }); i++; lineStart = true; continue; }
      /* Markdown 风格章节标题：行首 #（可多个），到行尾为标题内容 */
      if (lineStart && ch === '#') {
        var j = i;
        while (src.charAt(j) === '#') j++;
        var level = Math.min(4, j - i);   // # 数量 = 级别（最多 4 级）
        // 章节标题只截到本行首个换行 或 首个夹注开符；否则单行连写时会把整段正文吞掉
        var stopAt = -1;
        for (var k = j; k < src.length; k++) {
          var ck = src.charAt(k);
          if (ck === '\n' || ck === open) { stopAt = k; break; }
        }
        var rawSeg = (stopAt < 0 ? src.slice(j) : src.slice(j, stopAt));
        var segChars = [], segPoses = [];
        for (var si = 0; si < rawSeg.length; si++) {
          var sc = rawSeg.charAt(si);
          if (/\s/.test(sc)) continue;        // 章题去空白（同原 replace(/\s+/g,'')），逐字记源偏移
          segChars.push(sc);
          segPoses.push(j + si);
        }
        if (segChars.length) toks.push({ t: 'chapter', level: level, chars: segChars, pos: i, posArr: segPoses });
        if (stopAt < 0) { i = src.length; lineStart = true; continue; }
        i = stopAt;                          // 停在 \n 或 【，让外层循环继续吃正文/夹注
        lineStart = (src.charAt(stopAt) === '\n');
        continue;
      }
      lineStart = false;
      if (ch === t.tag_newpage) { toks.push({ t: 'page', pos: i }); lineStart = true; i++; continue; }
      if (ch === t.tag_halfpage) { toks.push({ t: 'half', pos: i }); lineStart = true; i++; continue; }
      if (ch === t.tag_lastcol) { toks.push({ t: 'lastcol', pos: i }); lineStart = true; i++; continue; }
      if (ch === t.tag_space) { toks.push({ t: 'space', pos: i }); i++; continue; }
      /* 列尾锚定：本行标记之后的内容贴「本列末端」（目录页码行尾对齐用）。
         取到本行行尾（\n 之前），空白略过；标记后无内容时按普通字符回落（不吞输入）。 */
      if (t.tag_colend && ch === t.tag_colend) {
        var eolC = src.indexOf('\n', i + 1);
        var segC = eolC < 0 ? src.slice(i + 1) : src.slice(i + 1, eolC);
        if (segC.replace(/\s+/g, '')) {
          toks.push({ t: 'colend', chars: segC.split(''), pos: i });
          i = eolC < 0 ? src.length : eolC;     // 停在 \n，由外层继续吃换行
          lineStart = (eolC >= 0);
          continue;
        }
      }
      /* {徽标}：随文注释徽标锚点；无闭符或跨行的 { 视为普通字符 */
      if (ch === '{') {
        var endB = src.indexOf('}', i + 1);
        var btxt = endB > i ? src.slice(i + 1, endB) : '';
        if (btxt && btxt.indexOf('{') < 0 && btxt.indexOf('\n') < 0) {
          btxt = btxt.trim();
          if (btxt && num(t.badge_show, 1)) toks.push({ t: 'badge', text: btxt, pos: i });
          i = endB + 1; continue;
        }
      }
      if (ch === open) {
        var end = src.indexOf(close, i + 1);
        if (end < 0) { i++; continue; }
        var ctext = src.slice(i + 1, end);
        if (num(t.comment_comma_fullwidth, 1)) ctext = toFullwidthPunct(ctext);
        var cbC = splitBadge(ctext, num(t.badge_show, 1));
        toks.push({ t: 'comment', chars: cbC.chars, pos: i, posArr: cbC.poses.map(function (x) { return i + 1 + x; }) });
        i = end + 1; continue;
      }
      if (ch === aOpen) {
        var endA = src.indexOf(aClose, i + 1);
        if (endA < 0) { i++; continue; }
        var atext = src.slice(i + 1, endA);
        if (num(t.accent_comma_fullwidth, num(t.comment_comma_fullwidth, 1))) atext = toFullwidthPunct(atext);
        var cbA = splitBadge(atext, num(t.badge_show, 1));
        toks.push({ t: 'accent', chars: cbA.chars, pos: i, posArr: cbA.poses.map(function (x) { return i + 1 + x; }) });
        i = endA + 1; continue;
      }
      /* ^注音^：横排小字挂到「前一个字形」上。仅在正文层解析——夹注【】与强调 [] 的内容
         在各自分支内整段取走，其内部的 ^ 原样作普通字符（本版不支持夹注/强调内注音）。
         标记符左右同形（默认 ^^）：闭符取「下一个 ^」，空串/跨行/前面没有字形时不成立，
         按普通字符处理（不吞用户输入）。 */
      if (ch === rOpen && i + 1 < src.length) {
        var endR = src.indexOf(rClose, i + 1);
        if (endR > i + 1) {
          var rtxt = src.slice(i + 1, endR);
          if (rtxt && rtxt.indexOf('\n') < 0 && rtxt.indexOf(rOpen) < 0) {
            toks.push({ t: 'ruby', text: rtxt, raw: src.slice(i, endR + 1), pos: i });
            i = endR + 1; continue;
          }
        }
      }
      if (ch === close || ch === aClose) { i++; continue; }
      if (/\s/.test(ch)) { i++; continue; }
      toks.push({ t: 'char', c: ch, pos: i });
      i++;
    }
    return toks;
  }

  /* ------------------------------------------------------------- 3. 分页 */
  /**
   * 返回 { pages: [ {vol, leaf, cols:[{x,half,items:[]}]} ], metrics, stats }
   * 填充规则：列内自上而下，列自右而左；【】内为夹注，双行小字；
   * % 换页（另起一张纸），$ 换半叶，& 跳至本半叶末列，@ 占一格空白。
   */
  function paginate(t, text) {
    var m = computeMetrics(t);
    var colDefs = columns(m);
    var nCols = colDefs.length;
    var toks = tokenize(text, t);
    var nopSet = setOf(t.text_comma_nop), rotSet = setOf(t.text_comma_90);
    /* 强调标点：独立参数，缺省回落正文（与 accent_* 样式参数同策略） */
    var anopSet = setOf(t.accent_comma_nop || t.text_comma_nop), arotSet = setOf(t.accent_comma_90 || t.text_comma_90);
    var aModeP = String(t.accent_comma_mode || t.text_comma_mode || 'full');
    var aHangP = (aModeP === 'hang' || aModeP === 'judou');   // 强调：句读与悬空同路
    var cnopSetP = setOf(t.comment_comma_nop), crotSetP = setOf(t.comment_comma_90);
    var cModeP = String(t.comment_comma_mode || 'full');
    var cHangP = (cModeP === 'hang' || cModeP === 'judou');   // 夹注：句读与悬空同路
    /* 青简夹注行宽模型：注字=1 注字位，full 标点=1；hang/none 的 nop（、，。类）=0，
       rot（「」〔〕（）类）始终占格（hang=1，none 已从 vis 剔除）——引号括号是行文结构，
       悬空漂移会破坏文意，故悬空模式仅 nop 贴前字角不占位。
       夹注占用列空间 = 最长行有效长 × 注字格高（fit-content）——切换全角/半角时夹注块变短，
       后续正文随之重排（与青简一致） */
    function cIsPunct(c) { return !!(cnopSetP[c] || crotSetP[c]); }
    function cEffLen(arr, from, to) {
      var s = 0;
      for (var i = from; i < to; i++) {
        var c = arr[i];
        if (typeof c === 'object') s += String(c.badge).length;   // 徽标按字数占格（与正文一致，字号不随字数缩）
        else         if (cnopSetP[c])      s += (cHangP || cModeP === 'none') ? 0 : 1;
        else if (crotSetP[c]) s += cModeP === 'none' ? 0 : 1;
        else s += 1;
      }
      return s;
    }

    var pages = [], cur = null, colIdx = 0, rowPos = 0, leafInVol = 0, placed = false;

    /* ^注音^ 挂靠用：每一轮循环重置，保证只有「紧挨着的上一个字形」能被注音挂上
       （跨换列、跨换页、跨其他标记都不成立 → 回落为普通字符） */
    var prevChar = null;

    function newPage() {
      cur = { vol: 1, leaf: leafInVol + 1, cols: [] };
      for (var i = 0; i < nCols; i++) cur.cols.push({ x: colDefs[i].x, half: colDefs[i].half, items: [] });
      pages.push(cur);
      leafInVol++;
      colIdx = 0; rowPos = 0;
    }
    function nextCol() {
      colIdx++; rowPos = 0;
      if (colIdx >= nCols) newPage();
    }
    newPage();

    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i];
      var rubyAnchor = prevChar;   // 仅当上一个 token 就是字形时才非空
      prevChar = null;
      if (tk.t === 'page') {
        if (!placed) continue;         // 章首的 %：前方无内容可断，不制造空白首叶
        newPage(); continue;           // 换页（另起一张纸）；不再做旧换卷逻辑（已清除）
      }
      if (tk.t === 'half') {
        var h = Math.floor(colIdx / m.cols);
        colIdx = (h + 1) * m.cols; rowPos = 0;
        if (colIdx >= nCols) newPage();
        continue;
      }
      if (tk.t === 'lastcol') {
        // vRain 语义：跳至「本叶」最后一列（左半叶最左列），用于卷回文末
        var target = nCols - 1;
        if (cur.cols[target].items.length) newPage();   // 末列已占用则另起一叶，绝不覆盖
        colIdx = target; rowPos = 0;
        continue;
      }
      if (tk.t === 'space') {
        if (rowPos + 1 > m.rowNum) nextCol();
        cur.cols[colIdx].items.push({ type: 'space', row: rowPos, _pos: tk.pos });
        rowPos += 1;
        continue;
      }
      if (tk.t === 'colend') {
        /* 列尾锚定：把本行标记之后的内容（页码）整体贴到本列末端，中间留白
           —— 目录「章名 … 页码」行尾对齐。一字一格（空白不占格，与正文一致）；
           整段超过一列时锚定无意义，退化为普通流式逐字推进（绝不覆盖已排内容）。 */
        placed = true;
        var ceTxt = String(tk.chars.join('')).replace(/\s+/g, '');
        var ceLen = ceTxt.length;
        var ceAnchor = ceLen > 0 && ceLen <= m.rowNum;
        if (ceAnchor && rowPos + ceLen > m.rowNum) nextCol();
        var ceFill = ceAnchor ? m.rowNum - rowPos - ceLen : 0;
        for (var qf = 0; qf < ceFill; qf++) {
          cur.cols[colIdx].items.push({ type: 'space', row: rowPos, _pos: tk.pos });
          rowPos += 1;
        }
        for (var qc = 0; qc < ceTxt.length; qc++) {
          if (rowPos + 1 > m.rowNum) nextCol();
          cur.cols[colIdx].items.push({
            type: 'char', c: ceTxt.charAt(qc), kind: 'text', row: rowPos,
            nop: false, rot: false, pMode: String(t.text_comma_mode || 'full'), _pos: tk.pos
          });
          rowPos += 1;
        }
        continue;
      }
      if (tk.t === 'badge') {              // 注释徽标：默认 1 字格；设定大字号时按框高自动占多格
        placed = true;
        var bn = String(tk.text).length;
        var bSz = num(t.badge_size, 0) > 0 ? num(t.badge_size, 0) : m.fontSize * 0.72;
        var bspan = Math.max(1, Math.ceil(bSz * (bn + 0.32) / m.cellH - 1e-9));
        if (rowPos + bspan > m.rowNum) nextCol();
        cur.cols[colIdx].items.push({ type: 'badge', text: tk.text, row: rowPos, span: bspan, _pos: tk.pos });
        rowPos += bspan;
        continue;
      }
      if (tk.t === 'ruby') {
        /* 注音挂「前一个字」：仅当紧邻的上一个 token 是普通正文汉字才成立
           （标点、已有注音的重复标记、句首都不接收）→ 否则把 ^…^ 原样退回普通字符，
           让用户看得见自己输入了什么，不静默吞掉。
           `m.rubySize > 0` 是「本模板能排出注音」的前提（注音关闭 / 固定字号模板下为 0）——
           排不出时同样回落为普通字符，绝不静默吃掉。 */
        if (m.rubySize > 0 && rubyAnchor && !rubyAnchor.nop && !rubyAnchor.rot && !rubyAnchor.ruby) {
          rubyAnchor.ruby = tk.text;
          continue;
        }
        placed = true;
        var rawR = String(tk.raw || '');
        var rLast = null;
        for (var rq = 0; rq < rawR.length; rq++) {
          if (rowPos + 1 > m.rowNum) nextCol();
          rLast = {
            type: 'char', c: rawR.charAt(rq), kind: 'text',
            row: rowPos, nop: false, rot: false,
            pMode: String(t.text_comma_mode || 'full'), _pos: tk.pos
          };
          cur.cols[colIdx].items.push(rLast);
          rowPos += 1;
        }
        prevChar = rLast;
        continue;
      }
      if (tk.t === 'br') { nextCol(); continue; }
      if (tk.t === 'char') {
        placed = true;
        var nop = !!nopSet[tk.c], rot = !!rotSet[tk.c];
        var tMode2 = String(t.text_comma_mode || 'full');
        /* 句读与悬空同路：不占字位（刻本圈点是后加的旁注，本就不入字格） */
        var tHang2 = (tMode2 === 'hang' || tMode2 === 'judou');
        // 模式=无：不渲染、不占格（白文）
        if ((nop || rot) && tMode2 === 'none') continue;
        /* 占格：全角=1，半角=0.5，悬空/句读=0（none 已跳过）
           悬空只作用于 nop（、，。类）；rot（「」〔〕（）类）是行文结构，悬空漂移会破坏文意，
           故 hang/judou 下仍占整格——与夹注 cEffLen 规则一致 */
        var unit = 1;
        if (nop) unit = tHang2 ? 0 : 1;
        else if (rot) unit = 1;
        if (rowPos + unit > m.rowNum) {
          /* 避头点（闭合标点不居列首）——「标点压缩」：本列已满时闭号**不新起列**，
             全尺寸排在末字之后、列底「下底线→版框底」的余白里（放不下才等比缩，见渲染端），
             不占列内格 → 列尾齐平不破坏、不增列不增页、不越版框。
             挂到本列**最后一个字形**上（末端若是夹注块等块级件，闭号仍落在列底余白，
             观感即「紧跟整列末尾」），每个末字至多挂 2 个、再多则换列；
             列空无字可挂（如 % 换页后首个字符即标点）→ 直接换列（闭号居首，罕见兜底）。 */
          var isClose = nop || (rot && CLOSE_PUNCT.indexOf(tk.c) >= 0);
          var sqItems = cur.cols[colIdx].items, tgt = null;
          if (isClose) for (var si2 = sqItems.length - 1; si2 >= 0; si2--)
            if (sqItems[si2].type === 'char') { tgt = sqItems[si2]; break; }
          if (tgt && (tgt.sqz || []).length < 2) { (tgt.sqz = tgt.sqz || []).push(tk.c); continue; }
          nextCol();
        }
        var citem = {
          type: 'char', c: tk.c, kind: 'text',
          row: rowPos, nop: nop, rot: rot, pMode: tMode2, _pos: tk.pos
        };
        cur.cols[colIdx].items.push(citem);
        rowPos += unit;
        prevChar = citem;   // 供紧随其后的 ^注音^ 挂靠
        continue;
      }
      if (tk.t === 'chapter') {
        placed = true;
        /* 章节标点为独立档：**永远整格占位、原字原样**，与正文标点四模式
           （全角/悬空/句读/无）完全解耦 —— 不剔除、不半格、不悬空、不换圈点；
           rot 类（引号/括号）是否旋转 90° 仅由 chapter_punct_90 决定。
           理由：正文标点档描述的是**正文行文**的标点形态，章题属另一层结构；
           且目录（toc.ts 拼「@章名·页码」）走的是正文级文本，若此处按正文档
           剔除，同一串标题文字会在目录与章题两处得到不同结果。 */
        var cch = tk.chars, keep = [];
        for (var ci = 0; ci < cch.length; ci++) {
          var cc = cch[ci];
          keep.push({ c: cc, nop: !!nopSet[cc], rot: !!rotSet[cc] });
        }
        var perCol = chapterPerCol(t, m, tk.level);
        var ci2 = 0;
        while (ci2 < keep.length) {
          if (cur.cols[colIdx].items.length) nextCol();   // 列已有内容 → 章节另起新列
          var cnt = Math.min(keep.length - ci2, perCol);  // 本列放多少字（每字占一章字格）
          cur.cols[colIdx].items.push({
            type: 'chapter', level: tk.level,
            chars: keep.slice(ci2, ci2 + cnt).map(function (o) { return o.c; }),
            meta: keep.slice(ci2, ci2 + cnt),
            row: 0, span: cnt, _pos: tk.pos,
            posArr: (tk.posArr || []).slice(ci2, ci2 + cnt)
          });
          rowPos = m.rowNum;                              // 章节列视为占满，后续正文另起一列
          ci2 += cnt;
          if (ci2 < keep.length) nextCol();               // 标题超长 → 跨列继续
        }
        continue;
      }
      if (tk.t === 'accent') {
        placed = true;
        var acs = tk.chars;
        for (var ai = 0; ai < acs.length; ai++) {
          var ac = acs[ai];
          /* 强调段内的换行：与正文一致触发换列（而非被当字形画成空格）。
             源文本里的 \n 在 tokenizer 被整段切进 accent.chars，未转成 br token，
             故在此显式处理——与顶层 \n→br→nextCol 行为对齐 */
          if (ac === '\n') { nextCol(); continue; }
          if (typeof ac === 'object') {        // 徽标（{}）在强调段内仍可用
            var abn = String(ac.badge).length;
            var abSz = num(t.badge_size, 0) > 0 ? num(t.badge_size, 0) : m.fontSize * 0.72;
            var abspan = Math.max(1, Math.ceil(abSz * (abn + 0.32) / m.cellH - 1e-9));
            if (rowPos + abspan > m.rowNum) nextCol();
            cur.cols[colIdx].items.push({ type: 'badge', text: ac.badge, row: rowPos, span: abspan, _pos: (tk.posArr && tk.posArr[ai] != null ? tk.posArr[ai] : tk.pos) });
            rowPos += abspan;
            continue;
          }
          var anop = !!anopSet[ac], arot = !!arotSet[ac];
          var aMode = aModeP;
          var aHang = aHangP;
          if ((anop || arot) && aMode === 'none') continue;
          var aunit = 1;
          if (anop) aunit = aHang ? 0 : 1;
          else if (arot) aunit = 1;
          if (rowPos + aunit > m.rowNum) {
            /* 与正文同规：闭号不新起列，「标点压缩」排到末字之后的列底余白里 */
            var aIsClose = anop || (arot && CLOSE_PUNCT.indexOf(ac) >= 0);
            var asq = cur.cols[colIdx].items, atgt = null;
            if (aIsClose) for (var asi2 = asq.length - 1; asi2 >= 0; asi2--)
              if (asq[asi2].type === 'char') { atgt = asq[asi2]; break; }
            if (atgt && (atgt.sqz || []).length < 2) { (atgt.sqz = atgt.sqz || []).push(ac); continue; }
            nextCol();
          }
          cur.cols[colIdx].items.push({ type: 'char', c: ac, kind: 'text', row: rowPos, nop: anop, rot: arot, pMode: aMode, accent: true, _pos: (tk.posArr && tk.posArr[ai] != null ? tk.posArr[ai] : tk.pos) });
          rowPos += aunit;
        }
        continue;
      }
      if (tk.t === 'comment') {
        placed = true;
        var chars = tk.chars;
        var posArrC = tk.posArr || [];
        var posOff = 0;                      // 已在前面列排掉的字符数（posArr 随 chars 一起推进）
        while (chars.length > 0) {
          if (rowPos >= m.rowNum) nextCol();
          /* 有效字符序列（青简 vis）：none 剔除全部标点；hang 仅剔除 nop（、，。类，悬空挂前字
             宽 0 不占计数），rot（「」〔〕（）类）保留计数、正常占格 */
          var vis = [], vmap = [];
          for (var vi = 0; vi < chars.length; vi++) {
            var vch = chars[vi];
            if (typeof vch === 'object') { vis.push(vch); vmap.push(vi); continue; }   // 徽标恒可见、按字数占格
            if (cModeP === 'none' ? cIsPunct(vch) : (cHangP && cnopSetP[vch])) continue;
            vis.push(vch); vmap.push(vi);
          }
          if (!vis.length && cHangP) {
            /* 全标点夹注兜底：悬空无锚点可挂 → 退回计数含标点 */
            for (var vi3 = 0; vi3 < chars.length; vi3++) { vis.push(chars[vi3]); vmap.push(vi3); }
          }
          if (!vis.length) break;
          var vN = vis.length;
          var lastVch = vis[vN - 1];
          var lastPch = typeof lastVch === 'string' &&
            (cnopSetP[lastVch] || CLOSE_PUNCT.indexOf(lastVch) >= 0);
          var per = (vN % 2 === 1 && lastPch) ? Math.max(1, (vN - 1) / 2)      // 尾闭合标点 → 右短左长：挤挂后齐平、span 不增
                  : Math.ceil(vN / 2);                                  // 每行字符数（青简 count-based 折行）
          /* 避头点：切点落在闭合标点上 → 标点并入右行行尾（跟住前字），不居左行首 */
          while (per < vN && typeof vis[per] === 'string' &&
                 (cnopSetP[vis[per]] || CLOSE_PUNCT.indexOf(vis[per]) >= 0)) per++;
          /* 切分按有效格数均衡（挤挂感知）：左长 1 且左行尾是闭合标点 → 视为已均衡；只增不减，避头约束不破坏 */
          while (per < vN) {
            var eLt = cEffLen(vis, per, vN), eRt = cEffLen(vis, 0, per);
            if (eLt <= eRt) break;
            if (eLt - eRt === 1 && lastPch) break;
            per++;
          }
          /* 挤挂候选（迷你字形不占格 → 两行齐平底）：**仅在它能决定「本列放不放得下」时才执行**
             （2026-09-22 改口径，详见下方 sqz 判据）。其余情形不挤挂——标点正常占格，
             块按内容进位一格、块内字距锁死规范注字格。 */
          var effR = cEffLen(vis, 0, per), effL = cEffLen(vis, per, vis.length), cand = null;
          /* 挤挂候选：**长行**行尾是标点（闭号或悬空点）即可 —— 不再要求两行差恰为 1（与跨列分支同口径）。 */
          if (effR > effL && per > 0 && typeof vis[per - 1] === 'string' &&
              (cnopSetP[vis[per - 1]] || CLOSE_PUNCT.indexOf(vis[per - 1]) >= 0)) cand = 'R';
          else if (effL > effR && typeof vis[vis.length - 1] === 'string' &&
              (cnopSetP[vis[vis.length - 1]] || CLOSE_PUNCT.indexOf(vis[vis.length - 1]) >= 0)) cand = 'L';
          var effMax0 = Math.max(effR, effL),
              effMaxS = Math.max(effR - (cand === 'R' ? 1 : 0), effL - (cand === 'L' ? 1 : 0)),
              spNo = Math.max(1, Math.ceil(effMax0 * m.commentCellNorm / m.cellH - 0.08)),
              spYes = Math.max(1, Math.ceil(effMaxS * m.commentCellNorm / m.cellH - 0.08)),
              /* 执行条件（2026-09-22 改口径：标点优先 · 块进一格 · 块内字距锁定）：
                 挤挂**只在它能决定「本列放不放得下」时才执行** —— 即不挤挂的 span 超出本列剩余
                 行数（m.rowNum − rowPos）、挤挂后放得下。此时收益是实打实的：不折列，且挤出的
                 那个标点沉入列底版框余白带**全尺寸**渲染（渲染端 sqEdge 档，用户认可的列底效果）。
                 其余情形（块中、本列本就放得下）一律不挤挂：块按内容进位一格、块内字距锁死规范
                 注字格（见渲染端 rowCell）、标点正常占格。旧规则「能省一个正文字位就挤」的收益
                 常是账面的（省下的那 1 格往往排不进下一个 token），而块内有余量时字距会被两端
                 钉格均分公式摊开（实测 +6.5%~+44.4%），远不如保住标点形态划算。
                 旧条件「两行明显不齐」一并取消：那属块中情形，新口径下由「块进位 + 字距锁定」
                 自然消除底空，不再靠牺牲标点形态去换。 */
              sqz = (cand && spNo > m.rowNum - rowPos + 1e-9 && spYes <= m.rowNum - rowPos + 1e-9) ? cand : null,
              effMax = sqz ? effMaxS : effMax0;
          /* 栅格锁（元宝 / W3C 中文排版草案模型）：夹注整体必须占「整数字位」的正文格，
             双行夹注 = 1 个正文字位、四行 = 2 个……列尾才能齐。
             此前 spanRows 是浮点累加 → 各列残余小数不同 → 列尾参差。
             容差 0.08：允许内容比整数格高 8% 以内仍按该格算（避免浮点与用户微调行距多占一格），
             超出则进位；渲染端 rowCell/fsC 会按 boxH 收缩，内容永不溢出格。
             用 commentCellNorm（规范点注格高）而非实际 commentCellH → 块占格与 text_ydis 解耦：
             调字距只改字形，块格数不跳（详见 computeMetrics 里的说明）。 */
          var spanRows = Math.max(1, Math.ceil(effMax * m.commentCellNorm / m.cellH - 0.08));
          var availRows = m.rowNum - rowPos;
          if (spanRows <= availRows + 1e-9) {                      // 当前列整段放下
            cur.cols[colIdx].items.push({ type: 'comment', chars: chars, row: rowPos, span: spanRows, per: per, sqz: sqz, _pos: tk.pos, posArr: tk.posArr ? posArrC.slice(posOff) : undefined });
            rowPos += spanRows;
            chars = [];
          } else {                                                 // 放不下 → 截短本列段，余下换列
            /* 列底不足 1 个正文字位（栅格锁下夹注最少占 1 格）→ 整段移下一列，不缩字号硬塞 */
            if (availRows < 1 - 1e-9) { nextCol(); continue; }
            var fitChars = Math.max(2, 2 * Math.floor(availRows * m.cellH / m.commentCellNorm));
            var k = Math.min(vis.length, fitChars);
            if (k < vis.length && k % 2) k--;
            /* 折点方案闭包：给定「取 kk 个可视单元」+「尾串标点是否压缩(useHang)」→ rawTake（避头吞尾）/
               segN/均衡 segPer/挤挂 sqz/两行压缩后有效格数 effR·effL → 返回**未经 availRows 钳制**的
               原始 spanRaw。外层在 (k,k+1) × (不压缩,压缩) 四个候选里择优（见下）。 */
            var planSeg = function (kk, useHang) {
            var rawTake = vmap[Math.min(kk, vmap.length) - 1] + 1;
            if (cHangP) { while (rawTake < chars.length && cnopSetP[chars[rawTake]]) rawTake++; }  // 折列点后紧跟的悬空 nop 随前字（rot 已占计数不吞）
            var rawTakePre = rawTake;                              // 折点原名落点（记下来算「闭号尾串」）
            while (rawTake < chars.length && typeof chars[rawTake] === 'string' &&
                   (cnopSetP[chars[rawTake]] || CLOSE_PUNCT.indexOf(chars[rawTake]) >= 0)) rawTake++;   // 避头点：闭合标点不留给下列首
            /* 闭号尾串 → **标点压缩**（同正文 v-sqz 口径）：仍归本段（绝不留给下列首），
               但**不占格**——渲染端把它挂排在段末字之后、沉入段底留白带内（全尺寸）。
               本文与正文的分工：正文只有「列满」一种避头，夹注有两处 ——
                 ① 闭号将落在**左列头**（= 右列尾之后那格）→ 并入右列尾、正常占字位（上面 per++）；
                 ② 闭号将落在**折列后新段头** → 即此处：拉回前段并压缩，不占格。
               本段 span 保持原值（折列段恒贴列底，栅格锁下最少 1 格）——省下的那一格转为
               块内均分余量（首末字仍钉死格网、列尾齐平不受影响），不增列不增页。 */
            /* 避头拉回的尾串标点（闭号 **与悬空点（：、；）**）**可**压缩——仍归本段（绝不留给下列首），
               但**不占格**：渲染端挂在段末字之后、沉入段底留白带。用户口径（2026-09-21）：
               「：」本来就是**避头标点**，拉回上一块后按「标点压缩」不占格，不该因它是 nop 就区别对待
               （旧版只认 CLOSE_PUNCT 且遇 nop 即 break → 「：」占整格 → span 多算 → 左子列底空 2 行）。
               但压缩会让**左行变短**，只有当它让两行更齐平（|effR−effL| 变小）时才划算 ——
               故由外层择优（useHang），不无条件压缩。rawTake − rawTakePre 即避头吞入的标点个数。 */
            var hangN = useHang ? (rawTake - rawTakePre) : 0;
            var seg = chars.slice(0, rawTake);
            /* 段内实际可见单元数：rawTake 吞尾标点（避头）后可能 > k——渲染端 fold 按全 chars 计数，
               此处必须同口径，否则多出的标点落到左行尾、maxEff 超 span 预算 → 底对齐整块上移 */
            var segN = 0;
            while (segN < vmap.length && vmap[segN] < rawTake) segN++;
            var segVis = vis.slice(0, segN);
            var lastV = segVis[segN - 1];
            var lastP = typeof lastV === 'string' &&
              (cnopSetP[lastV] || CLOSE_PUNCT.indexOf(lastV) >= 0);
            var segPer = (segN % 2 === 1 && lastP) ? Math.max(1, (segN - 1) / 2)   // 尾闭合标点 → 右短左长：挤挂后齐平、span 不增
                       : Math.max(1, Math.ceil(segN / 2));
            /* 避头点（跨列段同规则）：切点闭合标点并入右行行尾 */
            while (segPer < segN && typeof segVis[segPer] === 'string' &&
                   (cnopSetP[segVis[segPer]] || CLOSE_PUNCT.indexOf(segVis[segPer]) >= 0)) segPer++;
            /* 有效格数均衡（挤挂感知）：左长 1 且左行尾是闭合标点 → 视为已均衡（挤挂齐平） */
            while (segPer < segN) {
              var eLg = cEffLen(segVis, segPer, segN), eRg = cEffLen(segVis, 0, segPer);
              if (eLg <= eRg) break;
              if (eLg - eRg === 1 && lastP) break;
              segPer++;
            }
            var segEffR = cEffLen(segVis, 0, segPer), segEffL = cEffLen(segVis, segPer, segN), segCand = null;
            /* 【2026-09-21】吞尾闭号（hangN 个）由渲染端压缩沉入段底、**不占格**；但分页端 cEffLen
               在 full 模式仍按 eff=1 计入 → span 被多算 → 整块被外层钳短（列6 类底空）。此处扣除之，
               随后 sqz 候选判断才正确（与渲染端「hang 弹字不占位」同口径）。 */
            if (hangN > 0) {
              var hEff = 0, hCnt = 0;
              for (var hb = segN - 1; hb >= 0 && hCnt < hangN; hb--) {
                var hbc = segVis[hb];
                /* 同 hangN 口径：闭号 **与 nop** 都压缩不占格（旧版只认闭号，遇 nop 即停 → 扣不掉） */
                if (typeof hbc !== 'string' || (CLOSE_PUNCT.indexOf(hbc) < 0 && !cnopSetP[hbc])) break;
                hEff += cEffLen(segVis, hb, hb + 1); hCnt++;
              }
              if (segPer < segN) segEffL = Math.max(0, segEffL - hEff);
              else               segEffR = Math.max(0, segEffR - hEff);
            }
            /* 挤挂候选：**长行**行尾是标点（闭号或悬空点）即可 —— 不再要求两行差恰为 1。
               压缩令长行少占 1 格 → |effR−effL| 直接 −1，即「短子列底空行数」−1。 */
            if (segEffR > segEffL && segPer > 0 && typeof segVis[segPer - 1] === 'string' &&
                (cnopSetP[segVis[segPer - 1]] || CLOSE_PUNCT.indexOf(segVis[segPer - 1]) >= 0)) segCand = 'R';
            else if (segEffL > segEffR && !hangN && typeof segVis[segVis.length - 1] === 'string' &&
                (cnopSetP[segVis[segVis.length - 1]] || CLOSE_PUNCT.indexOf(segVis[segVis.length - 1]) >= 0)) segCand = 'L';
            /* 执行条件：① 能省下一个正文字位（原规则——避免「挤挂无收益、白牺牲标点形态」，
               用户 2026-09-17 反馈）；或 ② 两行明显不齐（|effR−effL| ≥ 2）——此时收益是「底空少一行」。
               注：hangN>0 时禁 'L'（尾串已从段末弹出，再挂左行尾会重复扣格）。 */
            var segEff0 = Math.max(segEffR, segEffL),
                segEffS = Math.max(segEffR - (segCand === 'R' ? 1 : 0), segEffL - (segCand === 'L' ? 1 : 0)),
                segSpNo = Math.max(1, Math.ceil(segEff0 * m.commentCellNorm / m.cellH - 0.08)),
                segSpYes = Math.max(1, Math.ceil(segEffS * m.commentCellNorm / m.cellH - 0.08)),
                segSqz = (segCand && (segSpYes < segSpNo || Math.abs(segEffR - segEffL) >= 2)) ? segCand : null,
                segEffMax = segSqz ? segEffS : segEff0;
            return { rawTake: rawTake, hangN: hangN, seg: seg, segPer: segPer, segSqz: segSqz, kk: kk,
                     /* 回传**压缩执行后**的两行格数：sqz 令长行再少 1 → 外层按此算真实底空 */
                     effR: segEffR - (segSqz === 'R' ? 1 : 0), effL: segEffL - (segSqz === 'L' ? 1 : 0),
                     spanRaw: Math.max(1, Math.ceil(segEffMax * m.commentCellNorm / m.cellH - 0.08)) };
            };
            /* 【2026-09-21】四候选择优：(取 k 或 k+1) × (尾串不压缩 / 压缩)。排序键（字典序）：
                 ① |effR − effL| 最小 —— 正好等于**短子列底空行数**，即用户看得见的「空着一格」；
                 ② 「不溢出」（spanRaw ≤ availRows）优先 —— 溢出会被外层 Math.min 钳短、行距被挤；
                 ③ spanRaw 最小；④ k 最小（少挪后文，减少连带位移）。
               正常块（k 方案本就不溢出且齐平）四项全优 → 此分支不触及，与旧版逐位一致。 */
            var cands = [];
            for (var dk = 0; dk <= 3; dk++) {
              if (k + dk > vis.length) break;
              cands.push(planSeg(k + dk, false));
              cands.push(planSeg(k + dk, true));
            }
            var ps = cands[0];
            for (var ci2 = 1; ci2 < cands.length; ci2++) {
              var cc = cands[ci2], psd = Math.abs(ps.effR - ps.effL), ccd = Math.abs(cc.effR - cc.effL);
              var pso = ps.spanRaw > availRows + 1e-9, cco = cc.spanRaw > availRows + 1e-9;
              var better = ccd !== psd ? ccd < psd
                         : cco !== pso ? !cco
                         : cc.spanRaw !== ps.spanRaw ? cc.spanRaw < ps.spanRaw
                         : cc.kk < ps.kk;
              if (better) ps = cc;
            }
            var rawTake = ps.rawTake, hangN = ps.hangN, seg = ps.seg,
                segPer = ps.segPer, segSqz = ps.segSqz;
            var segSpan = Math.min(availRows, ps.spanRaw);   // 同上：整数字位栅格锁（规范注格高）
            /* sqz 与 hang 可并存（各自从右行/左行尾弹字）：仅当 sqz='L' 时二者都弹左行 →
               与 hang 的扣除口径重复计数，弃 sqz（折点标点仍由 hang 压缩，不占格）。 */
            cur.cols[colIdx].items.push({ type: 'comment', chars: seg, row: rowPos, span: segSpan, per: segPer, sqz: (hangN && segSqz === 'L') ? null : segSqz, hang: hangN, _pos: tk.pos, posArr: tk.posArr ? posArrC.slice(posOff, posOff + rawTake) : undefined });
            rowPos += segSpan;
            chars = chars.slice(rawTake);
            posOff += rawTake;                 // 与 chars 同步推进，下一段 posArr 才对齐
            if (chars.length > 0) nextCol();                       // 还有剩余，换列继续
          }
        }
        continue;
      }
    }

    var stats = {
      pages: pages.length,
      chars: 0,
      leaves: pages.length
    };
    for (var p = 0; p < pages.length; p++)
      for (var c = 0; c < pages[p].cols.length; c++)
        for (var k = 0; k < pages[p].cols[c].items.length; k++) {
          var it = pages[p].cols[c].items[k];
          stats.chars += it.type === 'char' && !it.nop ? 1 : 0;
          if (it.type === 'comment') stats.chars += it.chars.length;
        }

    return { metrics: m, pages: pages, stats: stats };
  }

  /* --------------------------------------------- 4. 书口（象鼻）与鱼尾几何 */
  /** 书口样式归一化：none | single（单象鼻）| double（双象鼻）
   *  旧值兼容：on/auto 归并为 double，off 归并为 none */
  function seamMode(t) {
    var sm = String(t.if_seam === undefined ? 'double' : t.if_seam);
    if (sm === 'off' || sm === 'none') return 'none';
    if (sm === 'single') return 'single';
    return 'double';
  }

  /** 鱼身与书口横线之间的悬挂间隙（px）：由 fish_line_margin 控制，默认 4 */
  function seamGap(t) { return num(t.fish_line_margin, 4); }

  /**
   * 书口 = 象鼻（中缝中线竖线）+ 书口横线（宽贯中缝）
   * 位置基准为上/下分割线 Y（fish_top_y / fish_btm_y），与鱼尾开关完全无关：
   *   · 单象鼻 → 上横线 + 上象鼻[版心顶, 上分割线 Y]
   *   · 双象鼻 → 再 + 下横线 + 下象鼻[下分割线 Y, 版心底]
   * 象鼻只画在横线外侧，两横线之间的中缝留给书名/卷次/页码，不通高版心。
   */
  function seamGeom(t, m) {
    var y0 = m.content.y0, y1 = m.content.y1;
    var mode = seamMode(t), color = t.seam_color || '#1a1a1a';
    var topY = t.fish_auto ? (y0 + num(t.fish_top_pad, 100)) : num(t.fish_top_y, y0 + 100);
    var btmY = t.fish_auto ? (y1 - num(t.fish_btm_pad, 200)) : num(t.fish_btm_y, y1 - 200);
    var out = { mode: mode, color: color, topY: topY, btmY: btmY, bars: [], segs: [] };
    if (mode === 'none') return out;
    var tLw = num(t.seam_top_linewidth, 0), bLw = num(t.seam_btm_linewidth, 0);
    if (tLw > 0) out.bars.push({ y: topY, lw: tLw, color: color });
    if (mode === 'double' && bLw > 0) out.bars.push({ y: btmY, lw: bLw, color: color });
    function seg(a, b) { a = Math.max(a, y0); b = Math.min(b, y1); if (b - a > 0.01) out.segs.push({ y0: a, y1: b }); }
    seg(y0, topY);
    if (mode === 'double') seg(btmY, y1);
    return out;
  }

  /**
   * 鱼尾 = 单块五边形（vRain 口径）+ 花饰（自身不带横线）
   * 宽边贴基线，自尾侧向内挖 V 口：两瓣垂/翘 d1+d2，凹口底仅 d1（d1=鱼身高，d2=鱼尾高；
   * d1=0 时退化为实心三角）。位置基准为上/下分割线 Y，若该处存在书口横线，则空 SEAM_GAP 紧贴。
   * 下鱼尾默认对鱼尾（direction=1）：底边贴下书口横线，两瓣翘上、凹口朝下；
   * direction=0 为顺鱼尾：与上鱼尾同形，悬挂于下书口横线之下。
   */
  function fishGeom(t, m) {
    var cx = m.centerX, hw = Math.max(4, m.centerW) / 2;   // 鱼尾宽 = 中缝宽
    var x0 = cx - hw, x1 = cx + hw;
    var shape = t.fish_shape, parts = [];

    /* 鱼尾本体：基线 y 上、朝 dir 方向伸出，凹口深 d1、两瓣深 d1+d2 */
    function notch(y, d1, d2, dir) {
      var sgn = dir === 'down' ? 1 : -1;
      function Y(v) { return f(y + sgn * v); }
      if (shape === 'flower') {
        // 花鱼尾：冠形——直边贴基线，外缘三尖两凹弧（尖朝 dir），深度取 d2
        var hh = d2;
        if (hh <= 0) return null;
        var w = x1 - x0;
        function X(r) { return f(x0 + w * r); }
        return 'M ' + f(x0) + ' ' + f(y) +
          ' L ' + f(x0) + ' ' + Y(hh) +
          ' Q ' + X(0.17) + ' ' + Y(hh * 0.16) + ' ' + X(0.34) + ' ' + Y(hh * 0.70) +
          ' Q ' + X(0.42) + ' ' + Y(hh * 0.28) + ' ' + f(cx) + ' ' + Y(hh) +
          ' Q ' + X(0.58) + ' ' + Y(hh * 0.28) + ' ' + X(0.66) + ' ' + Y(hh * 0.70) +
          ' Q ' + X(0.83) + ' ' + Y(hh * 0.16) + ' ' + f(x1) + ' ' + Y(hh) +
          ' L ' + f(x1) + ' ' + f(y) + ' Z';
      }
      if (d1 + d2 <= 0) return null;
      if (shape === 'arc') {
        // 弧形：同五边形布局，凹口两侧为内凹圆弧（两瓣 + 中央凹尖）
        return 'M ' + f(x0) + ' ' + f(y) + ' L ' + f(x1) + ' ' + f(y) +
          ' L ' + f(x1) + ' ' + Y(d1 + d2) +
          ' Q ' + f(cx) + ' ' + Y(d1 + d2) + ' ' + f(cx) + ' ' + Y(d1) +
          ' Q ' + f(cx) + ' ' + Y(d1 + d2) + ' ' + f(x0) + ' ' + Y(d1 + d2) + ' Z';
      }
      // 三角（vRain 五边形）：M 左上 → 右上 → 右瓣 → 凹口底 → 左瓣 → Z
      return 'M ' + f(x0) + ' ' + f(y) + ' L ' + f(x1) + ' ' + f(y) +
        ' L ' + f(x1) + ' ' + Y(d1 + d2) +
        ' L ' + f(cx) + ' ' + Y(d1) +
        ' L ' + f(x0) + ' ' + Y(d1 + d2) + ' Z';
    }

    var out = { top: null, btm: null, mid: null, decor: [], seam: null, seamBars: null };
    var mode = t.fish_mode === 'centerline' ? 'none' : t.fish_mode;   // 兼容旧值：中心线并入「无」
    var sg = seamGeom(t, m);

    /* 书口：象鼻竖线 + 书口横线（与鱼尾样式互不依赖） */
    var sw = num(t.seam_width, 2);
    if (sg.mode !== 'none' && sw > 0) {
      out.seam = { color: sg.color, width: sw, y0: m.content.y0, y1: m.content.y1, segs: sg.segs };
    }
    if (sg.bars.length) out.seamBars = sg.bars;

    /* 上鱼身悬挂锚点（上鱼尾）：横线下 baseY + 线宽/2 + fish_line_margin */
    function anchorBelow(baseY) {
      var y = baseY;
      for (var i = 0; i < sg.bars.length; i++)
        if (Math.abs(sg.bars[i].y - baseY) < 0.01) y = baseY + sg.bars[i].lw / 2 + seamGap(t);
      return y;
    }
    /* 下鱼尾最低点（下鱼尾）：横线上方 baseY − 线宽/2 − fish_line_margin */
    function btmLow(baseY) {
      var y = baseY;
      for (var i = 0; i < sg.bars.length; i++)
        if (Math.abs(sg.bars[i].y - baseY) < 0.01) y = baseY - sg.bars[i].lw / 2 - seamGap(t);
      return y;
    }

    // 花饰：花鱼尾用对生叶枝，其余形状用三孔
    function decorFor(color, bodyY, bodyH) {
      if (!t.fish_decor || bodyH <= 0) return;
      if (shape === 'flower') {
        var r = Math.min(bodyH * 0.34, hw * 0.26);
        out.decor.push({ kind: 'leaf', x: cx - hw * 0.44, y: bodyY + bodyH * 0.52, r: r, color: color });
        out.decor.push({ kind: 'leaf', x: cx + hw * 0.44, y: bodyY + bodyH * 0.52, r: r, color: color });
      } else {
        out.decor.push({ x: cx, y: bodyY + bodyH / 2, r: Math.min(bodyH * 0.26, hw * 0.3), color: color });
      }
    }

    if (mode !== 'none') {
      // 上鱼尾：五边形宽边贴上书口横线下侧、两瓣垂下（凹口朝下）
      var aT = anchorBelow(sg.topY);
      var tRect = num(t.fish_top_rectheight, 0), tTri = num(t.fish_top_triaheight, 0);
      out.top = {
        color: t.fish_top_color,
        body: shape === 'flower' && tRect > 0 ? { x: x0, y: aT, w: hw * 2, h: tRect } : null,
        tri: shape === 'flower' ? notch(aT + tRect, 0, tTri, 'down') : notch(aT, tRect, tTri, 'down')
      };
      decorFor(t.fish_top_color, aT, tRect);
      if (mode === 'double' || mode === 'triple') {
        // 下鱼尾：固定尖朝上（对鱼尾），删除方向开关；双/三鱼尾共用
        var bLow = btmLow(sg.btmY);
        var bRect = num(t.fish_btm_rectheight, 0), bTri = num(t.fish_btm_triaheight, 0);
        out.btm = {
          color: t.fish_btm_color,
          body: shape === 'flower' && bRect > 0 ? { x: x0, y: bLow - bRect, w: hw * 2, h: bRect } : null,
          tri: shape === 'flower' ? notch(bLow - bRect, 0, bTri, 'up') : notch(bLow, bRect, bTri, 'up')
        };
        decorFor(t.fish_btm_color, bLow - bRect, bRect);
      }
      if (mode === 'triple') {
        // 中鱼尾：内容区中部，无书口横线；方向可翻（默认朝下=同上鱼尾），位置用内容区高度比例
        var mY = m.content.y0 + m.content.h * clamp01(num(t.fish_mid_pos, 0.5), 0, 1);
        var mDir = num(t.fish_mid_direction, 0) === 1 ? 'up' : 'down';
        var mRect = num(t.fish_mid_rectheight, 0), mTri = num(t.fish_mid_triaheight, 0);
        var mBodyY = mDir === 'down' ? mY : mY - mRect;
        var mTriBase = mDir === 'up' ? mBodyY : mBodyY + mRect;   // 花鱼尾：三角从 body 顶(朝上)或底(朝下)边无缝衔接，避免重叠
        out.mid = {
          color: t.fish_mid_color,
          body: shape === 'flower' && mRect > 0 ? { x: x0, y: mBodyY, w: hw * 2, h: mRect } : null,
          tri: shape === 'flower' ? notch(mTriBase, 0, mTri, mDir) : notch(mY, mRect, mTri, mDir)
        };
        decorFor(t.fish_mid_color, mBodyY, mRect);
      }
    }
    return out;
  }

  /* ----------------------------------------------------------- 5. 渲染 SVG */
  /* 注释徽标 SVG：牌记式竖排小徽标——外框圆角矩形 + 内细线 + 四角菱形花饰 + 竖排字
     famFallback：所在位置字体（正文→正文字体，夹注→夹注字体）；
     ctxOnly=1 时无视显式徽标字体设置，始终随所在位置（夹注内徽标永远随夹注） */
  function badgeSvg(t, cx, cy, size, text, famFallback, ctxOnly) {
    var chars = String(text || '').split('');
    var col = t.badge_color || '#a8322a';
    var fam = familyStack(ctxOnly ? (famFallback || t.text_font_family)
                                  : (t.badge_font_family || famFallback || t.text_font_family));
    /* ctxOnly（夹注内）：size = 徽标内文字字号，框贴字形（紧凑衬距）→ 字与注字几乎同大；
       正文内：size = 字位，字形 = 0.78×字位（框留呼吸衬距） */
    var gs = ctxOnly ? size : size * 0.78;
    var pad = ctxOnly ? size * 0.04 : size * 0.16;
    var bw = ctxOnly ? size * 1.12 : size * 1.26;
    var bh = chars.length * gs + pad * 2;
    var x0 = cx - bw / 2, y0 = cy - bh / 2;
    var o = ['<g class="v-badge">'];
    o.push('<rect x="' + f(x0) + '" y="' + f(y0) + '" width="' + f(bw) + '" height="' + f(bh) +
      '" rx="' + f(bw * 0.2) + '" fill="' + col + '" fill-opacity="0.10" stroke="' + col + '" stroke-width="' + f(Math.max(1, size * 0.055)) + '"/>');
    if (num(t.badge_decor, 1) && !ctxOnly) {   // 夹注内框贴字形，空间小，不加内线/角饰
      var inS = size * 0.09;
      o.push('<rect x="' + f(x0 + inS) + '" y="' + f(y0 + inS) + '" width="' + f(bw - inS * 2) + '" height="' + f(bh - inS * 2) +
        '" rx="' + f(bw * 0.12) + '" fill="none" stroke="' + col + '" stroke-width="' + f(Math.max(0.5, size * 0.022)) + '"/>');
      var ds = size * 0.09, mg = inS * 2.4;
      var cs = [[x0 + mg, y0 + mg], [x0 + bw - mg, y0 + mg], [x0 + mg, y0 + bh - mg], [x0 + bw - mg, y0 + bh - mg]];
      for (var k = 0; k < 4; k++)
        o.push('<rect x="' + f(cs[k][0] - ds / 2) + '" y="' + f(cs[k][1] - ds / 2) + '" width="' + f(ds) + '" height="' + f(ds) +
          '" fill="' + col + '" transform="rotate(45 ' + f(cs[k][0]) + ' ' + f(cs[k][1]) + ')"/>');
    }
    for (var i = 0; i < chars.length; i++) {
      var yb = cy - (chars.length - 1) * gs / 2 + i * gs;
      o.push('<text class="v-t v-badge-t" x="' + f(cx) + '" y="' + f(yb) + '" font-size="' + f(gs) +
        '" fill="' + col + '" font-family="' + esc(fam) + '"' +
        ' text-anchor="middle" dominant-baseline="central">' + esc(chars[i]) + '</text>');
    }
    o.push('</g>');
    return o.join('');
  }

  function drawColumn(t, m, col, out) {
    var fs = m.textFs != null ? m.textFs : m.fontSize;   // 注音开启时为正文字号的 0.95 倍左右（格子不动）
    /* 注音让位系数（章题字形同样让位，2026-09-15 三稿）：正文字形读 m.textFs（= 字号 × k），
       章题若读原 chapterSize，则「字号± = 0」时章题反而比正文大 4.9%（实测 90.35 vs 86.10）。
       乘同一系数后两者严格同尺度，偏移语义（+N px）不变；只改绘制，不动 chapterCellH/chapterPerCol。 */
    var fsChK = (m.fontSize > 0) ? fs / m.fontSize : 1;
    var cx = col.x + m.colW / 2;
    // 标点统一走 foreignObject + writing-mode:vertical-rl，由浏览器自动替换竖排字形（vert），形态与青简一致
    var pRightT = num(t.text_comma_right, 0), pUpT = num(t.text_comma_up, 0);
    var commaColor = t.text_comma_color || t.text_font_color;
    var ZHU = '#a8322a';                            // 朱色标点（套印本句读）
    var cMode = String(t.comment_comma_mode || 'full');
    var cHang = (cMode === 'hang' || cMode === 'judou');   // 夹注：句读与悬空同路
    // 悬空微调（正文 / 夹注独立设置；旧键 hang_x/hang_y 兼容回落，参考青简）
    var hangScale = num(t.hang_scale, 0.38);
    var hangXT = num(t.text_hang_x, num(t.hang_x, 0.02));      // 正文悬空横移
    var hangYT = num(t.text_hang_y, num(t.hang_y, 0.06));      // 正文悬空纵移
    var hangXC = num(t.comment_hang_x, num(t.hang_x, 0.02));   // 夹注悬空横移
    var hangYC = num(t.comment_hang_y, num(t.hang_y, 0.06));   // 夹注悬空纵移
    var cnopSet = setOf(t.comment_comma_nop), crotSet = setOf(t.comment_comma_90);
    var tnopSet = setOf(t.text_comma_nop), trotSet = setOf(t.text_comma_90);
    var fontT = familyStack(t.text_font_family);
    /* 强调样式（[] 包裹片段）：默认 = 正文字体 + 正文字号×0.9 + 正文颜色；可被 accent_* 覆盖 */
    var accentFont = familyStack(t.accent_font_family || t.text_font_family);
    var accentFs = num(t.accent_font_size, fs * 0.9);
    var accentColor = t.accent_font_color || t.text_font_color;
    var fontC = familyStack(t.comment_font_family);
    /* 注音：横排西文衬线小字（绝不走 foreignObject/writing-mode，否则会被竖排旋转） */
    var rubyFont = familyStack(t.ruby_font_family, 'ruby_serif');
    var rubyCol = t.ruby_color || t.text_font_color;
    var prevGY = null, prevGX = cx;                 // 本列上一个非悬空字形中心，供 hang 标点挂靠
    var bandB = m.frame ? (m.frame.y + m.frame.h) - (m.rowStartY + m.rowH) : m.fontSize;
    // 下底线→版框底余白带高（避头点出格落位用）
    /* 【2026-09-21】夹注「标点压缩」共用槽——块底那批被压缩的标点一律锚同一基准：
       槽顶 = 段末字**墨迹底**（紧挂末字之后），槽底 = 版框底（无版框则退一个正文格），
       槽高上限半格（不越版框、也不飘远）；落位一律「墨迹心对准槽心」。
       改前：挤挂 sqz 的列底档锚「正文格网底 + 余白带半宽」、折列吞尾 hang 锚「末字墨迹底 + 槽心」，
       同一页里左子列(hang)会比右子列(sqz)高 0.18 注字格 → 看着「不一般齐」（用户截图反馈：
       「同于失：」的『：』与「飘风：」的『：』一高一低，同为避头压缩却两套落位）。
       两条路径改成共用本函数后，同页两子列的压缩标点严格同 y。 */
    function hungSlot(inkBot) {
      var sBot = m.frame ? (m.frame.y + m.frame.h) : inkBot + m.cellH;
      return { top: inkBot, h: Math.min(Math.max(0, sBot - inkBot), m.cellH * 0.5) };
    }

    for (var i = 0; i < col.items.length; i++) {
      var it = col.items[i];

      /* --- 章节标题：整列大字，按级别取字体/字号(正文+偏移)/加粗/对齐；
           标点独立模式：整格占位，仅支持旋转90°（chapter_punct_90）——
           rot 类（「」〔〕（）…—）开=旋转90°、关=竖排字形直立；nop 类（、，。）始终直立 --- */
      if (it.type === 'chapter') {
        var lv = it.level || 1;
        var famChV = t['chapter' + lv + '_font_family'] || t.chapter_font_family;
        var fontCh = famChV ? familyStack(famChV) : fontT;   // 未设置 → 跟随正文字体
        var fsCh = chapterSize(t, m, lv) * fsChK;   // 正文字号 + 该级偏移（上限列宽），再随注音让位同比例缩
        var chBold = num(t['chapter' + lv + '_bold'], lv % 2 === 1 ? 1 : 0);
        var chAlign = t['chapter' + lv + '_align'] || 'top';
        var chCell = chapterCellH(t, m, lv);
        var chRot90 = num(t.chapter_punct_90, 1);
        var metaC = it.meta || it.chars.map(function (c) { return { c: c, nop: !!nopSet[c], rot: !!rotSet[c] }; });
        var chH = metaC.length * chCell;
        var chTop = (chAlign === 'center') ? m.rowStartY + (m.rowH - chH) / 2 : m.rowStartY;   // 顶对齐：从列头开始
        var chBoldAttr = chBold ? ' font-weight="bold"' : '';
        var chColor = t.chapter_font_color || t.text_font_color;
        var chSink = inkSink(fontCh) * fsCh;   // 章题汉字墨迹居中补偿（同正文口径）
        for (var q = 0; q < metaC.length; q++) {
          var mi = metaC[q];
          if (mi.c === t.tag_space) continue;   // @：占一个章字格的空白，不画字形
          var yCh = chTop + (q + 0.5) * chCell;
          if (mi.nop || mi.rot) {
            /* rot 类（引号/括号）走竖排字形；nop 类直立 */
            out.push(foPunct(t, cx, yCh, fsCh, chColor, fontCh, mi.c, 'v-t v-ch ' + (mi.rot ? 'v-t90' : 'v-tnop'), 0));
          } else {
            var diCh = (it.posArr && it.posArr[q] != null) ? it.posArr[q] : it._pos;
            out.push('<text class="v-t v-ch" data-i="' + diCh + '" x="' + f(cx) + '" y="' + f(yCh - chSink) + '" font-size="' + f(fsCh) +
              '" fill="' + chColor + '" font-family="' + esc(fontCh) + '"' + chBoldAttr +
              ' text-anchor="middle" dominant-baseline="central">' + esc(mi.c) + '</text>');
          }
        }
        continue;
      }

      /* --- 正文字符 / 强调字符（[]） --- */
      if (it.type === 'char') {
        var isAcc = !!it.accent;
        var aFs = isAcc ? accentFs : fs;
        var aFont = isAcc ? accentFont : fontT;
        var aCol = isAcc ? accentColor : t.text_font_color;
        var aPCol = isAcc ? (t.accent_comma_color || accentColor) : (num(t.text_comma_zhu, 0) ? ZHU : commaColor);
        var y = m.rowStartY + (it.row + 0.5) * m.cellH;
        if (isAcc) y += num(t.accent_letter_spacing, 0) * aFs;   // 强调段字距（竖排下为纵向间隙）
        /* 汉字墨迹居中补偿：字形 y 上移 δ×字号（em 框中心 → 汉字墨迹中心）。
           只改字形落位；prevGY（悬空标点挂靠基准）保持未补偿 —— 标点系统的 0.36 偏移是按真实
           渲染调出的经验值、其墨迹本就落在格心，故两者仍然对齐。 */
        var aSink = inkSink(aFont) * aFs;
        var mode = it.pMode || 'full';
        /* 悬空只作用于 nop（、，。类）；rot（「」〔〕（）类）在 hang 模式下按整格正常渲染
           （与夹注一致：引号括号是行文结构，挂到前字角外会破坏文意） */
        var tHang = (mode === 'hang' || mode === 'judou');
        if (tHang && it.rot) mode = 'full';
        // 记录「上一个非悬空字形」中心，供 hang 标点挂靠（只有悬空标点本身不更新；普通汉字即使 pMode=hang 也要更新）
        if (!(tHang && it.nop)) { prevGY = y; prevGX = cx; }
        if (it.rot) {
          if (mode === 'hang') {
            var s9h = aFs * hangScale;
            var ancX = prevGX !== null ? prevGX : cx, ancY = prevGY !== null ? prevGY : y;
            /* 青简 ::before 几何：字框右缘=前字格右缘-hang_x、底缘=格底-hang_y（均为 inset 距离） */
            var g9x = ancX + aFs * 0.5 - hangXT * aFs - s9h / 2;
            var g9y = ancY + aFs * 0.5 - hangYT * aFs - s9h / 2;
            out.push(foPunct(t, g9x, g9y, s9h, aPCol, aFont, it.c, 'v-t v-t90 v-thang', 1));
          } else {
            /* 青简实测模型（ink 定量 132..141 vs 预期）：rot 标点字形占满原字格 → 格心
               （半角 0.5 格支持已移除——栅格锁下 0.5 格会产生行位碎片） */
            var pyR = m.rowStartY + (it.row + 0.5) * m.cellH;
            var pxR = cx + aFs * pRightT;
            out.push(foPunct(t, pxR, pyR - aFs * pUpT, aFs, aPCol, aFont, it.c, 'v-t v-t90', 0));
          }
        } else if (it.nop) {
          if (mode === 'hang' || mode === 'judou') {
            var sxh = aFs * hangScale;
            var ancX2 = prevGX !== null ? prevGX : cx, ancY2 = prevGY !== null ? prevGY : y;
            var gxh = ancX2 + aFs * 0.5 - hangXT * aFs - sxh / 2;
            var gyh = ancY2 + aFs * 0.5 - hangYT * aFs - sxh / 2;
            if (mode === 'judou') {
              /* 句读形态：读点（、）用字形保笔锋；句圈（。！？）矢量自绘，保形态一致。
                 锚点取 hang 的墨迹中心——宋体 nop 墨迹偏 em 框左下（dx=−0.25/dy=+0.36 × 悬空字号），
                 故 (gxh,gyh) 是 em 框心而非墨迹点：圈心须再内收，读点仍按原框心落位（与 hang 完全一致），
                 否则自绘圈会比 hang 标点整体外移，观感「靠右」。 */
              var jgT = judouGlyph(it.c);
              var jxT = gxh - sxh * 0.25, jyT = gyh + sxh * 0.36;
              if (jgT === JUDOU_RING) {
                out.push(ringSvg(jxT, jyT, aFs * num(t.jd_ring_scale, 0.26), aFs * num(t.jd_ring_stroke, 0.05), aPCol, 'v-t v-tjd v-tring'));
              } else {
                out.push('<text class="v-t v-tjd v-tdot" x="' + f(gxh) + '" y="' + f(gyh) + '" font-size="' + f(sxh) +
                    '" fill="' + aPCol + '" font-family="' + esc(aFont) + '"' +
                    ' text-anchor="middle" dominant-baseline="central">' + esc(jgT) + '</text>');
              }
            } else {
              /* nop 恒手动落位——不依赖字体竖排字形（；：！？的 vert 形是旋转的，与，。不一致） */
              out.push('<text class="v-t v-tnop v-thang" x="' + f(gxh) + '" y="' + f(gyh) + '" font-size="' + f(sxh) +
                  '" fill="' + aPCol + '" font-family="' + esc(aFont) + '"' +
                  ' text-anchor="middle" dominant-baseline="central">' + esc(it.c) + '</text>');
            }
          } else {
            /* full：nop 句读类标点手动落位、不旋转（不走字体竖排字形：宋体 vert 对；：！？给旋转形，
               墨迹落格左下，与，。不一致）。实测 Songti「，」墨迹中心在 em 框内 dx=−0.25/dy=+0.36（×字号）。
               y 两模式统一 0.36（墨迹竖直落在格心高度——与居中观感一致，间隙足够不贴上字）；
               x 区分：right=0.5 → 墨迹 +0.25 格居右；center=0.25 → 墨迹恰落格心 */
            /* y 两种模式统一 0.36（墨迹竖直落格心高度——居中观感的间隙已验证足够，
                不会贴上一个字）；仅 x 区分：right=0.5（墨迹 +0.25 格居右）/ center=0.25（墨迹落格心） */
            var xOffN = (t.text_comma_pos === 'center') ? 0.25 : 0.5;
            var pyN = m.rowStartY + (it.row + 0.5) * m.cellH;
            out.push('<text class="v-t v-tnop" x="' + f(cx + aFs * (xOffN + pRightT)) + '" y="' + f(pyN - aFs * (0.36 + pUpT)) + '" font-size="' + f(aFs) +
                '" fill="' + aPCol + '" font-family="' + esc(aFont) + '"' +
                ' text-anchor="middle" dominant-baseline="central">' + esc(it.c) + '</text>');
          }
        } else {
          /* 字形实际落位（墨迹补偿后）：正文与注音**共用**这一个基准。
             注音的位置是从「本字墨迹」量出来的（band = cellH − 墨迹高），若仍用未补偿的
             格心 y，正文字形上移而注音不动，注音相对本字就整体下沉 δ×字号（宋体 0.06em）。 */
          var yGo = y - aSink;
            out.push('<text class="v-t" data-i="' + it._pos + '" x="' + f(cx) + '" y="' + f(yGo) + '" font-size="' + f(aFs) +
            '" fill="' + aCol + '" font-family="' + esc(aFont) + '"' +
            ' text-anchor="middle" dominant-baseline="central">' + esc(it.c) + '</text>');
          /* 注音（^拼音^）：横排小字排在「本字与上一字之间的字间净空带」里。
             带高 = cellH − 汉字墨迹（模型口径）；盒 = RUBY_ASC + RUBY_DESC（和 = RUBY_BOX）；
             盒在带内的纵向落位由 ruby_bias 控制（0 = 居中、1 = 盒底贴住本字墨迹上沿），
             默认略偏向下方本字 —— 因为注音注的是「本字」而不是上方的字；
             基线 = 盒底 − DESC × 注音字号（y 不带 dominant-baseline → 默认按基线落位）；
             右端与字身右缘齐平（text-anchor=end）；超长注音按列宽钳制字号，绝不横向侵入邻列。 */
          if (it.ruby && m.rubySize > 0) {
            var rIns = Math.max(0, (m.colW - aFs) / 2);
            var rFs = m.rubySize;
            var rW = Math.max(1, String(it.ruby).length * 0.62);   // 西文衬线平均字宽（em）粗估
            rFs = Math.min(rFs, (m.colW - 2 * rIns) / rW);
            if (rFs > 1) {
              var rBand = m.cellH - RUBY_RUBY_RUBY_INK_HZ * aFs;             // 字间净空带高
              var rSlack = Math.max(0, rBand - RUBY_BOX * rFs);    // 扣掉盒高后可供上下呼吸的净空
              var rBias = Math.max(0, Math.min(1, num(t.ruby_bias, 0.3)));
              var rBtm = yGo - RUBY_RUBY_RUBY_INK_HZ * aFs * 0.5 - rSlack * (1 - rBias) / 2;   // 盒底 y
              var rBase = rBtm - RUBY_DESC * rFs;                  // 基线 y
              out.push('<text class="v-t v-ruby" x="' + f(col.x + m.colW - rIns) + '" y="' + f(rBase) +
                '" font-size="' + f(rFs) + '" fill="' + esc(rubyCol) + '" font-family="' + esc(rubyFont) + '"' +
                ' text-anchor="end">' + esc(it.ruby) + '</text>');
            }
          }
        }

        /* --- 避头点「标点压缩」：列满时闭号不新起列，排在**末字之后**、列底
               「下底线→版框底」这段余白里（全尺寸；带内放不下才等比缩到放得下）。
               不占列内格 → 列尾齐平不破坏、不增列不增页、不越版框。
               落位按**墨迹心**而非 em 盒心：标点字形在盒内并不居中（竖排 》 墨迹心在盒顶下
               0.42em），按盒心落位会整体下沉、压到下底线上。多个闭号（罕见）均分余白。 --- */
        if (it.sqz && it.sqz.length) {
          var nSq = it.sqz.length;
          var sqTop = m.rowStartY + m.rowH;                                  // 下底线
          var sqBot = m.frame ? m.frame.y + m.frame.h : sqTop + m.cellH;     // 版框底
          var sqSlot = Math.min(Math.max(0, sqBot - sqTop), m.cellH * 0.5) / nSq;
          for (var qi = 0; qi < nSq; qi++) {
            var sc = it.sqz[qi];
            var scRot = !!trotSet[sc];
            var ph = PUNCT_INK[sc] || (scRot ? [0.45, 0.424] : [0.5, 0.86]);
            var sSize = Math.min(aFs, sqSlot * 0.94 / ph[0]);                // 全尺寸；放不下才等比缩
            var scY = sqTop + sqSlot * (qi + 0.5) - sSize * (ph[1] - 0.5);   // 墨迹心对准余白心
            if (scRot) {
              out.push(foPunct(t, cx + aFs * pRightT, scY - sSize * pUpT, sSize, aPCol, aFont, sc, 'v-t v-t90 v-sqz', 0));
            } else {
              var scX = cx + aFs * ((t.text_comma_pos === 'center') ? 0.25 : 0.5) + aFs * pRightT;
              out.push('<text class="v-t v-tnop v-sqz" data-i="' + it._pos + '" x="' + f(scX) + '" y="' + f(scY - sSize * pUpT) +
                '" font-size="' + f(sSize) + '" fill="' + aPCol + '" font-family="' + esc(aFont) + '"' +
                ' text-anchor="middle" dominant-baseline="central">' + esc(sc) + '</text>');
            }
          }
        }
        continue;
      }

      /* --- 注释徽标：随文牌记式小徽标（{} 标记），span≥1 格，居中所占格块 --- */
      if (it.type === 'badge') {
        var lenB = String(it.text).length;
        var boxB = (it.span || 1) * m.cellH;
        var bReq = num(t.badge_size, 0) > 0 ? num(t.badge_size, 0) : fs * 0.72;
        var bFit = Math.min(bReq, boxB / (lenB + 0.32));   // 高不溢占格（宽随设定，所见即所得）
        out.push(badgeSvg(t, cx, m.rowStartY + it.row * m.cellH + boxB / 2, bFit, it.text, t.text_font_family));
        continue;
      }

      /* --- 夹注：双行小字，居中 --- */
      if (it.type === 'comment') {
      var blockTop = m.rowStartY + it.row * m.cellH;
      var boxH = it.span * m.cellH;
        /* 计数字符数（none 剔全部标点；hang 仅剔 nop——rot 占格参与计数） */
        var cntVis = 0;
        for (var vi2 = 0; vi2 < it.chars.length; vi2++) {
          var vch2 = it.chars[vi2];
          if (cMode === 'none' ? (cnopSet[vch2] || crotSet[vch2]) : (cHang && cnopSet[vch2])) continue;
          cntVis++;
        }
        var per = it.per || Math.max(1, Math.ceil(cntVis / 2));
        /* 折行点：前 per 个计数字符归右行；hang 的 nop/none 的标点不占计数、紧跟前字
           （第 per 字之后紧跟的标点留在右行行尾挂靠） */
        var fold = it.chars.length, slots = 0;
        for (var fi = 0; fi < it.chars.length; fi++) {
          var fch = it.chars[fi], fN = !!cnopSet[fch], fR = !!crotSet[fch];
          if (fN && (cMode === 'none' || cHang)) {
            if (slots >= per) { fold = fi; break; }   // 计数已满 → 其后归左行
            continue;                                  // nop 不占计数，随前字
          }
          if (fR && cMode === 'none') {
            if (slots >= per) { fold = fi; break; }
            continue;                                  // none：rot 也不渲染不计数
          }
          if (slots >= per) { fold = fi; break; }
          slots++;
          if (slots >= per) {                          // 第 per 个计数字符 → 折点在其后
            var fj = fi + 1;
            while (fj < it.chars.length &&
                   (cMode === 'none' ? (cnopSet[it.chars[fj]] || crotSet[it.chars[fj]])
                                     : (cHang && cnopSet[it.chars[fj]]))) fj++;
            fold = fj; break;
          }
        }
        var rows = [it.chars.slice(0, fold), it.chars.slice(fold)];
        /* 每个夹注字的源文偏移数组（与 it.chars 等长、逐字对应；徽标对象取 { 的偏移）。
           按 fold 拆成与 rows 对齐的两段，供下方主循环/挤挂/段尾闭号给每个 <text> 回带 data-i。 */
        var pRows = it.posArr ? [it.posArr.slice(0, fold), it.posArr.slice(fold)] : [null, null];
        /* 长行尾闭合标点挤挂：从占格弹出，改画迷你字形挂前字角（两行齐平底） */
        var sqzRow = it.sqz === 'R' ? 0 : it.sqz === 'L' ? 1 : -1, sqzCh = null;
        var sqzPos = null;
        if (sqzRow >= 0) {
          var sqzLine = rows[sqzRow];
          for (var sqi = sqzLine.length - 1; sqi >= 0; sqi--) {
            if (typeof sqzLine[sqi] === 'string' && sqzLine[sqi] !== t.tag_space) {
              sqzCh = sqzLine.splice(sqi, 1)[0];
              if (pRows[sqzRow]) sqzPos = pRows[sqzRow].splice(sqi, 1)[0];
              break;
            }
          }
        }
        /* 折列处「标点压缩」的闭号尾串：同样从占格弹出（分页端已让该段 span 不计它），
           稍后挂排在段末字之后、沉入段底留白。顺序照原样：先弹出的排在最后。 */
        var hangChs = [], hangPosArr = [], hangAll = it.hang || 0, hRemain = rows[0].length + rows[1].length;
        for (var hqi = 0; hqi < hangAll && hRemain > 1; hqi++) {   // 留至少一个字当挂排锚点（全标点段不弹空）
          var hRow = rows[1].length ? 1 : 0, hLn = rows[hRow];
          if (!hLn.length) break;
          var hLast = hLn[hLn.length - 1];
          /* 【2026-09-21】与分页端同口径：闭号与悬空点（：；、，）都是避头标点，拉回本段后一并压缩沉底 */
          if (typeof hLast !== 'string' || (CLOSE_PUNCT.indexOf(hLast) < 0 && !cnopSet[hLast])) break;
          hangChs.unshift(hLn.pop());
          if (pRows[hRow]) hangPosArr.unshift(pRows[hRow].pop());
          hRemain--;
        }
        /* 青简行宽模型：注字=1、full 标点=1、half=0.5、hang/none 的 nop=0，rot 占格（hang=1）——
           行距恒为注字格高（span 已按有效长折算，此处仅兜底） */
        var maxEff = 0;
        for (var rr = 0; rr < 2; rr++) {
          var eff = 0;
          for (var q2 = 0; q2 < rows[rr].length; q2++) {
            var c2 = rows[rr][q2];
            if (typeof c2 === 'object') eff += String(c2.badge).length;   // 徽标按字数占格，与 cEffLen 一致
            else if (cnopSet[c2])      eff += (cHang || cMode === 'none') ? 0 : 1;
            else if (crotSet[c2]) eff += cMode === 'none' ? 0 : 1;
            else eff += 1;
          }
          if (eff > maxEff) maxEff = eff;
        }
        maxEff = Math.max(maxEff, 0.5);
        /* 方案A：夹注块首末字「墨迹中心」钉死正文格网，块内竖直均分。
           交界缝（正文↔夹注）恒等于正文↔正文缝 = cellH − K·fs；
           块内缝由块自行均分（夹注内部间隙自我决定）。
           注：正文与夹注的墨迹居中补偿（inkSink）已各自内化进「墨迹中心=行中心」，
           故交界缝只取决于两墨迹中心距与各自墨迹半高，不再需要额外扣 dSink。 */
        var rowCell = Math.min(boxH / maxEff, m.commentCellH);   // 声明位；最终值见下方「块内字距锁定」（会被覆盖）
        /* 字号自适应：不超半列宽、不超块内每行均分高。汉字墨迹率 0.922 自带余量，
           第三项此前再乘 0.92 → 每行均分高恰等于规范注字格时（maxEff=12 / span=6，
           1 正文字位 = 2 注字格）整块被无端缩 8%，同页其它夹注不缩，这块明显偏小。 */
        var fsC = Math.min(m.commentSize, m.colW / 2 * 0.92, boxH / maxEff);
        var K = 0.922;   // 汉字墨迹率（与引擎 RUBY_RUBY_INK_HZ 同值，局部内联避免跨作用域）
        /* 首/末字「墨迹中心」钉死正文格网：上墨迹顶贴正文同款缝、下墨迹底贴下方正文同款缝 */
        var aY1 = blockTop + 0.5 * m.cellH - 0.5 * K * m.fontSize + 0.5 * K * fsC;  // 首字墨迹中心(=首字格心)
        var aYN = blockTop + boxH - 0.5 * m.cellH + 0.5 * K * m.fontSize - 0.5 * K * fsC; // 末字墨迹中心
        /* 块内字距锁定（2026-09-22，用户口径「夹注内锁栅格」）：
           原式 (aYN−aY1)/(maxEff−1) 把「块首末字钉死块顶/块底」当硬约束，于是块一旦有余量
           （进位后必然出现）字就被摊开排 —— 同一段夹注的字距随块占格漂移 +6.5%~+44.4%，
           与「一个注字占一个规范注字格」的栅格模型不符。故补 min 钳制：
             · 块有余量 → 取规范注字格 m.commentCellH（内容自然下排、余量落块底；首字仍锚定
               在正文格网上，故块与正文的交界缝不变）；
             · 块被 availRows 钳短（boxH 变小）→ 取 boxH/maxEff 收紧，内容不溢出块高、不压下方正文。
           填满的块现状值本就略小于 commentCellH（实测 47.0 vs 47.5）→ min 取原值，既有排版零位移。 */
        rowCell = (maxEff <= 1) ? boxH : Math.min((aYN - aY1) / (maxEff - 1), m.commentCellH);
        var top = aY1 - 0.5 * rowCell;
        /* 夹注汉字墨迹居中补偿（同正文口径）。pGY（挂靠基准）保持未补偿。 */
        var cSink = inkSink(fontC) * fsC;
        var quarter = m.colW / 4;
        var pRightC = num(t.comment_comma_right, 0);      // 夹注标点落位微调（竖排字形默认 0）
        var pUpC = num(t.comment_comma_up, 0);            // 夹注标点落位微调
        var zhuC = num(t.comment_comma_zhu, 0);
        var cCol = zhuC ? ZHU : t.comment_font_color;
        for (var r = 0; r < 2; r++) {
          var line = rows[r];
          if (!line.length) continue;
          var rx = r === 0 ? cx + quarter : cx - quarter;   // 右行先读
          var idx = 0;
          var pGY = null, pGX = rx;                         // 本行上一个非悬空字形中心，供 hang 挂靠
          for (var j = 0; j < line.length; j++) {
            var ch = line[j];
            if (typeof ch === 'object') {
              /* 夹注内徽标：始终随夹注字体与字号（badge_size/badge_font 设置仅作用于正文徽标）。
                 按字数跨格（与正文徽标同规则）→ 单字/多字徽标的字号一致（≈0.95×注字号），不随字数缩。
                 bFitC 钳制：高不超 len 格、宽不超半列宽 */
              var lenCB = String(ch.badge).length;
              var bFitC = Math.min(fsC * 0.95, lenCB * rowCell / (lenCB + 0.08), m.colW / 2 / 1.15);
              var ycB = top + (idx + lenCB / 2) * rowCell;
              out.push(badgeSvg(t, rx, ycB, bFitC, ch.badge, t.comment_font_family, 1));
              idx += lenCB; pGY = ycB; pGX = rx;
              continue;
            }
            var nop = !!cnopSet[ch], rot = !!crotSet[ch];
            var cy2 = top + (idx + 0.5) * rowCell;
            if (ch === t.tag_space) { idx += 1; pGY = cy2; pGX = rx; continue; }   // @：占一个注字格的空白，不画字形
            /* 无：标点不渲染、不占格 */
            if (cMode === 'none' && (nop || rot)) continue;
            /* 悬空：nop（、，。类）极小字形挂在本行上一字右下角外，不占格；
               rot（「」〔〕（）类）不挂靠——占整格、走下方占格分支正常渲染 */
            if (cHang && nop) {
              var sH = fsC * hangScale;
              var hx, hy;
              if (pGY === null) {
                /* 兜底：本行行首无前字可挂（正常折行会把右行尾标点吞入右行，不该出现）——
                   不挂靠，就地落本格右下角，墨迹位与占格标点一致、仅小一号 */
                var xOffL = (t.comment_comma_pos === 'center') ? 0.25 : 0.5;
                hx = rx + fsC * (xOffL + pRightC) - fsC * 0.25 + sH * 0.25;
                hy = (cy2 - fsC * pUpC) - sH * 0.36;
              } else {
                hx = pGX + fsC * 0.5 - hangXC * fsC - sH / 2;
                hy = pGY + fsC * 0.5 - hangYC * fsC - sH / 2;
              }
              if (cMode === 'judou') {
                /* 同正文：圈心取墨迹点（em 框心内收 −0.25/+0.36 × 悬空字号），读点仍按框心 */
                var jgC = judouGlyph(ch);
                var jxC = hx - sH * 0.25, jyC = hy + sH * 0.36;
                if (jgC === JUDOU_RING) {
                  out.push(ringSvg(jxC, jyC, fsC * num(t.jd_ring_scale, 0.26), fsC * num(t.jd_ring_stroke, 0.05), cCol, 'v-c v-cjd v-cring'));
                } else {
                  out.push('<text class="v-c v-cjd v-cdot" x="' + f(hx) + '" y="' + f(hy) +
                      '" font-size="' + f(sH) + '" fill="' + cCol + '" font-family="' + esc(fontC) + '"' +
                      ' text-anchor="middle" dominant-baseline="central">' + esc(jgC) + '</text>');
                }
              } else {
                /* nop 恒手动落位（同下方占格分支）——不依赖字体竖排字形 */
                out.push('<text class="v-c v-cnop v-chang" x="' + f(hx) + '" y="' + f(hy) +
                    '" font-size="' + f(sH) + '" fill="' + cCol + '" font-family="' + esc(fontC) + '"' +
                    ' text-anchor="middle" dominant-baseline="central">' + esc(ch) + '</text>');
              }
              continue;
            }
            if (nop || rot) {
              /* 句读类标点与正文同规则：手动落位、不旋转，墨迹偏移按行距自适应
                 （right：x 恒 0.5 墨迹居右，y=rowCell/fsC−0.585 保证与上字 ~0.30 格隙；
                   center：0.25/0.36 墨迹落格心）；
                 仅 rot 括号类走字体竖排字形（vertG），保持引号/括号的旋转立变 */
              var cyC = top + (idx + 0.5) * rowCell;
              /* y 统一 0.36（同正文：墨迹竖直落格心高度）；x 区分 right=0.5 / center=0.25 */
              var xOffC = (t.comment_comma_pos === 'center') ? 0.25 : 0.5;
              var pxC = rx + fsC * (xOffC + pRightC);
              var pyC = cyC - fsC * (0.36 + pUpC);
              if (rot) {
                out.push(foPunct(t, rx + fsC * pRightC, cyC - fsC * pUpC, fsC, cCol, fontC, ch, 'v-c v-c90', 0));
              } else {
                out.push('<text class="v-c v-cnop" x="' + f(pxC) + '" y="' + f(pyC) +
                  '" font-size="' + f(fsC) + '" fill="' + cCol + '" font-family="' + esc(fontC) + '"' +
                  ' text-anchor="middle" dominant-baseline="central">' + esc(ch) + '</text>');
              }
              idx += 1;
            } else {
              var dPos = (pRows[r] && pRows[r][j] != null) ? pRows[r][j] : it._pos;
              out.push('<text class="v-c" data-i="' + dPos + '" x="' + f(rx) + '" y="' + f(cy2 - cSink) + '" font-size="' + f(fsC) +
                '" fill="' + t.comment_font_color + '" font-family="' + esc(fontC) + '"' +
                ' text-anchor="middle" dominant-baseline="central">' + esc(ch) + '</text>');
              idx += 1;
            }
            // 记录本行上一个非悬空字形
            pGY = cy2; pGX = rx;
          }
          /* 挤挂标点落位（三种，按块内可用余量递降）：
             ① 块内整格余量（sqFit）→ 按正常字符排在末字下一格（落位公式与占格标点一致）；
             ② 块已到列底（sqEdge）→ 下底线→版框余白带内垂直居中（nop 按正常字号；rot 缩到悬空
                尺寸再按带高钳 → 保住竖排字形，不像旧版那样退回「全尺寸挂角」压块内末字）；
             ③ 块中且无余量（出格位会被下方后文压字）→ 退回贴末字格右下角，缩到悬空尺寸并钳在本子列内。 */
          if (sqzCh && r === sqzRow && pGY !== null) {
            var sqCy = pGY + rowCell,
                sqFit = sqCy + rowCell / 2 <= top + boxH + 0.01,
                sqEdge = it.row + it.span >= m.rowNum - 1e-6;
            if (sqFit) {                                         // 块内余量放得下 → 恒整格下移一格
              var qyC = sqCy;
              if (crotSet[sqzCh]) {
                out.push(foPunct(t, rx + fsC * pRightC, qyC - fsC * pUpC, fsC, cCol, fontC, sqzCh, 'v-c v-c90', 0));
              } else {
                var qxOff = (t.comment_comma_pos === 'center') ? 0.25 : 0.5;
                var qxN = rx + fsC * (qxOff + pRightC), qyN = qyC - fsC * (0.36 + pUpC);
                if (cMode === 'judou' && judouGlyph(sqzCh) === JUDOU_RING) {
                  out.push(ringSvg(qxN - fsC * hangScale * 0.25, qyN + fsC * hangScale * 0.36, fsC * num(t.jd_ring_scale, 0.26), fsC * num(t.jd_ring_stroke, 0.05), cCol, 'v-c v-cjd v-cring'));
                } else {
                  out.push('<text class="v-c ' + (cMode === 'judou' ? 'v-cjd' : 'v-cnop') + '" data-i="' + (sqzPos != null ? sqzPos : it._pos) + '" x="' + f(qxN) + '" y="' + f(qyN) +
                      '" font-size="' + f(fsC) + '" fill="' + cCol + '" font-family="' + esc(fontC) + '"' +
                      ' text-anchor="middle" dominant-baseline="central">' + esc(cMode === 'judou' ? judouGlyph(sqzCh) : sqzCh) + '</text>');
                }
              }
            } else if (sqEdge) {                                 // 块已到列底 → 与折列吞尾 hang 同槽（段末字墨迹底→版框底，墨迹心落槽心）
              /* 【2026-09-21】此处原为「正文格网底 + 余白带半宽」——与 hang 的槽不同基准，
                 同一页左/右两子列的压缩标点因此不一般齐（见文件上方 hungSlot 注释）。 */
              var qsB = hungSlot(pGY + 0.5 * K * fsC);
              var qyB = qsB.top + qsB.h / 2;
              if (crotSet[sqzCh]) {
                /* rot 类同样沉排：缩到悬空尺寸（盒高上限 = 带高×1.2，墨迹恒在带内）→ 保住竖排字形，
                   又不压块内末字、不越列框 */
                var srC = Math.min(fsC * hangScale, bandB * 1.2);
                out.push(foPunct(t, rx, qyB, srC, cCol, fontC, sqzCh, 'v-c v-c90 v-chang', 1));
              } else {
                var qxOffB = (t.comment_comma_pos === 'center') ? 0.25 : 0.5;
                var qxNB = rx + fsC * (qxOffB + pRightC), qyNB = qyB - fsC * (0.36 + pUpC);
                if (cMode === 'judou' && judouGlyph(sqzCh) === JUDOU_RING) {
                  out.push(ringSvg(qxNB - fsC * hangScale * 0.25, qyNB + fsC * hangScale * 0.36, fsC * num(t.jd_ring_scale, 0.26), fsC * num(t.jd_ring_stroke, 0.05), cCol, 'v-c v-cjd v-cring'));
                } else {
                  out.push('<text class="v-c ' + (cMode === 'judou' ? 'v-cjd' : 'v-cnop') + '" data-i="' + (sqzPos != null ? sqzPos : it._pos) + '" x="' + f(qxNB) + '" y="' + f(qyNB) +
                      '" font-size="' + f(fsC) + '" fill="' + cCol + '" font-family="' + esc(fontC) + '"' +
                      ' text-anchor="middle" dominant-baseline="central">' + esc(cMode === 'judou' ? judouGlyph(sqzCh) : sqzCh) + '</text>');
                }
              }
            } else {
              /* 块中且无余量（出格位会被下方后文压字）→ 退回贴末字格右下角：缩到悬空尺寸 +
                 rot 走竖排字形（与 sqFit 分支一致，否则会被错画成横排 nop），盒缘钳在本子列内。
                 此前是「全尺寸 + 末字中心 +0.65/+0.05em」：小号注字里 0.65em 仍在字格内，
                 全尺寸标点直接压在末字（乃至上一字）的墨迹上。 */
              var sCq = fsC * hangScale;
              var qxF = pGX + fsC * 0.5 - hangXC * fsC - sCq / 2, qyF = pGY + fsC * 0.5 - hangYC * fsC - sCq / 2;
              qxF = Math.min(qxF, rx + m.colW / 4 - fsC * 0.02 - sCq / 2);     // 不越本子列（=半列宽）
              qyF = Math.min(qyF, top + boxH - fsC * 0.02 - sCq / 2);
              if (crotSet[sqzCh]) {
                out.push(foPunct(t, qxF, qyF, sCq, cCol, fontC, sqzCh, 'v-c v-c90 v-chang', 1));
              } else if (cMode === 'judou' && judouGlyph(sqzCh) === JUDOU_RING) {
                out.push(ringSvg(qxF - sCq * 0.25, qyF + sCq * 0.36, fsC * num(t.jd_ring_scale, 0.26), fsC * num(t.jd_ring_stroke, 0.05), cCol, 'v-c v-cjd v-cring'));
              } else {
                out.push('<text class="v-c ' + (cMode === 'judou' ? 'v-cjd v-cdot' : 'v-cnop v-chang') + '" data-i="' + (sqzPos != null ? sqzPos : it._pos) + '" x="' + f(qxF) + '" y="' + f(qyF) +
                    '" font-size="' + f(sCq) + '" fill="' + cCol + '" font-family="' + esc(fontC) + '"' +
                    ' text-anchor="middle" dominant-baseline="central">' + esc(cMode === 'judou' ? judouGlyph(sqzCh) : sqzCh) + '</text>');
              }
            }
          }
        }
        /* 折列处「标点压缩」：闭号全尺寸挂在**段末字之后**，沉入段底留白带（版框底之前）。
           与正文 v-sqz 同口径：槽高 = min(段末字墨迹底→版框底, 半格)，多个闭号均分；
           放不下才等比缩（绝不越版框）。锚在「末字所在子列」——左列已排完则挂左列，
           仅右列有字时挂右列（读序：右列 → 左列 → 段末字之后的闭号）。 */
        if (hangChs.length && pGY !== null) {
          var hRx = rows[1].length ? cx - quarter : cx + quarter;
          var hsB = hungSlot(pGY + 0.5 * K * fsC);                         // 共用槽（与挤挂的列底档同基准）
          var hTop = hsB.top;                                              // 段末字墨迹底
          var hSlot = hsB.h / hangChs.length;                              // 多标点均分槽高
          for (var hzi = 0; hzi < hangChs.length; hzi++) {
            var hzc = hangChs[hzi];
            var hzRot = !!crotSet[hzc];
            var hzPh = PUNCT_INK[hzc] || (hzRot ? [0.45, 0.424] : [0.5, 0.86]);
            var hzSize = Math.min(fsC, hSlot * 0.94 / hzPh[0]);            // 全尺寸；放不下才等比缩
            var hzY = hTop + hSlot * (hzi + 0.5) - hzSize * (hzPh[1] - 0.5); // 墨迹心对准槽心
            var hzX = hRx + fsC * ((t.comment_comma_pos === 'center') ? 0.25 : 0.5) + fsC * pRightC;
            if (hzRot) {
              out.push(foPunct(t, hRx + fsC * pRightC, hzY - hzSize * pUpC, hzSize, cCol, fontC, hzc, 'v-c v-c90 v-chang v-csqz', 0));
            } else if (cMode === 'judou' && judouGlyph(hzc) === JUDOU_RING) {
              /* 句读档：与占格标点同款——圈心取墨迹点、字号取悬空尺寸（同下方 sqz 分支口径） */
              out.push(ringSvg(hzX - hzSize * 0.25, hzY + hzSize * 0.36, fsC * num(t.jd_ring_scale, 0.26), fsC * num(t.jd_ring_stroke, 0.05), cCol, 'v-c v-cjd v-cring v-csqz'));
            } else {
              out.push('<text class="v-c ' + (cMode === 'judou' ? 'v-cjd v-cdot' : 'v-cnop') + ' v-chang v-csqz" data-i="' + (hangPosArr[hzi] != null ? hangPosArr[hzi] : it._pos) + '" x="' + f(hzX) + '" y="' + f(hzY - hzSize * pUpC) +
                '" font-size="' + f(hzSize) + '" fill="' + cCol + '" font-family="' + esc(fontC) + '"' +
                ' text-anchor="middle" dominant-baseline="central">' + esc(cMode === 'judou' ? judouGlyph(hzc) : hzc) + '</text>');
            }
          }
        }
        continue;
      }
    }
  }

  /**
   * 渲染一叶为 SVG 字符串
   * @param {object} t 模板参数
   * @param {object} page paginate 产出的页对象
   * @param {object} opts { guides:0|1, rulers:0|1 }
   */
  function renderPage(t, page, opts) {
    opts = opts || {};
    var m = computeMetrics(t);
    var o = [], i;
    // 书名/卷次/页码纵向自动定位：随内容区比例落位（换纸张高度时不错位）
    var pagerY = t.pager_y_auto ? (m.content.y0 + m.content.h * 0.70) : num(t.pager_y, 0);   // 默认在卷次(0.62)下方
    var titleY = t.title_y_auto ? (m.content.y0 + m.content.h * 0.20) : num(t.title_y, 0);   // 默认上—中鱼尾之间
    var volY = t.vol_y_auto ? (m.content.y0 + m.content.h * 0.62) : num(t.vol_y, 0);          // 卷次独立纵向位置（中—下鱼尾之间）
    var fontT = familyStack(t.text_font_family);
    // 版心文字字体：书名/卷次、页码独立设置，未设置时回落正文字体
    var fontTitle = t.title_font_family ? familyStack(t.title_font_family) : fontT;
    var fontPager = t.pager_font_family ? familyStack(t.pager_font_family) : fontT;

    o.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + f(m.W) + ' ' + f(m.H) + '" width="' + f(m.W) + '" height="' + f(m.H) + '">');

    /* 纸张 */
    o.push('<rect x="0" y="0" width="' + f(m.W) + '" height="' + f(m.H) + '" fill="' + t.canvas_color + '"/>');
    /* 底图：直接填图片路径/dataURL = 上下左右拉伸铺满整幅纸张（适应任何纸张尺寸） */
    if (t.canvas_background_image) {
      /* 背景图优先用预取的 dataURL 内联：同步解码、无网络请求、重渲不闪；
         cache 未就绪（首次/跨域污染）时回退原 url（preloadTexture 会后台预热） */
      const bgHref = textureCache.get(t.canvas_background_image) || t.canvas_background_image
      o.push('<image x="0" y="0" width="' + f(m.W) + '" height="' + f(m.H) + '" href="' + esc(bgHref) + '" preserveAspectRatio="none"/>')
    }

    /* 叶面水印：图片素材压在版框与文字之下（位置/大小按纸张比例，随纸张自动缩放） */
    if (t.watermark_src) {
      var wmBox = assetBox(
        t.watermark_src,
        clamp01(t.watermark_x, 0.5) * m.W,
        clamp01(t.watermark_y, 0.5) * m.H,
        clamp01(t.watermark_w, 0.5) * m.W
      );
      if (wmBox) o.push(assetEl(wmBox, clamp01(t.watermark_opacity, 0.12), 'v-wm'));
    }

    /* 版框：外粗线 + 内细线 */
    var fr = m.frame, ct = m.content;
    if (num(t.outline_width, 0) > 0)
      o.push('<rect x="' + f(fr.x) + '" y="' + f(fr.y) + '" width="' + f(fr.w) + '" height="' + f(fr.h) +
        '" fill="none" stroke="' + t.outline_color + '" stroke-width="' + f(num(t.outline_width, 0)) + '"/>');
    if (num(t.inline_width, 0) > 0)
      o.push('<rect x="' + f(ct.x0) + '" y="' + f(ct.y0) + '" width="' + f(ct.w) + '" height="' + f(ct.h) +
        '" fill="none" stroke="' + t.inline_color + '" stroke-width="' + f(num(t.inline_width, 0)) + '"/>');

    /* 界行：列与列之间的竖线，贯通内容区（与边框、中缝重合处不重画） */
    if (t.if_vline && num(t.vline_width, 0) > 0 && m.cols > 1) {
      var vl = [], b, k;
      for (k = 1; k < m.cols; k++) {
        b = m.content.x1 - k * m.colW;
        vl.push('<line class="v-vline" x1="' + f(b) + '" y1="' + f(ct.y0) + '" x2="' + f(b) + '" y2="' + f(ct.y1) +
          '" stroke="' + t.vline_color + '" stroke-width="' + f(num(t.vline_width, 0)) + '"/>');
        b = m.centerX - m.centerW / 2 - k * m.colW;
        vl.push('<line class="v-vline" x1="' + f(b) + '" y1="' + f(ct.y0) + '" x2="' + f(b) + '" y2="' + f(ct.y1) +
          '" stroke="' + t.vline_color + '" stroke-width="' + f(num(t.vline_width, 0)) + '"/>');
      }
      o.push(vl.join(''));
    }

    /* 版心界行竖线（中缝两侧）：内缩去掉，紧贴中缝边缘 → 版心界行 = 中缝宽 */
    if (m.centerW > 0 && num(t.fish_line_width, 0) > 0) {
      var lx = m.centerX - m.centerW / 2, rx2 = m.centerX + m.centerW / 2;
      o.push('<line class="v-cl" x1="' + f(lx) + '" y1="' + f(ct.y0) + '" x2="' + f(lx) + '" y2="' + f(ct.y1) +
        '" stroke="' + t.fish_line_color + '" stroke-width="' + f(num(t.fish_line_width, 0)) + '"/>');
      o.push('<line class="v-cl" x1="' + f(rx2) + '" y1="' + f(ct.y0) + '" x2="' + f(rx2) + '" y2="' + f(ct.y1) +
        '" stroke="' + t.fish_line_color + '" stroke-width="' + f(num(t.fish_line_width, 0)) + '"/>');
    }
    /* 鱼尾 */
    var g = fishGeom(t, m);
    var halfC = m.centerW / 2;
    /* 书口：象鼻竖线（仅横线外侧分段，不通高版心）+ 书口横线（宽贯中缝，位置随分割线 Y）；
       画在鱼尾之前，鱼身与版心文字压其上 */
    if (g.seam && g.seam.segs) for (i = 0; i < g.seam.segs.length; i++) {
      var ss = g.seam.segs[i];
      o.push('<line class="v-seam" x1="' + f(m.centerX) + '" y1="' + f(ss.y0) + '" x2="' + f(m.centerX) +
        '" y2="' + f(ss.y1) + '" stroke="' + g.seam.color + '" stroke-width="' + f(g.seam.width) + '"/>');
    }
    if (g.seamBars) for (i = 0; i < g.seamBars.length; i++) {
      var sb = g.seamBars[i];
      o.push('<line class="v-seam v-seamb" x1="' + f(m.centerX - halfC) + '" y1="' + f(sb.y) + '" x2="' + f(m.centerX + halfC) + '" y2="' + f(sb.y) +
        '" stroke="' + sb.color + '" stroke-width="' + f(sb.lw) + '"/>');
    }
    /* 鱼尾形状：鱼身 + 尾 + 花饰（下鱼尾默认 = 上鱼尾上下翻转） */
    if (g.top) {
      if (g.top.body) o.push('<rect class="v-fish" x="' + f(g.top.body.x) + '" y="' + f(g.top.body.y) + '" width="' + f(g.top.body.w) +
        '" height="' + f(g.top.body.h) + '" fill="' + g.top.color + '"/>');
      if (g.top.tri) o.push('<path class="v-fish" d="' + g.top.tri + '" fill="' + g.top.color + '"/>');
    }
    if (g.btm) {
      if (g.btm.body) o.push('<rect class="v-fish" x="' + f(g.btm.body.x) + '" y="' + f(g.btm.body.y) + '" width="' + f(g.btm.body.w) +
        '" height="' + f(g.btm.body.h) + '" fill="' + g.btm.color + '"/>');
      if (g.btm.tri) o.push('<path class="v-fish" d="' + g.btm.tri + '" fill="' + g.btm.color + '"/>');
    }
    if (g.mid) {
      if (g.mid.body) o.push('<rect class="v-fish" x="' + f(g.mid.body.x) + '" y="' + f(g.mid.body.y) + '" width="' + f(g.mid.body.w) +
        '" height="' + f(g.mid.body.h) + '" fill="' + g.mid.color + '"/>');
      if (g.mid.tri) o.push('<path class="v-fish" d="' + g.mid.tri + '" fill="' + g.mid.color + '"/>');
    }
    for (i = 0; i < g.decor.length; i++) {
      var d = g.decor[i];
      if (d.kind === 'leaf') {
        // 对生叶枝：两片尖叶呈 V 形（白色镂空）
        o.push('<path class="v-fish v-leaf" d="M 0 ' + f(-d.r) + ' Q ' + f(d.r * 0.85) + ' ' + f(-d.r * 0.15) + ' 0 ' + f(d.r) +
          ' Q ' + f(-d.r * 0.85) + ' ' + f(-d.r * 0.15) + ' 0 ' + f(-d.r) + ' Z" fill="' + t.canvas_color +
          '" transform="translate(' + f(d.x - d.r * 0.55) + ' ' + f(d.y) + ') rotate(-38)"/>');
        o.push('<path class="v-fish v-leaf" d="M 0 ' + f(-d.r) + ' Q ' + f(d.r * 0.85) + ' ' + f(-d.r * 0.15) + ' 0 ' + f(d.r) +
          ' Q ' + f(-d.r * 0.85) + ' ' + f(-d.r * 0.15) + ' 0 ' + f(-d.r) + ' Z" fill="' + t.canvas_color +
          '" transform="translate(' + f(d.x + d.r * 0.55) + ' ' + f(d.y) + ') rotate(38)"/>');
      } else {
        o.push('<circle cx="' + f(d.x - d.r * 1.5) + '" cy="' + f(d.y) + '" r="' + f(d.r) + '" fill="' + t.canvas_color + '"/>');
        o.push('<circle cx="' + f(d.x) + '" cy="' + f(d.y) + '" r="' + f(d.r) + '" fill="' + t.canvas_color + '"/>');
        o.push('<circle cx="' + f(d.x + d.r * 1.5) + '" cy="' + f(d.y) + '" r="' + f(d.r) + '" fill="' + t.canvas_color + '"/>');
      }
    }

    /* 版心文字：页码 + 书名 + 卷次（书口线加粗到接近字号时自动转阴文反白） */
    if (page) {
      function seamFill(fs) {
        return (g.seam && g.seam.width >= fs * 0.8) ? t.canvas_color : null;
      }
      var tx = t.if_tpcenter ? m.centerX : m.centerX - halfC + num(t.title_font_size, 60) * 0.62;
      var pagerTxt = t.pager_style === 'arabic' ? String(page.leaf) : cn(page.leaf);
      var pv = pagerTxt.split('');
      var pfs = num(t.pager_font_size, 30);
      for (i = 0; i < pv.length; i++)
        o.push('<text class="v-h v-pager" x="' + f(tx) + '" y="' + f(pagerY + (i + 0.5) * pfs) + '" font-size="' + f(pfs) +
          '" fill="' + (seamFill(pfs) || t.pager_color) + '" font-family="' + esc(fontPager) + '"' +
          ' text-anchor="middle" dominant-baseline="central">' + esc(pv[i]) + '</text>');

      var tfs = num(t.title_font_size, 60), tyd = Math.max(0.6, num(t.title_ydis, 1.05));
      var tv = String(t.title_text || '').split('');
      var cursor = 0;
      for (i = 0; i < tv.length; i++)
        o.push('<text class="v-h v-title" x="' + f(tx) + '" y="' + f(titleY + (i + 0.5) * tfs * tyd) + '" font-size="' + f(tfs) +
          '" fill="' + (seamFill(tfs) || t.title_color) + '" font-family="' + esc(fontTitle) + '"' +
          ' text-anchor="middle" dominant-baseline="central">' + esc(tv[i]) + '</text>');
      cursor = tv.length * tfs * tyd;

      /* 卷次位：优先取分页叶携带的卷分组名（page.volName = 章所在卷的分组名）；
         未携带时按 title_volnames 逐卷卷名（| 分隔按卷序），再回落 title_postfix 的「卷X」逻辑 */
      var _vnames = String(t.title_volnames || '').split('|').map(function (s) { return s.trim(); })
        .filter(function (s) { return s; });
      var _vname = _vnames[page.vol - 1];
      var post = (page.volName != null && page.volName !== '')
        ? page.volName
        : (_vname != null ? _vname : String(t.title_postfix || '').replace(/X/g, cn(page.vol)));
      var pvv = post.split('');
      for (i = 0; i < pvv.length; i++)
        o.push('<text class="v-h v-vol" x="' + f(tx) + '" y="' + f(volY + (i + 0.5) * tfs * 0.86) + '" font-size="' + f(tfs * 0.86) +
          '" fill="' + (seamFill(tfs * 0.86) || t.title_color) + '" font-family="' + esc(fontTitle) + '"' +
          ' text-anchor="middle" dominant-baseline="central">' + esc(pvv[i]) + '</text>');
    }

    /* 正文与夹注 */
    if (page) for (i = 0; i < page.cols.length; i++) drawColumn(t, m, page.cols[i], o);

    /* 版心堂号：中缝上的图片素材，压在鱼尾与版心文字之上（印章是最后盖上去的）。
       横向恒居中于中缝（m.centerX），纵向只由 seam_stamp_pos（内容区高度比例）决定。 */
    if (t.seam_stamp_src && m.centerW > 0) {
      var ssBox = assetBox(
        t.seam_stamp_src,
        m.centerX,
        ct.y0 + ct.h * clamp01(t.seam_stamp_pos, 0.5),
        clamp01(t.seam_stamp_w, 0.6) * m.centerW
      );
      if (ssBox) o.push(assetEl(ssBox, clamp01(t.seam_stamp_opacity, 0.9), 'v-seamstamp'));
    }

    /* 辅助线 */
    if (opts.guides) {
      var gs = 'stroke="#c0392b" stroke-width="1.5" stroke-dasharray="8 8" opacity="0.75"';
      o.push('<g ' + gs + ' fill="none">');
      var cd = columns(m);
      for (i = 0; i <= cd.length; i++) {
        var gx = i < cd.length ? cd[i].x : null;
        if (gx == null) continue;
        o.push('<line x1="' + f(gx) + '" y1="' + f(ct.y0) + '" x2="' + f(gx) + '" y2="' + f(ct.y1) + '"/>');
      }
      o.push('<line x1="' + f(ct.x0) + '" y1="' + f(m.rowStartY) + '" x2="' + f(m.centerX - m.centerW / 2) + '" y2="' + f(m.rowStartY) + '"/>');
      o.push('<line x1="' + f(m.centerX + m.centerW / 2) + '" y1="' + f(m.rowStartY) + '" x2="' + f(ct.x1) + '" y2="' + f(m.rowStartY) + '"/>');
      o.push('<line x1="' + f(ct.x0) + '" y1="' + f(m.rowEndY) + '" x2="' + f(m.centerX - m.centerW / 2) + '" y2="' + f(m.rowEndY) + '"/>');
      o.push('<line x1="' + f(m.centerX + m.centerW / 2) + '" y1="' + f(m.rowEndY) + '" x2="' + f(ct.x1) + '" y2="' + f(m.rowEndY) + '"/>');
      o.push('<line x1="' + f(m.centerX - m.centerW / 2) + '" y1="' + f(ct.y0) + '" x2="' + f(m.centerX - m.centerW / 2) + '" y2="' + f(ct.y1) + '"/>');
      o.push('<line x1="' + f(m.centerX + m.centerW / 2) + '" y1="' + f(ct.y0) + '" x2="' + f(m.centerX + m.centerW / 2) + '" y2="' + f(ct.y1) + '"/>');
      o.push('</g>');
    }

    /* 尺寸标尺（标注文字始终夹取在画布内，页边距较小时也不会被裁剪） */
    if (opts.rulers) {
      var mW = m.W, mH = m.H, rcol = '#b8860b';
      var rs = 'stroke="' + rcol + '" stroke-width="2" fill="' + rcol + '" font-size="34" font-family="' + esc(FONT_STACKS.hei) + '"';
      o.push('<g ' + rs + '>');
      function txtW(s) { var w = 0, i; for (i = 0; i < s.length; i++) w += (s.charCodeAt(i) > 255 ? 34 : 17); return w; }
      function dim(x1, y1, x2, y2, label, ex, ey) {
        x1 = Math.max(0, Math.min(mW, x1)); y1 = Math.max(0, Math.min(mH, y1));
        x2 = Math.max(0, Math.min(mW, x2)); y2 = Math.max(0, Math.min(mH, y2));
        o.push('<line x1="' + f(x1) + '" y1="' + f(y1) + '" x2="' + f(x2) + '" y2="' + f(y2) + '"/>');
        o.push('<circle cx="' + f(x1) + '" cy="' + f(y1) + '" r="5"/><circle cx="' + f(x2) + '" cy="' + f(y2) + '" r="5"/>');
        var tw = txtW(label), half = tw / 2 + 14;
        var lx = Math.max(half, Math.min(mW - half, ex));
        var ly = Math.max(34, Math.min(mH - 34, ey));
        o.push('<rect x="' + f(lx - half) + '" y="' + f(ly - 26) + '" width="' + f(tw + 28) + '" height="52" rx="9" fill="' + t.canvas_color + '" fill-opacity="0.9" stroke="' + rcol + '" stroke-width="1.5"/>');
        o.push('<text x="' + f(lx) + '" y="' + f(ly) + '" text-anchor="middle" dominant-baseline="central" stroke="none">' + esc(label) + '</text>');
      }
      // 上边距
      dim(m.W / 2, 0, m.W / 2, fr.y, '上 ' + Math.round(mt(t)), m.W / 2 + 150, fr.y / 2);
      // 左页边距
      dim(0, m.H / 2, fr.x, m.H / 2, 'L' + Math.round(ml(t)), fr.x / 2, m.H / 2 - 60);
      // 中缝宽
      dim(m.centerX - m.centerW / 2, ct.y0 - 70, m.centerX + m.centerW / 2, ct.y0 - 70, '中缝 ' + Math.round(m.centerW), m.centerX, ct.y0 - 110);
      // 半叶宽 + 列宽
      var ry = ct.y1 + 60;
      dim(m.centerX + m.centerW / 2, ry, ct.x1, ry, '半叶 ' + Math.round(m.halfW), (m.centerX + m.centerW / 2 + ct.x1) / 2, ry + 55);
      var c0 = ct.x1;
      dim(c0 - m.colW, ry + 130, c0, ry + 130, '列宽 ' + Math.round(m.colW), c0 - m.colW / 2, ry + 185);
      // 行高 / 字号
      var rx = ct.x0 - 90;
      dim(rx, m.rowStartY, rx, m.rowEndY, '行高 ' + Math.round(m.rowH), rx - 130, (m.rowStartY + m.rowEndY) / 2);
      dim(rx, m.rowStartY, rx, m.rowStartY + m.cellH, '字 ' + Math.round(m.fontSize), rx - 130, m.rowStartY + m.cellH + 60);
      o.push('</g>');
    }

    o.push('</svg>');
    return o.join('');
  }
  function mt(t) { return num(t.margins_top, 0); }
  function ml(t) { return num(t.margins_left, 0); }

  /* ---------------------------------------------------------------- 导出 */
  export const LayoutEngine = {
    FONT_STACKS: FONT_STACKS,
    FONT_CN: FONT_CN,
    familyStack: familyStack,
    DEFAULT_TEMPLATE: DEFAULT_TEMPLATE,
    computeMetrics: computeMetrics,
    columns: columns,
    tokenize: tokenize,
    paginate: paginate,
    fishGeom: fishGeom,
    renderPage: renderPage,
    /* 注入图片素材解析器（core/assets.ts 的 assetInfo）——engine 不 import 具体实现 */
    setAssetResolver: setAssetResolver,
    cn: cn
  };

/* 纹理预取缓存：把背景图预加载为 dataURL 内联，避免预览每次重渲整页 SVG 时宣纹 <image> 反复异步加载导致闪烁。
   预热成功后 renderPage 直接用 dataURL（同步解码、无网络请求、零闪）；若图片跨域污染 canvas 导致 toDataURL 失败则保留原 url（退化为原行为）。 */
var textureCache = new Map();
function preloadTexture(url) {
  if (!url || textureCache.has(url)) return;
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function () {
    try {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      textureCache.set(url, c.toDataURL('image/jpeg'));
    } catch (e) { /* tainted: 不缓存，回退原 url */ }
  };
  img.src = url;
}
export { preloadTexture };
