<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar :title="title" :sub="barSub" :link="canOpenInfo" @open="openInfo">
      <div class="dlt-all" v-if="multi" @click="toggleAll">
        <text class="dlt-all-t" :style="{ color: accent.light }">{{ allPicked ? '全不选' : '全选' }}</text>
      </div>
    </page-topbar>

    <!-- 歌单内曲目列表的状态卡片（git fetch / pull）：作为列表第一项跟随滚动。
         拉取只更新远端信息；同步才下载 A 并清理 D（策略 A：只解除归属，不删文件）。 -->
    <scroller class="dlt-list" @scroll="onInfiniteScroll">
      <div class="dlt-status" v-if="isPlaylist">
        <text class="dlt-last">{{ lastPullText }}</text>
        <div class="dlt-fill"></div>
        <div class="dlt-btn" @click="doPull">
          <image class="dlt-btn-ico" :src="ICON.pull" />
          <text class="dlt-btn-t">拉取</text>
        </div>
        <div class="dlt-btn" @click="doSync">
          <image class="dlt-btn-ico" :src="ICON.sync" />
          <text class="dlt-btn-t">同步</text>
        </div>
      </div>
      <song-row
        v-for="(r, i) in rows"
        :key="r.song.id"
        :song="r.song"
        :index="i"
        :selectable="multi && r.downloaded !== false"
        :sel="isSel(r.song.id)"
        :flag="r.flag"
        :flag-col="isPlaylist"
        @select="onRow(i)"
        @hold="onHold(i)"
      />
      <empty-hint v-if="!rows.length && !loading" :text="hint" />
      <div class="dlt-more" v-if="hasMore" @click="loadMore">
        <text class="dlt-more-t" :style="{ color: accent.light }">{{ moreLabel(fullRows.length - rows.length, '首') }}</text>
      </div>
      <div class="dlt-bottom"></div>
    </scroller>
    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/* 四种 kind 共用一个页面（由页面参数传入）：all 全部已下载 ｜ single 单曲下载 ｜
   orphan 遗留歌曲（歌单批量下载、但已不被任何索引歌单引用；策略 A 保留文件）｜
   playlist 某个已索引歌单（额外显示状态卡片 + A/D 标记）。
   歌单内的 A/D 都相对「本地文件」计算、不相对 baseIds 的上次快照（口径见 locallists.js）：
     A（新增）= remoteIds − 本地已下载：在线点击流播，离线提示「还没下载」
     D（移除）= baseIds − remoteIds 且本地有文件：点击播本地，同步后从歌单消失（策略 A 保留
       文件），去向由归属决定（歌单批量下载 → 遗留歌曲；用户单曲 → 单曲下载）
   同步 = 先拉取，再下载所有 A，把 D 从 baseIds 移除；失败/取消的 A 保持 A，下次重试。 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import EmptyHint from '../../components/EmptyHint.vue'
import SongRow from '../../components/SongRow.vue'
import HintToast from '../../components/HintToast.vue'
import { railBack, railBtn, ICON } from '../../ui/rail.js'
import { go, paramsFor } from '../../core/infra/nav.js'
import { listSongs } from '../../services/player/cache.js'
import { dlText, dlSig, dlApi } from '../../services/player/download.js'
import { bindDl } from '../../ui/mixins/dlsub.js'
import { playlistView, pullList, syncList, splitDownloads } from '../../services/player/locallists.js'
import { songIdOf } from '../../services/player/localmeta.js'
import { fmtSize } from '../../core/infra/format.js'
import { log } from '../../core/infra/log.js'
import { accentMixin } from '../../ui/mixins/accent.js'
import { toastMixin } from '../../ui/mixins/toast.js'
import { armMixin } from '../../ui/mixins/arm.js'
import { multiSelectMixin } from '../../ui/mixins/multi.js'
import { pageFrameMixin } from '../../ui/mixins/frame.js'
import { PAGE_SONG, AUTO_BATCH, ROW_PX_SONG } from '../../ui/paging.js'
import { infiniteScrollMixin } from '../../ui/mixins/infinite.js'
import { listPageMixin } from '../../ui/mixins/listpage.js'
import { dlRowPlayMixin } from './rowplay.js'
import { dlBatchMixin } from './batch.js'

const KIND_NAME = {
  all: '全部下载',
  single: '单曲下载',
  orphan: '遗留歌曲'
}

// 平台一次渲染 ≤50 行
const PAGE = PAGE_SONG 

/** 列表项 id 归一（口径见 localmeta.songIdOf）；顺带复制一份，避免改动缓存里的对象 */
function normSong(s) {
  const out = {}
  for (let k in s) out[k] = s[k]
  out.id = songIdOf(s && s.id)
  return out
}

