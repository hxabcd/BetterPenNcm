

// 页面骨架分派（rail 骨架）：提供默认 rail / onBack / onRailKey，页面覆写需要的钩子。
// 「返回」永远是第一个槽位，且**返回不归 PageShell 管**（$page 在组件里不可靠）——这里就是它的落点。
// 上下文键最多 3 个（返回 + 3 恰好排满左栏 100vh，超上限 NavRail 会 log 告警，折叠机制未实现）。
import { railBack } from '../rail.js'
import { attachPage } from '../../core/infra/nav.js'

export const pageFrameMixin = {
  mounted() {
    // 导航层兜底记账：页面根实例挂载时登记实例存活（attachPage 内部只认页面根实例，
    // PageShell 等子组件也混了本 mixin，会被跳过）
    attachPage(this)
  },
  computed: {
    // 默认左栏：只有返回。有上下文键的页面用自己的 computed 覆写（组件选项覆盖 mixin，同名同组）。
    // ⚠ 必须在 computed、**不能放 methods**：模板 `:rail="rail"` 编译出来是「取字段」不是调用，
    //   method 版取到的是**函数**、不是数组，NavRail 拿它 slice 直接炸 → 整条左栏消失；
    //   computed 版还会随依赖（如多选态）自动重算。
    rail() {
      return [railBack()]
    }
  },
  methods: {
    // PageShell 的 @rail 入口：back 与上下文键分流到两个钩子
    onRail(key) {
      if (key === 'back') this.onBack()
      else this.onRailKey(key)
    },
    // 返回语义：默认退页；覆写需自行调 $page.finish()。多选态的返回 = 退出多选（exitMultiIfAny）
    onBack() {
      this.$page.finish()
    },

    onRailKey(key) {}
  }
}
