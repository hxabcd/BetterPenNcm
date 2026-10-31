<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="本地下载" :sub="barSub" />
    <scroller class="dlpl-list">
      <library-row :item="allItem" @open="openAll" />
      <library-row v-for="it in visibleRows" :key="it.key" :item="it" @open="openItem(it)" />
      <div class="dlpl-more" v-if="hasMore" @click="loadMore">
        <text class="dlpl-more-t" :style="{ color: accent.light }">{{ moreLabel(rows.length - visibleRows.length, '个歌单') }}</text>
      </div>
      <div class="dlpl-empty" v-if="!loading && !lists.length">
        <div class="dlpl-empty-row">
          <image class="dlpl-empty-ico" :src="ICON.info" />
          <text class="dlpl-empty-t">暂无本地索引的歌单，在歌单详情页中添加</text>
        </div>
        <div class="dlpl-divider"></div>
      </div>
      <text class="dlpl-sect" v-if="!loading">其他</text>
      <library-row :item="singleItem" @open="openSingle" />
      <library-row v-if="orphanCount > 0" :item="orphanItem" @open="openOrphan" />
      <text class="dlpl-hint" v-if="loading">读取中...</text>
      <div class="dlpl-bottom"></div>
    </scroller>
    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 本地下载-歌单索引页。
 *
 * 列表结构（对齐 2026-10 设计）：
 *   [全部下载]               所有已下载文件的总入口
 *   ...已添加到本地索引的歌单...
 *   --- 其他 ---
 *   [单曲下载]               用户自己的单曲（含升级前的遗留文件）
 *   [遗留歌曲]               歌单批量下载、但已不被任何索引歌单引用的文件（策略 A 保留）
 *
 * 分类见 dlorigin.js / locallists.classify：
 *   referenced            → 歌单内（出现在对应歌单的曲目列表）
 *   !referenced && 歌单归属 → 遗留歌曲
 *   !referenced && 其它     → 单曲下载
 *
 * 没有已索引歌单时，在「其他」上方显示 info 图标 +「暂无本地索引的歌单，在歌单详情页中添加」+ 分割线。
 * 本页只做导航，不提供多选；删除/清理在各具体列表页做。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import LibraryRow from '../../components/LibraryRow.vue'
import HintToast from '../../components/HintToast.vue'
import { railBack, ICON } from '../../utils/rail.js'
import { go } from '../../utils/nav.js'
import { listSongs } from '../../utils/player/cache.js'
import { allLists, listSummary, splitDownloads } from '../../utils/player/locallists.js'
import { fmtSize } from '../../utils/format.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'
import { PAGE_ROW, moreText } from '../../utils/ui/paging.js'

const PAGE = PAGE_ROW // 索引歌单一次渲染 40 行（平台 ≤50 行）

