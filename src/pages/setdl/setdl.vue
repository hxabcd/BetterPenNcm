<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="音质与存储" :sub="hint" />
    <scroller class="dl-body">
      <!-- 播放音质：在线播放与「边听边存」用的档位。点选即写配置，下次解析直链才生效、
           不打断正在播放的歌 -->
      <div class="dl-row">
        <text class="dl-label">播放音质</text>
        <div class="dl-chips">
          <opt-chip v-for="q in qualities" :key="'p' + q.key" :text="q.label" :on="q.key === playQ" @pick="pickQuality('play', q.key)" />
        </div>
      </div>

      <!-- 下载音质：手动下载到本机（music/）用的档位；点选即写配置 -->
      <div class="dl-row">
        <text class="dl-label">下载音质</text>
        <div class="dl-chips">
          <opt-chip v-for="q in qualities" :key="'d' + q.key" :text="q.label" :on="q.key === downQ" @pick="pickQuality('down', q.key)" />
        </div>
      </div>

      <!-- 缓存上限（config.cacheLimitMb，默认 1G）：**只约束「边听边存」的播放缓存**（cache/），
           超出按「最久没播放」先滚掉；手动下载（downloads/）不受它约束 -->
      <div class="dl-row">
        <text class="dl-label">缓存上限</text>
        <div class="dl-chips">
          <opt-chip v-for="o in cacheLimits" :key="'c' + o.mb" :text="o.label" :on="o.mb === cacheLimit" @pick="pickCacheLimit(o.mb)" />
        </div>
      </div>

      <!-- 自动拉取（默认禁用）：启动时只更新本地索引歌单的远端快照，不下载/不删文件。
           是否把 A 条目下载下来仍由用户点「同步」决定 -->
      <div class="dl-row">
        <text class="dl-label">自动拉取</text>
        <opt-toggle :on="autoPull" @change="setAutoPull" />
      </div>
      <text class="dl-note">启动时拉取本地索引内的歌单；只更新远端信息，不下载或删除歌曲文件。</text>

      <cue-row name="存储管理" sub="已下载、自动缓存、封面缓存的占用与清理" @open="openStorage" />
    </scroller>
  </page-shell>
</template>

<script>
/* 放两个音质档位 + 缓存 + 存储（音质与存储归一类，不按播放/下载拆成两组）：
   播放音质（在线播放与边听边存）/ 下载音质（手动下载到 music/）/ 缓存上限
   （只约束边听边存的 cache/，改动后立刻按新上限滚一次）/ 存储管理页入口。
   「怎么放」的开关（倍速·歌词·退出暂停）在 pages/playeropts，别往这里搬。 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import OptChip from '../../components/OptChip.vue'
import OptToggle from '../../components/OptToggle.vue'
import CueRow from '../../components/CueRow.vue'
import { go } from '../../core/infra/nav.js'
import { QUALITIES, qualityInfo, currentQuality, DEFAULT_QUALITY } from '../../services/player/quality.js'
import { cacheLimitMb, enforceCacheLimit } from '../../services/player/cache.js'
import config, { DEFAULTS } from '../../core/infra/config.js'
import { limitLabel } from '../../core/infra/format.js'
import { log } from '../../core/infra/log.js'
import { pageFrameMixin } from '../../ui/mixins/frame.js'

/** 「缓存上限」可选档位（MB，按升序；**0 = 不限**）—— 文案统一由 format.js 的 limitLabel 给 */
const CACHE_LIMITS = [256, 512, 1024, 2048, 4096, 0].map(function (mb) {
  return { mb: mb, label: limitLabel(mb) }
})

