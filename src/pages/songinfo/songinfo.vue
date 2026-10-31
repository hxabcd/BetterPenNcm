<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="歌曲信息" :sub="sub" />
    <div class="si-body">
      <div class="si-coverbox">
        <image v-if="cover" class="si-cover" :src="cover" resize="cover" />
      </div>
      <div class="si-info">
        <div class="si-line">
          <text class="si-name">{{ info.song.name || '—' }}</text>
          <text class="si-alias" v-if="aliasText">{{ aliasText }}</text>
          <text class="si-vip" v-if="isVip">VIP</text>
        </div>
        <!-- 歌手：一人一个 chip，点谁进谁（无论几个歌手都统一 chip） -->
        <div class="si-line">
          <text class="si-k">歌手</text>
          <div class="si-ars">
            <div class="si-ar" v-for="(a, i) in info.artists" :key="i" @click="openArtistAt(a)">
              <text class="si-ar-t" :style="{ color: accent.light }">{{ a.name || '未知歌手' }}</text>
            </div>
            <text class="si-v" v-if="!info.artists.length">—</text>
          </div>
        </div>
        <div class="si-line" @click="openAlbum">
          <text class="si-k">专辑</text>
          <text class="si-v-link" :style="{ color: accent.light }">{{ info.album.name || '—' }} ›</text>
        </div>
        <div class="si-line">
          <text class="si-k">时长</text>
          <text class="si-v">{{ dur }}</text>
          <text class="si-k si-k2">发行</text>
          <text class="si-v">{{ pub }}</text>
        </div>
        <div class="si-line">
          <text class="si-k">音轨</text>
          <text class="si-v">{{ trackText }}</text>
          <text class="si-k si-k2">热度</text>
          <text class="si-v">{{ pop }}</text>
        </div>
      </div>
    </div>

    <!-- 左栏「更多」：收藏到歌单 / 下一首播放（CSV 的「歌曲详情」行）。
         播放与下载是左栏另两颗直给键，不在这里。 -->
    <context-sheet
      v-if="panel"
      title="更多"
      :options="moreOptions"
      mark-text=""
      @pick="pickMore"
      @close="closePanel"
    />
    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 歌曲详细信息页（点播放页顶部「歌名·歌手」进入）
 *
 * 数据来自 /api/v3/song/detail（见 utils/ncm/api.js 的 fetchSongInfo，PC 端已实测）。
 * 歌手行统一铺 chip：**一个歌手一个可点区，点谁进谁**。
 * 专辑行是整行链接，跳专辑页。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import ContextSheet from '../../components/ContextSheet.vue'
import HintToast from '../../components/HintToast.vue'
import { go, paramsFor } from '../../utils/nav.js'
import { fetchSongInfo } from '../../utils/ncm/api.js'
import { localSongInfo } from '../../utils/player/localmeta.js'
import { isOffline } from '../../utils/net/status.js'
import { ensureCover, BIG_COVER } from '../../utils/cover.js'
import { fmtDur, fmtDate } from '../../utils/format.js'
import { railBack, railBtn, ICON } from '../../utils/rail.js'
import { player } from '../../utils/player/player.js'
import { downloadSongs } from '../../utils/player/download.js'
import { toPlaylist, playNext, playNextText } from '../../utils/songact.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'

