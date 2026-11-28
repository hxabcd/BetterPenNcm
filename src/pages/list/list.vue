<template>
  <page-shell :rail="rail" @rail="onRail">
    <!-- 搜索页 = 主列（顶栏 + 列表）+ 右侧分类侧栏；其余 kind 侧栏宽度为 0，
         外壳结构保持不变（各 kind 共用同一套 DOM，切 kind 不增删节点）。 -->
    <div class="lst-wrap">
      <div class="lst-main">
        <!-- 顶栏可点：搜索页改关键词 / 歌单页进详情（link 由 canLinkTopbar 控制） -->
        <page-topbar :title="title" :sub="barSub" :link="canLinkTopbar" @open="onTopbarOpen">
          <!-- 多选态的「全选 / 全不选」：左栏放不下第三个上下文键（会撞返回键），
               只有顶栏右侧这一处。范围 = **整张列表**（未渲染的也算，见 toggleAll），
               页面只渲染已加载的前 shown 行。 -->
          <div class="lst-all" v-if="multi" @click="toggleAll">
            <text class="lst-all-t" :style="{ color: accent.light }">{{
              selectingAll ? "载入中..." : allPicked ? "全不选" : "全选"
            }}</text>
          </div>
        </page-topbar>
        <scroller class="lst-list" @scroll="onInfiniteScroll">
          <song-row
            v-for="(s, i) in viewSongs"
            :key="s.id"
            :song="s"
            :index="i"
            :selectable="multi"
            :sel="isSel(s.id)"
            @select="onRow(i)"
            @hold="onHold(i)"
          />

          <!-- 搜索结果里**不是歌曲**的三类（歌手/歌单/专辑）：与上面的 song-row 是并列的 v-for，
               同一时刻只有一条有数据（切分类时另一条被清空），不会混排 -->
          <entry-row v-for="(it, i) in items" :key="it.kid" :item="it" @open="openItem(i)" />
          <empty-hint v-if="!rowCount" :text="hint" />
          <div class="lst-more" v-if="hasMore" @click="loadMore">
            <text class="lst-more-t" :style="{ color: accent.light }">{{
              loadingMore ? "加载中..." : moreLabel(moreCount, "首")
            }}</text>
          </div>
        </scroller>
      </div>

      <search-sidebar
        v-if="isSearch"
        :search-type="searchType"
        :open="catOpen"
        @pick="pickCat"
      />
    </div>

    <!-- 分类侧栏的收起/展开提示：绝对定位基准是 .psh-body（PageShell），只盖顶栏右侧那一小块、不参与布局 -->
    <div class="lst-cat-toggle" v-if="showCatToggle" :style="toggleStyle" @click="toggleCat">
      <image v-if="!catOpen" class="lst-cat-ico" :src="ICON.cat" />
      <text class="lst-cat-toggle-t">{{ catOpen ? "收起" : "展开分类" }}</text>
      <image v-if="catOpen" class="lst-cat-chev" :src="ICON.chevright" />
    </div>

    <hint-toast :text="toast" />

    <!-- 排序浮窗：artistsongs 的选中项判定走 order（服务端排序键），没有方向箭头（mark-text=''） -->
    <context-sheet
      v-if="panel === 'sort'"
      title="排序方式"
      :options="sortOptions"
      :active-key="panelActiveSortKey"
      :asc="panelSortAsc"
      :mark-text="panelSortMark"
      @pick="pickSort"
      @close="closePanel"
    />

    <context-sheet
      v-if="panel === 'more'"
      title="更多"
      :options="moreOptions"
      mark-text=""
      @pick="pickMore"
      @close="closePanel"
    />
    <context-sheet
      v-if="panel === 'mmore'"
      title="更多"
      :options="multiMoreOptions"
      mark-text=""
      @pick="pickMultiMore"
      @close="closePanel"
    />
  </page-shell>
</template>

