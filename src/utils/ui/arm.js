/**
 * 「点两次确认」状态机（armed）—— 全工程唯一实现。
 *
 * 本平台没有对话框设施，破坏性动作一律「第一次点按进入待确认 → 第二次点按执行」，
 * 3 秒不复位。
 *
 * 用法：
 *   mixins: [armMixin]
 *   if (this.isArmed('del')) { this.disarm(); this.doDelete(); return }
 *   this.arm('del')                       // 进入待确认，3 秒后自动复位
 *   this.arm('stop:' + id)                // id 任意字符串，逐行场景用 '前缀:行id'
 *
 * 分工：本模块只拥有「状态 + 计时」；**呈现归调用方** —— 左栏红键（railBtn 的
 * danger）、行底色、按钮文案变化都由页面自己绑定 isArmed()。复位时机：动作执行 /
 * 选择变化 / 退出模式时调用方主动 disarm()；页面销毁时本模块自动 disarm。
 *
 * 文案模板（本轮就统一）：
 *   左栏批量：'双击{移除|删除|下载} N 首'  → armRailText(verb, n)
 *   行/按钮：'双击确认{中断|删除|清空已下载|退出登录}' → armConfirmText(verb)
 * 与页面展示相关的数量、体积等前缀（如「空间可能不足（需约 X）」）由页面自拼。
 */
export const ARM_MS = 3000

/** 左栏红键的待确认文案（批量动作） */
export function armRailText(verb, n) {
  return '双击' + verb + ' ' + n + ' 首'
}

/** 行内 / 按钮的待确认文案（单目标动作；verb 为空则只给「双击确认」） */
export function armConfirmText(verb) {
  return '双击确认' + (verb || '')
}

export const armMixin = {
  data() {
    return { armed: '' }
  },
  beforeDestroy() {
    this.disarm()
  },
  methods: {
    /** 进入待确认；id 为空串 = 直接复位。ms 缺省 ARM_MS（3000） */
    arm(id, ms) {
      this._armClear()
      this.armed = id ? String(id) : ''
      if (!this.armed) return
      const self = this
      this._armTimer = setTimeout(function () {
        self._armTimer = null
        self.armed = ''
      }, ms > 0 ? ms : ARM_MS)
    },
    isArmed(id) {
      return !!this.armed && this.armed === String(id)
    },
    /** 复位（动作执行 / 选择变化 / 退出模式时调用） */
    disarm() {
      this._armClear()
      this.armed = ''
    },
    _armClear() {
      if (this._armTimer) {
        clearTimeout(this._armTimer)
        this._armTimer = null
      }
    },
    /* 文案模板挂到 methods 上，便于 computed / 模板里 this.armRailText(...) */
    armRailText(verb, n) {
      return armRailText(verb, n)
    },
    armConfirmText(verb) {
      return armConfirmText(verb)
    }
  }
}
