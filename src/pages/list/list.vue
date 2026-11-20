<template>
  <page-shell :rail="rail" @rail="onRail">
    <!-- 搜索页 = 主列（顶栏 + 列表）+ 右侧分类侧栏；其余 kind 侧栏宽度为 0，结构保持不变。
         侧栏收起时只在顶栏右端留「[layout-grid-circles] 展开分类」提示（见下方 .lst-cat-toggle）。 -->
    <div class="lst-wrap">
      <div class="lst-main">
        <!-- 顶栏可点：搜索页改关键词 / 歌单页进详情（link 时才可点，见 PageTopbar） -->
        <page-topbar :title="title" :sub="barSub" :link="canLinkTopbar" @open="onTopbarOpen">
          <!-- 多选态的「全选 / 全不选」：左栏放不下第三个上下文按钮（会撞返回键），
               只有顶栏右侧这一处位置。范围 = **整张列表**（未渲染的也算，见 toggleAll：
               必要时先载入全量再全选）；页面只渲染已加载的前 shown 行，
               所以多选态副题一直显示「已选 N / 共 M 首」，差在哪儿一目了然。 -->
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
          <!-- 搜索结果里**不是歌曲**的三类（歌手/歌单/专辑）：封面 + 上下两行文字，点进各自的页。
               与上面的 song-row 是两条并列的 v-for —— 同一时刻只有一条有数据
               （切分类时另一条被清空），不会混排。 -->
          <entry-row v-for="(it, i) in items" :key="it.kid" :item="it" @open="openItem(i)" />
          <empty-hint v-if="!rowCount" :text="hint" />
          <div class="lst-more" v-if="hasMore" @click="loadMore">
            <text class="lst-more-t" :style="{ color: accent.light }">{{
              loadingMore ? "加载中..." : moreLabel(moreCount, "首")
            }}</text>
          </div>
        </scroller>
      </div>
      <!-- 右侧分类侧栏：搜索页专有（拆解件 SearchSidebar；开合宽度/选中态都在组件内） -->
      <search-sidebar
        v-if="isSearch"
        :search-type="searchType"
        :open="catOpen"
        @pick="pickCat"
      />
    </div>

    <!-- 分类侧栏的收起/展开提示：展开时「收起 >」贴在侧栏左缘；收起时「[图标] 展开分类」贴屏幕右缘。
         绝对定位基准是 .psh-body（PageShell），只盖顶栏右侧那一小块、不参与布局。 -->
    <div class="lst-cat-toggle" v-if="showCatToggle" :style="toggleStyle" @click="toggleCat">
      <image v-if="!catOpen" class="lst-cat-ico" :src="ICON.cat" />
      <text class="lst-cat-toggle-t">{{ catOpen ? "收起" : "展开分类" }}</text>
      <image v-if="catOpen" class="lst-cat-chev" :src="ICON.chevright" />
    </div>

    <hint-toast :text="toast" />

    <!-- 排序浮窗：ContextSheet 声明式组件（与 dlartists/dlalbums 同一实现，S2 统一）。
         artistsongs 的选中项判定走 order（服务端排序键），无方向箭头（mark-text=''）。 -->
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

    <!-- 只读歌单的「更多」面板 / 多选态的「更多」面板：共用 ContextSheet（贴左栏下部向上升） -->
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
  setSubscribed,
} from '../../services/ncm/playlist.js';
import { KINDS, appendUnique } from '../../services/player/listkinds.js';
import {
  loadMore as cursorLoadMore,
  sorted as cursorSorted,
  loadAllSongs as cursorLoadAll,
  ensureAllSongs as cursorEnsureAll,
  applyRemoved as cursorApplyRemoved,
  applyHistoryRemoved as cursorApplyHistRemoved,
} from '../../services/player/listcursor.js';
import { downloadSongs } from '../../services/player/download.js';
import { bindDl } from '../../services/player/dlvis.js';
import { downloadAll, isIndexed, addList, removeList } from '../../services/player/locallists.js';
import { toPlaylist, playNext, playNextText } from '../../services/player/acts.js';
import config from '../../core/infra/config.js';
import ContextSheet from "../../components/ContextSheet.vue";
import SearchSidebar from "../../components/list/SearchSidebar.vue";
import { selPicked, selAllIds, dlText, startText, resultText, spaceCheck } from '../../ui/dlselect.js';
import { fmtSize } from '../../core/infra/format.js';
import { evtJson } from '../../core/infra/events.js';
import { log } from '../../core/infra/log.js';
import { accentMixin } from '../../ui/theme.js';
import { toastMixin } from '../../ui/mixins/toast.js';
import { armMixin } from '../../ui/mixins/arm.js';
import { multiSelectMixin } from '../../ui/mixins/multi.js';
import { pageFrameMixin } from '../../ui/mixins/frame.js';
import { pageBusMixin } from '../../ui/mixins/pagebus.js';
import { PAGE_SONG, SEARCH_LIMIT, AUTO_BATCH, ROW_PX_SONG, moreText } from '../../ui/paging.js';
import { infiniteScrollMixin } from '../../ui/mixins/infinite.js';
import { openTextEdit, available as skAvailable } from '../../core/platform/systemKeyboard.js';

/* 每批条数（首屏 + 加载更多一批）：200 行一次性渲染会拖垮渲染器
   （实测：打开一个数百首规模的歌单、封面入队后应用崩溃），统一取 paging.js 的 50。 */
const PAGE = PAGE_SONG;

/* 顶栏标题里关键词的显示上限：侧栏展开时标题区约 600px 宽（@fs-strong 下约 29 个汉字），
   超出截断加省略号 —— 完整关键词仍在 this.keyword 里，点顶栏编辑时用的是完整值。 */