<script>
import PageShell from "../../components/PageShell.vue";
import PageTopbar from "../../components/PageTopbar.vue";
import EmptyHint from "../../components/EmptyHint.vue";
import SongRow from "../../components/SongRow.vue";
import EntryRow from "../../components/EntryRow.vue";
import HintToast from "../../components/HintToast.vue";
import { paramsFor } from '../../core/infra/nav.js';
import { railBack, railBtn, ICON } from '../../ui/rail.js';
import { KINDS } from '../../services/player/listkinds.js';
import { searchMeta } from '../../services/ncm/api.js';
import { listPageMixin } from '../../ui/mixins/listpage.js';
import { dlText, dlApi } from '../../services/player/download.js';
import { bindDl } from '../../ui/mixins/dlsub.js';
import ContextSheet from "../../components/ContextSheet.vue";
import SearchSidebar from "../../components/list/SearchSidebar.vue";
import { selAllPicked } from '../../ui/dlselect.js';
import { log } from '../../core/infra/log.js';
import { accentMixin } from '../../ui/mixins/accent.js';
import { toastMixin } from '../../ui/mixins/toast.js';
import { armMixin } from '../../ui/mixins/arm.js';
import { multiSelectMixin } from '../../ui/mixins/multi.js';
import { pageFrameMixin } from '../../ui/mixins/frame.js';
import { pageBusMixin } from '../../ui/mixins/pagebus.js';
import { PAGE_SONG, SEARCH_LIMIT, AUTO_BATCH } from '../../ui/paging.js';
import { infiniteScrollMixin } from '../../ui/mixins/infinite.js';
import { SORTS, listViewMixin } from './listview.js';
import { listLoadMixin } from './listload.js';
import { listActsMixin } from './listacts.js';

/* 每批条数（首屏 + 加载更多一批）：200 行一次性渲染会拖垮渲染器
   （实测：打开一个数百首规模的歌单、封面入队后应用崩溃），统一取 paging.js 的 50。 */
const PAGE = PAGE_SONG;

/* 顶栏标题里关键词的显示上限：侧栏展开时标题区约 600px 宽（@fs-strong 下约 29 个汉字），
   超出截断加省略号 —— 完整关键词仍在 this.keyword 里，点顶栏编辑时用的是完整值。 */
const TITLE_KW_MAX = 24;

function searchTitle(kw) {
  const s = String(kw || "");
  return "搜索：" + (s.length > TITLE_KW_MAX ? s.slice(0, TITLE_KW_MAX) + "…" : s);
}

