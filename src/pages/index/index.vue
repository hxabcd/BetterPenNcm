<template>
  <page-shell :rail="rail" @rail="onRail">

    <!-- 顶栏：logo + 构建号 + 登录态（底色由内联 :style 给，主题可换，见 ui/theme.js） -->
    <div class="idx-bar" :style="bgStyle">
      <text class="idx-logo" :style="{ color: accent.c }">BetterPenNcm</text>
      <text class="idx-ver">{{ buildTag }}</text>
      <div class="idx-fill"></div>

      <!-- 右上角登录态：整块可点、直接进个人中心（未登录时那里就是扫码入口，不必绕「设置 → 个人中心」）。
           节点常驻、不随登录态换结构，登录态只改文本内容（理由见 docs/待验证-slot补插错位.md）。 -->
      <text class="idx-status" @click="openAccount">{{ statusText }}</text>
    </div>

    <!-- 横向卡片流：五张卡都是 scroller 的直接子节点，不包 wrapper —— 横向 scroller 的内容层
         由渲染器生成，包 wrapper 会让宽度语义与命中区域都变复杂。
         新增卡片只加在末尾：给已有兄弟节点换结构会影响后续节点位置。 -->
    <scroller class="idx-row" scroll-direction="horizontal" :show-scrollbar="false">

      <div class="idx-card idx-now" :style="nowStyle" @click="openPlayer">
        <div class="idx-cv">
          <image v-if="cover" class="idx-cvi" :src="cover" resize="cover" />

          <image v-else class="idx-cvi-note" :src="ICON.note" />
        </div>
        <div class="idx-tx">
          <text class="idx-nm">{{ nowTitle }}</text>
          <text class="idx-ar">{{ nowArtist }}</text>

          <now-lyric />
        </div>

        <div class="idx-acts" v-if="hasTrack">
          <div class="idx-play" :style="{ backgroundColor: accent.c }" @click="onToggle">
            <image class="idx-play-ico" :src="playIcon" />
          </div>
          <div class="idx-next" @click="onNext">
            <image class="idx-next-ico" :src="ICON.next" />
          </div>
        </div>

        <now-progress />
      </div>

      <div class="idx-card idx-rec" :style="cardStyle" @click="openRecommend">
        <image class="idx-cico" :src="cico('rec')" />
        <div class="idx-tcfill"></div>
        <text class="idx-ct">每日推荐</text>
        <text class="idx-rec-t">{{ recText }}</text>
      </div>

      <div class="idx-card idx-pl" :style="cardStyle" @click="openPlaylists">
        <image class="idx-cico" :src="cico('pl')" />
        <div class="idx-tcfill"></div>
        <text class="idx-ct">我的歌单</text>
        <text class="idx-cn">{{ plText }}</text>
      </div>

      <div class="idx-card idx-dl" :style="cardStyle" @click="openDownloads">
        <image class="idx-cico" :src="cico('dl')" />
        <div class="idx-tcfill"></div>
        <text class="idx-ct">本地下载</text>
        <text class="idx-dl-t">{{ dlText }}</text>
      </div>

      <div class="idx-card idx-hist" :style="cardStyle" @click="openHistory">
        <image class="idx-cico" :src="cico('hist')" />
        <div class="idx-tcfill"></div>
        <text class="idx-ct">播放历史</text>
        <text class="idx-hist-t">{{ histText }}</text>
      </div>
    </scroller>
  </page-shell>
</template>

<script>
import PageShell from "../../components/PageShell.vue";
import NowLyric from "../../components/NowLyric.vue";
import NowProgress from "../../components/NowProgress.vue";
import { railBack, railBtn, ICON } from '../../ui/rail.js';
import { boot } from '../../core/infra/boot.js';
import { go } from '../../core/infra/nav.js';
import { todayMD } from '../../services/ncm/recommend.js';
import config from '../../core/infra/config.js';
import { openTextEdit, available as skAvailable } from '../../core/platform/systemKeyboard.js';
import { player } from '../../services/player/player.js';
import { bindDl } from '../../ui/mixins/dlsub.js';
import { dlApi, stopForExit, resetExit } from '../../services/player/download.js';
import { accentMixin } from '../../ui/mixins/accent.js';
import { aIcon } from "../../assets/icons.js";
import { BUILD_TAG } from "../../core/infra/buildInfo.js";
import { log } from '../../core/infra/log.js';
import { pageFrameMixin } from '../../ui/mixins/frame.js';
import { pageBusMixin } from '../../ui/mixins/pagebus.js';
import { bindPageVis } from '../../ui/vis.js';
import { nowCardMixin } from './nowcard.js';
import { homeDataMixin } from './homedata.js';

