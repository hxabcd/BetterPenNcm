<template>
  <page-shell :rail="rail" @rail="onRail">
    <!-- 顶栏：logo + 构建号 + 状态（底色跟随主题，见 utils/theme.js） -->
    <div class="idx-bar" :style="bgStyle">
      <text class="idx-logo" :style="{ color: accent.c }">BetterPenNcm</text>
      <text class="idx-ver">{{ buildTag }}</text>
      <div class="idx-fill"></div>
      <!-- 右上角登录态：整块可点，点了直接进个人中心——
           未登录时那里写着「未登录」，进去就能扫码，不用再绕「设置 → 个人中心」两步。
           节点常驻（不随登录态 v-if 换结构）：同一父节点下增删兄弟节点会让后续 slot 插错位，
           登录态只改文本内容。 -->
      <text class="idx-status" @click="openAccount">{{ statusText }}</text>
    </div>

    <!-- 横向卡片流（首页 = 一行卡片，右滑看后面的）
         五张卡都是 scroller 的直接子节点（不包一层 wrapper：横向 scroller 的内容层是
         渲染器生成的，包 wrapper 会让宽度语义和命中区域都变复杂）。
         ⚠ 新增卡片加在**末尾**：同一父节点下给已有兄弟节点换结构会让后续 slot 插错位；追加则安全。 -->
    <scroller class="idx-row" scroll-direction="horizontal" :show-scrollbar="false">
      <!-- 1) 当前播放（大卡）：封面 + 标题·歌手·当前歌词 + 暂停/下一首；点卡片进播放器。
           文本列多了一行歌词，整块仍按内容高度在卡内垂直居中 —— 标题/歌手因此比原来略微上移。 -->
      <div class="idx-card idx-now" :style="glowStyle" @click="openPlayer">
        <div class="idx-cv">
          <image v-if="cover" class="idx-cvi" :src="cover" resize="cover" />
          <!-- 无封面（没在播放 / 取不到封面）时给个灰音符占位，别留一块空面板 -->
          <image v-else class="idx-cvi-note" :src="ICON.note" />
        </div>
        <div class="idx-tx">
          <text class="idx-nm">{{ nowTitle }}</text>
          <text class="idx-ar">{{ nowArtist }}</text>
          <!-- 当前歌词（原文）：自带播放态订阅，只重渲染自己那一个 text -->
          <now-lyric />
        </div>
        <!-- 右侧竖列：暂停/继续 + 下一首。各自挂 handler 挡住卡片点击（平台不支持 stopPropagation） -->
        <div class="idx-acts" v-if="hasTrack">
          <div class="idx-play" :style="{ backgroundColor: accent.c }" @click="onToggle">
            <image class="idx-play-ico" :src="playIcon" />
          </div>
          <div class="idx-next" @click="onNext">
            <image class="idx-next-ico" :src="ICON.next" />
          </div>
        </div>
        <!-- 底部只读进度线（照播放页收起态那条做的）。**自带播放态订阅**：
             位置每 500ms 变一次，不能算进首页的 data —— 首页是横向 scroller，
             整页重渲染有把用户滑走的卡片甩回最左边的风险（同 now-lyric 的套路）。 -->
        <now-progress />
      </div>

      <!-- 2) 每日推荐（需登录）：打开是曲目列表页（list kind=recommend）。
           副行「今日 N 首」；未登录显示「登录后查看」，点卡片直接去个人中心扫码
           （与右上角登录态入口同一去处，不再多绕一层）。 -->
      <div class="idx-card idx-rec" @click="openRecommend">
        <image class="idx-cico" :src="cico('rec')" />
        <div class="idx-tcfill"></div>
        <text class="idx-ct">每日推荐</text>
        <text class="idx-rec-t">{{ recText }}</text>
      </div>

      <!-- 3) 我的歌单：打开后是带「创建 / 收藏」pivot 的页面（文案与页面标题对齐）。
           四张文字卡统一版式：**主题色裸图标贴顶、文本贴底**，
           中间由 .idx-tcfill 吸收余量（见样式里那条「不要写死 margin-top」的注释）。
           副行：**只显示总数「N 个歌单」**（=N 个创建 + M 个收藏含我喜欢），
           不再拆开显示 —— 首页是概览，进页面才看分类；
           未登录与「每日推荐」完全同款：副行「登录后查看」、点击去个人中心扫码。 -->
      <div class="idx-card idx-pl" @click="openPlaylists">
        <image class="idx-cico" :src="cico('pl')" />
        <div class="idx-tcfill"></div>
        <text class="idx-ct">我的歌单</text>
        <text class="idx-cn">{{ plText }}</text>
      </div>

      <!-- 4) 本地下载：**只显示曲目数量**「N 首」（不再带体积）；
           下载中优先显示「下载中 k/N」；点进下载页浏览/点播/单删 -->
      <div class="idx-card idx-dl" @click="openDownloads">
        <image class="idx-cico" :src="cico('dl')" />
        <div class="idx-tcfill"></div>
        <text class="idx-ct">本地下载</text>
        <text class="idx-dl-t">{{ dlText }}</text>
      </div>

      <!-- 5) 播放历史：副行是「今天听了 N 首」 -->
      <div class="idx-card idx-hist" @click="openHistory">
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
import { railBack, railBtn, ICON } from "../../utils/rail.js";
import { boot } from "../../utils/boot.js";
import { go } from "../../utils/nav.js";
import { loadUserPlaylists } from "../../utils/ncm/playlist.js";
import { loadDailyRecommend, cachedDaily, todayMD } from "../../utils/ncm/recommend.js";
import { loggedIn, cachedProfile } from "../../utils/ncm/login.js";
import config from "../../utils/config.js";
import { openTextEdit, available as skAvailable } from "../../utils/systemKeyboard.js";
import { player } from "../../utils/player/player.js";
import { countToday as histToday, isLoaded as histLoaded } from "../../utils/player/history.js";
import { dlState, onDl, offDl } from "../../utils/player/download.js";
import { stats } from "../../utils/player/cache.js";
import { fmtSize } from "../../utils/format.js";
import { ensureCover, BIG_COVER } from "../../utils/cover.js";
import { coverPair, glowGradient } from "../../utils/coverColor.js";
import { accentMixin } from "../../utils/theme.js";
import { aIcon } from "../../assets/icons.js";
import { BUILD_TAG } from "../../utils/buildInfo.js";
import { evtJson } from "../../utils/events.js";
import { log } from "../../utils/log.js";
import { pageFrameMixin } from "../../utils/ui/frame.js";
import { pageBusMixin } from "../../utils/ui/pagebus.js";