export default {
  name: 'dlplaylists',
  mixins: [accentMixin, toastMixin, pageFrameMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'library-row': LibraryRow,
    'hint-toast': HintToast
  },
  data() {
    return {
      ICON: ICON,
      loading: true,
      lists: [],
      rows: [],
      shown: PAGE,
      allCount: 0,
      allBytes: 0,
      singleCount: 0,
      orphanCount: 0,
      orphanBytes: 0
    }
  },
  computed: {
    barSub() {
      if (this.loading) return '读取中...'
      return '歌单 · ' + this.lists.length + ' 个索引 · ' + this.allCount + ' 首'
    },
    visibleRows() {
      return this.rows.slice(0, this.shown)
    },
    hasMore() {
      return this.rows.length > this.visibleRows.length
    },
    allItem() {
      return {
        key: 'all',
        name: '全部下载',
        sub: this.allCount + ' 首 · ' + fmtSize(this.allBytes),
        icon: ICON.music
      }
    },
    singleItem() {
      return {
        key: 'single',
        name: '单曲下载',
        sub: this.singleCount + ' 首',
        icon: ICON.music
      }
    },
    orphanItem() {
      return {
        key: 'orphan',
        name: '遗留歌曲',
        sub: this.orphanCount + ' 首 · ' + fmtSize(this.orphanBytes),
        icon: ICON.fail,
        flag: ''
      }
    },
    rail() {
      return [railBack()]
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
      log('dlplaylists', '$page.on(show) 订阅失败 ' + ((e && e.message) || e))
    }
    this.refresh()
    log('dlplaylists', '歌单索引页挂载')
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
      /* 返回本页时保留已展开的条数（同 dltracks）：不要因为 onShow 重读就把列表收回首批。 */
      const keepShown = this.shown
      try {
        const downloaded = await listSongs()
        const lists = await allLists()
        const split = await splitDownloads(downloaded)
        if (this._dead) return
        let allBytes = 0
        for (let i = 0; i < downloaded.length; i++) allBytes += downloaded[i].size || 0
        let orphanBytes = 0
        for (let i = 0; i < split.orphan.length; i++) orphanBytes += split.orphan[i].size || 0
        const rows = []
        for (let i = 0; i < lists.length; i++) {
          const rec = lists[i]
          const sm = await listSummary(rec, downloaded)
          let sub = '已下载 ' + sm.local + ' / ' + sm.total + ' 首'
          if (sm.added) sub += ' · 新增 ' + sm.added
          if (sm.removed) sub += ' · 移除 ' + sm.removed
          rows.push({
            key: 'pl' + rec.id,
            pid: rec.id,
            name: rec.name || ('歌单 ' + rec.id),
            sub: sub,
            cover: rec.cover,
            coverId: 'pl' + rec.id
          })
        }
        if (this._dead) return
        this.lists = lists
        this.rows = rows
        this.shown = Math.max(keepShown, PAGE)
        this.allCount = downloaded.length
        this.allBytes = allBytes
        this.singleCount = split.single.length
        this.orphanCount = split.orphan.length
        this.orphanBytes = orphanBytes
        this.loading = false
        log('dlplaylists', '索引=' + lists.length + ' 全部=' + this.allCount +
          ' 单曲=' + this.singleCount + ' 遗留=' + this.orphanCount)
      } catch (e) {
        if (this._dead) return
        this.loading = false
        log('dlplaylists', '读取失败 ' + ((e && e.message) || e))
      }
    },
    openAll() {
      go('dltracks', { kind: 'all', name: '全部下载' })
    },
    openSingle() {
      go('dltracks', { kind: 'single', name: '单曲下载' })
    },
    openOrphan() {
      go('dltracks', { kind: 'orphan', name: '遗留歌曲' })
    },
    openItem(it) {
      go('dltracks', { kind: 'playlist', id: it.pid, name: it.name })
    },
    moreLabel(n, unit) {
      return moreText(n, unit)
    },
    loadMore() {
      if (!this.hasMore) return
      this.shown += PAGE
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.dlpl-list {
  flex: 1;
  padding-top: 2vh;
}
/* 「其他」分组标题：弱文字、小字，把单曲/遗留和上面的歌单分开 */
.dlpl-sect {
  font-size: @fs-mute;
  color: @text-3;
  margin-top: 3vh;
  margin-left: 6vh;
  margin-bottom: 1vh;
}
/* 空态：info 图标 + 提示文字，下面一根通栏分割线。
   只在没有已索引歌单时出现，位置在「其他」之上。 */
.dlpl-empty {
  flex-direction: column;
  margin-top: 4vh;
}
.dlpl-empty-row {
  flex-direction: row;
  align-items: center;
  padding-left: 4vh;
  padding-right: 4vh;
}
.dlpl-empty-ico {
  width: 9vh;
  height: 9vh;
  flex: none;
  margin-right: 2vh;
}
.dlpl-empty-t {
  flex: 1;
  font-size: @fs-dim;
  color: @text-3;
}
.dlpl-divider {
  width: 100%;
  height: 1px;
  background-color: @line;
  margin-top: 3vh;
}
.dlpl-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.dlpl-more-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
.dlpl-hint {
  font-size: @fs-dim;
  color: @text-3;
  margin-top: 4vh;
  margin-left: 4vh;
}
.dlpl-bottom {
  height: 4vh;
}
</style>