// 防重：运行时页面会挂两遍。started 只护「启动链 + 登录事件」，不能护播放态订阅 ——
// 订阅若只挂第一次挂载的实例，而实际显示的是最后挂载的那个，卡片会永远停在初始状态。
let started = false;

// 最近一次挂载的实例：boot / 登录事件这些异步回调统一写到它
let live = null;

export default {
  name: "index",
  mixins: [accentMixin, pageBusMixin, pageFrameMixin, nowCardMixin, homeDataMixin],
  components: {
    "page-shell": PageShell,
    "now-lyric": NowLyric,
    "now-progress": NowProgress,
  },
  data() {
    return {
      ICON: ICON,
      buildTag: BUILD_TAG,
      keyword: "",
      status: "就绪",
      profile: { nickname: "", avatarUrl: "", userId: 0 },

      // 登录态单独存一份（statusText / 卡片计数都靠它判断）。必须在 data 里声明：
      // 运行时后加的属性不参与响应式，computed 会一直返回首帧的缓存值（踩过）
      isLogged: false,
      createdCount: "—",
      subCount: "—",

      // 每日推荐卡副行的原料：数字 = 已取到（副行于是显示日期），字符串 = 状态文案
      // （'—' 未加载 / '加载中…' / '加载失败'；未登录由 recText 直接接管）。同理必须在 data 里声明。
      recCount: "—",
      st: player.state(),
      cover: "",

      // 柔光渐变的两个颜色（必须在 data 里声明：后加到 this 上的属性不参与响应式，
      // computed 会一直返回首帧的缓存值 —— 卡面恒为主题色就是这么来的）。空 = 回落主题色
      glowColor: "", 
      glowColor2: "", 

      // 柔光总开关（config.glowOn，设置 → 个性化里改）。关 = 卡面退回纯色、不再叠渐变。
      // 同样必须在 data 里声明，否则开关改了 computed 不重算；真值在 mounted / onShow 各读一次
      // （页面是 navTo/finish 进出，不会重新挂载）。
      glowOn: true,
      histText: "—", 
      dl: null, 
      dlCount: 0, 
      dlBytes: 0,
      dlLoaded: false, 
    };
  },
  computed: {
    bgStyle() {
      return { backgroundColor: this.bg };
    },

    nowStyle() {
      const s = this.glowStyle;
      s.width = this.nowW + 'px';
      return s;
    },
    cardStyle() {
      return { width: this.cardW + 'px' };
    },

    // 左栏：主页是根页、没有上一级，第一个槽位的「返回」= 退出应用（$falcon.closeApp）；
    // 其余三键：搜索、播放列表（当前播放队列）、设置（里再进个人中心）。四键等距排满 100vh。
    rail() {
      return [
        railBack(),
        railBtn("search", ICON.search),
        railBtn("queue", ICON.queue),
        railBtn("settings", ICON.settings),
      ];
    },

    // 右上角登录态文案。未登录 → 恒为「未登录」：不管 status 里跑着什么临时提示语，
    // 登录态是更前台的信息，而且它这时是唯一能进扫码的地方；已登录 → 优先让临时提示语说话，
    // 没有就显示昵称（昵称来自 boot 拉的 profile，冷启动头两秒可能为空 → 兜底「已登录」）。
    statusText() {
      if (!this.isLogged) return "未登录";
      return this.status || this.profile.nickname || "已登录";
    },

    // 「我的歌单」卡副行：'—' →「N 个歌单」。N = 创建 + 收藏（「我喜欢」已算在创建里，见 loadPlaylists）。
    // 判定用 typeof number：两个计数的初值都是字符串 '—'。未登录优先于「已取到计数」：syncLogin
    // 会把计数清回 '—'，但计数是异步回写的，登录态变化与回写之间没有先后保证。
    plText() {
      if (!this.isLogged) return "登录后查看";
      if (typeof this.createdCount !== "number" || typeof this.subCount !== "number") return "—";
      return this.createdCount + this.subCount + " 个歌单";
    },

    // 每日推荐卡副行：未登录「登录后查看」，其余显示**今天的月/日**。为什么是日期而不是首数：
    // 这张卡的内容每天换，日期才是「这批推荐是哪天的」的正解；首数恒为 30 余首、没有信息量。
    // 异常态（'加载中…' / '加载失败'）直接顶上来 —— 那不是「今天的推荐」，不该拿日期糊过去。
    // ⚠ 未登录时不要把日期显示出来：内容账号相关，显示日期会让人以为「已就绪」，点进去却要扫码。
    recText() {
      if (!this.isLogged) return "登录后查看";
      if (typeof this.recCount === "string" && this.recCount !== "—") return this.recCount;
      return todayMD();
    },
    // 暂停中（或还没出声）显示 ▶，播放中显示 ⏸ —— 底是实心主题色，走 fgIcon 取深色版
    playIcon() {
      return this.fgIcon(this.st.paused || !this.st.isPlaying ? "play" : "pause");
    },

  },
  mounted() {
    const self = this;
    this._dead = false;
    // 启动链回调的落点（一次性 Promise，不是订阅 —— 见 ui/mixins/pagebus.js 的边界说明）
    live = this; 

    // 柔光开关。这里 config 可能还没 load（boot 在下面才跑），未 load 时 get 返回 undefined
    // → `!== false` 判为开，与 DEFAULTS 一致，不会闪错。
    this.glowOn = config.get("glowOn") !== false;

    // 播放态订阅（每个实例都订；签名判重 + 可见性门控，别让 500ms 的 tick 把渲染打爆）
    this._sig = "";
    this._vis = true;
    this._handler = function (s) {
      self.onPlayer(s);
    };
    player.on(this._handler);
    this._visOff = bindPageVis(this, function (on) {
      const was = self._vis;
      self._vis = on;

      if (on && !was) self.onPlayer(player.state());
    });
    this.onPlayer(player.state());
    this.syncHist();
    this.syncLogin();

    // 本地下载卡：下载活动订阅（进度）+ 计数（文件系统的真相；exec 一次别频繁调）
    // bindDl = 订阅 + 可见性门控 + 首帧快照（主页被上层页盖住时不落 data，见 ui/mixins/dlsub.js）
    this._dlOff = bindDl(this, dlApi, function (s) {
      self.syncDl(s);
    });
    // 每次重新露出：从个人中心退出登录后返回没有事件通知这里，靠重新可见刷一次；
    // 开关页（设置 → 个性化）改完返回：页面不重新挂载，靠 show 把开关值刷进来
    this._onShow = function () {
      self.loadDownloads();

      self.syncLogin();

      self.glowOn = config.get("glowOn") !== false;
      self.loadRecommend(); 
    };
    try {
      /* global $falcon */
      this.$page.on("show", this._onShow);
    } catch (e) {}
    this.loadDownloads();

    // 启动链 + 登录事件（只跑一次，异步回调写 live）
    if (!started) {
      started = true;
      log("index", "门户页启动");
      boot().then(function (p) {
        if (p && p.nickname && live) live.profile = p;
        if (!live) return;
        live.syncLogin(); 
        live.glowOn = config.get("glowOn") !== false;
        live.loadPlaylists();
        live.loadRecommend();
      });
    }

    // 跨页事件（注册/退役见 ui/mixins/pagebus.js；由页面栈上层存活实例处理）
    this.onPageEvent("bpncm:login-done", "onLoginDone");
    this.onPageEvent("bpncm:playlist-changed", "onPlaylistChanged");
    this.onPageEvent("bpncm:playhist", "onPlayhist");
  },
  beforeDestroy() {
    this._dead = true;
    if (this._handler) player.off(this._handler);
    this._handler = null;
    if (this._visOff) this._visOff();
    this._visOff = null;
    if (this._dlOff) this._dlOff();
    this._dlOff = null;
    try {
      if (this._onShow) this.$page.off("show", this._onShow);
    } catch (e) {}
    this._onShow = null;
  },
  methods: {
    cico(key) {
      return aIcon(key, this.accent.key);
    },

    openAccount() {
      go("account");
    },

    openRecommend() {
      if (!this.isLogged) {
        go("account");
        return;
      }
      go("list", { kind: "recommend", name: "每日推荐" });
    },

    async onBack() {

      try {
        await stopForExit();
      } catch (e) {}

      try {
        await player.pauseForExit();
      } catch (e) {}
      log("index", "退出应用");
      try {
        /* global $falcon */
        $falcon.closeApp();
      } catch (e) {

        try {
          resetExit();
        } catch (e2) {}
        log("index", "closeApp 失败: " + ((e && e.message) || e));
      }
    },
    onRailKey(key) {
      if (key === "search") this.openKb();
      else if (key === "queue") go("queue");
      else if (key === "settings") go("settings");
    },

    openPlayer() {

      if (Date.now() - (this._btnAt || 0) < 500) return;
      go("player", {});
    },
    onToggle() {
      this._btnAt = Date.now();
      player.toggle();
    },
    onNext() {
      this._btnAt = Date.now();
      player.next();
    },

    openPlaylists() {
      if (!this.isLogged) {
        go("account");
        return;
      }
      go("playlists", {});
    },

    openDownloads() {
      go("downloads");
    },

    openHistory() {
      go("list", { kind: "history", name: "播放历史" });
    },

    async openKb() {
      this.keyword = "";
      this.status = "唤起输入法...";
      let ok = false;
      try {
        ok = await skAvailable();
      } catch (e) {
        ok = false;
      }
      if (!ok) {

        this.status = "系统输入法不可用";
        return;
      }
      const text = await openTextEdit({
        text: "",
        placeholder: "歌名 / 歌手",
        enterButtonText: "搜索",
        maxlength: 60,
        inputType: "ZhCNPreferred",
      });
      if (text === null) {
        this.status = "已取消输入";
        return;
      }

      const kw = String(text || "").trim();
      if (!kw) {
        this.keyword = "";
        this.status = "未输入关键词";
        log("index", "搜索取消：关键词为空");
        return;
      }
      this.keyword = kw;
      this.status = "搜索: " + kw;
      go("list", { kind: "search", keyword: kw });
    },
  },
};
</script>