const TITLE_KW_MAX = 24;

/* 排序键：按 list 的 kind 给不同集合（搜索页不再提供排序，分类改由右侧侧栏承担）。
   - liked / playlist：本地排序，'at' = 收藏时间（trackIds[].at，见 playlist.js）
   - history：本地排序（条目自带 at=播放时间，但**默认顺序就是播放时间倒序**，
     再给一个 'at' 键是伪选项，不给）
   - artistsongs：**服务端**排序（/api/v1/artist/songs?order=hot|time），没有升降序
   除 artistsongs 外，'默认'（key=''）**也有升降序**：降序 = 接口/收藏原顺序，升序 = 整段反转 */
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

/* 搜索分类表（SEARCH_TYPES）归 SearchSidebar 组件与 api.js；页面只用 catOf 取 label/unit。 */
import { SEARCH_TYPES as searchCats } from '../../services/ncm/api.js';
/** 搜索分类 → 选项（拿 label / unit 用；表在 SearchSidebar 与 api.js 的 SEARCH_TYPES） */
function catOf(type) {
  for (let i = 0; i < searchCats.length; i++) {
    if (searchCats[i].key === Number(type)) return searchCats[i];
  }
  return searchCats[0];
}

/** 搜索页顶栏标题：搜索：<关键词>（过长截断，避免撑破定高顶栏；完整值在 this.keyword） */
function searchTitle(kw) {
  const s = String(kw || "");
  return "搜索：" + (s.length > TITLE_KW_MAX ? s.slice(0, TITLE_KW_MAX) + "…" : s);
}


