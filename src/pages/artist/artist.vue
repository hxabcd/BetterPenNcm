<template>
  <page-shell :rail="rail" @rail="onRail">
    <!-- 顶栏：标题固定「歌手详情」，副题灰色显示歌手名；
         专辑数/歌曲数在下面的头部已经给了，不重复 -->
    <page-topbar title="歌手详情" :sub="barSub" />
    <scroller class="ar-scroll">
      <!-- 头部：大圆头像 + 名字 + 别名 + 统计 -->
      <div class="ar-hero">
        <div class="ar-avbox">
          <image v-if="avatar" class="ar-av" :src="avatar" resize="cover" />
        </div>
        <div class="ar-hinfo">
          <text class="ar-hname">{{ name }}</text>
          <text class="ar-halias" v-if="aliasText">{{ aliasText }}</text>
          <text class="ar-hmeta">{{ meta }}</text>
        </div>
      </div>

      <!-- 热门曲目（10 首，更多 → 完整列表，那里可按热度/时间切）；离线 = 本地索引里该歌手的全部曲目 -->
      <div class="ar-sect">
        <text class="ar-st">{{ offline ? '本地曲目' : '热门曲目' }}</text>
        <div class="ar-fill"></div>
        <!-- 「更多 ›」胶囊：底色走 LESS 的 @panel-2、文字色由内层 text 内联主题色。 -->
        <div class="ar-more" @click="moreSongs">
          <text class="ar-more-t" :style="{ color: accent.light }">{{ offline ? '' : '更多 ›' }}</text>
        </div>
      </div>
      <song-row
        v-for="(s, i) in songList"
        :key="s.id"
        :song="s"
        :index="i"
        @select="onRow(i)"
        @hold="onHold(i)"
      />
      <empty-hint v-if="!hotSongs.length" :text="hint" />
      <!-- 离线本地曲目可能上百首（该歌手全部已下载），与曲目列表页同一分片口径 -->
      <div class="ar-more2" v-if="hasMoreSongs" @click="loadMoreSongs">
        <text class="ar-more2-t" :style="{ color: accent.light }">{{
          moreLabel(hotSongs.length - songList.length, '首')
        }}</text>
      </div>

      <!-- 专辑（横向滑动，更多 → 完整专辑列表）；离线 = 本地索引里该歌手的专辑 -->
      <div class="ar-sect">
        <text class="ar-st">专辑</text>
        <div class="ar-fill"></div>
        <div class="ar-more" @click="moreAlbums">
          <text class="ar-more-t" :style="{ color: accent.light }">{{ offline ? '' : '更多 ›' }}</text>
        </div>
      </div>
      <scroller class="ar-albums" scroll-direction="horizontal" :show-scrollbar="false">
        <playlist-card
          v-for="a in albumCards"
          :key="a.id"
          :item="a"
          :cover-size="120"
          @select="openAlbum(a)"
        />
      </scroller>
      <empty-hint v-if="!albumCards.length" :text="albumHint" />
      <div class="ar-bottom"></div>
    </scroller>

    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 歌手页（从歌曲信息页的「歌手」进入）
 *
 * 内容：大圆头像 + 名字 + 别名 + 专辑数/歌曲数；热门曲目 10 首（更多 → 完整列表）；
 * 专辑横向滑动卡片（更多 → 完整专辑列表，复用歌单列表页 source=artist）。
 *
 * 接口（PC 端实测）：
 *   /api/artist/{id}                      歌手信息（hotSongs 固定 50，offset 无效，故不用它取曲目）
 *   /api/v1/artist/songs?order=hot&limit=10  热门曲目（服务端排序，分页有效）
 *   /api/artist/albums/{id}?limit=10       专辑（分页有效）
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import EmptyHint from '../../components/EmptyHint.vue'
import SongRow from '../../components/SongRow.vue'
import PlaylistCard from '../../components/PlaylistCard.vue'
import HintToast from '../../components/HintToast.vue'
import { railBack, railBtn, ICON } from '../../utils/rail.js'
import { go, paramsFor } from '../../utils/nav.js'
import { player } from '../../utils/player/player.js'
import { fetchArtist, fetchArtistSongs, fetchArtistAlbums } from '../../utils/ncm/api.js'
import { setArtistFollowed } from '../../utils/ncm/subscribe.js'
import { localArtistView } from '../../utils/player/localmeta.js'
import { isOffline } from '../../utils/net/status.js'
import { ensureCover, BIG_COVER } from '../../utils/cover.js'
import { resolveArtistPortrait, rememberArtistPortrait, portraitId } from '../../utils/artistavatar.js'
import { clipText } from '../../utils/format.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'
import { PAGE_SONG, moreText } from '../../utils/ui/paging.js'

