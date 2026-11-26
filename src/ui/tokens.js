

// 设计令牌的**唯一来源**（静态部分：色板 / 字号阶梯 / 结构尺寸）。
// styles/common.less 的令牌段由 scripts/gen_tokens.py 生成/校验（默认校验、--write 重生成），手改 LESS 会被拦下。
// **运行时可换的值**（背景 bg、主题色 accent 系）在 ui/theme.js 的 PRESETS/ACCENTS，本文件不含它们。
// 这些共享颜色值不要再在别处写字面量：theme_verify.py 第五道在 src/{pages,components,styles} 内按 TOK 的颜色值巡检
// （白名单只有：本文件、styles/common.less 整文件、scripts/gen_tokens.py）。
// 每行必须保持 `key: '值',` 形态（生成器按行正则取值），不能把表项拆行或改逗号、引号。
export const TOK = {

  // 色板（静态部分；bg 与 accent 系是运行时的，在 theme.js）。text 与 theme.js 的 FG_LIGHT 同值，须一致
  panel: '#1a1b1f', 
  panel2: '#232428', 
  line: 'rgba(255, 255, 255, 0.08)', 
  text: '#ffffff', 
  text2: '#b9b9c0', 
  text3: '#888890', 
  ok: '#7bd88f', 
  warn: '#ffd166', 
  dangerSoft: '#ff9a9a', 
  surface3: '#2e3138', 
  surface4: '#1c1e23', 

  btnBg: '#242424', 
  subBg: '#272727', 
  cardBg: '#373737', 
  trackBg: '#282828', 
  scrim: 'rgba(0, 0, 0, 0.28)', 
  scrimDeep: 'rgba(4, 7, 10, 0.6)', 
  // 透明背景只能写 rgba(0,0,0,0)：'transparent' 关键字在 backgroundColor 上没验证过，别用
  none: 'rgba(0, 0, 0, 0)', 
  // 勾选圈「未选中」的描边（选中态描边 = 白色 TOK.text）
  markBorder: 'rgba(255, 255, 255, 0.85)', 

  fsTitle: '11vh', 
  fsStrong: '8.5vh', 
  fsDim: '7vh', 
  fsMute: '6vh', 

  topbarH: '15vh', 
  rowH: '23vh', 
  radius: '2.5vh' 
}

export const DESC = {
  panel: '面板/卡片',
  panel2: '次级面（按钮底）',
  line: '分割线',
  text: '主文字',
  text2: '次要文字',
  text3: '弱文字',
  ok: '成功态',
  warn: '警示',
  dangerSoft: '浅红（远端移除/遗留提示）',
  surface3: '面-3（浮窗内层/输入底）',
  surface4: '面-4（浮窗更深层）',
  btnBg: '播放页键底',
  subBg: '播放页子面板底',
  cardBg: '子面板卡片/矩形键底',
  trackBg: '进度槽',
  scrim: '浅遮罩',
  scrimDeep: '深遮罩',
  none: '透明背景（平台写法）',
  markBorder: '勾选圈未选描边',
  fsTitle: '大标题',
  fsStrong: '加粗正文（列表主文字）',
  fsDim: '次要',
  fsMute: '弱',
  topbarH: '顶栏高',
  rowH: '列表行高',
  radius: '卡片圆角'
}

// LESS 侧的名字（`@` 后那截）；值为 null = 仅 JS 用（LESS 不生成该 token）
export const LESS_NAME = {
  panel: 'panel',
  panel2: 'panel-2',
  line: 'line',
  text: 'text',
  text2: 'text-2',
  text3: 'text-3',
  ok: 'ok',
  warn: 'warn',
  dangerSoft: 'danger-soft',
  surface3: 'surface-3',
  surface4: 'surface-4',
  btnBg: 'btn-bg',
  subBg: 'sub-bg',
  cardBg: 'card-bg',
  trackBg: 'track-bg',
  scrim: 'scrim',
  scrimDeep: 'scrim-deep',
  none: null, 
  markBorder: null, 
  fsTitle: 'fs-title',
  fsStrong: 'fs-strong',
  fsDim: 'fs-dim',
  fsMute: 'fs-mute',
  topbarH: 'topbar-h',
  rowH: 'row-h',
  radius: 'radius'
}
