

// 主题混入：bg + accent + fgIcon 一次给齐，页面/组件不必自己写 data + mounted + beforeDestroy 三处。
// 唯一规矩：**一个实例只绑一次**（混了本 mixin 就别再自己 bindTheme）。
import { currentAccent, currentBg, THEME_EVENT } from '../theme.js'
import { fgIcon as pickFgIcon } from '../../assets/icons.js'

export function bindTheme(vm) {
  // 页面会挂两遍（平台坑 6）：mounted 再跑一次时 `this._accentOff = bindTheme(...)` 只会覆盖字段，
  // 上一组的 $falcon.on 监听就成了没人释放的孤儿（beforeDestroy 只解绑最后一个）。
  // 先释放同一 vm 上的上一组，让 bindTheme 自己幂等（与 vis.js / dlsub.js 同一口径）。
  if (vm && vm._accentOff) {
    unbindTheme(vm._accentOff)
    vm._accentOff = null
  }
  const apply = function () {
    vm.bg = currentBg()
    vm.accent = currentAccent()
  }
  try {
    /* global $falcon */
    $falcon.on(THEME_EVENT, apply)
  } catch (e) {}
  apply()
  return apply
}

export function unbindTheme(apply) {
  if (!apply) return
  try {
    /* global $falcon */
    $falcon.off(THEME_EVENT, apply)
  } catch (e) {}
}

export const accentMixin = {
  data() {
    return { accent: currentAccent() }
  },
  mounted() {
    this._accentOff = bindTheme(this)
  },
  beforeDestroy() {
    unbindTheme(this._accentOff)
  },
  methods: {
    // 模板里取「实心主题色上的图标」：亮色预设自动换深色版 PNG —— 白图标压在亮底上看不见
    fgIcon(key) {
      return pickFgIcon(key, this.accent)
    }
  }
}
