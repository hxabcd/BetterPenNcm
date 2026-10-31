<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="存储管理" :sub="hint" />
    <scroller class="sg-body">
      <div class="sg-row">
        <text class="sg-label">已下载</text>
        <text class="sg-value">{{ songText }}</text>
      </div>
      <div class="sg-row">
        <text class="sg-label">自动缓存</text>
        <text class="sg-value">{{ cacheText }}</text>
      </div>
      <div class="sg-row">
        <text class="sg-label">封面缓存</text>
        <text class="sg-value">{{ coverText }}</text>
      </div>
      <div class="sg-row">
        <text class="sg-label">可用空间</text>
        <text class="sg-value">{{ freeText }}</text>
      </div>

      <!-- 破坏性操作：两次点按确认（状态/计时在 ui/arm.js：isArmed('songs'|'cache'|'covers')） -->
      <div class="sg-btn" :style="btnStyle(isArmed('songs'))" @click="doClearSongs">
        <text class="sg-btn-t" :style="btnTextStyle(isArmed('songs'))">{{ songBtnText }}</text>
      </div>
      <div class="sg-btn" :style="btnStyle(isArmed('cache'))" @click="doClearCache">
        <text class="sg-btn-t" :style="btnTextStyle(isArmed('cache'))">{{ cacheBtnText }}</text>
      </div>
      <div class="sg-btn" :style="btnStyle(isArmed('covers'))" @click="doClearCovers">
        <text class="sg-btn-t" :style="btnTextStyle(isArmed('covers'))">{{ coverBtnText }}</text>
      </div>


    </scroller>

    <!-- 提示挂 page-shell 直接子级（同其余 9 页），不随 scroller 滚动 -->
    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 存储管理页（配套音质/缓存功能）
 *
 * 数据来自 utils/player/cache.js（文件系统为真相 + storage 元数据）：
 * 统计走 exec 通道（du/ls 一次调用），可用空间走 df（fs.statfs 语义可疑，见 cache.js 注释）。
 * 清空是破坏性操作 → 两次点按确认；清音乐缓存前先 stop() 停播（文件要没了）。
 * 页面会挂两遍 → _dead 守卫（account.vue 同款）。（原先还有个 live 指针，只写不读，删除。）
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import HintToast from '../../components/HintToast.vue'
import { fmtSize } from '../../utils/format.js'
import { stats, freeBytes, clearSongs, clearPlayCache, clearCoverCache } from '../../utils/player/cache.js'
import { cancelDownload, forgetAll, invalidateLocalPaths } from '../../utils/player/download.js'
import { player } from '../../utils/player/player.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { TOK } from '../../utils/ui/tokens.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { armMixin } from '../../utils/ui/arm.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'
import config from '../../utils/config.js'

/** 上限显示：1024 → 1G，512 → 512M，0 → 不限 */
function fmtLimit(mb) {
  if (!mb) return '不限'
  return mb % 1024 === 0 ? mb / 1024 + 'G' : mb + 'M'
}

