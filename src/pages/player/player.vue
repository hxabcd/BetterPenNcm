<template>
  <page-shell :rail="rail" @rail="onRail">
    <div class="ply-main">
      <!-- 控制区 480×240：封面 / 子面板切换键 / 标题·歌手·专辑 / 进度 / 控制 -->
      <control-panel
        :st="st"
        :cover="cover"
        :like-on="likeOn"
        :sub="sub"
        @toggle="onToggle"
        @prev="onPrev"
        @next="onNext"
        @loop="onLoop"
        @like="onLike"
        @pick="onPick"
        @sub="toggleSub"
      />

      <!-- 子面板 480×240：底色 #272727 + 左侧 12px 圆角（设计稿 SubPanel 槽位）。
           默认不打开任何面板（设计稿的 EmptyExtraPanel = 空面板，只留底色）；
           三个切换键各自开合：已打开的面板再点同一个键 → 关闭回到空面板。
           进度控制（TimeShiftPanel）内含定时播放子页：seek → timer 是同一面板内的两级页面。 -->
      <div class="ply-sub">
        <lyric-board
          v-if="sub === 'lyric' && lyricOn"
          :lines="lines"
          :show-trans="showTrans"
          :full="lyricFull"
          :follow="lyricFollow"
          :dbl-tap="lyricDbl"
          :word-on="lyricWord"
          :anim="lyricAnim"
          :empty-text="lyricHint"
          @seekline="onSeekLine"
        />
        <div class="ply-off" v-else-if="sub === 'lyric'">
          <text class="ply-off-t">歌词已关闭</text>
        </div>
        <comment-panel v-else-if="sub === 'comment'" :song-id="curId" @toast="showToast" />
        <seek-panel
          v-else-if="sub === 'seek' && seekView === 'seek'"
          :st="st"
          @seek="onSeekTo"
          @timer="openTimer"
          @close="closePanel"
        />
        <timer-panel v-else-if="sub === 'seek'" @back="timerBack" @toast="showToast" />
        <!-- 其余情况 = 空面板（EmptyExtraPanel）：不渲染任何内容，父级底色即可 -->
      </div>
    </div>

    <!-- 轻提示（喜欢结果 / 歌单选择页返回后的添加结果 / 子面板的 toast） -->
    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 播放页（2026-10-29 按 Figma 设计稿 PlayerPage 14:1570 重做；2026-10-30 调整交互）
 *
 * 布局（1020×240，三列一条横排；几何表见 docs/播放页.md）：
 *   左栏（全局 PageShell + NavRail，60px；设计稿左栏样式现已应用到全应用）
 *   ｜控制区 480px（ControlPanel.vue）｜子面板 480px（SubPanel 槽位）
 *   子面板 = 480×240、底 #272727、左侧 12px 圆角，内容在三种面板间切换：
 *     lyric（歌词） / comment（评论） / seek（进度控制，内含定时子页）
 *   默认**不打开**任何面板（设计稿的 EmptyExtraPanel 空面板）；
 *   控制区左列三个键各自开合，「已打开的面板再点同一个键 → 关闭」。
 *
 * 交互约束（2026-10-30）：
 *   - 标题/歌手/专辑三行文字不做跳转，详情页只从左栏「歌曲详情」键进入；
 *   - 进度条（TimeStatus/ProgressBar 那一行）纯展示，不挂点击；
 *   - 时钟键打开进度控制面板（TimeShiftPanel）；SetTimer/SetCustomTimer/Timer 三个面板
 *     是它内部的子页（seekView = seek | timer，timer 面板的返回回到 seek）。
 *
 * ⚠ 平台约定（详见 docs/平台约束与自检.md）：
 *   - 模板裸绑定只能来自 props/computed/data；method 版取到的是函数（会整块 UI 消失）；
 *   - watcher 不用值相等去重 → 所有带副作用的 watcher 入口自己判重（curId/coverKey 两处）；
 *   - 页面会挂两遍 → mounted 初始化幂等（loadLyric/loadCover/loadLike 自带 _xxxKey 判重）。
 */
