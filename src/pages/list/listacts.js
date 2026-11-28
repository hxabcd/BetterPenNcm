import { go } from '../../core/infra/nav.js';
import { removeFromPlaylist, setSubscribed } from '../../services/ncm/playlist.js';
import { searchMeta } from '../../services/ncm/api.js';
import { applyRemoved as cursorApplyRemoved, applyHistoryRemoved as cursorApplyHistRemoved } from '../../services/player/listcursor.js';
import { downloadSongs, startText, resultText, spaceCheck, dlSig } from '../../services/player/download.js';
import { downloadAll, addList, removeList } from '../../services/player/locallists.js';
import { toPlaylist, playNext, playNextText } from '../../services/player/acts.js';
import { selPicked, selAllIds } from '../../ui/dlselect.js';
import { fmtSize } from '../../core/infra/format.js';
import { log } from '../../core/infra/log.js';
import { openTextEdit, available as skAvailable } from '../../core/platform/systemKeyboard.js';

export const listActsMixin = {
  methods: {
    openInfo() {
      if (!this.canOpenInfo) return;

      const fromPage = (this.$page && this.$page.$pageId) || "";
      go("plinfo", { id: this.pid, name: this.title, fromPage: fromPage });
    },

    onTopbarOpen() {
      if (this.canEditKeyword) {
        this.editKeyword();
        return;
      }
      this.openInfo();
    },

    async editKeyword() {
      if (!this.canEditKeyword) return;
      let ok = false;
      try {
        ok = await skAvailable();
      } catch (e) {
        ok = false;
      }
      if (!ok) {
        this.showToast("系统输入法不可用");
        return;
      }
      const text = await openTextEdit({
        text: this.keyword,
        placeholder: "歌名 / 歌手",
        enterButtonText: "搜索",
        maxlength: 60,
        inputType: "ZhCNPreferred",
      });
      if (this._dead) return;
      if (text === null) {
        log("list", "改搜索词：取消");
        return;
      }

      const kw = String(text || "").trim();
      if (!kw) {
        this.showToast("关键词不能为空");
        return;
      }
      if (kw === this.keyword) return;
      this.keyword = kw;
      this.songs = [];
      this.items = [];
      this.trackIds = [];
      this.sortKey = "";
      this.sortAsc = false;
      this.hint = "加载中...";
      this.sub = "搜索中...";
      log("list", "搜索关键词改为 " + kw);
      await this.load({ kind: "search", keyword: kw });
    },

    onBack() {

      if (this.exitMultiIfAny()) {
        log("list", "返回键退出多选");
        return;
      }

      if (this.panel) {
        this.panel = "";
        this.disarm();
        return;
      }
      this.disarm(); 
      this.$page.finish();
    },
    onRailKey(key) {
      if (key === "playall") {
        this.playAll();
        return;
      }
      if (key === "multi") {
        this.enterMulti();
        return;
      }
      if (key === "dl") {
        this.doDownload();
        return;
      }
      if (key === "del") {
        this.armDelete();
        return;
      }

      if (key === "next") {
        this.doNext();
        return;
      }
      if (key === "topl") {
        this.doToPlaylist();
        return;
      }

      if (key === "more") {
        const open = this.panel !== "more";
        this.panel = open ? "more" : "";
        if (!open) this.disarm();
        return;
      }
      if (key === "mmore") {
        const open = this.panel !== "mmore";
        this.panel = open ? "mmore" : "";
        if (!open) this.disarm();
        return;
      }
      if (key === "sub") {
        this.toggleSub();
        return;
      }

      if (key === "sort" && !this.multi) this.panel = this.panel === "sort" ? "" : "sort";
    },

    pickMore(key) {
      this.panel = "";
      this.disarm();
      if (key === "dlall") this.doDownloadAll();
      else if (key === "index") this.toggleIndex();
      else if (key === "sort") this.panel = "sort";
    },

    pickMultiMore(key) {
      this.panel = "";
      if (key === "next") this.doNext();
      else if (key === "topl") this.doToPlaylist();
    },

    async doDownloadAll() {
      if (this._busy) return;
      this._busy = true;
      this.showToast("正在载入曲目...", 60000);
      const self = this;
      const r = await downloadAll(this.pid, function (done, total) {
        self.showToast("载入中 " + done + "/" + total, 60000);
      });
      this._busy = false;
      this.hideToast();
      if (this._dead) return;
      if (!r.ok) {
        this.showToast(r.offline ? "离线，无法下载" : r.error || "下载失败");
        return;
      }
      this.showToast("下载全部完成：成功 " + r.downloaded + " / 跳过 " + r.skipped + " / 失败 " + r.failed, 4000);
      this.loadIndexed();
    },

    async toggleIndex() {
      if (this._busy) return;
      this._busy = true;
      if (this.indexed) {
        const r = await removeList(this.pid);
        this._busy = false;
        if (this._dead) return;
        if (r.ok) {
          this.indexed = false;
          this.showToast("已移出本地索引（已下载文件保留）");
          log("list", "移出本地索引 " + this.pid);
        } else {
          this.showToast("移出失败");
        }
        return;
      }
      this.showToast("添加中...", 60000);
      const r = await addList(this.pid);
      this._busy = false;
      this.hideToast();
      if (this._dead) return;
      if (!r.ok) {
        this.showToast(r.offline ? "离线，无法添加" : r.error || "添加失败");
        return;
      }
      this.indexed = true;
      this.showToast("已添加至本地索引");
      log("list", "添加本地索引 " + this.pid + " 曲目=" + (r.count || 0));
    },

    async toggleSub() {
      if (this._busy) return;
      const on = !this.subscribed;
      this._busy = true;
      const r = await setSubscribed(this.pid, on);
      this._busy = false;
      if (this._dead) return;
      if (!r.ok) {
        this.showToast(r.code === 401 ? "这是自己的歌单，不用收藏" : "操作失败" + (r.message ? "：" + r.message : ""));
        log("list", (on ? "收藏" : "取消收藏") + "失败 code=" + r.code + " " + (r.message || ""));
        return;
      }
      this.subscribed = on;
      this.showToast(on ? "已收藏" : "已取消收藏");
      log("list", (on ? "已收藏 " : "已取消收藏 ") + this.pid);
    },

    selectedSongs() {
      return selPicked(this.selIds, this.viewAll);
    },

    doNext() {
      const picked = this.selectedSongs();
      if (!picked.length) {
        this.showToast("未选中歌曲");
        return;
      }
      const r = playNext(picked);
      log("list", "下一首播放 " + picked.length + " 首 " + JSON.stringify(r));
      this.exitMulti();
      const t = playNextText(r);
      if (t) this.showToast(t);
    },

    doToPlaylist() {
      const picked = this.selectedSongs();
      if (!picked.length) {
        this.showToast("未选中歌曲");
        return;
      }
      const n = toPlaylist(picked);
      if (!n) {
        this.showToast("未选中歌曲");
        return;
      }
      log("list", "收藏到歌单 " + n + " 首 → 选择页");
      this.exitMulti();
    },

    openItem(i) {
      const it = this.items[i];
      if (!it || !it.id) return;
      const t = this.searchType;
      if (t === 100) {
        log("list", "搜索结果 → 歌手 " + it.id + " " + it.name);
        go("artist", { id: it.id, name: it.name });
      } else if (t === 10) {
        log("list", "搜索结果 → 专辑 " + it.id + " " + it.name);
        go("album", { id: it.id, name: it.name });
      } else if (t === 1000) {
        log("list", "搜索结果 → 歌单 " + it.id + " " + it.name);
        go("list", { kind: "playlist", id: it.id, name: it.name });
      }
    },

    async pickCat(t) {
      if (Number(t) === this.searchType) return;
      this.searchType = Number(t);
      this.songs = [];
      this.items = [];
      this.shown = 0;
      this.cursor = 0;
      this.allLoaded = false;
      this.noMore = false;
      this.sortKey = "";
      this.sortAsc = false;
      this.hint = "加载中...";
      this.sub = "搜索中...";
      log("list", "切搜索分类 -> " + searchMeta(this.searchType).label);
      await this.load({ kind: "search", keyword: this.keyword });
    },

    toggleCat() {
      if (!this.showCatToggle) return;
      this.catOpen = !this.catOpen;
      log("list", "搜索分类侧栏" + (this.catOpen ? "展开" : "收起"));
    },

    async toggleAll() {
      if (this.selectingAll) return;
      if (this.allPicked) {
        this.selIds = [];
        this.disarmIfAny();
        return;
      }
      if (this.loadingMore) {
        this.showToast("正在加载列表，请稍候");
        return;
      }
      if (this._loadingFull) {
        this.showToast("正在载入全部曲目，请稍候");
        return;
      }

      if ((this.kind === "liked" || this.kind === "playlist") && !this.allLoaded && this.trackIds.length) {
        this.selIds = this.trackIds.slice();
        this.disarmIfAny();
        log("list", "全选（整单 id） " + this.selIds.length + " 首，未拉取全量曲目对象");
        return;
      }
      const needLoad = !this.allLoaded;
      let loadedOk = true;
      if (needLoad) this.selectingAll = true;
      try {
        if (needLoad) {
          const ok = await this.ensureAllSongs();
          if (!ok || this._dead) {
            loadedOk = false;
            return;
          }

          if (!this.multi) return;
        }
        this.selIds = selAllIds(this.viewAll);
        this.disarmIfAny();
        log("list", "全选 " + this.selIds.length + " / 共 " + this.totalCount + " 首");
      } finally {
        this.selectingAll = false;

        if (needLoad && loadedOk) this.hideToast();
      }
    },

    onMultiEnter() {
      this.panel = "";
      log("list", "进入多选 kind=" + this.kind + " pid=" + this.pid + " 列表 " + this.totalCount + " 首");
    },

    armDelete() {
      if (this._busy) return;
      if (!this.selIds.length) {
        this.showToast("未选中歌曲");
        return;
      }
      if (this.isArmed("del")) {
        if (this.kind === "history") this.doRemoveHistory();
        else this.doRemove();
        return;
      }
      this.arm("del");
    },

    async doDownload() {
      if (this._busy) return;
      if (!this.selIds.length) {
        this.showToast("未选中歌曲");
        return;
      }

      let picked = selPicked(this.selIds, this.viewAll);
      if (picked.length < this.selIds.length && !this.allLoaded) {

        if (this.loadingMore || this._loadingFull) {
          this.showToast("正在加载列表，请稍候");
          return;
        }
        this.showToast("正在载入选中的曲目...", 60000);
        const ok = await this.ensureAllSongs();
        if (this._dead) return;
        if (!ok) return; 
        this.hideToast();
        picked = selPicked(this.selIds, this.viewAll);
      }
      if (!picked.length) return;
      if (!this.isArmed("dl")) {
        this.showToast("检查空间...");
        const sp = await spaceCheck(picked);
        if (this._dead) return;
        if (sp.tight) {

          this.arm("dl");
          this.estText = fmtSize(sp.est);
          log("list", "空间预检不足：需约 " + fmtSize(sp.est) + " / 可用 " + fmtSize(sp.free));
          return;
        }
      }
      this.disarm();
      const n = picked.length;
      this.exitMulti();
      this.showToast(startText(n));
      log("list", "多选下载 " + n + " 首（kind=" + this.kind + "）");
      const self = this;
      downloadSongs(picked).then(function (r) {
        if (self._dead) return;
        self.showToast(resultText(r));
        log("list", "下载结果 " + JSON.stringify(r));
      });
    },

    doRemoveHistory() {
      this.disarm();
      cursorApplyHistRemoved(this, this.selIds.slice());
    },

    syncDl(s) {
      const d = s || {};
      const sig = dlSig(d);
      if (sig === this._dlSig) return;
      this._dlSig = sig;
      this.dl = d;
    },
    async doRemove() {
      this.disarm();
      this._busy = true;
      const ids = this.selIds.slice(); 
      const r = await removeFromPlaylist(this.pid, ids);
      this._busy = false;
      if (this._dead) return; 
      if (!r.ok) {
        this.showToast(
          r.needLogin
            ? "未登录"
            : r.denied
              ? "订阅的歌单不能移除歌曲"
              : "移除失败" + (r.message ? "：" + r.message : "（" + r.code + "）"),
        );
        log("list", "移除失败 code=" + r.code + " " + (r.message || ""));
        return; 
      }
      this.applyRemoved(ids);
    },

    applyRemoved(ids) {
      cursorApplyRemoved(this, ids);
    },

    closePanel() {
      this.panel = "";
    },
    async pickSort(k) {
      if (this.kind === "artistsongs") {

        if (k === this.order) {
          this.panel = "";
          return;
        }
        this.order = k;
        this.songs = [];
        this.shown = 0;
        this.cursor = 0;
        this.allLoaded = false;
        this.noMore = false;
        this.sub = "加载中...";
        log("list", "服务端换序 -> " + k);
        await this.load({ kind: "artistsongs", id: this.artistId });
      } else {

        const nextAsc = k === this.sortKey ? !this.sortAsc : false;
        const needFull = k !== "" || nextAsc;
        this.panel = "";
        if (needFull && !this.allLoaded) {

          if (this.loadingMore) {
            this.showToast("正在加载列表，稍后再排序");
            return;
          }
          log("list", "排序前载入全量（" + (k || "默认") + (nextAsc ? " 升序" : " 降序") + "）");
          const ok = await this.ensureAllSongs();
          if (!ok || this._dead) return;
          this.hideToast();
        }
        this.sortKey = k;
        this.sortAsc = nextAsc;
        log("list", "本地排序 " + (this.sortKey || "默认") + (this.sortAsc ? " 升序" : " 降序"));
      }
    },
  },
};