export default {
  name: 'songinfo',
  mixins: [accentMixin, toastMixin, pageFrameMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'context-sheet': ContextSheet,
    'hint-toast': HintToast
  },
  data() {
    return {
      ICON: ICON,
      id: 0,
      sub: '',
      panel: '', // '' | 'more'
      busy: false,
      info: {
        song: { name: '', durationMs: 0, fee: 0, aliases: [] },
        artists: [],
        album: { id: 0, name: '', cover: '' },
        publishTime: 0,
        trackNo: 0,
        disc: '',
        popularity: 0
      },
      cover: ''
    }
  },
  computed: {
    aliasText() {
      const a = this.info.song.aliases
      if (!a || !a.length) return ''
      return '(' + a.join('/') + ')'
    },
    isVip() {
      const f = this.info.song.fee
      return f === 1 || f === 4
    },
    dur() {
      return fmtDur(this.info.song.durationMs)
    },
    pub() {
      return fmtDate(this.info.publishTime)
    },
    trackText() {
      const n = this.info.trackNo
      if (!n) return '—'
      const d = this.info.disc
      return '第 ' + n + ' 首' + (d && String(d) !== '1' ? ' · 碟 ' + d : '')
    },
    pop() {
      const p = this.info.popularity
      return p ? String(Math.round(p)) : '—'
    },
    /** 本页曲目对象（已归一化，可直接喂播放器 / 下载 / 加歌单）；没加载完时 id 为 0 */
    song() {
      const s = this.info.song || {}
      return s.id ? s : null
    },
    /** 「更多」面板：CSV 的「歌曲详情」行只有这两项 */
    moreOptions() {
      return [
        { key: 'topl', label: '收藏到歌单', icon: ICON.plplus },
        { key: 'next', label: '下一首播放', icon: ICON.listplus }
      ]
    },
    /**
     * 左栏（CSV「歌曲详情」行）：返回 + 更多（收藏到歌单、下一首播放）+ 播放 + 下载。
     * 数组顺序 = 栏底组自上而下，所以 下载 贴底（76.67~96.67vh）、播放 在它上面、更多 最高。
     * 没有曲目（id 还没到）时三颗键置灰。
     */
    rail() {
      const has = !!this.song
      return [
        railBack(),
        railBtn('more', ICON.more, this.panel === 'more', '', false, !has),
        railBtn('play', ICON.play, false, '', false, !has),
        railBtn('dl', ICON.download, this.busy, '', false, !has)
      ]
    }
  },
  mounted() {
    this._dead = false
    // 参数通道按实例槽位 key 记账，取参必须用真实页名（写死逻辑页名只在兜底时命中）
    const p = paramsFor((this.$page && this.$page.$pageName) || 'songinfo', this.$page ? this.$page.options : null)
    this.openSong(p)
  },
  beforeDestroy() {
    this._dead = true
  },
  methods: {
    /** 加载目标歌曲；同一首（页面挂两遍）直接跳过，保证挂载幂等。 */
    openSong(p) {
      const id = Number(p && p.id) || 0
      if (id === this.id && this._loadSeq) return
      this.id = id
      this.sub = ''
      this.cover = ''
      this.panel = ''
      this.info = {
        song: { name: '', durationMs: 0, fee: 0, aliases: [] },
        artists: [],
        album: { id: 0, name: '', cover: '' },
        publishTime: 0,
        trackNo: 0,
        disc: '',
        popularity: 0
      }
      const seq = (this._loadSeq || 0) + 1
      this._loadSeq = seq
      log('songinfo', 'onLoad id=' + this.id)
      this.load(id, seq)
    },
    async load(id, seq) {
      const self = this
      if (!this.id) {
        this.sub = '缺少歌曲 id'
        return
      }
      // 数据源二选一：有网 = 纯云端（不闪本地视图）；
      // 离线（系统 API global.isOnline()，见 net/status.js）= 直接本地索引，不发请求
      if (await isOffline()) {
        if (this._dead || seq !== this._loadSeq) return
        await this.loadLocal(id, seq)
        return
      }
      try {
        const r = await fetchSongInfo(id)
        if (self._dead || seq !== self._loadSeq) return
        self.info = r
        self.sub = r.album.name || ''
        ensureCover({ id: 'al' + r.album.id, cover: r.album.cover }, function (cid, path) {
          if (path && !self._dead && seq === self._loadSeq) self.cover = path
        }, BIG_COVER)
        log('songinfo', '就绪 ' + r.song.name + ' 歌手数=' + r.artists.length)
      } catch (e) {
        if (self._dead || seq !== self._loadSeq) return
        // 请求失败（系统说在线也没拿到）→ 直接落本地
        await this.loadLocal(id, seq)
        log('songinfo', '网络失败，落本地索引：' + ((e && e.message) || e))
      }
    },
    /** 本地索引视图：已下载的歌详情照出（歌手 chip / 专辑链接带 id，可继续跳转） */
    async loadLocal(id, seq) {
      const self = this
      let loc = null
      try {
        loc = await localSongInfo(id)
      } catch (e) {}
      if (self._dead || seq !== self._loadSeq) return
      if (loc) {
        self.info = loc
        self.sub = (loc.album.name || '歌曲信息') + '（本地）'
        ensureCover({ id: 'al' + loc.album.id, cover: loc.album.cover }, function (cid, path) {
          if (path && !self._dead && seq === self._loadSeq) self.cover = path
        }, BIG_COVER)
        log('songinfo', '本地索引视图 ' + loc.song.name)
      } else {
        self.sub = '无网络，且本地没有这首歌的记录'
        log('songinfo', '本地索引无记录 id=' + id)
      }
    },
    /** 打开指定歌手页（chip 直接把这一个歌手传进来） */
    openArtistAt(ar) {
      if (!ar || !ar.id) return
      go('artist', { id: ar.id, name: ar.name })
    },
    openAlbum() {
      const al = this.info.album
      if (!al || !al.id) return
      go('album', { id: al.id, name: al.name })
    },
    /* ---- 左栏（分派骨架见 ui/frame.js：onBack / onRailKey 两个钩子）---- */
    onBack() {
      // 浮窗开着先收浮窗（同歌单详情页），别让一次返回跳过两层
      if (this.panel) {
        this.panel = ''
        return
      }
      this.$page.finish()
    },
    onRailKey(key) {
      if (key === 'more') {
        this.panel = this.panel === 'more' ? '' : 'more'
        return
      }
      if (key === 'play') {
        this.doPlay()
        return
      }
      if (key === 'dl') this.doDownload()
    },
    closePanel() {
      this.panel = ''
    },
    pickMore(key) {
      this.panel = ''
      const s = this.song
      if (!s) return
      if (key === 'topl') {
        const n = toPlaylist([s])
        if (n) log('songinfo', '收藏到歌单 → 选择页 id=' + s.id)
        return
      }
      if (key === 'next') {
        const r = playNext([s])
        log('songinfo', '下一首播放 ' + JSON.stringify(r))
        this.showToast(playNextText(r))
      }
    },
    /**
     * 播放：把这一首设为播放队列并起播（队列只有它一首 —— 与「点列表里的某一首」不同，
     * 这里没有所属列表的上下文，给个单曲队列最不容易误导）。
     */
    doPlay() {
      const s = this.song
      if (!s) {
        this.showToast('歌曲信息还没加载完')
        return
      }
      player.playList([s], 0)
      log('songinfo', '播放 ' + s.id + ' ' + (s.name || ''))
      go('player', {})
    },
    /** 下载：按设置里的下载音质下到本地（用户下载通道，与列表页多选下载同一实现） */
    async doDownload() {
      const s = this.song
      if (!s) {
        this.showToast('歌曲信息还没加载完')
        return
      }
      if (this.busy) return
      this.busy = true
      this.showToast('开始下载：' + (s.name || ''), 60000)
      const r = await downloadSongs([s])
      this.busy = false
      if (this._dead) return
      this.hideToast()
      if (r.cancelled) this.showToast('下载已停止')
      else if (r.ok > 0) this.showToast('已下载：' + (s.name || ''))
      else if (r.skipped > 0 && !r.failed) this.showToast('本地已下载')
      else if (r.failed > 0) this.showToast('下载失败：' + (r.error || '未知错误'))
      else this.showToast('没有可下载的内容')
      log('songinfo', '下载结果 ' + JSON.stringify(r))
    },
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.si-body {
  flex: 1;
  flex-direction: row;
  align-items: center; /* 不写的话封面盒（固定 58vh 高）贴顶，而文字列是纵向居中的 → 左右不齐 */
  padding: 3vh 4vh;
}
.si-coverbox {
  width: 58vh;
  height: 58vh;
  border-radius: @radius;
  background-color: @panel-2;
  overflow: hidden;
  flex: none;
}
.si-cover {
  width: 58vh;
  height: 58vh;
}
.si-info {
  flex: 1;
  flex-direction: column;
  justify-content: center;
  margin-left: 5vh;
  min-width: 0;
}
.si-line {
  flex-direction: row;
  align-items: center;
  margin-bottom: 1.6vh;
}
.si-name {
  font-size: @fs-title;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.si-alias {
  font-size: @fs-dim;
  color: @text-3;
  margin-left: 1.6vh;
  lines: 1;
}
.si-vip {
  font-size: @fs-mute;
  color: @warn;
  margin-left: 1.6vh;
}
.si-k {
  width: 16vh; /* 2 个汉字 ≈ 33.6px，给到 38.4px 才不折行 */
  flex: none;
  font-size: @fs-dim;
  color: @text-3;
}
.si-k2 {
  margin-left: 6vh;
}
.si-v {
  font-size: @fs-dim;
  color: @text-2;
}
.si-v-link {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
  lines: 1;
  text-overflow: ellipsis;
}
/* 歌手 chip 行：一人一个可点区（尺寸对齐播放选项页 po-chip，屏幕物理高仅 2.5cm，点击区给大） */
.si-ars {
  flex-direction: row;
  align-items: center;
  flex-wrap: wrap; /* 歌手多时换行；平台若不支持则退化成单行裁切，不影响 ≤3 人的常见情况 */
}
.si-ar {
  height: 14vh;
  flex: none; /* 歌手多时不让 chip 被压扁，宁可换行/裁切 */
  border-radius: 1.8vh;
  background-color: @panel-2;
  align-items: center;
  justify-content: center;
  padding-left: 2.4vh;
  padding-right: 2.4vh;
  margin-right: 1.6vh;
}
.si-ar-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
</style>