export default {
  name: "list",
  mixins: [accentMixin, listPageMixin, toastMixin, armMixin, multiSelectMixin, pageBusMixin, pageFrameMixin, infiniteScrollMixin, listViewMixin, listLoadMixin, listActsMixin],
  components: {
    "page-shell": PageShell,
    "page-topbar": PageTopbar,
    "song-row": SongRow,
    "entry-row": EntryRow,
    "hint-toast": HintToast,
    "empty-hint": EmptyHint,
    "context-sheet": ContextSheet,
    "search-sidebar": SearchSidebar,
  },
  data() {
    return {
      kind: "search",
      title: "歌曲",
      sub: "",
      // 已取回的曲目（默认序，分页累积；渲染只取前 shown 行）
      songs: [], 
      // 搜索结果里非歌曲的三类（歌手/歌单/专辑）的行数据；与 songs 互斥
      items: [], 
      // 当前搜索分类（SEARCH_TYPES 的 key）；只对 kind='search' 有效
      searchType: 1, 
      // 搜索词（切分类 / 顶栏改词都要拿它重搜）
      keyword: "", 
      // 右侧分类侧栏是否展开（默认收起；只表示侧栏的收起/展开状态）
      catOpen: false, 
      // 渲染分片步长（listcursor 本地展开用；值来自 ui/paging.js）
      autoBatch: AUTO_BATCH, 
      ICON: ICON, 
      hint: "加载中...",
      // 歌单全量 id（liked/playlist；history 时 = 历史全量 id）
      trackIds: [], 
      // kind=history：本地全量历史条目（全量装配 / 删除时用）
      fullSongs: [], 
      // 曲目id -> 收藏时间戳（歌单全量，供「按收藏时间排序」）
      addTimes: {}, 
      // 歌手曲目总数（artistsongs 的另一条分页线）
      total: 0, 
      // 歌手曲目服务端排序：hot（接口默认，按热度）| time（按时间）
      order: "hot", 
      artistId: 0,
      artistName: "",
      loadingMore: false,

      /* ---- 分页渲染状态 ----
         shown  = 当前渲染多少行（viewSongs = viewAll.slice(0, shown)）；
         cursor = 网络分页的**已消费**位置（liked/playlist 是 trackIds 下标，artistsongs
                  是服务端 offset）——**不能用 songs.length 代替**：接口会丢弃取不回的曲目
                  （下架/无版权），用显示条数当游标会重复请求上一批、并让「加载更多」永远点不完；
         allLoaded = 全量已在内存（历史/搜索/小歌单天然为 true；排序与全选会先把它拉满）；
         noMore = 服务端已明确没有下一页（返回空页），避免对着空页反复请求。 */
      shown: 0,
      cursor: 0,
      allLoaded: false,
      noMore: false,
      // 顶栏「全选」正在载入全量（按钮文案显示「载入中...」）
      selectingAll: false, 

      sortKey: "",
      sortAsc: false,

      panel: "",

      // pid 必须是数字：navTo 参数可能是字符串，与缓存比对前先归一
      pid: 0, 
      // 订阅歌单删不了曲目（实测接口回 401）
      canManage: false, 

      // 归属（'' | liked | created | subscribed）决定走「歌曲列表」还是「歌曲列表-只读」槽位：
      // 先按缓存同步取，缓存没热再问详情接口（见 resolvePlaylist）
      plRole: "", 
      subscribed: false, 
      indexed: false, 
      estText: "", 
      dl: null, 
      loadingAll: false, 
    };
  },
  computed: {
    // 本页是不是搜索结果页（只有它才有右侧分类侧栏；其余 kind 的内容类型是固定的）
    isSearch() {
      return this.kind === "search";
    },

    // 分类侧栏的收起/展开提示是否显示：搜索页且非多选（多选时把整列让给列表）
    showCatToggle() {
      return this.isSearch && !this.multi;
    },

    // 收起/展开提示的 right：展开时贴侧栏左缘，收起时贴屏幕右缘（绝对定位在 .psh-body）
    toggleStyle() {
      return { right: this.sideW + "vh" };
    },

    // 列表里的总行数（歌曲行 + 条目行）：「暂无结果」的判据不能只看 songs
    rowCount() {
      return this.songs.length + this.items.length;
    },

    // 排序浮窗的选项（搜索页没有排序，故只有非搜索的 kind 会用到）
    sortOptions() {
      return SORTS[this.kind] || [];
    },

    // 排序面板的选中项：artistsongs 判 order（服务端排序键），其余判 sortKey
    panelActiveSortKey() {
      return this.kind === "artistsongs" ? this.order : this.sortKey;
    },

    panelSortAsc() {
      return this.sortAsc;
    },
    // 排序面板的方向箭头：artistsongs 是服务端排序，没有方向
    panelSortMark() {
      return this.kind === "artistsongs" ? "" : null; 
    },

    // 当前真正渲染的行（分页渲染的唯一出口）：完整视图的前 shown 行
    viewSongs() {
      return this.viewAll.slice(0, this.shown);
    },

    // 还有取回但没渲染的行（本地切片 / 全量排序后的分页）→ 先只是往下显示；
    // 否则看游标之后还有没有源数据
    hasMore() {

      if (this.shown < this.viewAll.length) return true;
      if (this.allLoaded || this.noMore) return false;
      return this.cursor < this.idsTotal;
    },
    // 是否已全选：范围是**整单**（全量已载入时按实际可取回的曲目数算，未载入时按整单总数算），
    // 所以「加载更多」不会把「全不选」翻回「全选」（按已加载行数算就会翻回去）
    allPicked() {
      return selAllPicked(this.selIds, this.allLoaded ? this.viewAll.length : this.totalCount);
    },

    // 只读歌单「更多」面板的选项（CSV：下载全部、添加到本地索引、排序）
    moreOptions() {
      return [
        { key: "dlall", label: "下载全部", icon: ICON.download },
        {
          key: "index",
          label: this.indexed ? "移出本地索引" : "添加到本地索引",
          icon: this.indexed ? ICON.dbminus : ICON.dbplus,
        },
        { key: "sort", label: "排序", icon: ICON.sort },
      ];
    },

    // 多选态「更多」面板（CSV 多选-可写：收藏到歌单、下一首播放）
    multiMoreOptions() {
      return [
        { key: "topl", label: "收藏到歌单", icon: ICON.plplus },
        { key: "next", label: "下一首播放", icon: ICON.listplus },
      ];
    },

    // 顶栏标题区是否可点：搜索页改关键词 / 歌单页进详情
    canLinkTopbar() {
      return this.canOpenInfo || this.canEditKeyword;
    },

    // 顶栏副题：多选态显示持续状态（选择数/待确认），非多选态用 load 里算出来的 sub。
    // 「双击…」这种**待确认提示必须常显**，不能放 toast —— toast 2 秒就没了，用户还没反应过来
    // 要点哪儿；下载进度也要让位给待确认提示（armed 最优先）。
    barSub() {
      try {
        if (this.isArmed("del")) {
          return this.armRailText(this.kind === "history" ? "从历史移除" : "移除", this.selIds.length);
        }
        if (this.isArmed("dl")) {

          return "空间可能不足（需约 " + this.estText + "）· " + this.armRailText("下载", this.selIds.length);
        }
        const dt = dlText(this.dl);
        if (dt) return dt;
        if (!this.multi) return this.sub;

        return this.multiBarSub;
      } catch (e) {

        log("list", "★barSub 异常: " + ((e && e.message) || String(e)));
        return this.sub;
      }
    },

    // 左栏槽位：数组顺序即位置 —— 第一个固定是返回（钉顶），其余的最后一个贴底
    // （NavRail：最下 76.67~96.67vh，往上每个 −24.44vh）；上下文键最多 3 个。
    // ⚠ 浮窗贴的是**栏底那个按钮**（.lst-sheet / ContextSheet 的 bottom:24vh = 最下按钮上沿 76vh）。
    rail() {
      try {
        if (this.multi) {
          // × 退出多选
          const stop = railBack(ICON.stop); 
        // ⚠ canDelete 是 computed（取值不带括号）——写 this.canDelete() 会抛 TypeError，
        // 页面更新被框架整体吞掉（设备日志只有 console.error(null)）
          if (this.canDelete) {
            return [
              stop,
              railBtn("mmore", ICON.more, this.panel === "mmore"),
              railBtn("dl", this.fgIcon("download"), false, "", this.isArmed("dl")),
              railBtn("del", this.fgIcon("trash"), false, "", this.isArmed("del")),
            ];
          }
          return [
            stop,
            railBtn("next", ICON.listplus),
            railBtn("topl", ICON.plplus),
            railBtn("dl", this.fgIcon("download"), false, "", this.isArmed("dl")),
          ];
        }
        const out = [railBack()];
        if (this.isSearch || this.kind === "history") {

          out.push(railBtn("multi", ICON.multi, false, "", false, !this.viewSongs.length));
          return out;
        }
        if (this.readonlyPlaylist) {
          out.push(railBtn("more", ICON.more, this.panel === "more"));
          out.push(railBtn("playall", ICON.play, this.loadingAll));
          out.push(railBtn("sub", ICON.star, this.subscribed));
          return out;
        }
        out.push(railBtn("playall", ICON.play, this.loadingAll)); 
        out.push(railBtn("multi", ICON.multi, false, "", false, !this.viewSongs.length)); 
        out.push(railBtn("sort", ICON.sort, this.panel === "sort"));
        return out;
      } catch (e) {

        log("list", "★rail 异常: " + ((e && e.message) || String(e)));
        return [railBack()];
      }
    },
  },
  mounted() {
    this._dead = false;

    // 跨页广播：歌单详情页改名/删除 → 本页跟着变（注册/退役见 ui/mixins/pagebus.js）
    this.onPageEvent("bpncm:playlist-changed", "onPlaylistChanged");

    const self = this;
    // 「页面重新可见」的订阅：被删掉的歌单，其曲目列表页要自己退掉。
    // 不能收到广播就 finish —— 退栈只由栈顶页发起（此刻栈顶是详情页），所以置标志等重新可见。
    this._onShow = function () {
      if (!self._gone) return;
      self._gone = false;
      log("list", "歌单已删，曲目列表页跟着退出");
      self.$page.finish();
    };
    try {
      this.$page.on("show", this._onShow);
    } catch (e) {
      log("list", "$page.on(show) 订阅失败 " + ((e && e.message) || e));
    }

    // 下载活动订阅（多选批量下载的进度显示在顶栏副题；页面会挂两遍 → 每实例各订各退）。
    // bindDl = 订阅 + 可见性门控 + 首帧快照（被上层页盖住时不落 data，见 ui/mixins/dlsub.js）
    this._dlOff = bindDl(this, dlApi, function (s) {
      self.syncDl(s);
    });

    // 参数通道按实例槽位 key 记账，取参必须用真实页名（写死逻辑页名只在兜底时命中）
    const p = paramsFor((this.$page && this.$page.$pageName) || "list", this.$page ? this.$page.options : null);
    this.openList(p);
  },
  beforeDestroy() {

    this._dead = true;
    if (this._gone) this._gone = false;
    try {
      if (this._onShow) this.$page.off("show", this._onShow);
    } catch (e) {}
    this._onShow = null;
    if (this._dlOff) this._dlOff()
    this._dlOff = null;

  },
  methods: {
    async load(p, token) {
      const self = this;
      const loadToken = token || ((this._loadToken || 0) + 1);
      this._loadToken = loadToken;
      this.hint = "加载中...";
      this.noMore = false;
      this.allLoaded = false;
      try {

        const out = await KINDS[p.kind].load(self, p, {
          searchTitle,
          catOf: searchMeta,
          SEARCH_LIMIT,
        });
        if (loadToken !== self._loadToken) return;
        if (out && out.log) log("list", out.log);
      } catch (e) {
        if (loadToken !== self._loadToken) return;
        self.hint = "加载失败: " + ((e && e.message) || e);
        log("list", "加载失败 " + ((e && e.message) || e));
      }
    },

    multiList() {
      return this.viewAll;
    },

    multiTotal() {
      return this.totalCount;
    },

  },
};
</script>

<style lang="less" scoped>
@import "../../styles/common.less";

.lst-wrap {
  flex: 1;
  flex-direction: row;
  width: 100%;
  height: 100vh;
}
.lst-main {
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.lst-cat-toggle {
  position: absolute;
  top: 0;
  height: @topbar-h;
  flex-direction: row;
  align-items: center;
  padding-left: 2vh;
  padding-right: 3vh;
  z-index: 30;
}
.lst-cat-toggle-t {
  font-size: @fs-dim;
  color: @text-2;
}
.lst-cat-ico {
  width: 7vh;
  height: 7vh;
  flex: none;
  margin-right: 1.2vh;
}
.lst-cat-chev {
  width: 6vh;
  height: 6vh;
  flex: none;
  margin-left: 0.8vh;
}

.lst-list {
  flex: 1;
}

.lst-all {
  height: @topbar-h;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding-left: 5vh;
  padding-right: 5vh;
}
.lst-all-t {
  font-size: @fs-dim;
  color: @accent-2; 
}
.lst-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.lst-more-t {
  font-size: @fs-dim;
  color: @accent-2; 
}
</style>
