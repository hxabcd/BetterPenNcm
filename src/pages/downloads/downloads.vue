<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="本地下载" :sub="barSub" />

    <!-- 同主页的横向卡片流：歌单 / 歌手 / 专辑。
         三张卡都是 scroller 的直接子节点（不包 wrapper，理由同首页的 .idx-row）。 -->
    <scroller class="dlo-row" scroll-direction="horizontal" :show-scrollbar="false">
      <div class="dlo-card dlo-pl" @click="openPl">
        <image class="dlo-ico" :src="cico('dlpl')" />
        <div class="dlo-fill"></div>
        <text class="dlo-ct">歌单</text>
        <text class="dlo-sub">{{ plText }}</text>
      </div>
      <div class="dlo-card dlo-ar" @click="openAr">
        <image class="dlo-ico" :src="cico('dlar')" />
        <div class="dlo-fill"></div>
        <text class="dlo-ct">歌手</text>
        <text class="dlo-sub">{{ arText }}</text>
      </div>
      <div class="dlo-card dlo-al" @click="openAl">
        <image class="dlo-ico" :src="cico('dlal')" />
        <div class="dlo-fill"></div>
        <text class="dlo-ct">专辑</text>
        <text class="dlo-sub">{{ alText }}</text>
      </div>
    </scroller>
    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 本地下载（总览页）—— 从首页「本地下载」卡进入。
 *
 * 结构 = 同主页的横向卡片流：歌单 / 歌手 / 专辑。
 *   - 歌单：已添加到本地索引的歌单（索引页还有「全部下载」「单曲下载」「遗留歌曲」）；
 *   - 歌手 / 专辑：已下载歌曲的本地索引聚合（离线可用）。
 *
 * 数据源：
 *   - 歌单数量 = player/locallists.js 的 indexedCount()
 *   - 歌手/专辑数量 = player/localmeta.js 的 localStats()
 *   - 总曲目/体积 = player/cache.js 的 stats()（文件系统为真相）
 * 删除/多选不在总览页：进入具体列表后操作（旧的单页下载列表已拆成
 * 「全部下载 / 单曲下载 / 遗留歌曲 / 歌单内歌曲」四类）。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import HintToast from '../../components/HintToast.vue'
import { railBack, railBtn, ICON } from '../../utils/rail.js'
import { go } from '../../utils/nav.js'
import { stats, freeBytes, listSongs, putMeta } from '../../utils/player/cache.js'
import { localStats, loadIndex, indexOf, saveSongExtras } from '../../utils/player/localmeta.js'
import { indexedCount } from '../../utils/player/locallists.js'
import { dlState, onDl, offDl } from '../../utils/player/download.js'
import { dlText } from '../../utils/multidl.js'
import { fmtSize } from '../../utils/format.js'
import { isOffline } from '../../utils/net/status.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { aIcon } from '../../assets/icons.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'

// 老下载补齐的模块级互斥（页面会挂两遍；补全不依赖具体实例）
let enriching = false