export default {
  name: 'storage',
  mixins: [accentMixin, toastMixin, armMixin, pageFrameMixin],
  components: { 'page-shell': PageShell, 'page-topbar': PageTopbar, 'hint-toast': HintToast },
  data() {
    return {
      hint: '读取中...',
      songCount: -1,
      songBytes: 0,
      cacheCount: -1,
      cacheBytes: 0,
      coverCount: -1,
      coverBytes: 0,
      free: -1
    }
  },
  computed: {
    songText() {
      if (this.songCount < 0) return '统计中...'
      return this.songCount + ' 首 · ' + fmtSize(this.songBytes)
    },
    cacheText() {
      if (this.cacheCount < 0) return '统计中...'
      const lim = Number(config.get('cacheLimitMb')) || 0
      return this.cacheCount + ' 首 · ' + fmtSize(this.cacheBytes) + (lim ? ' / 上限 ' + fmtLimit(lim) : ' · 不限')
    },
    coverText() {
      if (this.coverCount < 0) return '统计中...'
      return this.coverCount + ' 张 · ' + fmtSize(this.coverBytes)
    },
    freeText() {
      return this.free < 0 ? '读取中...' : fmtSize(this.free)
    },
    songBtnText() {
      return this.isArmed('songs') ? '双击确认清空' : '清空已下载'
    },
    cacheBtnText() {
      return this.isArmed('cache') ? '双击确认清空' : '清空自动缓存'
    },
    coverBtnText() {
      return this.isArmed('covers') ? '双击确认清空' : '清空封面缓存'
    },
  },
  mounted() {
    this._dead = false
    this.refresh()
  },
  beforeDestroy() {
    // armed / toast 的计时器由 ui/arm.js、ui/toast.js 的 beforeDestroy 自动清
    this._dead = true
  },
  methods: {
    async refresh() {
      const s = await stats()
      if (this._dead) return
      const c = s.cache || { count: 0, bytes: 0 }
      this.songCount = s.songs.count
      this.songBytes = s.songs.bytes
      this.cacheCount = c.count
      this.cacheBytes = c.bytes
      this.coverCount = s.covers.count
      this.coverBytes = s.covers.bytes
      this.hint = '统计完成'
      const fb = await freeBytes()
      if (!this._dead && fb > 0) this.free = fb
      log('storage', '统计: 已下载 ' + this.songCount + '首/' + fmtSize(this.songBytes) +
        ' 自动缓存 ' + this.cacheCount + '首/' + fmtSize(this.cacheBytes) +
        ' 封面 ' + this.coverCount + '张/' + fmtSize(this.coverBytes) + ' 可用 ' + fmtSize(fb))
    },
    btnStyle(on) {
      return { backgroundColor: on ? this.accent.c : TOK.panel2 }
    },
    btnTextStyle(on) {
      return { color: on ? TOK.text : TOK.text2 }
    },
    async doClearSongs() {
      if (!this.isArmed('songs')) {
        this.arm('songs')
        this.hint = '双击确认清空'
        return
      }
      this.disarm()
      this.hint = '正在清空...'
      // 正在播放的本地文件马上要被删，先停播（避免边删边读）。
      // 走播放器单例而不是裸 stop()：状态/timer/gen 一起收干净，且裸 stop 会让播放器
      // 收到「结束事件」被误判成播完去连播（流式定位改造发现）。
      // 批量下载先取消、整库索引（doneCache/localPath）先作废 —— 否则清完同会话内
      // 还会拿着已删文件的路径去播（设计校验抓的）
      try {
        await player.stop()
      } catch (e) {}
      try {
        cancelDownload()
      } catch (e) {}
      try {
        forgetAll()
      } catch (e) {}
      const r = await clearSongs()
      if (this._dead) return
      // 播放队列来自「本地下载」（playList 的 'downloads' 标记）→ 队列里全是刚被删的歌，
      // 同步清空（removeFromQueue 全删 = clearPlayback：回空态 + 清会话快照）；
      // 混合来源的队列不动 —— 里面的歌删了本地文件还能流播
      try {
        const st = player.state()
        if (st.queueSrc === 'downloads' && st.queue && st.queue.length) {
          const qids = []
          for (let i = 0; i < st.queue.length; i++) qids.push(st.queue[i].id)
          player.removeFromQueue(qids)
        }
      } catch (e) {}
      this.showToast('已清空 ' + ((r.removed && r.removed.count) || 0) + ' 首已下载')
      await this.refresh()
    },
    /** 清空**自动缓存**（cache/）：不动下载队列 —— 只让播放器重新探测本地文件 */
    async doClearCache() {
      if (!this.isArmed('cache')) {
        this.arm('cache')
        this.hint = '双击确认清空'
        return
      }
      this.disarm()
      this.hint = '正在清空...'
      // 正在播的歌若用的是缓存文件：文件被删后 fd 仍在（声音不断），但 localPath 已失效，
      // seek/续播会撞一次空 → 先作废路径索引让它们重新探测。
      // **不调 forgetAll/cancelDownload**：那会把用户正在跑的下载任务一起取消。
      try {
        invalidateLocalPaths()
      } catch (e) {}
      const r = await clearPlayCache()
      if (this._dead) return
      this.showToast('已清空 ' + ((r.removed && r.removed.count) || 0) + ' 首自动缓存')
      await this.refresh()
    },
    async doClearCovers() {
      if (!this.isArmed('covers')) {
        this.arm('covers')
        this.hint = '双击确认清空'
        return
      }
      this.disarm()
      this.hint = '正在清空...'
      const r = await clearCoverCache()
      if (this._dead) return
      this.showToast('已清空 ' + ((r.removed && r.removed.count) || 0) + ' 张封面缓存')
      await this.refresh()
    },
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.sg-body {
  flex: 1;
  padding: 3vh 6vh;
}
.sg-row {
  height: 18vh;
  flex-direction: row;
  align-items: center;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.sg-label {
  width: 34vh; /* 最长标签「可用空间」4 字 */
  flex: none;
  font-size: @fs-dim;
  color: @text-2;
}
.sg-value {
  flex: 1;
  font-size: @fs-dim;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
/* 高 16vh ≈ 38px：破坏性按钮点击区给大，误触才有两次确认兜底 */
.sg-btn {
  height: 16vh;
  margin-top: 3vh;
  border-radius: 2.5vh;
  align-items: center;
  justify-content: center;
}
.sg-btn-t {
  font-size: @fs-dim;
}
.sg-note {
  font-size: @fs-mute;
  color: @text-3;
  margin-top: 3vh;
}
</style>
