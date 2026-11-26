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
import { go, paramsFor } from '../../core/infra/nav.js';
import { railBack, railBtn, ICON } from '../../ui/rail.js';
import { player } from '../../services/player/player.js';
import {
  removeFromPlaylist,
  cachedPlaylistRole,
  fetchPlaylistInfo,
  roleOf,
  setSubscribed,
} from '../../services/ncm/playlist.js';
import { KINDS, appendUnique } from '../../services/player/listkinds.js';
import { searchMeta } from '../../services/ncm/api.js';
import { listPageMixin } from '../../ui/mixins/listpage.js';
import {
  loadMore as cursorLoadMore,
  sorted as cursorSorted,
  ensureAllSongs as cursorEnsureAll,
  queuePlayAll as cursorQueuePlayAll,
  queueFromRow as cursorQueueFromRow,
  applyRemoved as cursorApplyRemoved,
  applyHistoryRemoved as cursorApplyHistRemoved,
} from '../../services/player/listcursor.js';
import { downloadSongs, dlText, startText, resultText, spaceCheck, dlSig, dlApi } from '../../services/player/download.js';
import { bindDl } from '../../ui/mixins/dlsub.js';
import { downloadAll, isIndexed, addList, removeList } from '../../services/player/locallists.js';
import { toPlaylist, playNext, playNextText } from '../../services/player/acts.js';
import config from '../../core/infra/config.js';
import ContextSheet from "../../components/ContextSheet.vue";
import SearchSidebar from "../../components/list/SearchSidebar.vue";
import { selPicked, selAllIds, selAllPicked } from '../../ui/dlselect.js';
import { fmtSize } from '../../core/infra/format.js';
import { evtJson } from '../../core/infra/events.js';
import { log } from '../../core/infra/log.js';
import { accentMixin } from '../../ui/mixins/accent.js';
import { toastMixin } from '../../ui/mixins/toast.js';
import { armMixin } from '../../ui/mixins/arm.js';
import { multiSelectMixin } from '../../ui/mixins/multi.js';
import { pageFrameMixin } from '../../ui/mixins/frame.js';
import { pageBusMixin } from '../../ui/mixins/pagebus.js';
import { PAGE_SONG, SEARCH_LIMIT, AUTO_BATCH, ROW_PX_SONG } from '../../ui/paging.js'
import { infiniteScrollMixin } from '../../ui/mixins/infinite.js';
import { openTextEdit, available as skAvailable } from '../../core/platform/systemKeyboard.js';

/* 每批条数（首屏 + 加载更多一批）：200 行一次性渲染会拖垮渲染器
   （实测：打开一个数百首规模的歌单、封面入队后应用崩溃），统一取 paging.js 的 50。 */
const PAGE = PAGE_SONG;

/* 顶栏标题里关键词的显示上限：侧栏展开时标题区约 600px 宽（@fs-strong 下约 29 个汉字），
   超出截断加省略号 —— 完整关键词仍在 this.keyword 里，点顶栏编辑时用的是完整值。 */
const TITLE_KW_MAX = 24;

/* 排序键：按 list 的 kind 给不同集合（搜索页不提供排序，分类改由右侧侧栏承担）。
   - liked / playlist：本地排序，'at' = 收藏时间（在 trackIds[].at 里，不在曲目对象上）
   - history：本地排序，默认顺序就是播放时间倒序，再给一个 'at' 键是伪选项，不给
   - artistsongs：**服务端**排序（/api/v1/artist/songs?order=hot|time），没有升降序
   除 artistsongs 外，'默认'（key=''）也有升降序：降序 = 接口/收藏原顺序，升序 = 整段反转 */
const SORTS = {
  liked: [
    { key: "", label: "默认" },
    { key: "name", label: "名称" },
    { key: "at", label: "收藏时间" },
    { key: "artist", label: "歌手名" },
  ],
  playlist: [
    { key: "", label: "默认" },
    { key: "name", label: "名称" },
    { key: "at", label: "收藏时间" },
    { key: "artist", label: "歌手名" },
  ],
  history: [
    { key: "", label: "默认" },
    { key: "name", label: "名称" },
    { key: "artist", label: "歌手名" },
  ],
  recommend: [
    { key: "", label: "默认" },
    { key: "name", label: "名称" },
    { key: "artist", label: "歌手名" },
  ],
  artistsongs: [
    { key: "hot", label: "热度" },
    { key: "time", label: "时间" },
  ],
};

function searchTitle(kw) {
  const s = String(kw || "");
  return "搜索：" + (s.length > TITLE_KW_MAX ? s.slice(0, TITLE_KW_MAX) + "…" : s);
}

