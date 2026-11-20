/**
 * 页面级跨页事件（`$falcon.on` 的注册与退役）。
 *
 * 语义：
 *   - 每个事件只向框架注册**一次**；
 *   - 同一事件由**注册顺序最靠后、且实例还活着**的页面处理（= 页面栈上层优先）：
 *     注册顺序就是页面挂载顺序（= 栈序），实例销毁自动退役，事件回落到下层页面；
 *   - 页面实例按「后进先出」处理 —— 与导航层的压栈语义一致（见 utils/nav.js）。
 *
 * 用法：
 *   mixins: [pageBusMixin]
 *   mounted() { this.onPageEvent('bpncm:login-done', 'onLoginDone') }
 *   methods: { onLoginDone(payload) { ... } }   // this = 页面实例
 *
 * 边界：
 *   - 与 accentMixin 的 bindTheme **不是**一回事（那是主题广播，订阅对象是组件实例本身）；
 *     本模块只管 `$falcon.on` 的跨页业务事件。
 *   - **一次性启动链的异步回调**（index 的 boot().then 那种）不走这里 —— 它不是订阅事件，
 *     继续用模块级 live 指针是正确的，别硬套。
 */
const REG = {} // evt -> [{ vm, method }, ...]（挂载顺序；最后一个 = 当前最上层接收者）
const WIRED = {} // evt -> true（已向框架注册过；永不解绑，框架级广播长存活）

function wire(evt, vm, method) {
  if (!REG[evt]) REG[evt] = []
  const list = REG[evt]
  for (let i = 0; i < list.length; i++) {
    // 同一实例重复注册（页面会挂两遍 / mounted 重复调）时只留一份
    if (list[i].vm === vm && list[i].method === method) return
  }
  list.push({ vm: vm, method: method })
  if (WIRED[evt]) return
  WIRED[evt] = true
  try {
    /* global $falcon */
    $falcon.on(evt, function (payload) {
      const cur = REG[evt] || []
      for (let i = cur.length - 1; i >= 0; i--) {
        const r = cur[i]
        if (!r || !r.vm) continue
        const fn = r.vm[r.method]
        if (typeof fn === 'function') {
          fn.call(r.vm, payload)
          return // 只由最上层实例处理（与导航压栈语义一致）
        }
      }
    })
  } catch (e) {}
}

function unwire(vm) {
  for (const evt in REG) {
    const list = REG[evt] || []
    REG[evt] = list.filter(function (r) {
      return r.vm !== vm
    })
  }
}

export const pageBusMixin = {
  methods: {
    /** 订阅跨页事件（页面栈上层优先；实例销毁自动退役，下层接着收） */
    onPageEvent(evt, method) {
      wire(evt, this, method)
    }
  },
  beforeDestroy() {
    unwire(this)
  }
}
