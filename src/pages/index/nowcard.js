import { dlText as dlBarText } from '../../services/player/download.js';
import { ensureCover, BIG_COVER } from '../../services/cover/cover.js';
import { coverPair, glowGradient } from '../../services/cover/color.js';
import { log } from '../../core/infra/log.js';

export const nowCardMixin = {
  computed: {
    // 五张卡的**定宽（px）**，两机型完全一致。不能写百分比：percent 基准是 scroller 内容盒，
    // 卡片自身还有 padding/边框/间距，会算过右沿；更关键是百分比随机型漂移。也不能写 vh：
    // 平台把任何 >100vh 的 vh **宽度**静默截到 100vh（当前播放卡 530px 在 X3S 上 ≈ 209vh）。
    // 取值以窄的 X3S 为基准反推（S7 更宽 → 只会在末尾多露一点，不会挤）：大卡 480、小卡 169。
    // 改这两个数前先按 720 / 946 两条可用宽预算重算首屏露几张。
    nowW() {
      return 480;
    },
    cardW() {
      return 169;
    },
    // 「正在播放」卡的静态柔光渐变：形状/方向写死在 cover/color.js 的 GLOW_DEG / GLOW_STOPS，
    // 只有颜色随封面走（播放中取封面主色 + 次色，单色系只取主色）；未播放/取不到时回落主题色。
    // 平台只认 linear-gradient（没有 radial）；颜色不能写死在 LESS 里（主题色运行时可换）→ 只能内联。
    // ⚠ 关闭时这里必须显式给 backgroundImage: '' 而不是返回空对象 —— 空对象里没有这个属性，
    // 平台不会去清掉上一次写进去的渐变，看起来就像开关失灵。
    glowStyle() {
      if (!this.glowOn) return { backgroundImage: "" };
      return {
        backgroundImage: glowGradient(this.glowColor || this.accent.c, this.glowColor2),
      };
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

    // 本地下载卡副行（只显示曲目数量，体积不再上屏）：下载中交给 download.js 的 dlText
    // （算式只有那一份），否则 '—' /「N 首」/「暂无下载」。卡片定宽 169px，去掉尾部 ` · NN%`
    // 才不折行；进度百分比在下载页看。体积仍要拉：下载页顶栏与日志用得上。
    dlText() {
      const dl = dlBarText(this.dl);
      if (dl) return dl.replace(/\s·\s\d+%$/, "");
      if (!this.dlLoaded) return "—";
      if (!this.dlCount) return "暂无下载";
      return this.dlCount + " 首";
    },
  },
  methods: {
    // 播放态推送：必须自己判重 —— player 每 500ms 换一个全新的 state 对象
    // （positionMs/status 一直在变），照单全收就是持续重渲染；而本平台 watch 不去重。
    // 签名只含「卡片上看得见的东西」。
    onPlayer(s) {

      if (!this._vis) return;
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

    // 封面：按 id+cover 判重（搜索结果的封面是详情接口后补的），回调里再校验一次 id
    syncCover() {
      const self = this;
      const c = (this.st && this.st.cur) || {};
      const key = (c.id || 0) + "|" + (c.cover || "");
      if (key === this._coverKey) return;
      this._coverKey = key;

      // 换歌期间显示灰色音符占位 —— 它是中性的，属于「未就绪」，不会跟前后两张封面产生色相冲突；
      // 反过来若保留旧图，就会出现「图是上一首、标题已经是下一首」的自相矛盾。
      this.cover = "";
        // 没有曲目在播（停止播放 / 冷启动未播放）→ 卡片写的是「未在播放」，还留着上一首的颜色属于说谎；
        // 只有这时才丢掉旧色、回落主题色。有曲目时柔光色**故意不清**：旧写法在这儿清空，
        // 取色那 ~100ms 里卡面会闪一下主题色（跟上一首往往不是一个色系，连点下一首还会连着闪）。
      if (!c.id) {

        this.glowColor = "";
        this.glowColor2 = "";
        return;
      }

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

    async loadGlow(path, id) {
      const pair = await coverPair(path);
      if (this._dead) return;
      const c = (this.st && this.st.cur) || {};
      if (!pair || c.id !== id) return;
      this.glowColor = pair[0];
      this.glowColor2 = pair[1] || "";
      log("index", "柔光取色 id=" + id + " → " + pair[0] + (pair[1] ? " + " + pair[1] : "（单色系）"));
    },

  },
};
