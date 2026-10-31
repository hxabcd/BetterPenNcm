/**
 * 左侧操作栏的槽位构造
 *
 * 约定：数组第一个是**全局固定**的返回，其余按页面上下文给
 * （主页是搜索 + 设置、歌单列表是排序、播放器页是播放选项 + 播放列表……）。
 * **返回在栏顶、其余槽位默认贴在栏底**（见 components/NavRail.vue 的竖排几何）。
 * 各页只需拼一个数组喂给 <page-shell :rail="…">，key 在 onRail 里分派。
 */
import { ICON } from '../assets/icons.js'

/**
 * 全局固定槽位：返回。各页判 key === 'back' 后调 this.$page.finish()。
 * icon 可选：多选态把返回键改成「退出多选」时传 ICON.stop（× 图标，
 * 进入多选后返回键退出多选、图标变成叉）——key 仍是 'back'，
 * 由页面 onRail 按当前模式分派（多选态退出多选、否则退出页面）。
 */
export function railBack(icon) {
  return { key: 'back', icon: icon || ICON.back, on: false, text: '' }
}

/**
 * 上下文槽位
 * @param {string} key   事件 key，页面 onRail(key) 里分派
 * @param {string} icon  ICON.xxx（data-URI PNG）
 * @param {boolean} on   是否高亮（如「当前正按这个键排序」「该浮层已打开」）
 * @param {string} text  无图标时的文字（图标画不出来的极少数情况兜底）
 * @param {boolean} danger 危险态（实心红）：用于「点一次进入待确认」的破坏性按钮
 *                        —— 比 on 的浅红描边更醒目，见 NavRail.btnStyle
 * @param {boolean} disabled 禁用态：点击被 NavRail 拦掉、
 *                        按钮底色转透明（空列表时的「多选」键是第一处用法）。
 *                        注意语义是「此刻没有可操作的内容」，不是「忙」。
 */
export function railBtn(key, icon, on, text, danger, disabled) {
  return { key: key, icon: icon || '', on: !!on, text: text || '', danger: !!danger, disabled: !!disabled }
}

export { ICON }
