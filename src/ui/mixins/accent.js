/**
 * 主题混入（S3 从 ui/theme.js 拆出）：bg + accent + fgIcon —— 页面/组件不必自己写
 * data + mounted + beforeDestroy 三处。
 *
 * chrome 组件（PageShell/NavRail/PageTopbar/index/login）也混本 mixin；
 * 唯一规矩：**一个实例只绑一次**（混了本 mixin 就别再自己 bindTheme）。
 *
 * 换色广播的状态本体（PRESETS/ACCENTS/setAccent/notify…）仍在 ui/theme.js；
 * gen_tokens.py 与 theme_verify.py 第一道对 theme.js 的判据不受影响。
 */
import { currentAccent, currentBg, THEME_EVENT } from '../theme.js'
import { fgIcon as pickFgIcon } from '../../assets/icons.js'

/** 广播主题变化后组件侧的刷新动作（bindTheme 的 apply）保持在本文件内聚 */

/**
 * 组件挂载时调用：订阅 + 立即取当前色（bg 与 accent 一起下发）。返回的 handler 交给 unbindTheme。
 */
export function bindTheme(vm) {
  /* 页面会挂两遍（平台坑 6）：accentMixin 的 mounted 再跑一次时 `this._accentOff = bindTheme(...)`
     只会覆盖字段，上一组的 $falcon.on 监听就成了没人释放的孤儿（beforeDestroy 只解绑最后一个）。
     这里先释放同一 vm 上的上一组，让 bindTheme 自己幂等（与 vis.js / dlsub.js 同一口径）。 */
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
    /**
     * 模板里取「实心主题色上的图标」：fgIcon('play')。
     * 亮色预设（黄/绿/青/蓝/紫/粉）自动换深色版 PNG —— 白图标压在亮底上看不见。
     */
    fgIcon(key) {
      return pickFgIcon(key, this.accent)
    }
  }
}