const HOT_N = 10 // 页面上先给 10 首，其余去完整列表
const ALBUM_N = 10

export default {
  name: 'artist',
  mixins: [accentMixin, toastMixin, pageFrameMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'song-row': SongRow,
    'playlist-card': PlaylistCard,
    'hint-toast': HintToast,
    'empty-hint': EmptyHint
  },
  data() {
    return {
      id: 0,
      name: '',
      aliases: [],
      avatar: '',
      albumSize: 0,
      musicSize: 0,
      hotSongs: [],
      shown: PAGE_SONG, // 离线本地曲目的渲染分片（在线热门固定 10 首，用不到）
      albums: [],
      offline: false, // 离线视图：数据全部来自本地索引（只含已下载的曲目/专辑）
      localOnly: false, // 从本地下载-歌手进入：在线也强制本地视图
      hint: '加载中...',
      albumHint: '加载中...',
      /* ---- 关注（CSV「歌手详情」行的唯一上下文键）----
         followed：true/false；null = 不知道（未登录或接口没下发 followed 字段），按未关注显示。
         followBusy：防连点（一次请求在飞时忽略再次点击）。 */
      followed: null,
      followBusy: false
    }
  },
  computed: {
    aliasText() {
      return this.aliases.length ? this.aliases.join(' / ') : ''
    },
    meta() {
      return this.albumSize + ' 张专辑 · ' + this.musicSize + ' 首歌'
    },
    /** 渲染的曲目：在线热门只有 10 首；离线本地全量在内存，只铺前 shown 行 */
    songList() {
      return this.offline ? this.hotSongs.slice(0, this.shown) : this.hotSongs
    },
    hasMoreSongs() {
      return this.offline && this.hotSongs.length > this.songList.length
    },
    /** 专辑按 PlaylistCard 的通用形状映射；id 加 'al' 前缀避免与歌曲 id 撞封面缓存 */
    albumCards() {
      const out = []
      for (let i = 0; i < this.albums.length; i++) {
        const a = this.albums[i]
        out.push({ id: 'al' + a.id, albumId: a.id, name: a.name, count: a.size, cover: a.cover })
      }
      return out
    },
    /** 顶栏副题：常态是灰色歌手名（名字在下面的大头像旁已有，但顶栏滚动后是唯一标识，留着） */
    barSub() {
      return clipText(this.name || '歌手', 22) + (this.offline ? '（本地）' : '')
    },
    /**
     * 左栏（CSV「歌手详情」行）：返回 + 关注。
     * 逐首操作（下载等）不在这页 —— 热门曲目只有 10 首，要批量处理走「更多 →」进完整曲目列表。
     * 离线 / 没拿到 id 时只留返回（关注是联网动作，离线点了必然失败）。
     *
     * 关注键是**双态**：未关注 user-round-plus、已关注 user-round-minus（同时高亮）。
     * 两态换图标而不是只换高亮：高亮只说明「键被按下过」，读不出当前状态；
     * 已关注态取减号而不是对勾 —— 这是开关不是状态灯，图标该说「点了会怎样」（取关）。
     */
    rail() {
      if (this.offline || !this.id) return [railBack()]
      const on = this.followed === true
      return [railBack(), railBtn('follow', on ? ICON.followed : ICON.follow, on, '', false, this.followBusy)]
    }
  },
  mounted() {
    this._dead = false
    // 参数通道按实例槽位 key 记账，取参必须用真实页名（写死逻辑页名只在兜底时命中）
    const p = paramsFor((this.$page && this.$page.$pageName) || 'artist', this.$page ? this.$page.options : null)
    this.openArtist(p)
  },
  beforeDestroy() {
    // toast 计时器由 ui/toast.js 的 beforeDestroy 自动清
    this._dead = true
  },
  methods: {
    /** 按导航参数加载歌手；同一歌手（页面挂两遍）直接跳过，保证挂载幂等。 */
    openArtist(p) {
      const id = Number(p && p.id) || 0
      const local = !!(p && p.local)
      if (id === this.id && this._loadSeq && local === this.localOnly) return
      const seq = (this._loadSeq || 0) + 1
      this._loadSeq = seq
      this.id = id
      this.name = (p && p.name) || ''
      this.localOnly = local
      this.followed = null
      this.followBusy = false
      this.aliases = []
      this.avatar = ''
      this.albumSize = 0
      this.musicSize = 0
      this.hotSongs = []
      this.shown = PAGE_SONG
      this.albums = []
      this.offline = false
      this.sub = ''
      this.hint = '加载中...'
      this.albumHint = '加载中...'
      log('artist', 'onLoad id=' + this.id + ' name=' + this.name)
      this.load(id, seq)
    },
    async load(id, seq) {
      const self = this
      if (!this.id) {
        this.hint = '缺少歌手 id'
        return
      }
      // 数据源二选一：有网 = 纯云端（不闪本地视图）；
      // 离线（系统 API global.isOnline()，见 net/status.js）= 直接本地索引，不发请求。
      // localOnly（从本地下载-歌手进入）= 在线也强制本地视图，只显示已下载曲目。
      if (this.localOnly || (await isOffline())) {
        if (this._dead || seq !== this._loadSeq) return
        await this.loadLocal(id, seq)
        return
      }
      // 三段各自独立，一段失败不影响其它；全挂说明断网 → 落本地索引
      let fails = 0
      try {
        const a = await fetchArtist(id)
        if (self._dead || seq !== self._loadSeq) return
        self.name = a.name || self.name
        self.aliases = a.aliases || []
        self.albumSize = a.albumSize
        self.musicSize = a.musicSize
        self.followed = a.followed // null = 未登录 / 接口没下发（按未关注显示）
        self.sub = self.meta
        if (a.cover) {
          const url = await rememberArtistPortrait(a.id || id, a.name || self.name, a.cover)
          if (url) self.applyPortrait(a.id || id, seq, url)
          else self.applyLocalFallbackAvatar(id, seq)
        } else {
          self.applyLocalFallbackAvatar(id, seq)
        }
        log('artist', '歌手信息就绪 ' + a.name + ' 专辑=' + a.albumSize + ' 曲目=' + a.musicSize)
      } catch (e) {
        if (self._dead || seq !== self._loadSeq) return
        fails++
        log('artist', '歌手信息失败 ' + ((e && e.message) || e))
        // 歌手信息失败但曲目/专辑成功时不会落本地视图；头像单独用本地代表专辑封面兜底
        self.applyLocalFallbackAvatar(id, seq)
      }
      try {
        const r = await fetchArtistSongs(id, 'hot', 0, HOT_N)
        if (self._dead || seq !== self._loadSeq) return
        self.hotSongs = r.songs || []
        self.hint = '没有曲目'
        log('artist', '热门曲目 ' + self.hotSongs.length + '/' + r.total)
      } catch (e) {
        if (self._dead || seq !== self._loadSeq) return
        fails++
        self.hint = '曲目加载失败'
        log('artist', '曲目失败 ' + ((e && e.message) || e))
      }
      try {
        const r = await fetchArtistAlbums(id, 0, ALBUM_N)
        if (self._dead || seq !== self._loadSeq) return
        self.albums = r.albums || []
        self.albumHint = '没有专辑'
        log('artist', '专辑 ' + self.albums.length)
      } catch (e) {
        if (self._dead || seq !== self._loadSeq) return
        fails++
        self.albumHint = '专辑加载失败'
        log('artist', '专辑失败 ' + ((e && e.message) || e))
      }
      if (fails === 3) await this.loadLocal(id, seq) // 三段全挂（断网）→ 本地索引兜底
    },
    /** 本地索引视图（离线）：只显示本地索引里该歌手的已下载曲目与专辑 */
    async loadLocal(id, seq) {
      const self = this
      let lv = null
      try {
        lv = await localArtistView(id)
      } catch (e) {}
      if (self._dead || seq !== self._loadSeq) return
      if (lv && lv.songs.length) {
        self.offline = true
        if (!self.name) self.name = lv.name
        self.albumSize = lv.albums.length
        self.musicSize = lv.songs.length
        self.hotSongs = lv.songs
        self.shown = PAGE_SONG
        self.albums = lv.albums
        self.hint = '本地没有该歌手的曲目'
        self.albumHint = '本地没有该歌手的专辑'
        // 头像：真头像（已缓存/在线轻量接口）优先；否则代表专辑封面
        // （下载完成时已预热 al<albumId>@200，离线也能命中）
        resolveArtistPortrait(id, BIG_COVER, true).then(function (url) {
          if (self._dead || seq !== self._loadSeq) return
          if (url) {
            self.avatar = url
            return
          }
          self.applyFallbackCover(lv.cover, lv.coverAlbumId, id, seq)
        }).catch(function () {})
        log('artist', '本地索引视图 ' + lv.songs.length + ' 首 / ' + lv.albums.length + ' 张')
      } else {
        self.hint = '无网络，且本地没有该歌手的记录'
        self.albumHint = ''
        log('artist', '本地索引无记录 id=' + this.id)
      }
    },
    /** 在线歌手信息拿到的真头像：下载大图；失败时退到本地代表专辑封面 */
    applyPortrait(id, seq, url) {
      const self = this
      ensureCover({ id: portraitId(id), cover: url }, function (cid, path) {
        if (!path) {
          self.applyLocalFallbackAvatar(id, seq)
          return
        }
        if (!self._dead && seq === self._loadSeq) self.avatar = path
      }, BIG_COVER)
    },
    /** 代表专辑封面（与本地下载-歌手列表同一张）：缓存键 al<albumId>，下载时已预热 */
    applyFallbackCover(cover, albumId, id, seq) {
      if (!cover) return
      const self = this
      const key = albumId ? 'al' + albumId : 'arf' + id
      ensureCover({ id: key, cover: cover }, function (cid, path) {
        if (path && !self._dead && seq === self._loadSeq && !self.avatar) self.avatar = path
      }, BIG_COVER)
    },
    /** 在线歌手信息不可用/无头像时，从本地索引取同一张代表专辑封面兜底 */
    async applyLocalFallbackAvatar(id, seq) {
      let lv = null
      try {
        lv = await localArtistView(id)
      } catch (e) {}
      if (this._dead || seq !== this._loadSeq) return
      if (lv) this.applyFallbackCover(lv.cover, lv.coverAlbumId, id, seq)
    },
    play(i) {
      // 渲染从 0 开始切片，行下标与 hotSongs 一致；队列仍用**全量**（离线 = 全部本地曲目）
      player.playList(this.hotSongs, i)
      go('player', {})
    },
    /** 「加载更多」文案（import 的 helper 模板里不能裸调，走 methods 暴露） */
    moreLabel(n, unit) {
      return moreText(n, unit)
    },
    loadMoreSongs() {
      if (!this.hasMoreSongs) return
      this.shown = Math.min(this.shown + PAGE_SONG, this.hotSongs.length)
    },
    /* ---- 行 / 热曲 ---- */
    onRow(i) {
      this.play(i)
    },
    /** 长按整行 → 歌曲详情页（与播放页点歌名等效） */
    onHold(i) {
      const s = this.songList[i]
      if (!s || !s.id) return
      log('artist', '长按 → 歌曲详情 id=' + s.id)
      go('songinfo', { id: s.id })
    },
    moreSongs() {
      if (this.offline) return // 离线视图已是本地全部曲目，没有「更多」
      go('list', { kind: 'artistsongs', id: this.id, name: this.name })
    },
    moreAlbums() {
      if (this.offline) return
      go('playlists', { source: 'artist', id: this.id, name: this.name })
    },
    openAlbum(card) {
      // 本地视图里的专辑也强制本地专辑页，避免在线时跳回远端全量
      go('album', { id: card.albumId, name: card.name, local: this.offline ? 1 : 0 })
    },
    /* ---- 左栏（分派骨架见 ui/frame.js）---- */
    onBack() {
      this.$page.finish()
    },
    onRailKey(key) {
      if (key === 'follow') this.toggleFollow()
    },
    /**
     * 关注 / 取消关注（两次点击才切换，不是二次确认 —— 关注是可逆的轻操作）：
     * 乐观更新按钮高亮，服务端非 200 就回滚并提示；请求期间 followBusy 禁用键（防连点）。
     */
    async toggleFollow() {
      if (this.followBusy || !this.id) return
      const want = this.followed !== true
      this.followBusy = true
      this.followed = want
      const r = await setArtistFollowed(this.id, want)
      this.followBusy = false
      if (this._dead) return
      if (r.ok) {
        this.showToast(want ? '已关注' : '已取消关注')
        log('artist', (want ? '关注' : '取消关注') + ' ' + this.id + ' ' + this.name)
        return
      }
      this.followed = !want
      this.showToast(r.needLogin ? '未登录，无法关注' : '操作失败' + (r.message ? '：' + r.message : ''))
      log('artist', '关注失败 code=' + r.code + ' ' + (r.message || ''))
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.ar-scroll {
  flex: 1;
}
.ar-hero {
  flex-direction: row;
  align-items: center;
  padding: 3vh 4vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.ar-avbox {
  width: 60vh;
  height: 60vh;
  border-radius: 30vh; /* 60vh 见方 → 正圆；平台不认 50% */
  background-color: @panel-2;
  overflow: hidden;
  flex: none;
}
.ar-av {
  width: 60vh;
  height: 60vh;
}
.ar-hinfo {
  flex: 1;
  flex-direction: column;
  margin-left: 4vh;
  min-width: 0;
}
.ar-hname {
  font-size: @fs-title;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.ar-halias {
  font-size: @fs-mute;
  color: @text-3;
  margin-top: 0.8vh;
  lines: 1;
}
.ar-hmeta {
  font-size: @fs-dim;
  color: @text-2;
  margin-top: 1.2vh;
}
/* 区块标题行 */
.ar-sect {
  flex-direction: row;
  align-items: center;
  padding: 3vh 3vh 2vh 3vh;
}
.ar-st {
  font-size: @fs-strong;
  font-weight: bold;
  color: @text;
}
.ar-fill {
  flex: 1;
}
.ar-more {
  padding-top: 1.6vh;
  padding-bottom: 1.6vh;
  padding-left: 3vh;
  padding-right: 3vh;
  border-radius: 50vh;
  background-color: @panel-2;
}
.ar-more-t {
  font-size: @fs-mute;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
/* 离线本地曲目的「加载更多」行（18vh 居中，与其它列表页一致） */
.ar-more2 {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.ar-more2-t {
  font-size: @fs-dim;
  color: @accent-2;
}
/* 专辑横向滑动：高度 = 卡片高 36vh + 余量 */
.ar-albums {
  height: 40vh;
  padding-left: 3vh;
}
.ar-bottom {
  height: 4vh;
}
</style>
