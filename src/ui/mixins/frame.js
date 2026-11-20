/**
 * 页面骨架分派（rail 骨架）。
 *
 * 用法（页面只要覆写需要的钩子）：
 *   mixins: [pageFrameMixin]
 *   rail()     → 默认 [railBack()]；有上下文键的页面覆写
 *   onBack()   → 默认 this.$page.finish()；index（退应用）/ login（自定义关闭）/
 *                 多选页（先退多选）覆写
 *   onRailKey(key) → 上下文键分派；有上下文键的页面覆写
 *
 * ⚠ 约定（平台 + 交互）：
 * - 「返回」永远是第一个槽位（NavRail 的几何约定），且**返回不归 PageShell 管**
 *   （$page 在组件里不可靠）——这里就是它的落点。
 * - 上下文键最多 3 个（返回 + 3 恰好等距排满 100vh，见 NavRail 注释）；
 *   超上限时 NavRail 会在 mounted 里 log 告警（折叠机制待评估、暂不实现）。
 * - 多选态的返回语义 = 退出多选，由 multiSelectMixin 的 exitMultiIfAny() 提供，
 *   页面 onBack 写一行 `if (this.exitMultiIfAny()) return` 即可。
 */
import { railBack } from '../rail.js'
import { attachPage } from '../nav.js'

export const pageFrameMixin = {
  mounted() {
    /* 导航层兜底记账：页面根实例挂载时登记实例存活（attachPage 内部只认页面根实例，
       PageShell 等子组件也混了本 mixin，会被跳过）。不依赖 App 级生命周期钩子是否可用。 */
    attachPage(this)
  },
  computed: {
    /**
     * 默认左栏：只有返回。有上下文键的页面用**自己的 computed** 覆写（组件选项覆盖 mixin，同名同组）。
     *
     * ⚠ 必须在 computed、**不能放 methods**：模板 `:rail="rail"` 编译出来是「取字段」
     * （字节码实证：`get_field rail` + `define_field rail`，不是调用）——method 版取到的是
     * **函数**、不是数组，NavRail 拿它 slice 直接炸 → 整条左栏消失。computed 版还随依赖（如多选态）自动重算，
     * 键集合变化照常触发 NavRail 重建。
     */
    rail() {
      return [railBack()]
    }
  },
  methods: {
    /** PageShell 的 @rail 入口：back 与上下文键分流到两个钩子 */
    onRail(key) {
      if (key === 'back') this.onBack()
      else this.onRailKey(key)
    },
    /** 返回语义：默认退页；覆写需自行调 $page.finish() */
    onBack() {
      this.$page.finish()
    },
    /** 上下文键分派（槽位 key → 动作）；默认无上下文键 */
    onRailKey(key) {}
  }
}