export default {
  name: 'setdl',
  mixins: [pageFrameMixin],
  components: { 'page-shell': PageShell, 'page-topbar': PageTopbar, 'opt-chip': OptChip, 'opt-toggle': OptToggle, 'cue-row': CueRow },
  data() {
    return {
      hint: '',
      qualities: QUALITIES,
      playQ: DEFAULT_QUALITY,
      downQ: DEFAULT_QUALITY,
      cacheLimits: CACHE_LIMITS,
      // 真值来自 config，mounted 里读；0 = 不限
      cacheLimit: DEFAULTS.cacheLimitMb, 
      autoPull: false
    }
  },
  computed: {
  },
  async mounted() {
    await config.load()
    this.playQ = currentQuality('play')
    this.downQ = currentQuality('down')
    // 0 = 不限，统一由 cache.js 读
    this.cacheLimit = cacheLimitMb() 
    this.autoPull = config.get('autoPull') === true
    log('setdl', '音质与存储挂载 播放音质=' + this.playQ + ' 下载音质=' + this.downQ +
      ' 缓存上限=' + limitLabel(this.cacheLimit) + ' 自动拉取=' + (this.autoPull ? '开' : '关'))
  },
  methods: {
    /* 改音质：写配置 + 广播（播放页的「已下载达标」判定会重算）。
       **不打断正在播放的歌** —— 下次解析直链才生效。
       kind: 'play' = 播放音质（在线播放 + 边听边存）；'down' = 下载音质（手动下载） */
    async pickQuality(kind, key) {
      const cur = kind === 'play' ? this.playQ : this.downQ
      if (key === cur) return
      if (kind === 'play') this.playQ = key
      else this.downQ = key
      await config.set(kind === 'play' ? 'playQuality' : 'downloadQuality', key)
      this.hint = (kind === 'play' ? '播放音质 ' : '下载音质 ') + qualityInfo(key).label
      log('setdl', (kind === 'play' ? '播放' : '下载') + '音质 -> ' + key + '（' + qualityInfo(key).note + '）')
      try {
        /* global $falcon */
        $falcon.trigger('bpncm:quality')
      } catch (e) {}
    },

    /** 缓存上限：改动后立刻按新上限滚一次（上限调小马上回收）；mb=0 表示不限 */
    async pickCacheLimit(mb) {
      if (mb === this.cacheLimit) return
      this.cacheLimit = mb
      await config.set('cacheLimitMb', mb)
      this.hint = '缓存上限 ' + limitLabel(mb)
      log('setdl', '缓存上限 -> ' + limitLabel(mb))
      try {
        const r = await enforceCacheLimit()
        if (r && r.removed) {
          log('setdl', '按新上限回收播放缓存 ' + r.removed + ' 首 / 释放 ' +
            Math.round((r.freed || 0) / 1048576) + 'MB')
        }
      } catch (e) {}
    },
    openStorage() {
      go('storage')
    },

    /** 自动拉取：写配置即可，启动链在 boot.js 里读；本页只负责开关 */
    async setAutoPull(on) {
      if (on === this.autoPull) return
      this.autoPull = on
      await config.set('autoPull', on)
      this.hint = '自动拉取 ' + (on ? '开' : '关')
      log('setdl', '自动拉取 -> ' + (on ? '开' : '关'))
    },
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 左右不给 padding：分隔线**通栏**（与设置索引页一致）；行自己带 6vh 内边距 */
.dl-body {
  flex: 1;
  padding-top: 3vh;
  padding-bottom: 3vh;
}

/* 设置行：label 左 + chips 右（高 26vh ≈ 62px，chip 18vh 上下各留 4vh） */
.dl-row {
  height: 26vh;
  flex-direction: row;
  align-items: center;
  padding-left: 6vh;
  padding-right: 6vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}

/* 4 字标签（「下载音质」「缓存上限」）：4 × 7vh = 28vh，宽给 36vh 留余量（CJK 折行坑） */
.dl-label {
  width: 36vh;
  flex: none;
  font-size: @fs-dim;
  color: @text-2;
}
.dl-chips {
  flex-direction: row;
  align-items: center;
}
.dl-note {
  font-size: @fs-mute;
  color: @text-3;
  padding-left: 6vh;
  padding-right: 6vh;
  margin-top: 1.6vh;
  margin-bottom: 2.4vh;
}
</style>
