/**
 * 轻提示（HintToast 通道）—— 全工程唯一实现；默认 2000ms，个别场景显式传 ms。
 *
 * 边界（别混用通道）：顶栏 sub / status 那条「常显状态行」**不归这里** —— 需要常显的提示
 * （如「双击确认」）应走 barSub，两秒后就没了的提示撑不起二次确认。
 * 页面会挂两遍：字段与计时器都挂在实例上、不跨实例共享；销毁时自动清计时器。
 */
const DEFAULT_MS = 2000

export const toastMixin = {
  data() {
    return { toast: '' }
  },
  beforeDestroy() {
    this.hideToast()
  },
  methods: {
    /** 显示轻提示（HintToast）；text 为空串 = 立即隐藏。ms 缺省 2000 */
    showToast(text, ms) {
      this._toastClear()
      this.toast = text || ''
      if (!text) return
      const self = this
      this._toastTimer = setTimeout(function () {
        self._toastTimer = null
        self.toast = ''
      }, ms > 0 ? ms : DEFAULT_MS)
    },
    /** 立即隐藏并清掉计时器（销毁时由本模块自动调用） */
    hideToast() {
      this._toastClear()
      this.toast = ''
    },
    _toastClear() {
      if (this._toastTimer) {
        clearTimeout(this._toastTimer)
        this._toastTimer = null
      }
    }
  }
}
