/**
 * 多选模式状态机 —— 全工程唯一实现。
 *
 * 用法：
 *   mixins: [multiSelectMixin]              // 通常与 armMixin 一起用
 *   multiList()  { return this.songs }      // **页面必须提供**：多选的「整单」范围
 *   multiTotal() { return this.totalCount } // 可选：顶栏计数口径（缺省 = multiList().length）
 *   onMultiEnter() / onMultiExit()          // 可选钩子：页面特有的进入/退出副作用
 *
 * 页面侧保留的职责（不进本模块）：rail 槽位怎么给、row 怎么分派、动作本身（删除/下载）。
 * 顶栏文案由 multiBarSub 统一给句式；armed 待确认提示优先于它（各页 barSub 自己排）。
 *
 * 与 armMixin 的耦合：选择变化 / 进入 / 退出多选时自动 disarm()（有则调）——
 * 「选择变了，二次确认作废」这条语义从此不用在五个页面里各写一遍。
 */
import { selHas, selToggle, selAllPicked, selAllIds } from '../multidl.js'

export const multiSelectMixin = {
  data() {
    return {
      multi: false, // 多选模式（本平台无动态 key，勾选态一律用数组整体替换表达）
      selIds: [] // 已选曲目 id
    }
  },
  computed: {
    /** 是否已全选（范围 = multiList()，与 toggleAll 同口径） */
    allPicked() {
      return selAllPicked(this.selIds, this.multiList())
    },
    /** 多选态顶栏副题（统一句式）；非多选态返回空串，由页面自己的 sub 接管 */
    multiBarSub() {
      if (!this.multi) return ''
      if (!this.selIds.length) return '未选中 / 共 ' + this.multiTotal() + ' 首'
      return '已选 ' + this.selIds.length + ' / 共 ' + this.multiTotal() + ' 首'
    }
  },
  methods: {
    /** 页面必须覆写：多选的范围（全选/全不选的目标数组） */
    multiList() {
      return []
    },
    /** 顶栏计数口径（缺省与范围同口径；list 用整单数 trackIds 时覆写） */
    multiTotal() {
      return this.multiList().length
    },
    enterMulti() {
      this.multi = true
      this.selIds = []
      this.disarmIfAny()
      if (this.onMultiEnter) this.onMultiEnter()
    },
    exitMulti() {
      this.multi = false
      this.selIds = []
      this.disarmIfAny()
      if (this.onMultiExit) this.onMultiExit()
    },
    isSel(id) {
      return selHas(this.selIds, id)
    },
    toggleSel(id) {
      this.selIds = selToggle(this.selIds, id)
      this.disarmIfAny() // 选择变了，二次确认作废（提示里的数量已经不对了）
    },
    toggleAll() {
      this.selIds = this.allPicked ? [] : selAllIds(this.multiList())
      this.disarmIfAny()
    },
    /** 多选态下返回键的统一语义：退出多选并返回 true（页面 onBack 里先调它） */
    exitMultiIfAny() {
      if (!this.multi) return false
      this.exitMulti()
      return true
    },
    /** 与 armMixin 的可选联动（页面没接 armMixin 时静默跳过） */
    disarmIfAny() {
      if (typeof this.disarm === 'function') this.disarm()
    }
  }
}