export default {
  name: 'downloads',
  mixins: [accentMixin, toastMixin, pageFrameMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'hint-toast': HintToast
  },
  data() {
    return {
      ICON: ICON,
      loading: true,
      plCount: 0,
      arCount: 0,
      alCount: 0,
      songCount: 0,
      bytes: 0,
      free: -1,
      dl: null
    }
  },
  computed: {
    plText() {
      if (this.loading) return '—'
      return this.plCount ? this.plCount + ' 个歌单' : '暂无索引'
    },
    arText() {
      if (this.loading) return '—'
      return this.arCount ? this.arCount + ' 位歌手' : '暂无歌手'
    },
    alText() {
      if (this.loading) return '—'
      return this.alCount ? this.alCount + ' 张专辑' : '暂无专辑'
    },
    sub() {
      const t = dlText(this.dl)
      if (t) return t
      if (this.loading) return '读取中...'
      let s = this.songCount + ' 首 · ' + fmtSize(this.bytes)
      if (this.free > 0) s += ' · 可用 ' + fmtSize(this.free)
      return s
    },
    barSub() {
      return this.sub
    },
    rail() {
      return [
        railBack(),
        // 下载队列：有未查看的已完成任务时高亮（同旧本地下载页）
        railBtn('queue', ICON.tasks, !!(this.dl && this.dl.finished > 0))
      ]
    }
  },
  mounted() {
    this._dead = false
    const self = this
    this._dlOff = onDl(function (s) {
      self.syncDl(s)
    })
    this.syncDl(dlState())
    this._onShow = function () {
      self.refresh()
    }
    try {
      this.$page.on('show', this._onShow)
    } catch (e) {
      log('downloads', '$page.on(show) 订阅失败 ' + ((e && e.message) || e))
    }
    this.refresh()
    log('downloads', '本地下载总览挂载')
  },
  beforeDestroy() {
    this._dead = true
    if (this._dlOff) offDl(this._dlOff)
    this._dlOff = null
    try {
      if (this._onShow) this.$page.off('show', this._onShow)
    } catch (e) {}
    this._onShow = null
  },
  methods: {
    /** 三张卡的裸图标：按当前主题色取 PNG（平台不能给 <image> 染色） */
    cico(key) {
      return aIcon(key, this.accent.key)
    },
    async refresh(skipEnrich) {
      try {
        const [lists, ls, st] = await Promise.all([
          indexedCount(),
          localStats(),
          stats()
        ])
        if (this._dead) return
        this.plCount = lists || 0
        this.arCount = (ls && ls.artists) || 0
        this.alCount = (ls && ls.albums) || 0
        this.songCount = (st && st.songs && st.songs.count) || 0
        this.bytes = (st && st.songs && st.songs.bytes) || 0
        this.loading = false
        log('downloads', '总览 歌单=' + this.plCount + ' 歌手=' + this.arCount +
          ' 专辑=' + this.alCount + ' 歌曲=' + this.songCount + ' / ' + fmtSize(this.bytes))
        // 老下载缺本地索引/时长的后台补齐（一次最多 30 首；异常自己吃掉，不影响总览）
        if (!skipEnrich) {
          this.enrich().catch(function (e) {
            log('downloads', '补齐异常 ' + ((e && e.message) || e))
          })
        }
      } catch (e) {
        if (this._dead) return
        this.loading = false
        log('downloads', '总览读取失败 ' + ((e && e.message) || e))
      }
      const fb = await freeBytes()
      if (this._dead || !(fb > 0)) return
      this.free = fb
    },
    /**
     * 老下载补齐（本功能上线前下的歌）：缺本地索引或时长的逐首 saveSongExtras
     * （v3 详情 → 本地索引 + 歌词落盘 + 封面预热），一次 ≤30 首、串行。
     * 连续 2 首失败即停（离线时逐首吃超时没有意义）；在线时下次进页面继续。
     * 补到的时长/封面写回下载元数据，之后列表行/歌手/专辑聚合直接可用。
     */
    async enrich() {
      if (enriching || this._dead) return
      if (await isOffline()) return
      try {
        await loadIndex()
      } catch (e) {}
      if (this._dead) return
      let downloaded = []
      try {
        downloaded = await listSongs()
      } catch (e) {
        log('downloads', '补齐读取下载列表失败 ' + ((e && e.message) || e))
        return
      }
      const todo = []
      for (let i = 0; i < downloaded.length && todo.length < 30; i++) {
        const s = downloaded[i]
        if (!s.durationMs || !indexOf(s.id)) todo.push(s)
      }
      if (!todo.length) return
      enriching = true
      log('downloads', '补齐元数据/歌词 ' + todo.length + ' 首')
      let got = 0
      let fails = 0
      try {
        for (let i = 0; i < todo.length; i++) {
          if (this._dead) break
          const s = todo[i]
          const r = await saveSongExtras(s.id)
          if (!r || !r.info) {
            fails++
            if (fails >= 2) {
              log('downloads', '连续失败，停止补齐（离线？）got=' + got)
              break
            }
            continue
          }
          fails = 0
          const info = r.info
          const song = info.song || {}
          const album = info.album || {}
          const name = s.name || song.name || ''
          const dur = s.durationMs || song.durationMs || 0
          const cover = s.cover || album.cover || ''
          let artist = s.artist
          if (!artist && info.artists && info.artists.length) {
            const names = []
            for (let k = 0; k < info.artists.length; k++) names.push(info.artists[k].name)
            artist = names.join(' / ')
          }
          try {
            await putMeta(
              { id: s.id, name: name, artist: artist, durationMs: dur, cover: cover },
              s.br,
              s.ext
            )
          } catch (e) {}
          got++
        }
      } finally {
        enriching = false
      }
      if (this._dead || !got) return
      log('downloads', '补到 ' + got + ' 首元数据/歌词')
      this.refresh(true)
    },
    syncDl(s) {
      const d = s || {}
      const sig = (d.active ? 1 : 0) + '|' + d.total + '|' +
        (d.done + d.failed + (d.cancelled || 0)) + '|' + (d.stopping ? 1 : 0) + '|' + (d.finished || 0)
      if (sig !== this._dlSig) {
        this._dlSig = sig
        this.dl = d
      }
      const active = !!d.active
      if (this._wasActive && !active) this.refresh()
      this._wasActive = active
    },
    openPl() {
      go('dlplaylists')
    },
    openAr() {
      go('dlartists')
    },
    openAl() {
      go('dlalbums')
    },
    onRailKey(key) {
      if (key === 'queue') go('dlqueue')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 竖向预算同首页：内容区 85vh；scroller 上下 6vh + 卡高 70vh = 82vh，留 3vh 余量。
   卡宽与首页文字卡一致（23% ≈ 219px）：3×219 + 2×9.6 ≈ 676px。
   内容不足一屏时右侧自然留白，横向滑动行为不变。 */
.dlo-row {
  flex: 1;
  padding: 6vh 3vh;
}
.dlo-card {
  width: 23%;
  height: 70vh;
  background-color: @panel;
  border-width: 1px;
  border-style: solid;
  border-color: @line;
  border-radius: 6vh;
  margin-right: 4vh;
}
/* 三张卡版式一致：图标贴顶、标题/副行贴底，中间由 .dlo-fill 吸收余量。
   上/左内边距相等（5vh）→ 墨迹到左、到上视觉等距（同首页文字卡）。 */
.dlo-pl {
  flex-direction: column;
  align-items: flex-start;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 4vh;
}
.dlo-ar {
  flex-direction: column;
  align-items: flex-start;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 4vh;
}
.dlo-al {
  flex-direction: column;
  align-items: flex-start;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 4vh;
}
.dlo-ico {
  width: 23vh;
  height: 23vh;
  flex: none;
}
.dlo-fill {
  flex: 1;
}
.dlo-ct {
  font-size: 10vh;
  font-weight: bold;
  color: @text;
}
.dlo-sub {
  width: 100%;
  font-size: 8vh;
  color: @text-2;
  margin-top: 1.5vh;
  lines: 1;
  text-overflow: ellipsis;
}
</style>