export default {
  name: "list",
  mixins: [accentMixin, listPageMixin, toastMixin, armMixin, multiSelectMixin, pageBusMixin, pageFrameMixin, infiniteScrollMixin],
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

    // 当前分类的选项（label / unit），供顶栏副行与切分类后的提示用
    searchCat() {
      return searchMeta(this.searchType);
    },

    // 分类侧栏的收起/展开提示是否显示：搜索页且非多选（多选时把整列让给列表）
    showCatToggle() {
      return this.isSearch && !this.multi;
    },

    // 分类侧栏当前是否展开（收起 / 非搜索 / 多选时宽度都是 0，内容被 overflow 裁掉）
    catSideOn() {
      return this.showCatToggle && this.catOpen;
    },

    // 侧栏宽（SearchSidebar 开合时让顶栏提示让位用）：与组件内 SIDE_W 同值成对维护
    sideW() {
      return this.catSideOn ? 62.5 : 0;
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

    // 完整视图序列：本地排序作用在**已取回的全量**上（未全量时 pickSort 会先拉满，
    // 所以不会出现「只排前 50 首」）；artistsongs 是服务端排序，原样透出。
    viewAll() {
      return this.sorted(this.songs);
    },

    // 当前真正渲染的行（分页渲染的唯一出口）：完整视图的前 shown 行
    viewSongs() {
      return this.viewAll.slice(0, this.shown);
    },

    // 源数据总数：liked/playlist 是 trackIds，artistsongs 是服务端 total
    idsTotal() {
      if (this.kind === "artistsongs") return this.total;
      return this.trackIds.length;
    },
    // 还有取回但没渲染的行（本地切片 / 全量排序后的分页）→ 先只是往下显示；
    // 否则看游标之后还有没有源数据
    hasMore() {

      if (this.shown < this.viewAll.length) return true;
      if (this.allLoaded || this.noMore) return false;
      return this.cursor < this.idsTotal;
    },
    moreCount() {
      if (this.allLoaded) return Math.max(0, this.viewAll.length - this.shown);
      // 剩余源数据（游标之后）——不是「总数 − 已显示」：取不回的曲目会被接口丢掉
      return Math.max(0, this.idsTotal - this.cursor);
    },

    totalCount() {
      if (this.kind === "artistsongs") return this.total || this.songs.length;
      // 搜索 / 每日推荐：服务端一次给全、没有分页 → 已加载的即全量
      if (this.kind === "search" || this.kind === "recommend") return this.songs.length;
      // 正常情况两张表一样长；极端回包缺 trackIds 时以已取回的曲目数为准
      return Math.max(this.trackIds.length, this.songs.length);
    },

    // 是否已全选：范围是**整单**（全量已载入时按实际可取回的曲目数算，未载入时按整单总数算），
    // 所以「加载更多」不会把「全不选」翻回「全选」（按已加载行数算就会翻回去）
    allPicked() {
      return selAllPicked(this.selIds, this.allLoaded ? this.viewAll.length : this.totalCount);
    },

    // 当前列表是否「可编辑」（多选态给不给删除键）：播放历史是本地数据可移除；
    // 我喜欢的音乐 / 自建歌单接口可删（canManage；订阅歌单 401 不给）；搜索/歌手曲目只给下载
    canDelete() {
      if (this.kind === "history") return true;
      if (this.kind === "liked" || this.kind === "playlist") return this.canManage;
      return false;
    },

    // CSV「歌曲列表-只读」：订阅（别人的）歌单的曲目列表 —— 没有权限改内容，改走「更多 + 收藏」
    readonlyPlaylist() {
      return this.kind === "playlist" && this.plRole === "subscribed";
    },

    // 左栏给不给「播放全部」：搜索页由顶栏改词承担入口、播放历史按 CSV 只留多选
    railPlayAll() {
      return !this.isSearch && this.kind !== "history";
    },

    // 左栏给不给「排序」：只读歌单把排序收进「更多」面板（CSV 的顺序），历史页不排序
    railSort() {
      return this.railPlayAll && !this.readonlyPlaylist;
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

    // 顶栏可点进「歌单详情」：只有歌单与我喜欢的曲目页才有歌单可看（搜索/歌手曲目没有）
    canOpenInfo() {
      if (this.multi) return false;
      return !!this.pid && (this.kind === "liked" || this.kind === "playlist");
    },

    // 搜索页顶栏可点：点击重新编辑关键词（多选态顶栏不可点）
    canEditKeyword() {
      return this.isSearch && !this.multi;
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

    multiList() {
      return this.viewAll;
    },

    multiTotal() {
      return this.totalCount;
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