import PageShell from '../../components/PageShell.vue'
import ControlPanel from '../../components/player/ControlPanel.vue'
import LyricBoard from '../../components/player/LyricBoard.vue'
import CommentPanel from '../../components/player/CommentPanel.vue'
import TimerPanel from '../../components/player/TimerPanel.vue'
import SeekPanel from '../../components/player/SeekPanel.vue'
import HintToast from '../../components/HintToast.vue'
import { ICON } from '../../assets/icons.js'
import { railBack, railBtn } from '../../utils/rail.js'
import { go } from '../../utils/nav.js'
import { player } from '../../utils/player/player.js'
import { loadLyrics } from '../../utils/player/lyric.js'
import { sleepTimer } from '../../utils/player/sleeptimer.js'
import { ensureCover, BIG_COVER } from '../../utils/cover.js'
import { checkLiked, setLiked, cachedLiked } from '../../utils/ncm/like.js'
import { loggedIn } from '../../utils/ncm/login.js'
import config from '../../utils/config.js'
import { evtData } from '../../utils/events.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'
import { log } from '../../utils/log.js'

const LONG_SWALLOW_MS = 3000 // 长按后吞掉 click 的窗口（防御性，见 toggleLike 注释）

export default {
  name: 'player',
  components: {
    'page-shell': PageShell,
    'control-panel': ControlPanel,
    'lyric-board': LyricBoard,
    'comment-panel': CommentPanel,
    'timer-panel': TimerPanel,
    'seek-panel': SeekPanel,
    'hint-toast': HintToast
  },
  mixins: [toastMixin, pageFrameMixin],
  data() {
    return {
      ICON: ICON,
      st: player.state(),
      lines: [],
      lyricHint: '暂无歌词',
      cover: '',
      lyricOn: true,
      showTrans: true,
      lyricFull: true, // 歌词可拖动翻看（false = 省性能：禁用拖动、位置恒跟当前行）
      lyricFollow: true, // 歌词自动跟歌（活动行更新时平滑滚动；false = 只换高亮，见 LyricBoard 的 follow）
      lyricDbl: true, // 双击歌词跳转到该行
      lyricWord: true, // 逐字歌词（无 YRC 自动回退逐行）
      lyricAnim: true, // 歌词动画（滚动/高亮/逐字过渡；关闭 = 全部瞬时）
      likeOn: false, // 当前曲目是否已喜欢（收藏到「我喜欢的音乐」）
      sub: 'lyric', // 子面板：默认直接打开歌词面板 / lyric / comment / seek（'' = 空面板）
      seekView: 'seek', // seek 面板内部页面：seek（进度控制）/ timer（定时播放三态）
      timerOn: false // 定时播放是否在跑（只用于到点提示的边沿判定）
    }
  },
  computed: {
    curId() {
      return (this.st.cur && this.st.cur.id) || 0
    },
    /** 曲目 id + 封面 url：搜索结果的封面是详情接口后补的，两个都要跟 */
    coverKey() {
      return this.curId + '|' + ((this.st.cur && this.st.cur.cover) || '')
    },
    /**
     * 左栏槽位（全局 NavRail）：返回固定第一，其余贴底。
     * 「歌曲详情」没有在播曲时禁用（那页要 id）。下载不占槽位（在歌曲详情/列表页）。
     */
    rail() {
      const out = [railBack()]
      out.push(railBtn('info', ICON.info, false, '', false, !this.curId))
      out.push(railBtn('queue', ICON.queue))
      out.push(railBtn('settings', ICON.options))
      return out
    }
  },
  watch: {
    /**
     * ⚠ 平台坑（实测）：watcher 会被以播放器 tick 的频率用同一个值反复回调
     * （不像标准 Vue 2 用 value !== this.value 去重）——所以带副作用的 watcher 必须入口判重。
     */
    curId(id) {
      if (String(id || 0) === this._lyricKey) return
      this.loadLyric(id)
      this.loadLike(id) // 共用上面的判重：同一首歌只查一次喜欢状态
    },
    coverKey() {
      if (this._coverKey === this.coverKey) return
      this.loadCover()
    }
  },
  mounted() {
    const self = this
    this._dead = false
    // 播放状态订阅：每 tick（约 500ms）推一次快照 —— 整页依赖它更新
    this._off = player.on(function (s) {
      self.st = s
    })
    this.readOpts()
    // 定时播放状态（模块级单例，跨页面存活）：每秒广播一次，页面只关心 active。
    // 到点提示：定时面板开着时由 TimerPanel 自己 emit（避免双 toast），
    // 其余情况（空面板/评论/歌词/进度控制）由页面补一条。
    this._timerFn = function (s) {
      const on = !!(s && s.active)
      const timerPanelOpen = self.sub === 'seek' && self.seekView === 'timer'
      if (self.timerOn && !on && !timerPanelOpen) {
        self.showToast(s && s.keepTrack ? '已播完整首，定时结束' : '定时已到，已暂停播放')
      }
      self.timerOn = on
    }
    sleepTimer.on(this._timerFn)
    this.timerOn = !!sleepTimer.state().active
    // 从「播放设置」页返回时刷新开关（那边改完 trigger 这个事件）
    this._evt = function () {
      self.readOpts()
    }
    try {
      /* global $falcon */
      $falcon.on('bpncm:playeropts', this._evt)
    } catch (e) {}
    // 歌单选择页添加成功后 trigger('bpncm:toast', 文案)，返回本页就能看到结果。
    // ⚠ 回调参数是框架包过的 {type,timestamp,data}，必须 evtData 解包 —— 否则显示 [object Object]
    this._toastEvt = function (evt) {
      const text = evtData(evt)
      if (text) self.showToast(String(text))
    }
    try {
      /* global $falcon */
      $falcon.on('bpncm:toast', this._toastEvt)
    } catch (e) {}
    this.loadLyric(this.curId)
    this.loadCover()
    this.loadLike(this.curId)
    log('player', '播放页挂载 id=' + this.curId + ' 歌词=' + this.lyricOn + ' 翻译=' + this.showTrans +
      ' 跟歌=' + this.lyricFollow)
  },
  beforeDestroy() {
    this._dead = true
    if (this._off) player.off(this._off)
    this._off = null
    if (this._timerFn) sleepTimer.off(this._timerFn)
    this._timerFn = null
    try {
      /* global $falcon */
      if (this._evt) $falcon.off('bpncm:playeropts', this._evt)
    } catch (e) {}
    this._evt = null
    try {
      /* global $falcon */
      if (this._toastEvt) $falcon.off('bpncm:toast', this._toastEvt)
    } catch (e) {}
    this._toastEvt = null
  },
  methods: {
    readOpts() {
      this.lyricOn = config.get('lyricOn') !== false
      this.showTrans = config.get('showTrans') !== false
      this.lyricFull = config.get('lyricFull') !== false
      this.lyricFollow = config.get('lyricFollow') !== false
      this.lyricDbl = config.get('lyricDbl') !== false
      this.lyricWord = config.get('lyricWord') !== false
      this.lyricAnim = config.get('lyricAnim') !== false
    },
    /* ---- 歌词 ---- */
    async loadLyric(id) {
      const key = String(id || 0)
      this._lyricKey = key
      this.lines = []
      this.lyricHint = '暂无歌词'
      if (!id) return
      const r = await loadLyrics(id)
      if (this._lyricKey !== key) return // 期间换歌了，丢弃这次结果
      this.lines = r.lines
      this.lyricHint = r.pureMusic ? '纯音乐，请欣赏' : r.empty ? '暂无歌词' : ''
      log('player', '歌词就绪 id=' + id + ' 行数=' + r.lines.length)
    },
    /* ---- 封面（播放页封面 152px，BIG_COVER=200 缩略图足够） ---- */
    loadCover() {
      const self = this
      const s = this.st.cur || {}
      const id = s.id
      this._coverKey = this.coverKey
      this.cover = ''
      if (!id || !s.cover) return
      ensureCover(
        { id: id, cover: s.cover },
        function (cid, p) {
          if (p && cid === id) self.cover = p
        },
        BIG_COVER
      )
    },
    /* ---- 歌词双击 seek（LyricBoard 抛上行下标） ---- */
    onSeekLine(idx) {
      const ln = this.lines[idx]
      if (!ln || !isFinite(ln.time)) return
      log('player', '歌词双击跳转 idx=' + idx + '/' + this.lines.length + ' t=' + ln.time + 'ms')
      player.seekTo(ln.time)
    },
    /* ---- 控制 ---- */
    onToggle() {
      player.toggle()
    },
    onPrev() {
      player.prev()
    },
    onNext() {
      player.next()
    },
    onLoop() {
      player.cycleLoopMode()
    },
    /* ---- 喜欢（收藏到「我喜欢的音乐」） ---- */
    async loadLike(id) {
      const key = String(id || 0)
      this._likeKey = key
      this.likeOn = false
      if (!id) return
      const hit = cachedLiked(id)
      if (hit !== null) {
        this.likeOn = hit
        return
      }
      const v = await checkLiked(id)
      if (this._likeKey !== key) return // 期间换歌了，丢弃
      if (v === null) return // 未登录 / 查询失败：保持未知（空心）
      this.likeOn = v
    },
    /**
     * 单击 → 收藏 / 取消（乐观更新，失败回滚）。
     * 长按走渲染器原生手势事件（pressing 态只发 pressend、不发 click），与单击天然互斥；
     * 仍保留 LONG_SWALLOW_MS 保险：万一固件长按后仍发 click，不误触发收藏。
     */
    async toggleLike() {
      const id = this.curId
      if (!id) return
      const dgap = Date.now() - (this._likeLongAt || 0)
      if (this._likeLongAt && dgap >= 0 && dgap < LONG_SWALLOW_MS) {
        log('player', '长按余波，吞掉 click')
        return
      }
      if (!loggedIn()) {
        this.showToast('未登录')
        return
      }
      const gen = (this._likeGen = (this._likeGen || 0) + 1)
      const want = !this.likeOn
      this.likeOn = want
      const r = await setLiked(id, want)
      if (gen !== this._likeGen || id !== this.curId) return // 期间又点了/换歌：交给后来者
      if (r.ok) {
        this.showToast(want ? '已加入「我喜欢的音乐」' : '已取消喜欢')
        return
      }
      this.likeOn = !want
      this.showToast(r.needLogin ? '未登录，无法收藏' : '操作失败，请重试')
    },
    /** 长按 → 歌单选择页（选一个歌单把当前曲目加进去）。
     *  选择态 = `playlists` 的第二层实例：由 utils/nav.js 分配不在栈里的槽位 key，
     *  不会复用栈里已有的浏览态实例，也不会弹掉本页。 */
    openPick() {
      const id = this.curId
      if (!id) return
      this._likeLongAt = Date.now()
      if (!loggedIn()) {
        this.showToast('未登录')
        return
      }
      go('playlists', { pick: id, pname: (this.st.cur && this.st.cur.name) || '' })
    },
    onLike() {
      this.toggleLike()
    },
    onPick() {
      this.openPick()
    },
    /* ---- 子面板开合 ---- */
    /**
     * 三个切换键共用：点开某个面板；**已经打开的那个再点一次就是关闭**（回空面板）。
     * 进度控制（seek）每次打开都从 TimeShiftPanel 首页开始（定时子页不保留）。
     */
    toggleSub(key) {
      if (this.sub === key) {
        this.sub = ''
        this.seekView = 'seek'
        log('player', '子面板关闭 -> 空面板')
        return
      }
      this.sub = key
      if (key === 'seek') this.seekView = 'seek'
      log('player', '子面板 -> ' + key)
    },
    /** 关闭子面板（进度控制面板顶栏点标题时用） */
    closePanel() {
      this.sub = ''
      this.seekView = 'seek'
      log('player', '子面板关闭 -> 空面板')
    },
    /* ---- 进度控制面板 ---- */
    onSeekTo(ms) {
      player.seekTo(ms)
    },
    /** 进度控制面板右上「定时播放」→ 定时子页（SetTimer / SetCustomTimer / Timer 都在这里） */
    openTimer() {
      if (this.sub !== 'seek') return
      this.seekView = 'timer'
      log('player', '进度控制 -> 定时播放')
    },
    /** 定时子页顶栏「返回」→ 回到进度控制首页（不是在页面之间跳转） */
    timerBack() {
      if (this.sub !== 'seek') return
      this.seekView = 'seek'
    },
    /* ---- 导航 ---- */
    openInfo() {
      if (!this.curId) return
      go('songinfo', { id: this.curId })
    },
    /* ---- 左栏上下文键（pageFrameMixin 的 onRailKey；返回由 mixin 的 onBack 处理） ---- */
    onRailKey(key) {
      if (key === 'info') {
        this.openInfo()
        return
      }
      if (key === 'queue') {
        go('queue')
        return
      }
      if (key === 'settings') go('playeropts')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 三列横排铺满 PageShell 的内容区（.psh-body 是 column + flex:1，所以这里必须 flex:1 + row）。
   底色由 PageShell 按主题给（本页不再自己上底色）。 */
.ply-main {
  flex: 1;
  width: 100%;
  flex-direction: row;
}
/* 子面板 480×240：底 #272727、左上/左下 12px 圆角（设计稿 SubPanel 槽位），
   右侧两角是直角 —— 所以只给左边两个角，overflow 裁掉子内容的直角。
   空面板（EmptyExtraPanel）时它就只是一块纯色面。 */
.ply-sub {
  width: 480px; /* 200vh：>100vh 的宽度必须写 px，否则被平台截到 240px */
  height: 100vh;
  flex: none;
  background-color: @sub-bg;
  border-top-left-radius: 5vh; /* 12px */
  border-bottom-left-radius: 5vh;
  overflow: hidden;
}
/* 歌词关闭态（保留与旧页面一致的提示） */
.ply-off {
  flex: 1;
  align-items: center;
  justify-content: center;
}
.ply-off-t {
  font-size: 7vh;
  color: @text-3;
}
</style>
