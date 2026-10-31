<template>
  <page-shell :rail="rail" @rail="onRail">
    <!-- 顶栏：标题固定「专辑详情」，副题灰色显示专辑名；
         发行时间/曲目数在下面的头部已经给了，不重复；多选/下载态副题让位给状态文案 -->
    <page-topbar title="专辑详情" :sub="barSub">
      <div class="ab-all" v-if="multi" @click="toggleAll">
        <text class="ab-all-t">{{ allPicked ? '全不选' : '全选' }}</text>
      </div>
    </page-topbar>
    <scroller class="ab-scroll">
      <!-- 头部：大封面 + 专辑名 + 歌手（可点 → 歌手页）+ 发行时间/曲目数 -->
      <div class="ab-hero">
        <div class="ab-coverbox">
          <image v-if="cover" class="ab-cover" :src="cover" resize="cover" />
        </div>
        <div class="ab-hinfo">
          <text class="ab-hname">{{ album.name }}</text>
          <div class="ab-line" @click="openArtist">
            <text class="ab-artist" :style="{ color: accent.light }">{{ artistText }} ›</text>
          </div>
          <text class="ab-hmeta">{{ meta }}</text>
        </div>
      </div>

      <song-row
        v-for="(s, i) in visibleSongs"
        :key="s.id"
        :song="s"
        :index="i"
        :selectable="multi"
        :sel="isSel(s.id)"
        @select="onRow(i)"
        @hold="onHold(i)"
      />
      <empty-hint v-if="!songs.length" :text="hint" />
      <!-- 专辑曲目也可能超过一次渲染预算（精选集/套装），与曲目列表页同一口径 -->
      <div class="ab-more" v-if="hasMore" @click="loadMore">
        <text class="ab-more-t" :style="{ color: accent.light }">{{ moreLabel(songs.length - visibleSongs.length, '首') }}</text>
      </div>
      <div class="ab-bottom"></div>
    </scroller>

    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 专辑页（从歌曲信息页的「专辑」或歌手页的专辑卡进入）
 *
 * 数据：/api/v1/album/{id}　—— 实测 album.size 与 songs.length 一致（12/12、25/25），
 * 一次请求就拿到专辑元信息 + 全量曲目，不用再单独拉曲目表。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import EmptyHint from '../../components/EmptyHint.vue'
import SongRow from '../../components/SongRow.vue'
import HintToast from '../../components/HintToast.vue'
import { railBack, railBtn, ICON } from '../../utils/rail.js'
import { go, paramsFor } from '../../utils/nav.js'
import { player } from '../../utils/player/player.js'
import { fetchAlbum } from '../../utils/ncm/api.js'
import { setAlbumSubscribed, albumSubscribed } from '../../utils/ncm/subscribe.js'
import { toPlaylist, playNext, playNextText } from '../../utils/songact.js'
import { localAlbumView } from '../../utils/player/localmeta.js'
import { isOffline } from '../../utils/net/status.js'
import { ensureCover, BIG_COVER } from '../../utils/cover.js'
import { fmtDate, fmtSize, clipText } from '../../utils/format.js'
import { downloadSongs, dlState, onDl, offDl } from '../../utils/player/download.js'
import { selPicked, dlText, startText, resultText, spaceCheck } from '../../utils/multidl.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { armMixin } from '../../utils/ui/arm.js'
import { multiSelectMixin } from '../../utils/ui/multi.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'
import { PAGE_SONG, moreText } from '../../utils/ui/paging.js'

