

// 左栏槽位构造：数组第一个是固定的返回，其余按页面上下文给；返回在栏顶、其余槽位默认贴底
// （竖排几何见 components/NavRail.vue）。各页拼一个数组喂给 <page-shell :rail="…">，key 在 onRail 里分派。
// 栏宽 25vh（S7 60px），返回 + 最多 3 个上下文键恰好排满 100vh —— 第 4 个物理放不下（NavRail 会告警）。
import { ICON } from '../assets/icons.js'

// icon 可选：多选态把返回键改成「退出多选」时传 ICON.stop（× 图标），key 仍是 'back'，
// 由页面 onRail 按当前模式分派。
export function railBack(icon) {
  return { key: 'back', icon: icon || ICON.back, on: false, text: '' }
}

// danger = 实心红（「点一次进入待确认」的破坏性按钮，比 on 的浅红描边更醒目，见 NavRail.btnStyle）；
// disabled = NavRail 拦掉点击且键底转透明，语义是「此刻没有可操作的内容」，不是「忙」。
export function railBtn(key, icon, on, text, danger, disabled) {
  return { key: key, icon: icon || '', on: !!on, text: text || '', danger: !!danger, disabled: !!disabled }
}

export { ICON }
