import { loadUserPlaylists } from '../../services/ncm/playlist.js';
import { loadDailyRecommend, cachedDaily } from '../../services/ncm/recommend.js';
import { loggedIn, cachedProfile } from '../../services/ncm/login.js';
import config from '../../core/infra/config.js';
import { countToday as histToday, isLoaded as histLoaded } from '../../services/player/history.js';
import { stats } from '../../services/player/cache.js';
import { dlSig } from '../../services/player/download.js';
import { fmtSize } from '../../core/infra/format.js';
import { evtJson } from '../../core/infra/events.js';
import { log } from '../../core/infra/log.js';

export const homeDataMixin = {
  methods: {
    onLoginDone() {
      this.profile = cachedProfile();
      this.keyword = "";
      this.syncLogin();
      this.loadPlaylists(true);
      this.loadRecommend(true);
    },
    // 歌单详情页删/收藏了歌单 → 「我的歌单」卡的计数要跟着变（否则一直是旧数字）。
    // 改名不影响卡片上的计数（首页只显示总数），不为它重拉整份歌单列表。
    // 负载被框架套了一层壳（{type,timestamp,data}），必须解包 —— 见 core/infra/events.js
    onPlaylistChanged(evt) {

      const d = evtJson(evt) || {};
      if (d.op !== "rename") this.loadPlaylists(true);
    },
    // 播放历史变了（记录/清空/载入完成）→ 卡片上的最近歌名跟着变
    onPlayhist() {

      this.syncHist();
    },

    syncLogin() {
      this.isLogged = loggedIn();
      if (!this.isLogged) {
        this.createdCount = "—";
        this.subCount = "—";
        this.recCount = "—";
      }
    },

    async loadPlaylists(force) {
      const self = this;
      if (!loggedIn()) {

        this.syncLogin();
        return;
      }
      const uid = config.get("userId") || this.profile.userId || 0;
      if (!uid) return;
      this.status = "加载歌单...";
      try {
        const r = await loadUserPlaylists(uid, force);

        const created = r.created.length + (r.liked ? 1 : 0);

        self.createdCount = created;
        self.subCount = r.subscribed.length;

        self.status = "";
        log("index", "歌单: 创建=" + created + "（含我喜欢 " + (r.liked ? 1 : 0) + "）收藏=" + r.subscribed.length);
      } catch (e) {
        self.status = "歌单加载失败";
        log("index", "歌单加载失败 " + ((e && e.message) || e));
      }
    },

    async loadRecommend(force) {
      if (!loggedIn()) {
        this.recCount = "—";
        return;
      }

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

    syncHist() {
      let t = "—";
      if (histLoaded()) t = "今天听了 " + histToday() + " 首";
      if (t === this.histText) return;
      this.histText = t;
    },
    syncDl(s) {
      const d = s || {};
      const sig = dlSig(d);
      if (sig === this._dlSig) return;
      this._dlSig = sig;
      this.dl = d;
      const active = !!d.active;
      if (this._wasActive && !active) this.loadDownloads();
      this._wasActive = active;
    },

    async loadDownloads() {
      const s = await stats();
      if (this._dead) return;
      this.dlCount = (s && s.songs && s.songs.count) || 0;
      this.dlBytes = (s && s.songs && s.songs.bytes) || 0;
      this.dlLoaded = true;
      log("index", "本地下载卡: " + this.dlCount + " 首 / " + fmtSize(this.dlBytes));
    },
  },
};
