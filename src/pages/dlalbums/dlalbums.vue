<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="本地下载" :sub="barSub" />
    <scroller class="dal-list" @scroll="onInfiniteScroll">
      <div class="dal-row" v-for="(row, ri) in rows" :key="ri">
        <album-card v-for="a in row" :key="a.id" :item="a" :cols="cols" :width-px="cardWpx" @open="openAlbum(a)" />
      </div>
      <empty-hint v-if="loading" text="读取中..." />
      <empty-hint v-else-if="!albums.length" text="暂无本地专辑" />
      <div class="dal-more" v-if="hasMore" @click="loadMore">
        <text class="dal-more-t" :style="{ color: accent.light }">{{ moreLabel(view.length - shown, '张') }}</text>
      </div>
      <div class="dal-bottom"></div>
    </scroller>

    <context-sheet
      v-if="panel"
      title="排序与列数"
      :options="sortOptions"
      :active-key="sortKey"
      :asc="sortAsc"
      :columns="[2, 3, 4]"
      :active-columns="cols"
      columns-label="列数"
      @pick="pickSort"
      @pick-columns="pickCols"
      @close="closePanel"
    />
  </page-shell>
</template>

<script>
/**
 * 本地下载-专辑：歌曲本地索引里的所有专辑，卡片网格。
 *
 * 卡面（见 components/AlbumCard.vue）：专辑封面（取专辑内歌曲的封面）+ 专辑名(L1)
 * + 专辑艺术家(L2) + 歌曲数量/年份(L3)。
 *
 * 左栏排序键展开 ContextSheet：「排序依据（标题/年份/数量）+ 列数（2/3/4）」。
 * 默认按年份新→旧（专辑库最常见），标题默认 A→Z、数量默认多→少；
 * 同一项再点一次切升降序。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import AlbumCard from '../../components/AlbumCard.vue'
import EmptyHint from '../../components/EmptyHint.vue'
import ContextSheet from '../../components/ContextSheet.vue'
import { railBack, railBtn, ICON } from '../../ui/rail.js'
import { go } from '../../core/infra/nav.js'
import { cmpText } from '../../core/infra/format.js'
import { localAlbumList } from '../../services/player/localmeta.js'
import { log } from '../../core/infra/log.js'
import { accentMixin } from '../../ui/mixins/accent.js'
import { pageFrameMixin } from '../../ui/mixins/frame.js'
import { PAGE_CARD, AUTO_BATCH, ROW_PX_CARD } from '../../ui/paging.js'
import { fitColumns, cardWidthPx } from '../../core/platform/viewport.js'
import { infiniteScrollMixin } from '../../ui/mixins/infinite.js'
import { listPageMixin } from '../../ui/mixins/listpage.js'

const SORTS = [
  { key: 'title', label: '标题' },
  { key: 'year', label: '年份' },
  { key: 'count', label: '数量' }
]

const PAGE = PAGE_CARD // 一次最多 40 张卡（4 列 10 行 / 2 列 20 行，均在 ≤50 行内）

/**
 * 默认列数：按**内容区宽度**自动选（S7 1020 宽 → 4 列；X3S/X5 800 宽 → 3 列）。
 * 不再读 `env.screenWidth` —— 那个字段在 X3S 上根本不存在（只有 deviceWidth）。
 */
function defaultCols() {
  return fitColumns(76, 5, 7, 4).cols
}