export default {
  name: "list",
  mixins: [accentMixin, toastMixin, armMixin, multiSelectMixin, pageBusMixin, pageFrameMixin, infiniteScrollMixin],
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
      songs: [], // 已取回的曲目（**默认序**，分页累积；渲染只取前 shown 行）
      items: [], // 搜索结果里**非歌曲**的三类（歌手/歌单/专辑）的行数据；与 songs 互斥
      searchType: 1, // 当前搜索分类（SEARCH_TYPES 的 key）；只对 kind='search' 有效
      keyword: "", // 搜索词（切分类 / 顶栏改词都要拿它重搜）
      catOpen: false, // 右侧分类侧栏是否展开（默认收起；只表示侧栏的收起/展开状态）
      autoBatch: AUTO_BATCH, // 渲染分片步长（listcursor 本地展开用；值来自 ui/paging.js）
      ICON: ICON, // 模板里取图标（分类侧栏的展开/收起图标）
      hint: "加载中...",
      trackIds: [], // 歌单全量 id（liked/playlist；history 时 = 历史全量 id）
      fullSongs: [], // kind=history：本地全量历史条目（loadAllSongs / 删除时用）
      addTimes: {}, // 曲目id -> 收藏时间戳（歌单全量，供「按收藏时间排序」）
      total: 0, // 歌手曲目总数（artistsongs 的另一条分页线）
      order: "hot", // 歌手曲目服务端排序：hot（接口默认，按热度）| time（按时间）
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
      selectingAll: false, // 顶栏「全选」正在载入全量（按钮文案显示「载入中...」）
      // 本地排序（sortKey='' 即「默认」，它与其它键一样带方向：降序=原顺序，升序=反序）
      sortKey: "",
      sortAsc: false,
      /* 浮窗：'' | 'sort'（排序方式）| 'more'（只读歌单的「更多」）| 'mmore'（多选态的「更多」）。
         同一时刻只开一个（字符串天然互斥，模板按值挂不同面板）。 */
      panel: "",
      /* ---- 多选模式（所有曲目列表共用）----
         进入多选：下载选中（所有 kind）；删除选中（仅「可编辑」列表：我喜欢的音乐 /
         自建歌单 / 播放历史 —— 历史是本地数据；订阅歌单、搜索、歌手曲目只给下载）。 */
      pid: 0, // 当前歌单 id（**数字**：navTo 参数可能是字符串，与缓存比对前必须归一）
      canManage: false, // 我创建/收藏的歌单可删除曲目（订阅歌单删不了，实测 401）
      /* 歌单归属与「收藏 / 本地索引」状态（只对 kind=playlist 有意义）：
         plRole 决定本页走 CSV 的「歌曲列表」（可写）还是「歌曲列表-只读」两套槽位。
         先按缓存同步取，缓存没热再用详情接口补（见 resolvePlaylist）。 */
      plRole: "", // '' | 'liked' | 'created' | 'subscribed'
      subscribed: false, // 这张歌单是否已在「收藏」里（只读列表的收藏键状态）
      indexed: false, // 是否已加入本地索引（只读列表「更多」面板的索引项）
      estText: "", // 空间预检估算的体积文案（仅 isArmed('dl') 的提示里显示）
      dl: null, // 下载活动快照（bindDl 订阅，签名判重后赋值；顶栏副题显示进度）
      loadingAll: false, // 「播放全部」正在拉全量曲目（左栏播放键高亮 + 防重入）
    };
  },
  computed: {
    infiniteBottomPx() {
      return this.shown * ROW_PX_SONG
    },
    /** 本页是不是搜索结果页（只有它才有右侧分类侧栏；其余 kind 的内容类型是固定的） */
    isSearch() {
      return this.kind === "search";
    },
    /** 当前分类的选项（label / unit），供顶栏副行与切分类后的提示用 */
    searchCat() {
      return catOf(this.searchType);
    },
    /** 分类侧栏的收起/展开提示是否显示：搜索页且非多选（多选时把整列让给列表） */
    showCatToggle() {
      return this.isSearch && !this.multi;
    },
    /** 分类侧栏当前是否展开（收起 / 非搜索 / 多选时宽度都是 0，内容被 overflow 裁掉） */
    catSideOn() {
      return this.showCatToggle && this.catOpen;
    },
    /** 侧栏宽（SearchSidebar 开合时让顶栏提示让位用）：与组件内 SIDE_W 同值成对维护 */
    sideW() {
      return this.catSideOn ? 62.5 : 0;
    },
    /** 收起/展开提示的 right：展开时贴侧栏左缘，收起时贴屏幕右缘（绝对定位在 .psh-body） */
    toggleStyle() {
      return { right: this.sideW + "vh" };
    },
    /** 列表里的总行数（歌曲行 + 条目行）：「暂无结果」的判据不能只看 songs */
    rowCount() {
      return this.songs.length + this.items.length;
    },
    /** 排序浮窗的选项（搜索页没有排序，故只有非搜索的 kind 会用到） */
    sortOptions() {
      return SORTS[this.kind] || [];
    },
    /** 排序面板的选中项：artistsongs 判 order（服务端排序键），其余判 sortKey */
    panelActiveSortKey() {
      return this.kind === "artistsongs" ? this.order : this.sortKey;
    },
    /** 排序面板的方向箭头：artistsongs 是服务端排序，没有方向 */
    panelSortAsc() {
      return this.sortAsc;
    },
    panelSortMark() {
      return this.kind === "artistsongs" ? "" : null; // null = ContextSheet 默认 ↑/↓
    },
    /**
     * 完整视图序列：本地排序**作用在已取回的全量上**（未全量时 pickSort 会先拉满，
     * 所以这里不会出现「只排前 50 首」）；artistsongs 是服务端排序，原样透出。
     */
    viewAll() {
      return this.sorted(this.songs);
    },
    /** 当前真正渲染的行（分页渲染的唯一出口）：完整视图的前 shown 行 */
    viewSongs() {
      return this.viewAll.slice(0, this.shown);
    },
    /** 源数据总数：liked/playlist 是 trackIds，artistsongs 是服务端 total */
    idsTotal() {
      if (this.kind === "artistsongs") return this.total;
      return this.trackIds.length;
    },
    hasMore() {
      // 还有取回但没渲染的行（本地切片 / 全量排序后的分页）
      if (this.shown < this.viewAll.length) return true;
      if (this.allLoaded || this.noMore) return false;
      return this.cursor < this.idsTotal;
    },
    moreCount() {
      if (this.allLoaded) return Math.max(0, this.viewAll.length - this.shown);
      // 剩余源数据（游标之后）——不是「总数 − 已显示」：取不回的曲目会被接口丢掉
      return Math.max(0, this.idsTotal - this.cursor);
    },
    /** 本页曲目总数（多选提示「已选 N / 共 M」的 M）：按 kind 取对应的那条线 */
    totalCount() {
      if (this.kind === "artistsongs") return this.total || this.songs.length;
      // 搜索 / 每日推荐（服务端一次给全、没有分页）→ 已加载的即全量
      if (this.kind === "search" || this.kind === "recommend") return this.songs.length;
      // 正常情况两张表一样长；极端回包缺 trackIds 时以已取回的曲目数为准
      return Math.max(this.trackIds.length, this.songs.length);
    },
    /**
     * 是否已全选。范围是**整单**：全量已载入时按实际可取回的曲目数算（trackIds 里可能有
     * 取不回的下架曲目），未载入时按整单总数算 —— 无论哪种口径，加载更多都不会把
     * 「全不选」翻回「全选」（旧实现按已加载行数算，翻页一次就翻回去了）。
     */
    allPicked() {
      const n = this.allLoaded ? this.viewAll.length : this.totalCount;
      return n > 0 && this.selIds.length >= n;
    },
    /**
     * 当前列表是否「可编辑」（多选态给不给删除键）：
     *   - 播放历史：本地数据，可移除（全选+删除 = 原「清空」）
     *   - 我喜欢的音乐 / 自建歌单：接口可删（canManage；订阅歌单 401 不给）
     *   - 搜索 / 歌手曲目：无归属概念，只给下载
     */
    canDelete() {
      if (this.kind === "history") return true;
      if (this.kind === "liked" || this.kind === "playlist") return this.canManage;
      return false;
    },
    /** CSV「歌曲列表-只读」：订阅（别人的）歌单的曲目列表 —— 没有权限改内容，改走「更多 + 收藏」 */
    readonlyPlaylist() {
      return this.kind === "playlist" && this.plRole === "subscribed";
    },
    /** 左栏给不给「播放全部」：搜索页由顶栏改词承担入口、播放历史按 CSV 只留多选 */
    railPlayAll() {
      return !this.isSearch && this.kind !== "history";
    },
    /** 左栏给不给「排序」：只读歌单把排序收进「更多」面板（CSV 的顺序），历史页不排序 */
    railSort() {
      return this.railPlayAll && !this.readonlyPlaylist;
    },
    /** 只读歌单「更多」面板的选项（CSV：下载全部、添加到本地索引、排序） */
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
    /** 多选态「更多」面板（CSV 多选-可写：收藏到歌单、下一首播放） */
    multiMoreOptions() {
      return [
        { key: "topl", label: "收藏到歌单", icon: ICON.plplus },
        { key: "next", label: "下一首播放", icon: ICON.listplus },
      ];
    },
    /** 顶栏可点进「歌单详情」：只有歌单与我喜欢的曲目页才有歌单可看（搜索/歌手曲目没有），
        多选态顶栏在显示勾选状态，也不可点 */
    canOpenInfo() {
      if (this.multi) return false;
      return !!this.pid && (this.kind === "liked" || this.kind === "playlist");
    },
    /** 搜索页顶栏可点：点击重新编辑关键词（多选态顶栏不可点） */
    canEditKeyword() {
      return this.isSearch && !this.multi;
    },
    /** 顶栏标题区是否可点：搜索页改关键词 / 歌单页进详情 */
    canLinkTopbar() {
      return this.canOpenInfo || this.canEditKeyword;
    },
    /**
     * 顶栏副题：多选态显示持续状态（选择数/待确认），非多选态用 load 里算出来的 sub。
     * 「双击…」这种**待确认提示必须常显**，不能放 toast —— toast 2 秒就没了，
     * 用户还没反应过来要点哪儿；下载进度也要让位给待确认提示（armed 最优先）。
     */
    barSub() {
      try {
        if (this.isArmed("del")) {
          return this.armRailText(this.kind === "history" ? "从历史移除" : "移除", this.selIds.length);
        }
        if (this.isArmed("dl")) {
          // 数量前缀是本页特有信息，句式走 armRailText 统一模板（ui/arm.js）
          return "空间可能不足（需约 " + this.estText + "）· " + this.armRailText("下载", this.selIds.length);
        }
        const dt = dlText(this.dl);
        if (dt) return dt;
        if (!this.multi) return this.sub;
        // 多选态句式（未选中 / 已选 N / 共 M 首）由 multiSelectMixin 统一；M 走本页 multiTotal() = 整单数。
        // 未选中只报总数（不再写「点歌曲勾选 · 左栏是…」的引导语）
        // ⚠ canDelete 是 computed（取值不带括号）——写 this.canDelete() 会抛 TypeError，
        // 页面更新被框架整体吞掉（排查了半天：设备日志只有 console.error(null)）
        return this.multiBarSub;
      } catch (e) {
        // 诊断：这一层抛错会被框架吞成 null（见 app.js 的注释）——自己引到日志
        log("list", "★barSub 异常: " + ((e && e.message) || String(e)));
        return this.sub;
      }
    },
    /**
     * 左栏槽位（口径 = docs/上下文菜单与图标.md 的 CSV 表）。数组顺序即位置：
     * 第一个固定是返回（钉顶），**其余的最后一个贴底**（NavRail：最下 76.67~96.67vh，往上每个 −24.44vh）。
     * 上下文键最多 3 个（四键等距排满，见 NavRail.vue 的几何注释）。
     *   - 搜索：返回 + 多选（只读）—— 分类在右侧辅助侧栏、排序不给（CSV 的「搜索」行）
     *   - 播放历史：返回 + 多选（可写）—— 不给播放全部 / 排序（CSV 的「播放历史」行）
     *   - 订阅歌单（只读）：返回 + 更多（下载全部 / 添加到本地索引 / 排序）+ 播放全部 + 收藏
     *   - 其余（我喜欢 / 自建歌单 / 每日推荐 / 歌手曲目）：返回 + 播放全部 + 多选 + 排序
     *   - 多选态-可写：关闭 + 更多（收藏到歌单 / 下一首播放）+ 下载 + 删除
     *   - 多选态-只读：关闭 + 下一首播放 + 收藏到歌单 + 下载
     * ⚠ 浮窗贴的是**栏底那个按钮**（.lst-sheet / ContextSheet 的 bottom:24vh = 最下按钮上沿 76vh）。
     */
    rail() {
      try {
        if (this.multi) {
          const stop = railBack(ICON.stop); // × 退出多选
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
          // 非歌曲分类没有可多选的行 → 置灰（viewSongs 为空）
          out.push(railBtn("multi", ICON.multi, false, "", false, !this.viewSongs.length));
          return out;
        }
        if (this.readonlyPlaylist) {
          out.push(railBtn("more", ICON.more, this.panel === "more"));
          out.push(railBtn("playall", ICON.play, this.loadingAll));
          out.push(railBtn("sub", ICON.star, this.subscribed));
          return out;
        }
        out.push(railBtn("playall", ICON.play, this.loadingAll)); // 载入全量曲目期间高亮
        out.push(railBtn("multi", ICON.multi, false, "", false, !this.viewSongs.length)); // 空列表置灰；删除能力见 canDelete
        out.push(railBtn("sort", ICON.sort, this.panel === "sort"));
        return out;
      } catch (e) {
        // 诊断（同 barSub）：异常自己引到日志，别让框架吞成 null
        log("list", "★rail 异常: " + ((e && e.message) || String(e)));
        return [railBack()];
      }
    },
  },
  mounted() {
    this._dead = false;
    // 跨页广播：歌单详情页改名/删除 → 本页跟着变（注册/退役见 utils/ui/pagebus.js）
    this.onPageEvent("bpncm:playlist-changed", "onPlaylistChanged");
    /* 「页面重新可见」的订阅：被删掉的歌单，其曲目列表页要自己退掉。
       ⚠ 不能写成 methods.onShow —— 框架的 _performPageLifeCycle 只调 Page 实例自己的 onShow、
         再 trigger('show')；组件里的 onShow 只有在 app.js 注册了页面基类
         （$falcon.useDefaultBasePageClass，本项目没注册）时才会被转发。
         所以这里直接订框架的页面事件（每个 Page 实例各订各的，不能用模块级守卫）。 */
    const self = this;
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
    // bindDl = 订阅 + 可见性门控 + 首帧快照（被上层页盖住时不落 data，见 utils/player/dlvis.js）
    this._dlOff = bindDl(this, function (s) {
      self.syncDl(s);
    });
    // 参数通道按实例槽位 key 记账，取参必须用真实页名（写死逻辑页名只在兜底时命中）
    const p = paramsFor((this.$page && this.$page.$pageName) || "list", this.$page ? this.$page.options : null);
    this.openList(p);
  },
  beforeDestroy() {
    // 页面已退：定时器与异步回调不能再动 data（页面还会挂两遍，回调不可靠）
    this._dead = true;
    if (this._gone) this._gone = false;
    try {
      if (this._onShow) this.$page.off("show", this._onShow);
    } catch (e) {}
    this._onShow = null;
    if (this._dlOff) this._dlOff()
    this._dlOff = null;
    // armed / toast 的计时器由 ui/arm.js、ui/toast.js 的 beforeDestroy 自动清
  },
  methods: {
    /** 按导航参数重置路由状态并加载列表；同一参数（页面挂两遍）直接跳过，保证挂载幂等。 */
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
        /* 归属决定槽位：缓存同步取一次（避免先闪一套可写槽位），缓存没热再问详情接口。
           liked 页的 pid 就是「我喜欢的音乐」，缓存没热也按可写处理（它一定是我自己的）。 */
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
    /** 归属 → 可写/只读两套槽位的前置状态（plRole 变了就调它） */
    applyRole() {
      this.canManage = this.plRole !== "subscribed";
      // 收藏状态：出现在「收藏」页签里的歌单按已收藏算；自建的 / 我喜欢的没有「收藏」概念
      this.subscribed = this.plRole === "subscribed";
    },
    /**
     * 缓存里查不到归属（冷启动 / 从搜索结果直接进来）→ 问一次歌单详情。
     * 失败就当可写处理（与旧行为一致：宁可多给一个删不掉会 401 的键，也不要误锁自己的歌单）。
     */
    async resolvePlaylist(token) {
      const self = this;
      const pid = this.pid;
      if (!pid) return;
      try {
        const info = await fetchPlaylistInfo(pid);
        if (self._dead || pid !== self.pid || token !== self._loadToken) return;
        const me = Number(config.get("userId")) || 0;
        if (info.creatorId) {
          self.plRole = info.creatorId !== me ? "subscribed" : info.specialType === 5 ? "liked" : "created";
        }
        self.applyRole();
        self.subscribed = info.subscribed; // applyRole 给的是推断值，详情接口回的是准数
        log("list", "歌单归属 " + self.plRole + " subscribed=" + info.subscribed + " pid=" + pid);
        self.loadIndexed();
      } catch (e) {
        log("list", "歌单详情失败（按可写处理）" + ((e && e.message) || e));
      }
    },
    /** 本地索引状态（只读歌单的「更多」面板里那一项用；未登录/离线时静默保持 false） */
    async loadIndexed() {
      if (this.kind !== "playlist" || !this.pid) return;
      try {
        const v = await isIndexed(this.pid);
        if (this._dead || !this.pid) return;
        this.indexed = v;
      } catch (e) {}
    },
    /* ---- 跨页事件（pagebus 派发给页面栈上层存活实例）---- */
    onPlaylistChanged(evt) {
      const d = evtJson(evt); // 框架会把负载套成 {type,timestamp,data}，见 utils/events.js
      if (!d || Number(d.id) !== this.pid) return;
      if (d.op === "rename") {
        // 详情页改了名：列表页顶栏跟着改（歌单列表页/首页由它们自己刷新）
        if (d.name) this.title = d.name;
        return;
      }
      if (d.op === "delete") {
        // 歌单没了，本页（曲目列表）也就没意义了 —— 但**不能在这里直接 finish**：
        // 退栈只由栈顶页发起（此刻栈顶是详情页）。置个标志，等本页重新可见时在 onShow 里退。
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
        // 六-kind 取数路由表（services/player/listkinds.js）：kind → 首屏取数 + 文案
        const out = await KINDS[p.kind].load(self, p, {
          searchTitle,
          catOf,
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
    /** 把「收藏时间」挂到曲目上（时间戳在 trackIds 条目里，不在曲目对象里） */
    attachTimes(songs) {
      const map = this.addTimes;
      for (let i = 0; i < songs.length; i++) {
        if (songs[i] && map[songs[i].id]) songs[i].at = map[songs[i].id];
      }
      return songs;
    },
    /** 追加去重（listkinds 的 applyPlaylistPage / loadTracksBatch 经 self 调用） */
    dedupe(list) {
      return appendUnique([], list);
    },
    appendUnique(base, add) {
      return appendUnique(base, add);
    },
    /** 「加载更多」文案（模板里只能用 methods/data 暴露的方法，import 的 helper 不能裸调） */
    moreLabel(n, unit) {
      return moreText(n, unit);
    },
    /** 「加载更多」：三路分派与并发/生命周期守卫在 ui/listcursor.js */
    async loadMore() {
      await cursorLoadMore(this);
    },
    /** 点行的分派：多选态下是勾选，否则是播这一首（对齐 PenMusic onRowTap 的写法） */
    onRow(i) {
      if (!this.multi) {
        this.pick(i);
        return;
      }
      const s = this.viewSongs[i];
      if (s) this.toggleSel(s.id);
    },
    /**
     * 长按整行 → 歌曲详情页（与播放页点歌名等效）。
     * 多选态忽略：那时点行是勾选，跳走会打断选择（口径同下载页多选态忽略长按）。
     */
    onHold(i) {
      if (this.multi) return;
      const s = this.viewSongs[i];
      if (!s || !s.id) return;
      log("list", "长按 → 歌曲详情 id=" + s.id);
      go("songinfo", { id: s.id });
    },
    async pick(i) {
      /* 点行起播的队列 = **整份列表**（与「播放全部」同口径）：
         分页只限制渲染量，不该让连播/上一首/队列页只在前 50 首里转。
         未全量时先拉全量（进度提示由 loadAllSongs 给），再按 id 找回点中的那首
         ——不能直接拿渲染下标当起播位置：全量重新取回后下标可能与旧视图不同。 */
      const song = this.viewSongs[i];
      if (!song) return;
      if (this.allLoaded) {
        player.playList(this.viewAll, i);
        go("player", {});
        return;
      }
      if (this.loadingAll || this._loadingPick) return; // 已在拉全量：忽略连点，别并发两份队列
      this._loadingPick = true;
      const loadToken = this._loadToken;
      try {
        const ok = await this.ensureAllSongs();
        if (!ok || this._dead || loadToken !== this._loadToken) return;
        const list = this.viewAll; // 全量 + 当前排序
        let at = -1;
        for (let j = 0; j < list.length; j++) {
          if (list[j].id === song.id) {
            at = j;
            break;
          }
        }
        if (at < 0) {
          // 点中的行一定来自 trackIds；找不到说明取回时被接口丢了，兜底按旧下标起播，别点了没反应
          at = Math.min(i, list.length - 1);
          log("list", "点行起播：全量里找不到 id=" + song.id + "，退回下标 " + at);
        }
        log("list", "点行起播前拉全量 " + list.length + " 首，起播 #" + (at + 1));
        player.playList(list, at);
        this.hideToast(); // 收起「正在载入全部曲目...」进度
        if (!this.multi) go("player", {});
      } catch (e) {
        this.showToast("载入全部曲目失败：" + ((e && e.message) || e));
        log("list", "点行起播载入失败 " + ((e && e.message) || e));
      } finally {
        this._loadingPick = false;
      }
    },
    /** 按当前本地排序键排一份副本（artistsongs 是服务端排序，原样返回）。
        viewAll（页面渲染的前 shown 行从这里切）与「播放全部」的全量队列共用它，顺序永远一致。
        本地排序键生效前 pickSort 会先拉全量——所以这里排的始终是完整列表，不是前 50 首。
        ⚠ 「默认」（sortKey=''）也带方向：降序 = 接口/收藏原顺序，升序 = 整段反转
        （「默认」也要能切升降序，所以不能按 !k 直接原样返回）。 */
    /** 本地排序（实现在 services/player/listcursor.js；artistsongs 服务端排序原样透出） */
    sorted(arr) {
      return cursorSorted(this, arr);
    },
    /** 取全量（默认序）但不写页面状态——「播放全部」/「点行起播」用；实现在 listcursor.js */
    async loadAllSongs(token) {
      return cursorLoadAll(this, token);
    },
    /** 确保**全量在页面状态里**（本地排序、整单全选的前置条件）；实现在 listcursor.js */
    async ensureAllSongs() {
      return cursorEnsureAll(this);
    },
    /**
     * 「播放全部」（左栏播放键）：把**整份列表**设为当前播放队列 —— 顺序/循环模式从第一首起播，
     * 随机模式从随机一首起播（player.playList 在随机模式下以传入的这首为锚点重洗临时队列，
     * 见 player.js 的 buildShuffle）。起播位置按**当前视图顺序**（本地排序生效；artistsongs
     * 是服务端排序）。与点行的 pick 一致，起播后进播放页。
     */
    async playAll() {
      if (this.loadingAll) return;
      if (!this.songs.length) {
        this.showToast("没有可播放的曲目");
        return;
      }
      this.loadingAll = true;
      const loadToken = this._loadToken;
      try {
        // 已全量时直接用完整视图（排序已生效）；否则另行取全量（不写页面状态）
        const all = this.allLoaded ? this.viewAll.slice() : await this.loadAllSongs(loadToken);
        if (this._dead || loadToken !== this._loadToken) return;
        if (!all.length) {
          this.showToast("没有可播放的曲目");
          return;
        }
        const list = this.sorted(all);
        const st = player.state();
        const shuf = st.loopMode === "shuffle";
        const at = shuf ? Math.floor(Math.random() * list.length) : 0;
        log("list", "播放全部 " + list.length + " 首（" + (shuf ? "随机起播 #" + (at + 1) : "第一首起播") + "）");
        player.playList(list, at);
        this.hideToast(); // 进度提示收起（页面被推到播放页后它也留在栈里）——hideToast 来自 toastMixin
        // 载入期间用户可能已进了多选态（左栏管理键仍点得到）—— 那种情况不强推播放页
        if (!this.multi) go("player", {});
      } catch (e) {
        this.showToast("载入全部曲目失败：" + ((e && e.message) || e));
        log("list", "播放全部载入失败 " + ((e && e.message) || e));
      } finally {
        this.loadingAll = false;
      }
    },
    /** 顶栏 → 歌单详情（名字先带过去当标题，详情页拿到接口数据后再以接口为准） */
    openInfo() {
      if (!this.canOpenInfo) return;
      // 带上本页的 pageId：详情页删掉歌单时顺手把它关掉（$falcon.closePageById），
      // 用户不会停在「已删歌单」的曲目页（本页 onShow 的自退是二级兜底）
      const fromPage = (this.$page && this.$page.$pageId) || "";
      go("plinfo", { id: this.pid, name: this.title, fromPage: fromPage });
    },
    /** 顶栏点击：搜索页改关键词；歌单页进详情（link 由 canLinkTopbar 控制） */
    onTopbarOpen() {
      if (this.canEditKeyword) {
        this.editKeyword();
        return;
      }
      this.openInfo();
    },
    /**
     * 改搜索关键词（系统输入法，搜索页顶栏点击进入）。
     * 取消 / 空关键词 → 保留原结果；改成功 → 清空旧结果并按**当前分类**重搜。
     */
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
      // trim 一并去掉中文全角空格；纯空白按「没输入」处理，保留原结果
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
    /* ---- 左栏（分派骨架见 ui/frame.js：onBack / onRailKey 两个钩子）---- */
    onBack() {
      // 多选态：返回键是「退出多选」（图标 ×，见 rail()），不退页面
      if (this.exitMultiIfAny()) {
        log("list", "返回键退出多选");
        return;
      }
      // 浮窗开着：先收起浮窗（同歌单详情页），别让一次返回跳过两层
      if (this.panel) {
        this.panel = "";
        this.disarm();
        return;
      }
      this.disarm(); // 待确认作废（3 秒计时由 armMixin 管）
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
      // 下一首播放 / 收藏到歌单：多选态的只读槽位，以及「更多」面板里的同名项
      if (key === "next") {
        this.doNext();
        return;
      }
      if (key === "topl") {
        this.doToPlaylist();
        return;
      }
      // 只读歌单：更多（下载全部 / 添加到本地索引 / 排序）+ 收藏
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
      // 排序：再点一次同一个键 = 收起（搜索页没有排序键；分类走右侧侧栏）
      if (key === "sort" && !this.multi) this.panel = this.panel === "sort" ? "" : "sort";
    },
    /* ---- 只读歌单的「更多」面板 + 收藏 ---- */
    /** 面板项分派（key 与左栏同名键语义一致；面板关掉再执行） */
    pickMore(key) {
      this.panel = "";
      this.disarm();
      if (key === "dlall") this.doDownloadAll();
      else if (key === "index") this.toggleIndex();
      else if (key === "sort") this.panel = "sort";
    },
    /** 多选态「更多」面板：动作与左栏同名键同一条路径（面板先关，动作里自己退多选） */
    pickMultiMore(key) {
      this.panel = "";
      if (key === "next") this.doNext();
      else if (key === "topl") this.doToPlaylist();
    },
    /**
     * 下载全部（只读歌单）：走 locallists.downloadAll —— 已索引时下载的文件按 playlist 归属
     * 写标记，未索引时按用户单曲下载（与歌单详情页同一实现，不再另写一份）。
     */
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
    /** 添加 / 移出本地索引：只动索引记录，不下载 / 不删文件（策略 A） */
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
    /** 收藏 / 取消收藏这张（别人的）歌单 —— 只读列表的底键 */
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
    /* ---- 多选态的两颗动作键（可写列表收进「更多」面板，只读列表直接给键） ---- */
    /** 选中的曲目对象（顺序 = 用户看到的顺序）；selIds 可能含未渲染的行，所以取完整视图 */
    selectedSongs() {
      return selPicked(this.selIds, this.viewAll);
    },
    /** 下一首播放：插到当前曲之后（player.insertNext），完成后退出多选 */
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
    /** 收藏到歌单：跳歌单选择页（pick 模式带一批 id），退出多选免得回来还停在选中态 */
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
    /**
     * 点搜索结果里的歌手 / 歌单 / 专辑：进各自的页。
     * 歌单走曲目列表页（kind='playlist'）—— 与歌单列表页点歌单同一条路径，
     * 进来就能播；要看简介/收藏再从顶栏点进详情。
     */
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
    /**
     * 切搜索分类（右侧侧栏）：清掉旧结果 → 按新分类重搜。
     * 排序键一并复位（搜索结果的相关性顺序才是默认序；搜索页也已不提供排序）。
     */
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
      log("list", "切搜索分类 -> " + catOf(this.searchType).label);
      await this.load({ kind: "search", keyword: this.keyword });
    },
    /** 收起 / 展开右侧分类侧栏（多选态没有提示按钮，直接忽略） */
    toggleCat() {
      if (!this.showCatToggle) return;
      this.catOpen = !this.catOpen;
      log("list", "搜索分类侧栏" + (this.catOpen ? "展开" : "收起"));
    },
    /* ---- 多选模式（下载 / 删除选中）——状态机在 ui/multi.js，本页只给范围与计数口径 ---- */
    /**
     * 多选范围 = **整单**（viewAll 的当前视图序）。未全量时 toggleAll 会先载入全量再全选；
     * 页面渲染仍然只有前 shown 行（见 viewSongs）——「全选整单、只渲染已加载」。
     */
    multiList() {
      return this.viewAll;
    },
    /** 顶栏计数的 M = 整单数（trackIds/总数），与已渲染行数不同 */
    multiTotal() {
      return this.totalCount;
    },
    /**
     * 全选 / 全不选（覆写 ui/multi.js 的缺省实现）：范围是整张歌单，不是已渲染的 50 行。
     * 未全量时先 ensureAllSongs（顶栏文案走 selectingAll）再取全部 id；
     * 取消全选只清 selIds；载入失败时保留原选择，不误清空。
     */
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
      /* liked/playlist 的 trackIds 在首屏就全量到手（见 docs/歌单接口边界.md）：
         整单全选直接用 id，**不必先拉几百上千个曲目对象**（9335 首 ≈ 24MB）；
         只有下载需要对象时（doDownload）才补齐全量。 */
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
          // 载入期间用户退出了多选：选择态已经作废，别再写 selIds
          if (!this.multi) return;
        }
        this.selIds = selAllIds(this.viewAll);
        this.disarmIfAny();
        log("list", "全选 " + this.selIds.length + " / 共 " + this.totalCount + " 首");
      } finally {
        this.selectingAll = false;
        // 成功才收进度 toast；失败时 ensureAllSongs 的错误提示要留在屏上
        if (needLoad && loadedOk) this.hideToast();
      }
    },
    /** 进入多选前的本页副作用：浮窗必须先关 —— 遮罩只盖 .psh-body，左栏在浮窗开着时仍可点
        （PageShell 的刻意设计），进多选态后排序键从 rail 消失、浮窗就再也关不掉了 */
    onMultiEnter() {
      this.panel = "";
      log("list", "进入多选 kind=" + this.kind + " pid=" + this.pid + " 列表 " + this.totalCount + " 首");
    },
    /**
     * 删除键：**两次点按确认**（对齐 account 页「退出登录」的既有做法 —— 本平台没有对话框设施）。
     * 第一次 → armed='del'（按钮实心红 + 顶栏常显「再点一次」），3 秒不复位；第二次才真删。
     * kind=history 走本地移除（doRemoveHistory），其余走接口移除（doRemove）。
     */
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
    /**
     * 「下载」键：选中 →（空间预检：不足时两次点按确认，armed='dl'）→ downloadSongs
     * （用户下载通道，按设置里的下载音质）→ 退出多选 + toast；完成再 toast 汇总（判 _dead）。
     */
    async doDownload() {
      if (this._busy) return;
      if (!this.selIds.length) {
        this.showToast("未选中歌曲");
        return;
      }
      // 选中集合可能包含未渲染的曲目（整单全选）→ 从完整视图里取对象，顺序同用户看到的
      let picked = selPicked(this.selIds, this.viewAll);
      if (picked.length < this.selIds.length && !this.allLoaded) {
        /* 全选是按 trackIds 直接选的（省一次全量拉取），但下载需要曲目对象
           （歌名/歌手/封面/时长）——这里补齐全量，再按同一顺序取。
           列表正在分页/排序时别并发拉，避免两处都写 songs/shown。 */
        if (this.loadingMore || this._loadingFull) {
          this.showToast("正在加载列表，请稍候");
          return;
        }
        this.showToast("正在载入选中的曲目...", 60000);
        const ok = await this.ensureAllSongs();
        if (this._dead) return;
        if (!ok) return; // ensureAllSongs 已经给了失败提示
        this.hideToast();
        picked = selPicked(this.selIds, this.viewAll);
      }
      if (!picked.length) return;
      if (!this.isArmed("dl")) {
        this.showToast("检查空间...");
        const sp = await spaceCheck(picked);
        if (this._dead) return;
        if (sp.tight) {
          // 空间可能不足：第一次点按只进入待确认（顶栏常显提示 + 按钮变实心红）。
          // 3 秒自动复位由 armMixin 管；estText 只在待确认态里被读，留旧值不可见
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
    /** 历史的「删除选中」：本地移除 + 三份数据同批过滤（收敛实现在 listcursor.js） */
    doRemoveHistory() {
      this.disarm();
      cursorApplyHistRemoved(this, this.selIds.slice());
    },
    /** 下载活动 → this.dl（签名判重：快照 ~400ms 一发，不判重就是持续重渲染，坑 16 同族） */
    syncDl(s) {
      const d = s || {};
      const sig =
        (d.active ? 1 : 0) +
        "|" +
        d.total +
        "|" +
        (d.done + d.failed + (d.cancelled || 0)) +
        "|" +
        (d.stopping ? 1 : 0) +
        "|" +
        d.pct;
      if (sig === this._dlSig) return;
      this._dlSig = sig;
      this.dl = d;
    },
    async doRemove() {
      this.disarm();
      this._busy = true;
      const ids = this.selIds.slice(); // 先拷贝：applyRemoved 里的 exitManage 会清空 selIds
      const r = await removeFromPlaylist(this.pid, ids);
      this._busy = false;
      if (this._dead) return; // 页面已经退出（返回键），别再动 data
      if (!r.ok) {
        this.showToast(
          r.needLogin
            ? "未登录"
            : r.denied
              ? "订阅的歌单不能移除歌曲"
              : "移除失败" + (r.message ? "：" + r.message : "（" + r.code + "）"),
        );
        log("list", "移除失败 code=" + r.code + " " + (r.message || ""));
        return; // 选中集合保留，用户可以重试
      }
      this.applyRemoved(ids);
    },
    /** 删成功后的本地收敛（songs/trackIds/cursor 一起收敛；实现在 listcursor.js） */
    applyRemoved(ids) {
      cursorApplyRemoved(this, ids);
    },
    /* ---- 排序浮窗（ContextSheet 版：选中项/箭头见 panel* computed，pickSort 见下）---- */
    closePanel() {
      this.panel = "";
    },
    async pickSort(k) {
      if (this.kind === "artistsongs") {
        // 服务端排序：换序要重新拉（游标/分页状态一起复位）
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
        /* 本地排序：**先对完整列表排序，再分页渲染**。
           只有「默认 + 降序」是数据原序、分页拉多少排多少；其余任何排序键（含「默认 + 升序」
           = 整段反转）都必须先 ensureAllSongs 拿到全量，否则排的只是前 50 首、加载更多后
           新行会插到已排好的列表中间。 */
        const nextAsc = k === this.sortKey ? !this.sortAsc : false;
        const needFull = k !== "" || nextAsc;
        this.panel = "";
        if (needFull && !this.allLoaded) {
          // loadMore 在飞的时候不并发拉全量：两边都会写 songs/shown，后到的会把分页状态冲掉
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

/* ---- 主列 + 右侧分类侧栏 ----
   侧栏（搜索页）是独立组件 search-sidebar，开合宽度在其内部；
   外壳 flex:row 常驻是为了搜索页与其它 kind 共用同一套 DOM（切 kind 时不增删节点）。 */
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
/* 收起/展开提示：盖在顶栏右端那一块，right 由 toggleStyle 给（展开时让出侧栏宽度） */
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
/* 多选态顶栏右侧的「全选 / 全不选」：占满顶栏高度当点击区（同歌单页页签的写法） */
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
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
.lst-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.lst-more-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}

</style>