<style lang="less" scoped>
@import "../../styles/common.less";

.idx-bar {
  height: @topbar-h;
  flex: none;
  flex-direction: row;
  align-items: center;

  padding-left: 3vh;
  padding-right: 3vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.idx-logo {
  font-size: @fs-strong;
  color: @accent;
  font-weight: bold;
  margin-right: 1.6vh;
}
.idx-ver {
  font-size: @fs-mute;
  color: @text-3;
  margin-right: 3.4vh;
}
.idx-fill {
  flex: 1;
}

.idx-status {
  font-size: @fs-mute;
  color: @text-3;
  padding-left: 4vh;
  padding-right: 4vh;
  margin-right: 1vh;
}

.idx-row {
  flex: 1;
  padding: 6vh 3vh;
}

.idx-card {
  height: 70vh;
  background-color: @panel;
  border-width: 1px;
  border-style: solid;
  border-color: @line;

  border-radius: 6vh;
  margin-right: 4vh;
}

.idx-now {

  flex-direction: row;
  align-items: center;
  padding-left: 5vh;
  padding-right: 5vh;
  position: relative; 

  overflow: hidden;
}
.idx-cv {
  width: 58vh;
  height: 58vh;
  flex: none;
  border-radius: 1.8vh;
  background-color: @panel-2;
  overflow: hidden;
  align-items: center; 
  justify-content: center;
}
.idx-cvi {
  width: 58vh;
  height: 58vh;
}
.idx-cvi-note {
  width: 26vh; 
  height: 26vh;
}

.idx-tx {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  margin-left: 5vh;
  margin-right: 3vh;
}
.idx-nm {
  font-size: @fs-title;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.idx-ar {
  font-size: @fs-dim;
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
  margin-top: 1.6vh;
}

.idx-acts {
  flex: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.idx-play {
  width: 22vh;
  height: 22vh;
  flex: none;
  border-radius: 11vh; 
  background-color: @accent; 
  align-items: center;
  justify-content: center;
}
.idx-play-ico {
  width: 11vh;
  height: 11vh;
}

.idx-next {
  width: 22vh;
  height: 22vh;
  flex: none;
  margin-top: 6vh;
  border-radius: 11vh;
  background-color: @panel-2;
  align-items: center;
  justify-content: center;
}
.idx-next-ico {
  width: 11vh;
  height: 11vh;
}

.idx-cico {
  width: 23vh;
  height: 23vh;
  flex: none;
}

.idx-tcfill {
  flex: 1;
}

.idx-ct {
  font-size: 10vh;
  font-weight: bold;
  color: @text;
}

.idx-rec {

  flex-direction: column;
  align-items: flex-start;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 4vh;
}
.idx-rec-t {
  width: 100%;
  font-size: 8vh;
  color: @text-2;
  margin-top: 1.5vh;
  lines: 1;
  text-overflow: ellipsis;
}

.idx-pl {

  flex-direction: column;
  align-items: flex-start;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 4vh;
}

.idx-cn {
  width: 100%;
  font-size: 8vh;
  color: @text-2;
  margin-top: 1.5vh;
  lines: 1;
  text-overflow: ellipsis;
}

.idx-dl {

  flex-direction: column;
  align-items: flex-start;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 4vh;
}
.idx-dl-t {
  width: 100%;
  font-size: 8vh;
  color: @text-2;
  margin-top: 1.5vh;
  lines: 1;
  text-overflow: ellipsis;
}

.idx-hist {

  flex-direction: column;
  align-items: flex-start;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 4vh;
}
.idx-hist-t {
  width: 100%;
  font-size: 8vh;
  color: @text-2;
  margin-top: 1.5vh;
  lines: 1;
  text-overflow: ellipsis;
}
</style>