export default {
  name: 'album',
  mixins: [accentMixin, toastMixin, armMixin, multiSelectMixin, pageFrameMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'song-row': SongRow,
    'hint-toast': HintToast,
    'empty-hint': EmptyHint
  },
  data() {
    return {
      id: 0,
      album: { id: 0, name: '', cover: '', publishTime: 0, size: 0, company: '', description: '' },
      artists: [],
      songs: [],
      shown: PAGE_SONG, // 渲染分片：全量曲目在内存，首屏只铺 PAGE_SONG 行
      cover: '',
      offline: false, // 离线视图：数据全部来自本地索引（只含已下载的曲目）
      localOnly: false, // 从本地下载-专辑进入：在线也强制本地视图
      hint: '加载中...',
      /* ---- 多选下载（：专辑页也是「所有曲目列表」之一）---- */
      estText: '', // 估算体积文案（仅 isArmed('dl') 时被读；armed/toast 由 mixin 提供）
      dl: null, // 下载活动快照（订阅 onDl，签名判重后赋值）
      /* ---- 收藏（CSV「专辑详情」行的底键）----
         subscribed：true/false；null = 不知道（未登录 / 离线 / 状态接口失败），按未收藏显示。 */
      subscribed: null,
      subBusy: false
    }
  },
  computed: {
    artistText() {
      if (!this.artists.length) return '未知歌手'
      const out = []
      for (let i = 0; i < this.artists.length; i++) out.push(this.artists[i].name)
      return out.join(' / ')
    },
    meta() {
      const parts = [fmtDate(this.album.publishTime), this.songs.length + ' 首']
      if (this.album.company) parts.push(this.album.company)
      if (this.offline) parts.push('本地')
      return parts.join(' · ')
    },
    /** 渲染分片（全量 songs 已在内存；多选/播放全部仍用全量） */
    visibleSongs() {
      return this.songs.slice(0, this.shown)
    },
    hasMore() {
      return this.songs.length > this.visibleSongs.length
    },
    /**
     * 顶栏副题：多选/下载进度优先（待确认提示必须常显 —— toast 两秒就没了，
     * 用户还没反应过来要点哪儿，同曲目列表页 barSub 的做法）。
     */
    barSub() {
      const t = dlText(this.dl)
      if (t) return t
      if (this.multi) {
        if (this.isArmed('dl')) {
          // 数量前缀是本页特有信息，句式走 armRailText 统一模板（ui/arm.js）
          return '空间可能不足（需约 ' + this.estText + '）· ' + this.armRailText('下载', this.selIds.length)
        }
        return this.multiBarSub // 句式由 multiSelectMixin 统一（缺省 M = songs.length）
      }
      // 常态：灰色专辑名（名字在下面的大封面旁已有，但顶栏滚动后是唯一标识，留着）
      return clipText(this.album.name || '专辑', 22)
    },
    /**
     * 左栏（CSV「专辑详情」行）：返回 + 播放全部 + 多选 + 收藏。
     * 多选态按「只读列表」给：关闭 + 下一首播放 + 收藏到歌单 + 下载（专辑曲目没有删除概念）。
     * 离线视图只留返回（收藏是联网动作，播放/多选在离线时也没有可用动作）。
     */
    rail() {
      if (this.multi) {
        return [
          railBack(ICON.stop),
          railBtn('next', ICON.listplus),
          railBtn('topl', ICON.plplus),
          railBtn('dl', this.fgIcon('download'), false, '', this.isArmed('dl')),
        ]
      }
      if (this.offline) return [railBack()]
      return [
        railBack(),
        railBtn('playall', ICON.play, false, '', false, !this.songs.length),
        railBtn('multi', ICON.multi, false, '', false, !this.songs.length),
        railBtn('sub', ICON.star, this.subscribed === true, '', false, this.subBusy || !this.id),
      ]
    }
  },
  mounted() {
    this._dead = false
    const self = this
    // 参数通道按实例槽位 key 记账，取参必须用真实页名（写死逻辑页名只在兜底时命中）
    const p = paramsFor((this.$page && this.$page.$pageName) || 'album', this.$page ? this.$page.options : null)
    this.id = p.id || 0
    this.localOnly = !!p.local
    if (p.name) this.album.name = p.name
    // 下载活动订阅（顶栏副题显示进度）；页面会挂两遍 → 每实例各订各退
    this._dlOff = onDl(function (s) {
      self.syncDl(s)
    })
    this.syncDl(dlState())
    log('album', 'onLoad id=' + this.id + ' name=' + p.name)
    this.load()
  },
  beforeDestroy() {
    // armed / toast 的计时器由 ui/arm.js、ui/toast.js 的 beforeDestroy 自动清
    this._dead = true
    if (this._dlOff) offDl(this._dlOff)
    this._dlOff = null
  },
  methods: {
    async load() {
      const self = this
      if (!this.id) {
        this.hint = '缺少专辑 id'
        return
      }
      // 数据源二选一：有网 = 纯云端（不闪本地视图）；
      // 离线（系统 API global.isOnline()，见 net/status.js）= 直接本地索引，不发请求。
      // localOnly（从本地下载-专辑进入）= 在线也强制本地视图，只显示已下载曲目。
      if (this.localOnly || (await isOffline())) {
        await this.loadLocal()
        return
      }
      try {
        const r = await fetchAlbum(this.id)
        self.album = r.album
        self.artists = r.artists
        self.songs = r.songs
        self.shown = PAGE_SONG
        self.sub = self.meta
        self.hint = '专辑没有曲目'
        ensureCover({ id: 'al' + r.album.id, cover: r.album.cover }, function (cid, path) {
          if (path) self.cover = path
        }, BIG_COVER)
        log('album', '就绪 ' + r.album.name + ' 曲目=' + r.songs.length)
        self.loadSubscribed() // 收藏键的状态（拿不到就按未收藏显示）
      } catch (e) {
        // 请求失败（系统说在线也没拿到）→ 直接落本地
        await this.loadLocal()
        log('album', '网络失败，落本地索引：' + ((e && e.message) || e))
      }
    },
    /** 本地索引视图（离线）：只显示本地索引里该专辑的已下载曲目（按 碟/音轨号 排序） */
    async loadLocal() {
      const self = this
      let lv = null
      try {
        lv = await localAlbumView(this.id)
      } catch (e) {}
      if (lv) {
        self.offline = true
        self.album = lv.album
        self.artists = lv.artists
        self.songs = lv.songs
        self.shown = PAGE_SONG
        self.hint = '本地没有该专辑的曲目'
        ensureCover({ id: 'al' + lv.album.id, cover: lv.album.cover }, function (cid, path) {
          if (path) self.cover = path
        }, BIG_COVER)
        log('album', '本地索引视图 ' + lv.album.name + ' 曲目=' + lv.songs.length)
      } else {
        self.hint = '无网络，且本地没有该专辑的记录'
        log('album', '本地索引无记录 id=' + this.id)
      }
    },
    /** 「加载更多」文案（import 的 helper 模板里不能裸调，走 methods 暴露） */
    moreLabel(n, unit) {
      return moreText(n, unit)
    },
    /** 只加渲染行数；云端/本地数据早已全量在 songs 里 */
    loadMore() {
      if (!this.hasMore) return
      this.shown = Math.min(this.shown + PAGE_SONG, this.songs.length)
    },
    play(i) {
      // 渲染从 0 开始切片，行下标与 songs 下标一致；队列仍用**全量** songs
      player.playList(this.songs, i)
      go('player', {})
    },
    /* ---- 多选下载 ---- */
    /** 点行分派：多选态 = 勾选，否则点播 */
    onRow(i) {
      if (!this.multi) {
        this.play(i)
        return
      }
      const s = this.songs[i]
      if (s) {
        this.toggleSel(s.id) // 选择变化自动 disarm（ui/multi.js）
      }
    },
    /** 长按整行 → 歌曲详情页（与播放页点歌名等效）；多选态忽略（那时点行是勾选） */
    onHold(i) {
      if (this.multi) return
      const s = this.songs[i]
      if (!s || !s.id) return
      log('album', '长按 → 歌曲详情 id=' + s.id)
      go('songinfo', { id: s.id })
    },
    /* ---- 多选 ——状态机在 ui/multi.js，本页只给范围与计数口径 ---- */
    multiList() {
      return this.songs
    },
    onMultiEnter() {
      log('album', '进入多选 ' + this.album.name + ' 共 ' + this.songs.length + ' 首')
    },
    /**
     * 「下载」键：选中 →（空间预检：不足时两次点按确认）→ downloadSongs（用户下载通道，
     * 按设置里的下载音质）→ 退出多选 + toast；完成时再 toast 汇总（判 _dead）。
     */
    async doDownload() {
      if (!this.selIds.length) {
        this.showToast('未选中歌曲')
        return
      }
      const picked = selPicked(this.selIds, this.songs)
      if (!picked.length) return
      if (!this.isArmed('dl')) {
        this.showToast('检查空间...')
        const sp = await spaceCheck(picked)
        if (this._dead) return
        if (sp.tight) {
          // 空间可能不足：第一次点按只进入待确认（顶栏常显提示 + 按钮变实心红）。
          // 3 秒自动复位由 armMixin 管；estText 只在待确认态里被读，留旧值不可见
          this.arm('dl')
          this.estText = fmtSize(sp.est)
          log('album', '空间预检不足：需约 ' + fmtSize(sp.est) + ' / 可用 ' + fmtSize(sp.free))
          return
        }
      }
      this.disarm()
      const n = picked.length
      this.exitMulti()
      this.showToast(startText(n))
      log('album', '开始下载 ' + n + ' 首')
      const self = this
      downloadSongs(picked).then(function (r) {
        if (self._dead) return
        self.showToast(resultText(r))
        log('album', '下载结果 ' + JSON.stringify(r))
      })
    },
    /** 下载活动 → this.dl（签名判重：快照 ~400ms 一发，不判重就是持续重渲染，坑 16 同族） */
    syncDl(s) {
      const d = s || {}
      const sig = (d.active ? 1 : 0) + '|' + d.total + '|' + (d.done + d.failed + (d.cancelled || 0)) +
        '|' + (d.stopping ? 1 : 0) + '|' + d.pct
      if (sig === this._dlSig) return
      this._dlSig = sig
      this.dl = d
    },
    /* ---- 播放全部 / 收藏 ---- */
    /** 播放全部：整张专辑（songs 已是全量，不受渲染分片影响）设为队列，从第一首起播 */
    playAll() {
      if (!this.songs.length) {
        this.showToast('没有可播放的曲目')
        return
      }
      player.playList(this.songs.slice(), 0)
      log('album', '播放全部 ' + this.songs.length + ' 首')
      go('player', {})
    },
    /**
     * 收藏状态：只读接口（/api/album/detail/dynamic）问一次；拿不到就是 null（按未收藏显示）。
     * 只在在线视图里问 —— 离线时这页是本地索引视图，问了也会失败。
     */
    async loadSubscribed() {
      if (!this.id || this.offline) return
      const v = await albumSubscribed(this.id)
      if (this._dead) return
      this.subscribed = v
      log('album', '收藏状态 ' + (v === null ? '未知' : v) + ' id=' + this.id)
    },
    /** 收藏 / 取消收藏（乐观更新 + 失败回滚；请求期间 subBusy 禁用键） */
    async toggleSub() {
      if (this.subBusy || !this.id) return
      const want = this.subscribed !== true
      this.subBusy = true
      this.subscribed = want
      const r = await setAlbumSubscribed(this.id, want)
      this.subBusy = false
      if (this._dead) return
      if (r.ok) {
        this.showToast(want ? '已收藏专辑' : '已取消收藏')
        log('album', (want ? '收藏' : '取消收藏') + ' ' + this.id + ' ' + (this.album.name || ''))
        return
      }
      this.subscribed = !want
      this.showToast(r.needLogin ? '未登录，无法收藏' : '操作失败' + (r.message ? '：' + r.message : ''))
      log('album', '收藏失败 code=' + r.code + ' ' + (r.message || ''))
    },
    /* ---- 多选态的两颗只读动作键 ---- */
    /** 下一首播放：插到当前曲之后（player.insertNext），完成后退出多选 */
    doNext() {
      const picked = selPicked(this.selIds, this.songs)
      if (!picked.length) {
        this.showToast('未选中歌曲')
        return
      }
      const r = playNext(picked)
      log('album', '下一首播放 ' + picked.length + ' 首 ' + JSON.stringify(r))
      this.exitMulti()
      const t = playNextText(r)
      if (t) this.showToast(t)
    },
    /** 收藏到歌单：跳歌单选择页（pick 模式带一批 id） */
    doToPlaylist() {
      const picked = selPicked(this.selIds, this.songs)
      if (!picked.length) {
        this.showToast('未选中歌曲')
        return
      }
      const n = toPlaylist(picked)
      if (!n) {
        this.showToast('未选中歌曲')
        return
      }
      log('album', '收藏到歌单 ' + n + ' 首 → 选择页')
      this.exitMulti()
    },
    openArtist() {
      if (!this.artists.length) return
      go('artist', { id: this.artists[0].id, name: this.artists[0].name, local: this.offline ? 1 : 0 })
    },
    /* ---- 左栏（分派骨架见 ui/frame.js）---- */
    onBack() {
      // 多选态：返回键是「退出多选」（图标 ×，见 rail()），不退页面
      if (this.exitMultiIfAny()) return
      this.$page.finish()
    },
    onRailKey(key) {
      if (key === 'multi') this.enterMulti()
      else if (key === 'dl') this.doDownload()
      else if (key === 'playall') this.playAll()
      else if (key === 'sub') this.toggleSub()
      else if (key === 'next') this.doNext()
      else if (key === 'topl') this.doToPlaylist()
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.ab-scroll {
  flex: 1;
}
.ab-hero {
  flex-direction: row;
  align-items: center;
  padding: 3vh 4vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.ab-coverbox {
  width: 66vh;
  height: 66vh;
  border-radius: @radius;
  background-color: @panel-2;
  overflow: hidden;
  flex: none;
}
.ab-cover {
  width: 66vh;
  height: 66vh;
}
.ab-hinfo {
  flex: 1;
  flex-direction: column;
  margin-left: 4vh;
  min-width: 0;
}
.ab-hname {
  font-size: @fs-title;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.ab-line {
  flex-direction: row;
  align-items: center;
}
.ab-artist {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
  margin-top: 1.2vh;
  lines: 1;
  text-overflow: ellipsis;
}
.ab-hmeta {
  font-size: @fs-mute;
  color: @text-3;
  margin-top: 1.4vh;
}
/* 多选态顶栏右侧的「全选 / 全不选」：占满顶栏高度当点击区（同曲目列表页 .lst-all） */
.ab-all {
  height: @topbar-h;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding-left: 5vh;
  padding-right: 5vh;
}
.ab-all-t {
  font-size: @fs-dim;
  color: @accent-2;
}
.ab-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.ab-more-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
.ab-bottom {
  height: 4vh;
}
</style>
