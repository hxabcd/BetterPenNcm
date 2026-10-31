<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="本地下载" :sub="barSub" />
    <scroller class="dla-list">
      <artist-row v-for="a in visible" :key="a.id" :item="card(a)" @open="openArtist(a)" />
      <empty-hint v-if="loading" text="读取中..." />
      <empty-hint v-else-if="!artists.length" text="暂无本地歌手" />
      <div class="dla-more" v-if="hasMore" @click="loadMore">
        <text class="dla-more-t" :style="{ color: accent.light }">{{ moreLabel(view.length - visible.length, '位') }}</text>
      </div>
      <div class="dla-bottom"></div>
    </scroller>

    <context-sheet
      v-if="panel"
      title="排序方式"
      :options="sortOptions"
      :active-key="sortKey"
      :asc="sortAsc"
      @pick="pickSort"
      @close="closePanel"
    />
  </page-shell>
</template>

<script>
/**
 * 本地下载-歌手：歌曲本地索引里的所有歌手。
 *
 * 行 = 头像 + 名称 + 歌曲数量，行高 32vh（需求：比歌曲列表更高）。
 * 头像来源统一在 ArtistRow 里解析：真头像（arp<id>@60，在线可取轻量接口）优先，
 * 代表专辑封面（al<albumId>@60，下载时已预热）兜底；与歌手详情本地视图同一张图。
 * 点行进歌手页并带上 local=1，让 artist 页强制走本地索引视图
 * （只显示已下载曲目，而不是在线全量）。
 *
 * 左栏排序键展开 ContextSheet：标题（升序）/ 数量（降序），同键再点切方向。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import ArtistRow from '../../components/ArtistRow.vue'
import EmptyHint from '../../components/EmptyHint.vue'
import ContextSheet from '../../components/ContextSheet.vue'
import { railBack, railBtn, ICON } from '../../utils/rail.js'
import { go } from '../../utils/nav.js'
import { localArtistList } from '../../utils/player/localmeta.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'
import { PAGE_ROW, moreText } from '../../utils/ui/paging.js'

const SORTS = [
  { key: 'name', label: '标题' },
  { key: 'count', label: '数量' }
]

const PAGE = PAGE_ROW // 一次渲染 ≤50 行（平台坑 5）；ArtistRow 较高，取 40

function cmpName(a, b) {
  const x = String(a || '')
  const y = String(b || '')
  try {
    return x.localeCompare(y)
  } catch (e) {
    return x < y ? -1 : x > y ? 1 : 0
  }
}

export default {
  name: 'dlartists',
  mixins: [accentMixin, pageFrameMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'artist-row': ArtistRow,
    'empty-hint': EmptyHint,
    'context-sheet': ContextSheet
  },
  data() {
    return {
      ICON: ICON,
      loading: true,
      artists: [],
      shown: PAGE,
      panel: '',
      sortOptions: SORTS,
      sortKey: 'name',
      sortAsc: true
    }
  },
  computed: {
    view() {
      const out = this.artists.slice()
      const k = this.sortKey
      const dir = this.sortAsc ? 1 : -1
      out.sort(function (a, b) {
        if (k === 'count') return dir * ((a.count || 0) - (b.count || 0))
        return dir * cmpName(a.name, b.name)
      })
      return out
    },
    visible() {
      return this.view.slice(0, this.shown)
    },
    hasMore() {
      return this.view.length > this.visible.length
    },
    barSub() {
      if (this.loading) return '读取中...'
      return '歌手 · ' + this.artists.length + ' 位'
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
    const self = this
    this._onShow = function () {
      self.refresh()
    }
    try {
      this.$page.on('show', this._onShow)
    } catch (e) {
      log('dlartists', '$page.on(show) 订阅失败 ' + ((e && e.message) || e))
    }
    this.refresh()
    log('dlartists', '本地歌手页挂载')
  },
  beforeDestroy() {
    this._dead = true
    try {
      if (this._onShow) this.$page.off('show', this._onShow)
    } catch (e) {}
    this._onShow = null
  },
  methods: {
    async refresh() {
      try {
        const list = await localArtistList()
        if (this._dead) return
        this.artists = list
        /* 不重置 shown：从歌手详情返回时保留已展开的分页（排序切换另行重置）。 */
        this.loading = false
        log('dlartists', '歌手 ' + list.length + ' 位')
      } catch (e) {
        if (this._dead) return
        this.loading = false
        log('dlartists', '读取失败 ' + ((e && e.message) || e))
      }
    },
    card(a) {
      return {
        id: a.id,
        name: a.name,
        count: a.count,
        cover: a.cover,
        albumId: a.albumId
      }
    },
    openArtist(a) {
      if (!a || !a.id) return
      go('artist', { id: a.id, name: a.name, local: 1 })
    },
    closePanel() {
      this.panel = ''
    },
    moreLabel(n, unit) {
      return moreText(n, unit)
    },
    loadMore() {
      if (!this.hasMore) return
      this.shown += PAGE
    },
    pickSort(k) {
      if (k === this.sortKey) {
        this.sortAsc = !this.sortAsc
      } else {
        this.sortKey = k
        // 标题默认 A→Z；数量默认多→少
        this.sortAsc = k === 'name'
      }
      this.shown = PAGE
      this.panel = ''
      log('dlartists', '排序 ' + k + (this.sortAsc ? ' 升序' : ' 降序'))
    },
    onRailKey(key) {
      if (key === 'sort') this.panel = this.panel === 'sort' ? '' : 'sort'
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.dla-list {
  flex: 1;
  padding-top: 2vh;
}
.dla-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.dla-more-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
.dla-bottom {
  height: 4vh;
}
</style>
