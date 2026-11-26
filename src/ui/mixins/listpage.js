

// 列表页骨架接线：moreLabel 文案转发、本地切片 loadMore、infiniteBottomPx 底部估算（infinite mixin 的判据）、
// beforeDestroy 时 _dlOff 订阅兜底清理。
// 各页的数据源字段名不同（songs/rows/visible/viewAll、行高常量各异）：页面覆写 `listPageConfig()`
// 声明「切片数组在哪、行高多少」，缺省按最常见形态取（slice='songs'）。
// list/dltracks/dlplaylists 等带网络游标或三段列表的页**不接**本 mixin 的 loadMore（分派更复杂），
// 只接 moreLabel 与订阅清理。
import { AUTO_BATCH, moreText } from '../paging.js'

export const listPageMixin = {
  data() {
    return {
      // 本地切片步长（滚到底自动续批的展开量）；网络游标页用不到
      listBatch: AUTO_BATCH
    }
  },
  computed: {
    // 「加载更多」估算底部（已渲染行数 × 行高）；行高由 listRowPx 给（页面可覆写）
    infiniteBottomPx() {
      return Math.round(this.listShownCount * this.listRowPx)
    },
    // 已渲染的行数（本地切片的口径 = slice 数组的前 shown 条；全量渲染页 = 数组长度）
    listShownCount() {
      const arr = this.listSliceArr
      if (!arr) return 0
      if (this.listShown == null) return arr.length
      return Math.min(this.listShown, arr.length)
    }
  },
  methods: {
    // 「加载更多」文案（模板里只能用 methods/data 暴露的方法，import 的 helper 不能裸调）
    moreLabel(n, unit) {
      return moreText(n, unit)
    },
    // 本地切片的「加载更多」（无网络请求）：有没渲染的行就展开一批。
    // 页面覆写 loadMore 时自行处理网络游标（如 playlists 的歌手专辑分支），或先调本实现。
    loadMoreLocalSlice() {
      const arr = this.listSliceArr
      if (!arr || this.listShown == null) return
      if (this.listShown < arr.length) {
        this.listShown = Math.min(this.listShown + this.listBatch, arr.length)
      }
    },

    // 页面侧声明切片形态（可选，缺省 = { slice: 'songs' }）：
    //   slice: data 里切片全量数组的字段名；shown: data 里已渲染条数的字段名（全量渲染页不传）；rowPx: 行高 px
    listPageConfig() {
      return { slice: 'songs', rowPx: 0 }
    }
  },
  beforeDestroy() {
    // 下载活动订阅的兜底清理：页面忘写 if (this._dlOff) this._dlOff() 也不泄漏
    if (this._dlOff) {
      try {
        this._dlOff()
      } catch (e) {}
      this._dlOff = null
    }
  }
}

// 按 config 解析出切片数组 / shown / 行高（computed 侧的共享读取）
function cfgOf(vm) {
  const c = (vm.listPageConfig && vm.listPageConfig()) || {}
  return c
}

// computed 里不能调 methods（模板判据之外的内部实现）：用 accessor 形式挂在 computed 定义里
Object.defineProperty(listPageMixin.computed, 'listSliceArr', {
  configurable: true,
  get: function listSliceArr() {
    /* eslint-disable-next-line no-invalid-this */
    const c = cfgOf(this)
    /* eslint-disable-next-line no-invalid-this */
    return c.slice ? this[c.slice] : null
  }
})
Object.defineProperty(listPageMixin.computed, 'listShown', {
  configurable: true,
  get: function listShown() {
    /* eslint-disable-next-line no-invalid-this */
    const c = cfgOf(this)
    /* eslint-disable-next-line no-invalid-this */
    return c.shown ? this[c.shown] : null
  }
})
Object.defineProperty(listPageMixin.computed, 'listRowPx', {
  configurable: true,
  get: function listRowPx() {
    /* eslint-disable-next-line no-invalid-this */
    const c = cfgOf(this)
    return c.rowPx || 0
  }
})