export default {
  name: 'dlalbums',
  mixins: [accentMixin, listPageMixin, pageFrameMixin, infiniteScrollMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'album-card': AlbumCard,
    'empty-hint': EmptyHint,
    'context-sheet': ContextSheet
  },
  data() {
    return {
      ICON: ICON,
      loading: true,
      albums: [],
      cols: 4,
      shown: PAGE,
      panel: '',
      sortOptions: SORTS,
      sortKey: 'year',
      sortAsc: false
    }
  },
  computed: {
    view() {
      const out = this.albums.slice()
      const k = this.sortKey
      const dir = this.sortAsc ? 1 : -1
      out.sort(function (a, b) {
        if (k === 'count') return dir * ((a.count || 0) - (b.count || 0))
        if (k === 'year') return dir * ((a.publishTime || 0) - (b.publishTime || 0))
        return dir * cmpText(a.name, b.name)
      })
      return out
    },
    /** 每张卡的定宽（px）：按当前列数在本机型内容区里均分（末列不再溢出被裁） */
    cardWpx() {
      // 用户选的列数可能在小屏上装不下：卡宽按内容区均分（变窄，不溢出）
      return cardWidthPx(this.cols, 5, 7)
    },
    rows() {
      const out = []
      const list = this.view.slice(0, this.shown)
      const n = this.cols === 2 ? 2 : this.cols === 3 ? 3 : 4
      for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
      return out
    },
    hasMore() {
      return this.view.length > this.shown
    },
    barSub() {
      if (this.loading) return '读取中...'
      return '专辑 · ' + this.albums.length + ' 张'
    },
    rail() {
      return [
        railBack(),
        railBtn('sort', ICON.sort, this.panel === 'sort')
      ]
    }
  },
  mounted() {
    this._dead = false
    this.cols = defaultCols()
    const self = this
    this._onShow = function () {
      self.refresh()
    }
    try {
      this.$page.on('show', this._onShow)
    } catch (e) {
      log('dlalbums', '$page.on(show) 订阅失败 ' + ((e && e.message) || e))
    }
    this.refresh()
    log('dlalbums', '本地专辑页挂载，默认 ' + this.cols + ' 列')
  },
  beforeDestroy() {
    this._dead = true
    try {
      if (this._onShow) this.$page.off('show', this._onShow)
    } catch (e) {}
    this._onShow = null
  },
  methods: {
    /** 列表页骨架声明（见 ui/mixins/listpage.js）：切片数组与行高 */
    listPageConfig() {
      return { slice: 'rows', rowPx: ROW_PX_CARD }
    },
    async refresh() {
      try {
        const list = await localAlbumList()
        if (this._dead) return
        this.albums = list
        /* 不重置 shown：从专辑详情返回时保留已展开的分页（排序 / 列数切换另行重置）。 */
        this.loading = false
        log('dlalbums', '专辑 ' + list.length + ' 张')
      } catch (e) {
        if (this._dead) return
        this.loading = false
        log('dlalbums', '读取失败 ' + ((e && e.message) || e))
      }
    },
    openAlbum(a) {
      if (!a || !a.id) return
      go('album', { id: a.id, name: a.name, local: 1 })
    },
    closePanel() {
      this.panel = ''
    },
    loadMore() {
      if (!this.hasMore) return
      this.shown += AUTO_BATCH
    },
    pickSort(k) {
      if (k === this.sortKey) {
        this.sortAsc = !this.sortAsc
      } else {
        this.sortKey = k
        // 标题默认 A→Z；年份默认新→旧；数量默认多→少
        this.sortAsc = k === 'title'
      }
      this.shown = PAGE
      this.panel = ''
      log('dlalbums', '排序 ' + k + (this.sortAsc ? ' 升序' : ' 降序'))
    },
    pickCols(n) {
      const v = Number(n)
      if (v === 2 || v === 3 || v === 4) this.cols = v
      this.shown = PAGE
      this.panel = ''
      log('dlalbums', '列数 -> ' + this.cols)
    },
    onRailKey(key) {
      if (key === 'sort') this.panel = this.panel === 'sort' ? '' : 'sort'
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 卡片外边距结构同歌单列表页：每张卡自带 5vh 右间距，列表右 padding 收窄。
   2/3/4 列的卡片宽度分别 190/124/92.5vh，加 5vh 间距后总宽 390/387/390vh，
   均在内容区 ~400vh（左栏 25vh 之后）内。 */
.dal-list {
  flex: 1;
  padding-top: 4vh;
  padding-left: 6vh;
  padding-right: 1vh;
}
.dal-row {
  flex-direction: row;
  margin-bottom: 5vh;
}
.dal-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.dal-more-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
.dal-bottom {
  height: 4vh;
}
</style>
