import { searchMeta } from '../../services/ncm/api.js';

/* 排序键：按 list 的 kind 给不同集合（搜索页不提供排序，分类改由右侧侧栏承担）。
   - liked / playlist：本地排序，'at' = 收藏时间（在 trackIds[].at 里，不在曲目对象上）
   - history：本地排序，默认顺序就是播放时间倒序，再给一个 'at' 键是伪选项，不给
   - artistsongs：**服务端**排序（/api/v1/artist/songs?order=hot|time），没有升降序
   除 artistsongs 外，'默认'（key=''）也有升降序：降序 = 接口/收藏原顺序，升序 = 整段反转 */
export const SORTS = {
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

export const listViewMixin = {
  computed: {
    // 当前分类的选项（label / unit），供顶栏副行与切分类后的提示用
    searchCat() {
      return searchMeta(this.searchType);
    },

    // 分类侧栏当前是否展开（收起 / 非搜索 / 多选时宽度都是 0，内容被 overflow 裁掉）
    catSideOn() {
      return this.showCatToggle && this.catOpen;
    },

    // 侧栏宽（SearchSidebar 开合时让顶栏提示让位用）：与组件内 SIDE_W 同值成对维护
    sideW() {
      return this.catSideOn ? 62.5 : 0;
    },

    // 完整视图序列：本地排序作用在**已取回的全量**上（未全量时 pickSort 会先拉满，
    // 所以不会出现「只排前 50 首」）；artistsongs 是服务端排序，原样透出。
    viewAll() {
      return this.sorted(this.songs);
    },

    // 源数据总数：liked/playlist 是 trackIds，artistsongs 是服务端 total
    idsTotal() {
      if (this.kind === "artistsongs") return this.total;
      return this.trackIds.length;
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

    // 顶栏可点进「歌单详情」：只有歌单与我喜欢的曲目页才有歌单可看（搜索/歌手曲目没有）
    canOpenInfo() {
      if (this.multi) return false;
      return !!this.pid && (this.kind === "liked" || this.kind === "playlist");
    },

    // 搜索页顶栏可点：点击重新编辑关键词（多选态顶栏不可点）
    canEditKeyword() {
      return this.isSearch && !this.multi;
    },

  },
};
