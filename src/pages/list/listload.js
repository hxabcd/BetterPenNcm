import { go } from '../../core/infra/nav.js';
import { player } from '../../services/player/player.js';
import { cachedPlaylistRole, fetchPlaylistInfo, roleOf } from '../../services/ncm/playlist.js';
import { appendUnique } from '../../services/player/listkinds.js';
import { loadMore as cursorLoadMore, sorted as cursorSorted, ensureAllSongs as cursorEnsureAll, queuePlayAll as cursorQueuePlayAll, queueFromRow as cursorQueueFromRow } from '../../services/player/listcursor.js';
import { isIndexed } from '../../services/player/locallists.js';
import config from '../../core/infra/config.js';
import { evtJson } from '../../core/infra/events.js';
import { log } from '../../core/infra/log.js';
import { ROW_PX_SONG } from '../../ui/paging.js';

export const listLoadMixin = {
  methods: {
    // 列表页骨架声明（见 ui/mixins/listpage.js）：切片数组与行高
    listPageConfig() {
      return { slice: 'songs', shown: 'shown', rowPx: ROW_PX_SONG }
    },

    // 按导航参数重置路由状态并加载列表；同一参数（页面挂两遍）直接跳过，保证挂载幂等。
    openList(p) {
      const params = p || {};
      const kind = params.kind || "search";
      const id = Number(params.id) || 0;
      const routeKey = [kind, id, params.keyword || "", Number(params.stype) || 1, params.name || "", params.order || ""].join("|");
      if (routeKey === this._routeKey) return;
      const routeParams = {
        kind: kind,
        id: id,
        keyword: params.keyword || "",
        stype: Number(params.stype) || 1,
        name: params.name || "",
        order: params.order || "",
      };
      this._routeKey = routeKey;
      const token = (this._loadToken || 0) + 1;
      this._loadToken = token;

      this.exitMulti();
      this.hideToast();
      this.panel = "";
      this.catOpen = false;
      this.kind = kind;
      this.title = "歌曲";
      this.sub = "";
      this.songs = [];
      this.items = [];
      this.shown = 0;
      this.cursor = 0;
      this.allLoaded = false;
      this.noMore = false;
      this.selectingAll = false;
      this.searchType = Number(params.stype) || 1;
      this.keyword = params.keyword || "";
      this.hint = "加载中...";
      this.trackIds = [];
      this.fullSongs = [];
      this.addTimes = {};
      this.total = 0;
      this.order = params.order === "time" ? "time" : "hot";
      this.artistId = id;
      this.artistName = "";
      this.loadingMore = false;
      this.sortKey = "";
      this.sortAsc = false;
      this.pid = 0;
      this.canManage = false;
      this.plRole = "";
      this.subscribed = false;
      this.indexed = false;
      this.loadingAll = false;
      this._gone = false;
      if (routeParams.name) {
        this.title = routeParams.name;
        this.artistName = routeParams.name;
      }
      if (this.kind === "liked" || this.kind === "playlist") {
        this.pid = id;

        this.plRole = cachedPlaylistRole(this.pid) || (this.kind === "liked" ? "liked" : "");
        this.applyRole();
        if (!this.plRole) this.resolvePlaylist(token);
        else this.loadIndexed();
      }
      log(
        "list",
        "onLoad " + JSON.stringify(routeParams) + " pid=" + this.pid + " role=" + this.plRole + " manage=" + this.canManage,
      );
      this.load(routeParams, token);
    },

    applyRole() {
      this.canManage = this.plRole !== "subscribed";

      this.subscribed = this.plRole === "subscribed";
    },

    async resolvePlaylist(token) {
      const self = this;
      const pid = this.pid;
      if (!pid) return;
      try {
        const info = await fetchPlaylistInfo(pid);
        if (self._dead || pid !== self.pid || token !== self._loadToken) return;
        const me = Number(config.get("userId")) || 0;
        if (info.creatorId) {
          self.plRole = roleOf({ creatorId: info.creatorId, specialType: info.specialType, me: me });
        }
        self.applyRole();
        self.subscribed = info.subscribed; 
        log("list", "歌单归属 " + self.plRole + " subscribed=" + info.subscribed + " pid=" + pid);
        self.loadIndexed();
      } catch (e) {
        log("list", "歌单详情失败（按可写处理）" + ((e && e.message) || e));
      }
    },

    async loadIndexed() {
      if (this.kind !== "playlist" || !this.pid) return;
      try {
        const v = await isIndexed(this.pid);
        if (this._dead || !this.pid) return;
        this.indexed = v;
      } catch (e) {}
    },

    onPlaylistChanged(evt) {
      const d = evtJson(evt); 
      if (!d || Number(d.id) !== this.pid) return;
      if (d.op === "rename") {

        if (d.name) this.title = d.name;
        return;
      }
      if (d.op === "delete") {

        this._gone = true;
      }
    },
    attachTimes(songs) {
      const map = this.addTimes;
      for (let i = 0; i < songs.length; i++) {
        if (songs[i] && map[songs[i].id]) songs[i].at = map[songs[i].id];
      }
      return songs;
    },

    dedupe(list) {
      return appendUnique([], list);
    },
    appendUnique(base, add) {
      return appendUnique(base, add);
    },

    async loadMore() {
      await cursorLoadMore(this);
    },

    onRow(i) {
      if (!this.multi) {
        this.pick(i);
        return;
      }
      const s = this.viewSongs[i];
      if (s) this.toggleSel(s.id);
    },

    onHold(i) {
      if (this.multi) return;
      const s = this.viewSongs[i];
      if (!s || !s.id) return;
      log("list", "长按 → 歌曲详情 id=" + s.id);
      go("songinfo", { id: s.id });
    },
    async pick(i) {

      const song = this.viewSongs[i];
      if (!song) return;
      if (this.loadingAll || this._loadingPick) return; 
      this._loadingPick = true;
      const loadToken = this._loadToken;
      try {
        const q = await cursorQueueFromRow(this, i);
        if (this._dead || loadToken !== this._loadToken) return;
        if (!q.songs.length) {
          this.showToast("没有可播放的曲目");
          return;
        }
        log("list", "点行起播 #" + (q.at + 1) + "，队列首段 " + q.songs.length + " 首");
        player.playList(q.songs, q.at);
        if (q.fill) q.fill(); 
        this.hideToast();
        if (!this.multi) go("player", {});
      } catch (e) {
        this.showToast("载入曲目失败：" + ((e && e.message) || e));
        log("list", "点行起播载入失败 " + ((e && e.message) || e));
      } finally {
        this._loadingPick = false;
      }
    },

    sorted(arr) {
      return cursorSorted(this, arr);
    },

    async ensureAllSongs() {
      return cursorEnsureAll(this);
    },

    async playAll() {
      if (this.loadingAll || this._loadingPick) return;
      if (!this.songs.length) {
        this.showToast("没有可播放的曲目");
        return;
      }
      this.loadingAll = true;
      this.showToast("正在载入曲目...", 60000);
      const loadToken = this._loadToken;
      try {
        const q = await cursorQueuePlayAll(this);
        if (this._dead || loadToken !== this._loadToken) return;
        const list = q.songs;
        if (!list.length) {
          this.showToast("没有可播放的曲目");
          return;
        }
        const st = player.state();
        const shuf = st.loopMode === "shuffle";
        const at = shuf ? Math.floor(Math.random() * list.length) : q.at;
        log("list", "播放全部 " + list.length + " 首（" + (shuf ? "随机起播 #" + (at + 1) : "第一首起播") + "）" + (q.fill ? "，其余后台补齐" : ""));
        player.playList(list, at);
        if (q.fill) q.fill(); 
        this.hideToast(); 

        if (!this.multi) go("player", {});
      } catch (e) {
        this.showToast("载入曲目失败：" + ((e && e.message) || e));
        log("list", "播放全部载入失败 " + ((e && e.message) || e));
      } finally {
        this.loadingAll = false;
      }
    },

  },
};