// 防重：运行时页面会挂两遍。started 只护「启动链 + 登录事件」，**不能护播放态订阅**
// （订阅若只挂第一次挂载的实例，而实际显示的是最后挂载的那个，卡片会永远停在初始状态）。
let started = false;
// 最近一次挂载的实例：boot / 登录事件这些异步回调统一写到它
let live = null;

export default {
  name: "index",
  mixins: [accentMixin, pageBusMixin, pageFrameMixin],
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
      // 登录态单独存一份（statusText / 卡片计数都靠它判断）。**必须在 data 里声明**：
      // 运行时后加的属性不参与响应式，computed 会一直返回首帧的缓存值（踩过）
      isLogged: false,
      createdCount: "—",
      subCount: "—",
      // 每日推荐卡副行的原料：**数字** = 已取到（副行于是显示日期），字符串 = 状态文案
      // （'—' 未加载 / '加载中…' / '加载失败'；未登录由 recText 直接接管）。
      // 数字本身不再直接上屏 —— 它现在只表示「今天这份已经取到手」。
      // 同理**必须在 data 里声明**：后加的属性不参与响应式（踩过）。
      recCount: "—",
      st: player.state(),
      cover: "",
      // 柔光渐变的两个颜色（**必须在 data 里声明**：后加到 this 上的属性不参与响应式，
      // computed 会一直返回首帧的缓存值 —— 卡面恒为主题色就是这么来的）
      glowColor: "", // 主色（空 = 回落主题色）
      glowColor2: "", // 次色（空 = 单色渐变；封面是单色系时取色就给 null）
      // 柔光总开关（config.glowOn，设置 → 个性化里改）。关 = 卡面退回纯色，不再叠渐变。
      // **同样必须在 data 里声明**，理由同上：否则开关改了 computed 不重算。
      // 真值在 mounted / onShow 各读一次（页面是 navTo/finish 进出，不会重新挂载）。
      glowOn: true,
      histText: "—", // 播放历史卡副行：'—'（未加载）→「今天听了 N 首」
      dl: null, // 下载活动快照（订阅 onDl；签名判重后赋值）
      dlCount: 0, // 已下载歌曲数（stats 读目录）
      dlBytes: 0,
      dlLoaded: false, // 计数是否已读过（区分 '—' 与「暂无下载」）
    };
  },
  computed: {
    bgStyle() {
      return { backgroundColor: this.bg };
    },
    /**
     * 「正在播放」卡上的**静态柔光渐变**（加，换形状）：
     * 渐变的形状/方向是写死的（utils/coverColor.js 的 GLOW_DEG / GLOW_STOPS，
     * 现在 = **左上角 → 右下角的对角双色渐变**），**只有颜色随封面走** ——
     * 播放中取封面主色（+ 次色，单色系封面就只用主色），
     * 未播放 / 取不到封面 / 平台不支持时回落当前主题色。
     * 平台只认 `linear-gradient`（没有 radial），所以只能在角度与色标上做文章；
     * 上面颜色写死在 LESS 里不行（主题色运行时可换），只能走内联。
     *
     * 总开关 config.glowOn（设置 → 个性化，加）：关 = **清空** backgroundImage，
     * 卡面只剩 @panel 底色。⚠ 这里必须显式给 `backgroundImage: ''` 而不是返回空对象 ——
     * 空对象里没有这个属性，平台不会去清掉上一次写进去的渐变，看起来就像开关失灵。
     */
    glowStyle() {
      if (!this.glowOn) return { backgroundImage: "" };
      return {
        backgroundImage: glowGradient(this.glowColor || this.accent.c, this.glowColor2),
      };
    },
    /**
     * 左栏：主页是根页、没有上一级，第一个槽位的「返回」= **退出应用**（$falcon.closeApp）；
     * 其余三键：搜索、播放列表（当前播放队列）、设置（里再进个人中心）。
     * 四键等距排满 100vh（NavRail 的几何）。
     */
    rail() {
      return [
        railBack(),
        railBtn("search", ICON.search),
        railBtn("queue", ICON.queue),
        railBtn("settings", ICON.settings),
      ];
    },
    /**
     * 右上角的登录态入口文案（可点 → 个人中心）。
     * 未登录 → 恒为「未登录」：不管 status 里跑着什么临时提示语（加载/搜索…），
     *   登录态是更前台的信息，而且它这时是唯一能进扫码的地方；
     * 已登录 → 优先让临时提示语说句话（搜索关键词、加载失败…），没有就显示昵称
     *   （昵称取 boot 那次拉的 profile，冷启动头两秒可能是空 → 兜底「已登录」）。
     */
    statusText() {
      if (!this.isLogged) return "未登录";
      return this.status || this.profile.nickname || "已登录";
    },
    /**
     * 「我的歌单」卡副行：未加载/未登录 '—' →「N 个歌单」
     * （再改：**未登录态与「每日推荐」统一显示「登录后查看」**，不再是一个光秃秃的 '—'）。
     * N = 创建 + 收藏（「我喜欢」已算在创建里，见 loadPlaylists），进歌单页才会有分类页签。
     * 判定用 typeof number：两个计数的初值都是字符串 '—'。
     * ⚠ 未登录优先于「已取到计数」：syncLogin 会把计数清回 '—'，但两个分支顺序写死在这里更稳
     *   （计数是异步回写的，登录态变化与计数回写之间没有先后保证）。
     */
    plText() {
      if (!this.isLogged) return "登录后查看";
      if (typeof this.createdCount !== "number" || typeof this.subCount !== "number") return "—";
      return this.createdCount + this.subCount + " 个歌单";
    },
    /**
     * 每日推荐卡副行：未登录「登录后查看」，其余显示**今天的月/日**（如 `10/7`）。
     * 为什么是日期而不是首数：这张卡的内容**每天换**，日期才是「这批推荐是哪天的」这个信息的正解；
     * 首数恒为 30 余首、没有信息量（要首数看列表页顶栏的「10月7日 · 32 首」）。
     * 异常态（'加载中…' / '加载失败'）直接顶上来 —— 那不是「今天的推荐」，不该拿日期糊过去。
     * ⚠ 未登录时不要把日期/数字显示出来：这张卡的内容是**账号相关**的，
     *   显示日期会让它看起来「已经就绪」，点进去却要扫码（同歌单计数那条约定）。
     */
    recText() {
      if (!this.isLogged) return "登录后查看";
      if (typeof this.recCount === "string" && this.recCount !== "—") return this.recCount;
      return todayMD();
    },
    nowTitle() {
      const c = (this.st && this.st.cur) || {};
      return c.name || "未在播放";
    },
    nowArtist() {
      const c = (this.st && this.st.cur) || {};
      if (c.artist) return c.artist;
      return this.hasTrack ? "" : "选择音乐以播放";
    },
    hasTrack() {
      return !!(this.st && this.st.hasTrack);
    },
    /** 暂停中（或还没出声）显示 ▶，播放中显示 ⏸ —— 底是实心主题色，走 fgIcon 取深色版 */
    playIcon() {
      return this.fgIcon(this.st.paused || !this.st.isPlaying ? "play" : "pause");
    },
    /**
     * 本地下载卡副行（**只显示曲目数量**，体积不再上屏）：
     * '—'（未加载）→「N 首」→「暂无下载」；下载中优先显示进度「下载中 k/N」。
     * ⚠ 体积（dlBytes / fmtSize）仍要拉：下载页顶栏与日志用得上，只是这张卡不再显示。
     */
    dlText() {
      const d = this.dl;
      if (d && d.active) {
        if (d.stopping) return "正在停止下载…";
        const k = d.done + d.failed + (d.cancelled || 0);
        return "下载中 " + (k < d.total ? k + 1 : k) + "/" + d.total;
      }
      if (!this.dlLoaded) return "—";
      if (!this.dlCount) return "暂无下载";
      return this.dlCount + " 首";
    },
  },
  mounted() {
    const self = this;
    this._dead = false;
    live = this; // 启动链回调的落点（一次性 Promise，不是订阅 —— 见 utils/ui/pagebus.js 的边界说明）
    // 柔光开关（设置 → 个性化）。这里 config 可能还没 load（boot 在下面才跑），
    // 未 load 时 get 返回 undefined → `!== false` 判为开，与 DEFAULTS 一致，不会闪错。
    this.glowOn = config.get("glowOn") !== false;

    // ---- 播放态订阅（每个实例都订；签名判重，别让 500ms 的 tick 把渲染打爆）----
    this._sig = "";
    this._handler = function (s) {
      self.onPlayer(s);
    };
    player.on(this._handler);
    this.onPlayer(player.state());
    this.syncHist();
    this.syncLogin();

    // ---- 本地下载卡：下载活动订阅（进度）+ 计数（文件系统的真相；exec 一次别频繁调）----
    this._dlOff = onDl(function (s) {
      self.syncDl(s);
    });
    this.syncDl(dlState());
    this._onShow = function () {
      self.loadDownloads();
      // 从个人中心退出登录后返回主页时，没有事件会通知这里 —— 靠重新可见刷一次
      self.syncLogin();
      // 开关页（设置 → 个性化）改完返回：页面不重新挂载，靠 show 把开关值刷进来
      self.glowOn = config.get("glowOn") !== false;
      self.loadRecommend(); // 命中当日缓存 → 零成本；跨天了就重取
    };
    try {
      /* global $falcon */
      this.$page.on("show", this._onShow);
    } catch (e) {}
    this.loadDownloads();

    // ---- 启动链 + 登录事件（只跑一次，异步回调写 live）----
    if (!started) {
      started = true;
      log("index", "门户页启动");
      boot().then(function (p) {
        if (p && p.nickname && live) live.profile = p;
        if (!live) return;
        live.syncLogin(); // boot 里 config.load() 已跑完，这里再补一次开关真值
        live.glowOn = config.get("glowOn") !== false;
        live.loadPlaylists();
        live.loadRecommend();
      });
    }
    // ---- 跨页事件（注册/退役见 utils/ui/pagebus.js；由页面栈上层存活实例处理）----
    this.onPageEvent("bpncm:login-done", "onLoginDone");
    this.onPageEvent("bpncm:playlist-changed", "onPlaylistChanged");
    this.onPageEvent("bpncm:playhist", "onPlayhist");
  },
  beforeDestroy() {
    this._dead = true;
    if (this._handler) player.off(this._handler);
    this._handler = null;
    if (this._dlOff) offDl(this._dlOff);
    this._dlOff = null;
    try {
      if (this._onShow) this.$page.off("show", this._onShow);
    } catch (e) {}
    this._onShow = null;
  },
  methods: {
    /** 四张文字卡的裸图标：按当前主题色取 PNG（平台不能给 <image> 染色，见 assets/icons.js 的 aIcon） */
    cico(key) {
      return aIcon(key, this.accent.key);
    },
    /* ---- 跨页事件处理（pagebus 派发给页面栈上层存活实例）---- */
    onLoginDone() {
      this.profile = cachedProfile();
      this.keyword = "";
      this.syncLogin();
      this.loadPlaylists(true);
      this.loadRecommend(true);
    },
    onPlaylistChanged(evt) {
      // 歌单详情页删/收藏了歌单 → 「我的歌单」卡的计数要跟着变（否则一直是旧数字）。
      // 改名不影响卡片上的计数（首页卡片只显示总数「N 个歌单」），不为它重拉整份歌单列表。
      // 负载被框架套了一层壳（{type,timestamp,data}），必须解包 —— 见 utils/events.js
      const d = evtJson(evt) || {};
      if (d.op !== "rename") this.loadPlaylists(true);
    },
    onPlayhist() {
      // 播放历史变了（记录/清空/载入完成）→ 卡片上的最近歌名跟着变
      this.syncHist();
    },
    /**
     * 播放态推送：**必须自己判重**——player 每 500ms 换一个全新的 state 对象
     * （positionMs/status 一直在变），照单全收就是持续重渲染；而本平台 watch 不去重
     * （见 AGENTS.md 平台坑 16）。签名只含「卡片上看得见的东西」。
     */
    onPlayer(s) {
      const c = (s && s.cur) || {};
      const k =
        (c.id || 0) +
        "|" +
        (c.name || "") +
        "|" +
        (c.artist || "") +
        "|" +
        (c.cover || "") +
        "|" +
        (s.paused ? 1 : 0) +
        (s.isPlaying ? 1 : 0) +
        (s.hasTrack ? 1 : 0);
      if (k === this._sig) return;
      this._sig = k;
      this.st = s;
      this.syncCover();
    },
    /** 封面：按 id+cover 判重（搜索结果的封面是详情接口后补的），回调里再校验一次 id */
    syncCover() {
      const self = this;
      const c = (this.st && this.st.cur) || {};
      const key = (c.id || 0) + "|" + (c.cover || "");
      if (key === this._coverKey) return;
      this._coverKey = key;
      // 封面照旧清空（换歌期间显示灰色音符占位 —— 它是**中性**的，属于「未就绪」，
      // 不会跟前后两张封面产生色相冲突；反过来若保留旧图，就会出现「图是上一首、
      // 标题已经是下一首」的自相矛盾，看着像显示错了）。
      this.cover = "";
      if (!c.id) {
        // 没有曲目在播（停止播放 / 冷启动未播放）→ 卡片写的是「未在播放」，
        // 还留着上一首的颜色属于说谎 —— **只有这时**才丢掉旧色、回落主题色。
        this.glowColor = "";
        this.glowColor2 = "";
        return;
      }
      // 有曲目：柔光色**故意不清**。
      // 旧写法在这儿清空，取色那 ~100ms（封面大/设备忙时更久）里卡面会闪一下**主题色** ——
      // 主题色是饱和的红/青/紫，跟上一首往往不是一个色系，那一跳比「颜色暂时没跟上」刺眼得多，
      // 连点下一首还会连着闪。现在换成「旧色 → 新色」直接过渡，中间不出现回落。
      // 取色失败 / 封面缺失 / 连点导致回调被 id 校验丢弃时，旧色自然一直顶着：
      // 它是用户刚看过的颜色，比跳成主题色更接近当前语境（取色失败是常态性失败，
      // 一旦 execBroken 之后每首都失败，这时回落主题色等于改动白做一半）。
      if (!c.cover) return;
      ensureCover(
        { id: c.id, cover: c.cover },
        function (cid, p) {
          if (p && cid === c.id) self.cover = p;
          if (p) self.loadGlow(p, cid);
        },
        BIG_COVER,
      );
    },
    /**
     * 封面就绪 → 取主色（+次色）→ 填柔光。异步且失败静默（**沿用上一首的颜色**，
     * 不回落主题色 —— 见 syncCover 里那段注释）；
     * 回来时校验曲目 id 仍是当时那首，否则丢弃（连点下一首会乱序回来）。
     */
    async loadGlow(path, id) {
      const pair = await coverPair(path);
      if (this._dead) return;
      const c = (this.st && this.st.cur) || {};
      if (!pair || c.id !== id) return;
      this.glowColor = pair[0];
      this.glowColor2 = pair[1] || "";
      log("index", "柔光取色 id=" + id + " → " + pair[0] + (pair[1] ? " + " + pair[1] : "（单色系）"));
    },

    /**
     * 登录态同步（mounted / 重新可见 / boot 完成 / 登录成功 四处都要刷）。
     * ! 退出登录没有广播事件（logout() 只清数据），所以从个人中心返回主页时必须靠 onShow 补一次。
     * 未登录顺手把歌单计数与每日推荐清回 '—'：卡片上留着上次登录后那个数字等于说谎
     * （两张账号相关的卡的文案本身由 plText / recText 按 isLogged 接管 → 「登录后查看」）。
     */
    syncLogin() {
      this.isLogged = loggedIn();
      if (!this.isLogged) {
        this.createdCount = "—";
        this.subCount = "—";
        this.recCount = "—";
      }
    },
    /** 右上角点一下 → 个人中心（未登录时那里就有「扫码登录」按钮，不用多绕一层） */
    openAccount() {
      go("account");
    },

    /* ---- 歌单数据（只供歌单卡片的计数与顶栏状态） ---- */
    async loadPlaylists(force) {
      const self = this;
      if (!loggedIn()) {
        // 不再在这里写 this.status = '未登录'：右上角文案由 statusText 统一给，
        // 两处各写一遍早晚对不上（那边改了这边没改，就会出现「显示已登录但点进去要扫码」）
        this.syncLogin();
        return;
      }
      const uid = config.get("userId") || this.profile.userId || 0;
      if (!uid) return;
      this.status = "加载歌单...";
      try {
        const r = await loadUserPlaylists(uid, force);
        // 「我喜欢」在歌单页归入「创建」页签并置顶，这里跟着算，点进去数量才对得上
        const created = r.created.length + (r.liked ? 1 : 0);
        // 只存数字，卡片上怎么显示交给 plText（起是总数「N 个歌单」）
        self.createdCount = created;
        self.subCount = r.subscribed.length;
        // 顶栏不再重复计数：数量看歌单卡就行，这里只在
        // 异常/搜索/未登录这些「真的需要说一句」的时候才占用
        self.status = "";
        log("index", "歌单: 创建=" + created + "（含我喜欢 " + (r.liked ? 1 : 0) + "）收藏=" + r.subscribed.length);
      } catch (e) {
        self.status = "歌单加载失败";
        log("index", "歌单加载失败 " + ((e && e.message) || e));
      }
    },

    /* ---- 每日推荐（卡片只需「有几首」；列表页才要曲目本体） ---- */
    /**
     * 取当日推荐数。命中当日缓存（模块级，见 utils/ncm/recommend.js）就是零成本，
     * 所以 mounted / onShow / 登录成功三处都敢直接调。
     * force=true（刚登录 / 换账号）强制重取 —— 缓存不区分账号，退出登录时已作废，这里双保险。
     */
    async loadRecommend(force) {
      if (!loggedIn()) {
        this.recCount = "—";
        return;
      }
      // 有当日缓存就用，别闪一下「加载中…」（从列表页返回首页是高频路径）
      const c = force ? null : cachedDaily();
      if (c) {
        this.recCount = c.length;
        return;
      }
      if (typeof this.recCount === "number" && !force) return;
      this.recCount = "加载中…";
      try {
        const songs = await loadDailyRecommend(force);
        if (this._dead) return;
        this.recCount = (songs && songs.length) || 0;
        log("index", "每日推荐卡: 今日 " + this.recCount + " 首");
      } catch (e) {
        if (this._dead) return;
        this.recCount = "加载失败";
        log("index", "每日推荐加载失败 " + ((e && e.message) || e));
      }
    },
    /** 点卡片：未登录 → 个人中心（那里有扫码，与右上角同一去处）；已登录 → 曲目列表页 */
    openRecommend() {
      if (!this.isLogged) {
        go("account");
        return;
      }
      go("list", { kind: "recommend", name: "每日推荐" });
    },

    /* ---- 左栏分派（骨架见 ui/frame.js）：主页的「返回」是退出应用，不是 $page.finish() ---- */
    async onBack() {
      // 「退出时暂停音乐」（默认开，设置页可关）：先停住再关应用 —— SoundPlayer 是独立系统
      // 进程，应用退出带不走它。内部有 800ms 兜底超时，卡住也能正常退出。
      try {
        await player.pauseForExit();
      } catch (e) {}
      log("index", "退出应用");
      try {
        /* global $falcon */
        $falcon.closeApp();
      } catch (e) {
        log("index", "closeApp 失败: " + ((e && e.message) || e));
      }
    },
    onRailKey(key) {
      if (key === "search") this.openKb();
      else if (key === "queue") go("queue");
      else if (key === "settings") go("settings");
    },

    /* ---- 当前播放卡 ---- */
    openPlayer() {
      // 暂停键若被平台按冒泡语义传导过来（本平台不支持 stopPropagation），忽略这一次
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
    /**
     * 点「我的歌单」卡：未登录 → 个人中心扫码（与「每日推荐」卡同一去处），
     * 已登录 → 带「创建 / 收藏」pivot 的歌单页。
     * 为什么不再直接进歌单页：我的歌单是**账号数据**，未登录进去只能看到一个空壳页，
     * 而副行这时已经写着「登录后查看」—— 文案与点击去处必须一致，否则点下去等于被骗进去。
     */
    openPlaylists() {
      if (!this.isLogged) {
        go("account");
        return;
      }
      go("playlists", {});
    },
    /* ---- 本地下载卡 ---- */
    /**
     * 下载活动 → 卡片副行。**签名判重**（活动快照 ~400ms 一发，坑 16 同族）；
     * 活动从有到无 → 刷新一次计数（批量下载完成的文件数要更新）。
     */
    syncDl(s) {
      const d = s || {};
      const sig =
        (d.active ? 1 : 0) +
        "|" +
        d.total +
        "|" +
        (d.done + d.failed + (d.cancelled || 0)) +
        "|" +
        (d.stopping ? 1 : 0);
      if (sig !== this._dlSig) {
        this._dlSig = sig;
        this.dl = d;
      }
      const active = !!d.active;
      if (this._wasActive && !active) this.loadDownloads();
      this._wasActive = active;
    },
    /** 已下载计数（cache.js 的 stats：exec du/ls 一次调用；只在挂载/下载结束/重新可见时调） */
    async loadDownloads() {
      const s = await stats();
      if (this._dead) return;
      this.dlCount = (s && s.songs && s.songs.count) || 0;
      this.dlBytes = (s && s.songs && s.songs.bytes) || 0;
      this.dlLoaded = true;
      log("index", "本地下载卡: " + this.dlCount + " 首 / " + fmtSize(this.dlBytes));
    },
    openDownloads() {
      go("downloads");
    },
    /**
     * 播放历史卡副行：未加载 '—' → 「今天听了 N 首」。
     * 值判重（同 onPlayer 的理由：平台 watch 不去重；每 500ms 一发的事件会反复调到这里）。
     */
    syncHist() {
      let t = "—";
      if (histLoaded()) t = "今天听了 " + histToday() + " 首";
      if (t === this.histText) return;
      this.histText = t;
    },
    openHistory() {
      go("list", { kind: "history", name: "播放历史" });
    },

    /* ---- 搜索（系统输入法） ----
       两条入口约定：
         ① **每次点搜索都从空框开始** —— 首页实例在页面栈里是复用的，`keyword` 会一直留着，
            不清的话第二次点进来输入法是带着上一次的关键词弹出来的，想搜新歌还得先删干净。
         ② **输入为空就不进结果页** —— 空关键词会拉回一份没有意义的（多半是空的）搜索结果，
            这种「进去了还得再退出来」不如直接留在主页：等同取消。 */
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
        // 自绘键盘已弃用：系统输入法不可用时只提示，不再弹兜底键盘
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
      // trim 一并去掉中文全角空格；纯空白与空串同样按「没输入」处理
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
  /* 底色由内联 :style 给（主题可换，见 utils/theme.js） */
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
/* 右上角登录态入口（可点 → openAccount）。
   **左右各 4vh 内边距是拿来撑命中区的**：字号只有 @fs-mute（14.4px），「未登录」三个字
   约 43px 宽、字高更小，紧贴着点很容易落空（屏幕上这块只有指甲盖大）。
   竖向不加 padding —— 顶栏高 15vh，加上下内边距有被 overflow 裁掉的风险。
   外边距从 4vh 收到 1vh 抵掉新增的右内边距，视觉位置基本不动（净 +1.2vh）。 */
.idx-status {
  font-size: @fs-mute;
  color: @text-3;
  padding-left: 4vh;
  padding-right: 4vh;
  margin-right: 1vh;
}

/* ---- 横向卡片流 ----
   竖向预算（改任一常量都要重推这条链）：
     屏 100 − 顶栏 15 = 85vh 可用空间；
     scroller 上下 padding 各 6vh + 卡高 70vh = 82vh ≤ 85vh，**留 3vh 余量**。
   零余量不行：1vh=2.4px 会被取整，横向 scroller 是 overflow:hidden，溢出会被静默裁掉。
   兜底方案（若真机上 scroller 不吃竖向 padding）：给 .idx-row 写死 height: 85vh。

   ⚠ 宽度 >100vh 的卡**不能用 vh**（真机实测）：写 `width: 172vh` 渲染出来只有
   239px（≈100vh），而 88vh 的卡正常 —— vh 宽度被截到 100vh。所以这里用**百分比**：
   百分比的基准是 scroller 内容区宽（≈960px = 1020 − 左栏 25vh），不受该限制
   （同 .ply-seekmask 的 width:100%）。 */
.idx-row {
  flex: 1;
  padding: 6vh 3vh;
}
/* 卡片公共外观。**布局属性（宽度/排列方向/对齐）一律放各卡自己的类**，
   避免 .idx-card 与 .idx-xxx 在同一节点上出现同名属性（平台按加载顺序定胜负，不靠谱）。 */
.idx-card {
  height: 70vh;
  background-color: @panel;
  border-width: 1px;
  border-style: solid;
  border-color: @line;
  /* 圆角比全局卡片大（「大一点」）：6vh = 14.4px，原来的 @radius(2.5vh)
     是 6px，在 70vh=168px 的卡上几乎看不出来。
     ⚠ **这里故意不改用 @radius token**：它是全局的，动它会把歌单页/列表页/设置页所有卡片
     一起放大（token 全局生效，见 AGENTS.md），本次只改首页 —— 所以写字面量。 */
  border-radius: 6vh;
  margin-right: 4vh;
}

/* 1) 当前播放：58vh 封面 + 文本列（标题/歌手/歌词）+ 22vh 按钮竖列（43% ≈ 172vh；不能用 vh，见上）

   卡面在 @panel 底色之上还有一层**静态柔光渐变**（左上角最亮、沿对角收到右下，
   封面有两个色相时颜色也从主色过渡到次色），
   颜色由模板内联 `:style="glowStyle"` 给 —— 播放中 = 封面取色，未播放 = 当前主题色，
   两者都是运行时的值，写在这里没用（见 utils/coverColor.js）。 */
.idx-now {
  width: 48%; /* 宽度：43% → 50% → **48%**（43% ≈ 404px → 48% ≈ 457px）
                               ⚠ 代价：后面四张文字卡整体右移。文字卡一路收到 **23%**（248 → 219px）
                               找补回来了（26% → 24% → 23%）。
                               一屏账（估算，基准 960px、间距 4vh=9.6、起点 x≈74、内容区右沿 1019）：
                               首卡右沿 531 → 卡 2（每日推荐）右沿 760 → **卡 3（我的歌单）完整**（右沿 989）；
                               卡 4（本地下载）只露 13px，卡 5 要滑过去看。 */
  flex-direction: row;
  align-items: center;
  padding-left: 5vh;
  padding-right: 5vh;
  position: relative; /* 底部进度线（now-progress）的定位基准；.idx-card 没设 position，必须在这里给 */
  /* 圆角放大后要**裁剪子元素**：底部进度线是 `bottom:0` 的通栏直条，
     在 14.4px 圆角下左右两端各有 ~5px 会戳到卡轮廓外面，露出两个方角。
     卡内其它内容都不碰圆角（封面 58vh 在 70vh 卡内居中，上下各留 6vh = 14.4px，
     顶边正好落在圆心高度那一线上，切入量为 0），裁掉的无非是那根线的两个角。 */
  overflow: hidden;
}
.idx-cv {
  width: 58vh;
  height: 58vh;
  flex: none;
  border-radius: 1.8vh;
  background-color: @panel-2;
  overflow: hidden;
  align-items: center; /* 无封面时灰音符居中（有封面时封面 58vh 铺满，居中是无操作） */
  justify-content: center;
}
.idx-cvi {
  width: 58vh;
  height: 58vh;
}
.idx-cvi-note {
  width: 26vh; /* 58vh 封面盒的 45%，占位符的常见比例 */
  height: 26vh;
}
/* 文本列吸收剩余宽度；min-width:0 + overflow:hidden 才能让省略号生效（同 .ply-right） */
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
/* 按钮竖列：暂停在上、下一首在下。22+6+22 = 50vh，
   在 70vh 卡内垂直居中 → 上下各留 10vh；封面 58vh 上下各留 6vh，两者不必对齐。 */
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
  border-radius: 11vh; /* 22vh 见方 → 正圆；平台不认 50% */
  background-color: @accent; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
  align-items: center;
  justify-content: center;
}
.idx-play-ico {
  width: 11vh;
  height: 11vh;
}
/* 下一首：次级键（同播放页 .ply-btn 的底），别跟主控键抢视觉重心 */
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

/* ---- 四张文字卡的公共件 ----
   这几个类名与其它类无属性重叠，可以只写一份（.idx-pl/.idx-dl/.idx-hist 那三个
   同名属性必须各写各的，见 .idx-card 上面那条警告）。

   图标：**主题色裸图标、不带底**，23vh = 55.2px。
   颜色是烙在 PNG 里的（平台不能给 <image> 染色），所以**每个主题色各有一张 PNG**：
   由 scripts/gen_icons.py 的 ACCENT_ICONS 生成，模板用 `cico('pl'|'dl'|'hist')` 取
   （见 assets/icons.js 的 aIcon）。key 按**用途**命名（pl/dl/hist），
   所以白色 download 仍归播放器页。
   ⚠ 上边距必须与左边距相等（都是 5vh）—— 见下面三个卡类里的说明；这与图标大小无关（墨迹内缩会跟着缩放）。 */
.idx-cico {
  width: 23vh;
  height: 23vh;
  flex: none;
}
/* 撑空节点：吸收「上组（图标）↔ 下组（标题/副行）」之间的余量。
   ⚠ 别用写死的 margin-top 代替它：文本行盒高由平台行高决定（≠ font-size），
   写死的总高一旦超过卡高 70vh，卡是 overflow:hidden —— 副行会被静默裁掉一截。
   2 倍图标下这块约 26px（3 倍时只剩 8px，所以最后退回了 2 倍）。 */
.idx-tcfill {
  flex: 1;
}
/* 卡片标题：@fs-strong 8.5vh → 10vh。
   仍小于「当前播放」卡的 @fs-title 11vh，层级不变。 */
.idx-ct {
  font-size: 10vh;
  font-weight: bold;
  color: @text;
}

/* 2) 每日推荐：与「我的歌单」同宽（23%），副行是**今天的月/日**（如 10/7；未登录「登录后查看」）。
   副行宽度账：最宽的是异常态「登录后查看」约 96px，日期（约 45px）与「加载中…/加载失败」（约 77px）
   都更短，内容宽 197px —— 余量充足。 */
.idx-rec {
  width: 23%;
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

/* 3) 歌单列表（26% ≈ 104vh）。版式：图标贴顶、文本贴底。

   **上边距 = 左边距 = 5vh**（视觉平衡：到左、上距离相等）。
   不能照抄「上 1.5vh」那种更小的值：Lucide 图形在盒子里自带内缩，且横竖内缩比例相同
   （library 的墨迹 bbox 在 72px 图里是 8..64，x/y 都是 8/72 ≈ 11%），
   所以「内边距相等」=「墨迹到左、到上的距离相等」，一眼看过去才是等距的。
   下边距也给 5vh 让上下对称；副行字底会因行距比上边距视觉上略紧一点，属正常。 */
/* 四张文字卡的统一宽度：26% ≈ 248px → 24% ≈ 229px → **23% ≈ 219px**。
   ⚠ 副行的宽度账（改窄就要重算）：卡内可用文字宽 = 219 − 左 5vh(12) − 右 4vh(9.6) ≈ 197px。
   8vh=19.2px 下最长的副行「今天听了 18 首」真机约 134px，余量还有 60px 上下，安全。
   本地下载卡只显示「N 首」，比「N 首 · X MB」更短，不再需要单独量体积文案。 */
.idx-pl {
  width: 23%;
  flex-direction: column;
  align-items: flex-start;
  padding-top: 5vh;
  padding-bottom: 5vh;
  padding-left: 5vh;
  padding-right: 4vh;
}
/* 副行：8vh。
   现在内容是「N 个歌单」——
   宽度账：8vh=19.2px 下「123 个歌单」真机约 130px，内容宽 197px，余量充足。
   ⚠ 若哪天又要拆开显示，注意「10 个创建 · 113 个收藏」在 16.8px 就占 175px（雅黑）、
   放大到 19.2px 后真机约 220px ≈ 内容宽的全部 —— 必漏省略号，所以把「个」去掉、数字后置
   （真机约 178px），仍然很紧。 */
.idx-cn {
  width: 100%;
  font-size: 8vh;
  color: @text-2;
  margin-top: 1.5vh;
  lines: 1;
  text-overflow: ellipsis;
}

/* 4) 本地下载：与「我的歌单」同宽（23%），副行是「N 首」/ 下载中进度（只显示曲目数量）。
   副行 text 要 width:100% 才吃 ellipsis —— column 容器里 align-items:flex-start
   会让 text 收缩到内容宽，长文案会把卡片撑出去（同 .idx-hist-t 的坑） */
.idx-dl {
  width: 23%;
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

/* 5) 播放历史：与「我的歌单」同宽（23%），副行是「今天听了 N 首」。
   副行 text 要 width:100% 才吃 ellipsis —— column 容器里 align-items:flex-start
   会让 text 收缩到内容宽，长文案会把卡片撑出去 */
.idx-hist {
  width: 23%;
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