export default {
  name: 'dltracks',
  mixins: [accentMixin, listPageMixin, toastMixin, armMixin, multiSelectMixin, pageFrameMixin, infiniteScrollMixin, dlRowPlayMixin, dlBatchMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'song-row': SongRow,
    'hint-toast': HintToast,
    'empty-hint': EmptyHint
  },
  data() {
    return {
      ICON: ICON,
      kind: 'all',
      pid: 0,
      pageName: '',
      // 全量（新→旧 / 远端顺序），rows 是前 N 条切片
      fullRows: [], 
      rows: [],
      hasMore: false,
      added: 0,
      removed: 0,
      lastPullAt: 0,
      songBytes: 0,
      loading: true,
      hint: '读取中...',
      // '' | 'pull' | 'sync'
      busy: '', 
      dl: null
    }
  },
  computed: {
    isPlaylist() {
      return this.kind === 'playlist'
    },

    /** 顶栏可点进「歌单详情」：仅本地索引歌单的曲目页；多选态顶栏显示勾选状态，不可点 */
    canOpenInfo() {
      return !this.multi && this.isPlaylist && !!this.pid
    },
    title() {
      if (this.pageName) return this.pageName
      return KIND_NAME[this.kind] || '本地下载'
    },
    downloadedCount() {
      let n = 0
      for (let i = 0; i < this.fullRows.length; i++) {
        if (this.fullRows[i].downloaded !== false) n++
      }
      return n
    },
    lastPullText() {
      if (!this.lastPullAt) return '上次拉取：—'
      const v = Number(this.lastPullAt)
      const d = new Date(v)
      const y = d.getFullYear()
      if (!y || y < 1900) return '上次拉取：—'
      const m = d.getMonth() + 1
      const day = d.getDate()
      return '上次拉取：' + y + '/' + (m < 10 ? '0' : '') + m + '/' + (day < 10 ? '0' : '') + day
    },
    barSub() {
      if (this.isArmed('del')) return this.armRailText('删除', this.selIds.length)
      const t = dlText(this.dl)
      if (t) return t
      if (this.busy === 'pull') return '拉取中...'
      if (this.busy === 'sync') return '同步中...'
      if (this.multi) return this.multiBarSub
      if (this.loading) return '读取中...'
      if (this.isPlaylist) {
        let s = '已下载 ' + this.downloadedCount + ' 首'
        if (this.added) s += ' · 新增 ' + this.added
        if (this.removed) s += ' · 移除 ' + this.removed
        return s
      }
      return this.fullRows.length + ' 首 · ' + fmtSize(this.songBytes)
    },

    /* 左栏：返回 + 播放全部 + 多选；多选态给关闭 / 下一首播放 / 收藏到歌单 / 删除。
       ⚠ 遗留歌曲页把「收藏到歌单」换成「保留为单曲」（markUser，把文件从「遗留」转为
       「单曲下载」）—— 返回 + 3 已是槽位上限（NavRail 的 100vh 几何装不下第四颗）。
       ⚠ 必须在 computed 不能放 methods：模板 `:rail` 是「取字段」，method 版取到函数会炸。 */
    rail() {
      if (this.multi) {
        const out = [railBack(ICON.stop), railBtn('next', ICON.listplus)]
        out.push(this.kind === 'orphan' ? railBtn('keep', ICON.star) : railBtn('topl', ICON.plplus))
        out.push(railBtn('del', this.fgIcon('trash'), false, '', this.isArmed('del')))
        return out
      }
      return [
        railBack(),
        railBtn('playall', ICON.play),
        railBtn('multi', ICON.multi, false, '', false, !this.downloadedCount)
      ]
    }
  },
  mounted() {
    this._dead = false
    const self = this
    // 下载活动订阅（可见性门控 + 首帧快照，见 ui/mixins/dlsub.js）
    this._dlOff = bindDl(this, dlApi, function (s) {
      self.syncDl(s)
    })
    this._onShow = function () {
      self.loadView()
    }
    try {
      this.$page.on('show', this._onShow)
    } catch (e) {
      log('dltracks', '$page.on(show) 订阅失败 ' + ((e && e.message) || e))
    }

    // 参数通道按实例槽位 key 记账，取参必须用真实页名（写死逻辑页名只在兜底时命中）
    this.openPage(paramsFor((this.$page && this.$page.$pageName) || 'dltracks', this.$page ? this.$page.options : null))
    log('dltracks', '曲目列表页挂载')
  },
  beforeDestroy() {
    this._dead = true
    if (this._dlOff) this._dlOff()
    this._dlOff = null
    try {
      if (this._onShow) this.$page.off('show', this._onShow)
    } catch (e) {}
    this._onShow = null
  },
  methods: {
    /** 列表页骨架声明（见 ui/mixins/listpage.js）：切片数组与行高 */
    listPageConfig() {
      return { slice: 'rows', rowPx: ROW_PX_SONG }
    },
    openPage(p) {
      const par = p || {}
      const kind = par.kind === 'playlist' || par.kind === 'single' || par.kind === 'orphan' ? par.kind : 'all'
      const pid = Number(par.id) || 0
      const routeKey = kind + '|' + pid
      if (routeKey === this._routeKey) return
      this._routeKey = routeKey
      this.kind = kind
      this.pid = pid
      this.pageName = par.name || KIND_NAME[kind] || '本地下载'
      this.exitMulti()
      this.fullRows = []
      this.rows = []
      this.hasMore = false
      this.added = 0
      this.removed = 0
      this.lastPullAt = 0
      this.songBytes = 0
      this.loading = true
      this.hint = '读取中...'
      this._localIds = null
      this._loaded = false
      if (kind === 'playlist' && !pid) {
        this.loading = false
        this.hint = '缺少歌单 id'
        return
      }
      log('dltracks', '打开 kind=' + kind + ' id=' + pid + ' name=' + this.pageName)
      this.loadView()
    },
    async loadView() {
      if (this._dead) return
      const token = (this._loadToken || 0) + 1
      this._loadToken = token
      /* 已展开的条数：onShow 重读 / 拉取同步后重读时保留分页进度，否则每次退回都只剩
         首批 PAGE 首、用户得反复点「加载更多」。切换歌单时 openPage 会先清空 rows，
         这里读到 0，仍从 PAGE 起。 */
      const keepRows = this.rows.length
      this._loaded = false
      this._localIds = null
      try {
        const downloaded = (await listSongs()).map(normSong)
        if (this._dead || token !== this._loadToken) return
        // 拉取/同步复用这次目录扫描结果，避免在 locallists 里再扫一遍
        this._localIds = downloaded.map(function (s) { return s.id })
        this._loaded = true
        let rows = []
        let added = 0
        let removed = 0
        let lastPullAt = 0
        if (this.kind === 'playlist') {
          const pv = await playlistView(this.pid, downloaded)
          if (this._dead || token !== this._loadToken) return
          if (pv) {
            rows = pv.rows
            added = pv.added
            removed = pv.removed
            lastPullAt = pv.lastPullAt
            if (pv.list && pv.list.name) this.pageName = pv.list.name
            this.hint = '暂无已下载曲目'
          } else {
            this.hint = '歌单不在本地索引'
          }
        } else {
          let pool = downloaded
          if (this.kind === 'single' || this.kind === 'orphan') {
            const split = await splitDownloads(downloaded)
            if (this._dead || token !== this._loadToken) return
            pool = this.kind === 'single' ? split.single : split.orphan
          }
          pool = pool.slice()
          // 新→旧（同旧本地下载页）
          pool.sort(function (a, b) {
            return (b.mtime || 0) - (a.mtime || 0) 
          })
          rows = []
          for (let i = 0; i < pool.length; i++) {
            rows.push({ song: pool[i], flag: '', downloaded: true })
          }
          this.hint = this.kind === 'single' ? '暂无单曲下载'
            : this.kind === 'orphan' ? '暂无遗留歌曲' : '暂无下载'
        }
        if (this._dead || token !== this._loadToken) return
        let bytes = 0
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].downloaded !== false) bytes += (rows[i].song && rows[i].song.size) || 0
        }
        this.fullRows = rows
        this.rows = rows.slice(0, Math.max(keepRows, PAGE))
        this.hasMore = rows.length > this.rows.length
        this.added = added
        this.removed = removed
        this.lastPullAt = lastPullAt
        this.songBytes = bytes
        this.loading = false
        log('dltracks', '就绪 kind=' + this.kind + ' 行=' + rows.length +
          ' A=' + added + ' D=' + removed + ' 体积=' + fmtSize(bytes))
      } catch (e) {
        if (this._dead) return
        this.loading = false
        this.hint = '读取失败'
        log('dltracks', '读取失败 ' + ((e && e.message) || e))
      }
    },
    loadMore() {
      if (!this.hasMore) return
      this.rows = this.fullRows.slice(0, this.rows.length + AUTO_BATCH)
      this.hasMore = this.fullRows.length > this.rows.length
    },

    /** 顶栏 → 歌单详情（名字先带过去当标题，详情页拿到接口数据后再以接口为准） */
    openInfo() {
      if (!this.canOpenInfo) return
      // 带上本页 pageId：详情页删掉歌单时顺手把它关掉
      // entry:'dl' = 从本地下载进来：plinfo 左栏底键换「移除本地索引」，删除收进「更多」面板
      const fromPage = (this.$page && this.$page.$pageId) || ''
      go('plinfo', { id: this.pid, name: this.title, fromPage: fromPage, entry: 'dl' })
    },

    async doPull() {
      if (this.busy || !this.isPlaylist || !this.pid) return
      if (this.loading) {
        this.showToast('读取中...')
        return
      }
      this.busy = 'pull'
      this.showToast('拉取中...', 60000)

      const r = await pullList(this.pid, this._loaded ? this._localIds : null)
      this.busy = ''
      this.hideToast()
      if (this._dead) return
      if (!r.ok) {
        this.showToast(r.offline ? '离线，无法拉取' : (r.error || '拉取失败'))
        return
      }
      await this.loadView()
      const a = (r.added || []).length
      const d = (r.removed || []).length
      this.showToast(a || d ? '拉取完成：新增 ' + a + ' · 移除 ' + d : '已是最新')
    },
    async doSync() {
      if (this.busy || !this.isPlaylist || !this.pid) return
      if (this.loading) {
        this.showToast('读取中...')
        return
      }
      this.busy = 'sync'
      this.showToast('同步中...', 60000)
      const r = await syncList(this.pid, this._loaded ? this._localIds : null)
      this.busy = ''
      this.hideToast()
      if (this._dead) return
      if (!r.ok) {
        this.showToast(r.offline ? '离线，无法同步' : (r.error || '同步失败'))
        return
      }
      await this.loadView()
      if (!r.added && !r.removed) {
        this.showToast('已是最新')
        return
      }
      this.showToast(
        '同步：新增 ' + r.added + ' · 成功 ' + (r.downloaded + r.skipped) + ' · 失败 ' + r.failed +
        (r.removed ? ' · 移除 ' + r.removed + '（保留）' : ''),
        4000
      )
    },

    /* 多选范围 = **整份列表**（全部已下载曲目），不是已渲染的 50 行：全选/删除/保留都覆盖
       整单，页面仍只渲染 rows（前 N 行）。A 条目（远端有、本地没下载）不参与任何操作，排除。 */
    multiList() {
      const out = []
      for (let i = 0; i < this.fullRows.length; i++) {
        if (this.fullRows[i].downloaded !== false) out.push(this.fullRows[i].song)
      }
      return out
    },
    multiTotal() {
      return this.downloadedCount
    },
    onMultiEnter() {
      log('dltracks', '进入多选 kind=' + this.kind + ' 可操作 ' + this.downloadedCount + ' 首')
    },

    syncDl(s) {
      const d = s || {}
      const sig = dlSig(d)
      if (sig === this._dlSig) return
      this._dlSig = sig
      this.dl = d
    },

    onBack() {
      if (this.exitMultiIfAny()) return
      this.$page.finish()
    },
    onRailKey(key) {
      if (key === 'playall') this.playAll()
      else if (key === 'multi') this.enterMulti()
      else if (key === 'del') this.armDelete()
      else if (key === 'keep') this.keepSelected()
      else if (key === 'next') this.doNext()
      else if (key === 'topl') this.doToPlaylist()
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 状态卡片：列表第一项，随内容滚动（不钉在顶栏下方）；上下各 4vh 拉开与顶栏/首行的距离 */
.dlt-status {
  height: 18vh;
  flex: none;
  flex-direction: row;
  align-items: center;
  margin: 4vh 4vh 4vh 4vh;
  padding-left: 3vh;
  padding-right: 3vh;
  background-color: @panel;
  border-width: 1px;
  border-style: solid;
  border-color: @line;
  border-radius: @radius;
}
.dlt-last {
  font-size: @fs-dim;
  color: @text-2;
}
.dlt-fill {
  flex: 1;
}

/* 拉取 / 同步：带图标的按钮（14vh ≈ 34px 高，小屏上更好点）；圆角用全局卡片圆角 */
.dlt-btn {
  height: 14vh;
  flex-direction: row;
  align-items: center;
  background-color: @panel-2;
  border-radius: @radius;
  padding-left: 3.5vh;
  padding-right: 3.5vh;
  margin-left: 2vh;
}
.dlt-btn-ico {
  width: 9vh;
  height: 9vh;
  flex: none;
  margin-right: 1.8vh;
}
.dlt-btn-t {
  font-size: @fs-strong;
  color: @text-2;
}
.dlt-list {
  flex: 1;
}

/* 分页加载：与曲目列表页同一口径（一次渲染 ≤50 行） */
.dlt-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.dlt-more-t {
  font-size: @fs-dim;
  /* 书面值是默认（红）主题；运行时由模板内联 style 给当前主题色 */
  color: @accent-2; 
}
/* 多选态顶栏右侧的「全选 / 全不选」（同其它列表页） */
.dlt-all {
  height: @topbar-h;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding-left: 5vh;
  padding-right: 5vh;
}
.dlt-all-t {
  font-size: @fs-dim;
  /* 书面值是默认（红）主题；运行时由模板内联 style 给当前主题色 */
  color: @accent-2; 
}
.dlt-bottom {
  height: 4vh;
}
</style>
