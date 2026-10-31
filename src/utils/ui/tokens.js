/**
 * 设计令牌的**唯一来源**（静态部分）。
 *
 * 分工（三条，别越界）：
 *   1. **共享的静态值 → 本文件**（色板 / 字号阶梯 / 结构尺寸）。改共享值 = 改这里一行；
 *      仅单页使用的一次性尺寸可以直接写在组件里。
 *   2. `styles/common.less` 的令牌段**由 `scripts/gen_tokens.py` 从本文件生成/校验**
 *      （`python scripts/gen_tokens.py --check` 校验、`--write` 重生成）—— 手改 LESS 会被校验拦下。
 *   3. **运行时可换的值**（背景色 bg、主题色 accent 系）仍在 `utils/theme.js`（PRESETS/ACCENTS），
 *      消费方式是内联 `:style`；本文件**不含**它们（LESS 里那三个书面值 @accent/@accent-soft/@accent-2
 *      是手写段，生成器不管，保留原「书面默认值」语义）。
 *
 * 消费方式：
 *   - JS：`import { TOK } from '../../utils/ui/tokens.js'` → `{ backgroundColor: TOK.panel2 }`
 *   - 模板：需要时按老规矩把 TOK 放进 data（同 `ICON: ICON` 的做法；平台模板不解析模块作用域）
 *   - LESS：直接用生成段里的 `@panel-2` 等
 *   - **不要再写这些共享值的字面量**：theme_verify.py 第五道在 `src/{pages,components,styles}` 内按 TOK 的颜色值巡检（白名单：本文件、
 *     `styles/common.less` 整文件、gen_tokens.py）。
 *
 * 新增一个 token 的步骤：① 本表加一行（值 + DESC 说明）② 如需 LESS 侧就用，LESS_NAME 里登记名
 * ③ 跑 `python scripts/gen_tokens.py --write`。
 */

/** 值表（键 → 值）。camelCase 键；LESS 侧名见 LESS_NAME */
export const TOK = {
  /* ---- 色板（静态部分；bg 与 accent 系是运行时的，在 theme.js） ---- */
  panel: '#1a1b1f', // 面板 / 卡片
  panel2: '#232428', // 次级面（按钮底）
  line: 'rgba(255, 255, 255, 0.08)', // 分割线 / 1px 描边
  text: '#ffffff', // 主文字（= theme.js 的 FG_LIGHT，同值）
  text2: '#b9b9c0', // 次要文字（歌手名等）
  text3: '#888890', // 弱文字（时长 / 计数 / 占位）
  ok: '#7bd88f', // 成功态（下载完成）
  warn: '#ffd166', // 警示（VIP 标签 / 键盘功能键）
  dangerSoft: '#ff9a9a', // 浅红：远端已移除（D）行文字 / 遗留歌曲提示
  surface3: '#2e3138', // 面-3：浮窗内层 / 输入底 / 未选中开关底
  surface4: '#1c1e23', // 面-4：浮窗里更深的一层（列表/轨道底）
  /* ---- 播放页（2026-10-29 按设计稿 PlayerPage 14:1570 重构；设计稿色值 1:1 落表） ---- */
  btnBg: '#242424', // 播放页左栏键 / 控制键底（设计稿 48×48 圆角键）
  subBg: '#272727', // 播放页右侧子面板底（480×240，左侧圆角）
  cardBg: '#373737', // 子面板内浮起卡片 / 矩形键底（评论卡、定时按钮）
  trackBg: '#282828', // 进度槽（未播放部分）
  scrim: 'rgba(0, 0, 0, 0.28)', // 浅遮罩（排序/分类浮窗）
  scrimDeep: 'rgba(4, 7, 10, 0.6)', // 深遮罩（播放页进度浮窗）
  none: 'rgba(0, 0, 0, 0)', // 透明背景 —— **平台的透明写法**（SongRow/queue 的勾选圈底已在用）；'transparent' 关键字在 backgroundColor 上未验证，别用
  markBorder: 'rgba(255, 255, 255, 0.85)', // 勾选圈「未选中」的描边（选中态描边 = 白色 TOK.text）
  /* ---- 字号阶梯（1vh = 2.4px；@fs-body 已删——与 @fs-strong 同值且零消费） ---- */
  fsTitle: '11vh', // 大标题（详情页主标题）
  fsStrong: '8.5vh', // 加粗正文（列表主文字）
  fsDim: '7vh', // 次要
  fsMute: '6vh', // 弱
  /* ---- 结构 ---- */
  topbarH: '15vh', // 顶栏高
  rowH: '23vh', // 列表行高
  radius: '2.5vh' // 卡片圆角
}

/** 每个 token 的中文说明（生成 LESS 注释用；键必须与 TOK 一一对应） */
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

/** LESS 侧的名字（`@` 后那截）；值为 null = 仅 JS 用（LESS 不生成该 token） */
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
  none: null, // 仅 JS 用（LESS 里不需要「透明」）
  markBorder: null, // 仅 JS 用（勾选圈是内联样式）
  fsTitle: 'fs-title',
  fsStrong: 'fs-strong',
  fsDim: 'fs-dim',
  fsMute: 'fs-mute',
  topbarH: 'topbar-h',
  rowH: 'row-h',
  radius: 'radius'
}
