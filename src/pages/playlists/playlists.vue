<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar :title="title" :sub="sub">
      <!-- pivot 直接并进顶栏（不用胶囊，就是两个文字页签）。
          平台没有内置 tab 组件，自绘；选中态走内联样式（不支持 .a.b 复合选择器）。
           每个页签的**右上角**带一个小号计数（网易云手机客户端页签上标的做法）——
           见 .pls-tabrow 的顶对齐实现。
          artist 源（歌手专辑）没有页签；pick 模式（选歌单）也没有 —— 订阅歌单实测
          加不了歌（401 无权限），所以只列「创建」页签里的（含置顶的「我喜欢」）。 -->
      <div class="pls-tabs" v-if="!isArtist && !pickMode">
        <div class="pls-tab" @click="switchTab('created')">
          <div class="pls-tabrow">
            <text class="pls-tab-t" :style="tabTextStyle('created')">创建</text>
            <text class="pls-tab-c" v-if="loaded" :style="tabCountStyle('created')">{{ createdTabCount }}</text>
          </div>
        </div>
        <div class="pls-tab" @click="switchTab('subscribed')">
          <div class="pls-tabrow">
            <text class="pls-tab-t" :style="tabTextStyle('subscribed')">收藏</text>
            <text class="pls-tab-c" v-if="loaded" :style="tabCountStyle('subscribed')">{{ subTabCount }}</text>
          </div>
        </div>
      </div>
    </page-topbar>

    <scroller class="pls-list">
      <!-- 4 张一行的横卡网格（手动分行，不依赖 flex-wrap） -->
      <div class="pls-row" v-for="(row, ri) in rows" :key="ri">
        <playlist-card v-for="p in row" :key="p.id" :item="p" @select="openItem(p)" />
      </div>
      <empty-hint v-if="!sorted.length" :text="hint" />
      <div class="pls-more" v-if="hasMore" @click="loadMore">
        <text class="pls-more-t" :style="{ color: accent.light }">{{
          loadingMore ? "加载中..." : isArtist ? "加载更多" : moreLabel(sorted.length - visibleItems.length, "个歌单")
        }}</text>
      </div>
    </scroller>

    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
import PageShell from "../../components/PageShell.vue";
import PageTopbar from "../../components/PageTopbar.vue";
import EmptyHint from "../../components/EmptyHint.vue";
import PlaylistCard from "../../components/PlaylistCard.vue";
import HintToast from "../../components/HintToast.vue";
import { go, paramsFor } from "../../utils/nav.js";
import { railBack, railBtn, ICON } from "../../utils/rail.js";
import {
  loadUserPlaylists,
  addToPlaylist,
  addToPlaylistMany,
  createPlaylist,
  fitPlaylistName
} from "../../utils/ncm/playlist.js";
import { loggedIn } from "../../utils/ncm/login.js";
import { fetchArtistAlbums } from "../../utils/ncm/api.js";
import { openTextEdit, available as imeAvailable } from "../../utils/systemKeyboard.js";
import config from "../../utils/config.js";
import { log } from "../../utils/log.js";
import { accentMixin } from "../../utils/theme.js";
import { TOK } from "../../utils/ui/tokens.js";
import { toastMixin } from "../../utils/ui/toast.js";
import { pageFrameMixin } from "../../utils/ui/frame.js";
import { pageBusMixin } from "../../utils/ui/pagebus.js";
import { PAGE_CARD, moreText } from "../../utils/ui/paging.js";

const PER_ROW = 4; // 每行卡片数

const ALBUM_PAGE = 30; // 歌手专辑一次拉多少（实测 offset 分页有效）

/** 输入法里名字的字符上限（服务端还要按显示宽度卡 40，见 fitPlaylistName） */
const NAME_MAX = 40;

export default {
  name: "playlists",
  mixins: [accentMixin, toastMixin, pageBusMixin, pageFrameMixin],
  components: {
    "page-shell": PageShell,
    "page-topbar": PageTopbar,
    "playlist-card": PlaylistCard,
    "hint-toast": HintToast,
    "empty-hint": EmptyHint,
  },
  data() {
    return {
      source: "created", // created | subscribed | artist
      tab: "created", // 顶部 pivot 的当前页签（created | subscribed），artist 源不用
      all: { liked: null, created: [], subscribed: [] }, // 一次拉回，切页签不再请求
      albums: [], // source=artist 时的专辑卡
      loaded: false, // 歌单数据是否已就绪（就绪前页签右上角不显示计数，避免先闪一个 0）
      hint: "加载中...",
      artistId: 0, // source=artist 时的歌手 id
      artistName: "",
      more: false, // 还有更多（仅 source=artist 的**服务端**分页用）
      shown: PAGE_CARD, // 用户歌单的渲染分片（本地全量在内存，按卡片数递增）
      loadingMore: false,
      pickId: 0,
      pickIds: [], // pick 模式要加入的曲目 id（多选态传一批；单个时长度为 1）
      pickName: "", // 曲名（顶栏副题给上下文）
      pickMode: false,
      busy: false // 添加请求进行中（防连点）
    };
  },
  computed: {
    isArtist() {
      return this.source === "artist";
    },
    /** 当前页签的歌单（artist 源时是专辑） */
    items() {
      if (this.isArtist) return this.albums;
      return this.tab === "created" ? this.all.created : this.all.subscribed;
    },
    /**
     * 歌单顺序固定为「更新时间」倒序（这页不做排序 UI，
     * 排序功能放到曲目列表页）。updateTime 来自 /api/user/playlist，
     * 由 playlist.js 的 fetchUserPlaylists 带出。
     *
     * 「我喜欢」在「创建」页签**置顶**：排序之后再 unshift 插队 —— 它的 updateTime
     * 可能很旧，放进排序会被甩到中间去。
     * source=artist 时不重排 —— 专辑按接口返回的顺序（新→旧）就好。
     */
    sorted() {
      if (this.isArtist) return this.albums;
      const out = this.items.slice();
      out.sort(function (a, b) {
        return (b.updateTime || 0) - (a.updateTime || 0);
      });
      if (this.tab === "created" && this.all.liked) out.unshift(this.all.liked);
      return out;
    },
    /** 当前页签实际渲染的卡片：用户歌单按 shown 分片；歌手专辑是服务端增量拉取（拉回多少渲染多少） */
    visibleItems() {
      return this.isArtist ? this.sorted : this.sorted.slice(0, this.shown);
    },
    /** 还有没有更多：歌手专辑看服务端 more；用户歌单看本地分片是否还有剩余 */
    hasMore() {
      if (this.isArtist) return !!this.more;
      return this.sorted.length > this.visibleItems.length;
    },
    /**
     * 「创建歌单」这个动作给不给：只在**自己创建的**列表里给 ——
     * 收藏（订阅）列表与歌手专辑列表都不是「我的歌单」，新建没有落点。
     * 「添加到歌单」的选择态（pickMode）也走 created 页签，所以自动继承。
     */
    showCreate() {
      return !this.isArtist && this.tab === "created" && loggedIn();
    },
    /** 按 4 个一组分行（113 个歌单 ≈ 12 屏，名字截断可接受） */
    rows() {
      const out = [];
      const list = this.visibleItems;
      for (let i = 0; i < list.length; i += PER_ROW) {
        out.push(list.slice(i, i + PER_ROW));
      }
      return out;
    },
    /** 页签名由 pivot 表达，标题就不重复了 */
    title() {
      if (this.pickMode) return "添加到歌单";
      if (!this.isArtist) return "我的歌单";
      return this.artistName ? this.artistName + " · 专辑" : "全部专辑";
    },
    sub() {
      // 顶栏不放「N 个歌单」这类计数（卡片上已经有了，页签名由 pivot 表达）
      // —— 计数改挂在 pivot 页签自己的右上角（.pls-tab-c 上标）
      if (this.pickMode) {
        const n = this.pickIds.length
        if (n === 1) return this.pickName ? "歌曲：" + this.pickName : "选一个歌单";
        return n ? "已选 " + n + " 首" : "选一个歌单";
      }
      if (this.isArtist) return this.albums.length + " 张";
      return "";
    },
    /** 「创建」页签计数：含置顶的「我喜欢」（与首页卡片的口径一致） */
    createdTabCount() {
      return this.all.created.length + (this.all.liked ? 1 : 0);
    },
    /** 「收藏」页签计数 */
    subTabCount() {
      return this.all.subscribed.length;
    },
    /**
     * 左栏：返回 + 底键「创建歌单」。
     *
     * 走左栏而不是在网格里塞一张入口卡：网格第一格被固定的入口占掉后，
     * 「我喜欢」的置顶位置和每页 4 张的分组都要为它让位，而这是个低频动作。
     * 「添加到歌单」的选择态（pickMode）用的是同一个页面、同一个页签，键自动继承 ——
     * 选歌单时发现没有合适的，直接新建并把选中的歌加进去。
     *
     * ⚠ 必须留在 computed：模板 `:rail="rail"` 编译成「取字段」，methods 里取到的是函数
     * （pageFrameMixin 已有同名 computed，Vue 只留 mixin 那份并 warn，页面这份整个失效）。
     * 本页曾误写进 methods → 「创建歌单」键从未出现，见 docs/平台约束与自检.md。
     */
    rail() {
      const out = [railBack()];
      if (this.showCreate) out.push(railBtn("newpl", ICON.plus));
      return out;
    },
  },
  mounted() {
    this._dead = false;
    // 歌单详情页改过歌单（改名/删除/收藏状态）→ 本页重拉一次（loadUserPlaylists 带 force）；
    // 注册/退役见 utils/ui/pagebus.js
    this.onPageEvent("bpncm:playlist-changed", "load");
    /* 本页会在栈里同时存活多个实例（浏览态 / 「添加到歌单」选择态 / 歌手专辑），
       参数通道 utils/nav.js 的 pending 按**实例槽位 key** 记账，
       所以这里必须用真实 $pageName 取参数，写死 "playlists" 会让第二层实例的 pick 参数静默丢失。 */
    this._routePage = (this.$page && this.$page.$pageName) || "playlists";
    const p = paramsFor(this._routePage, this.$page ? this.$page.options : null);
    /* pick 参数两种形态：单曲 = 数字（或 "123"）；多选态 = 逗号串 "1,2,3"。
       都按字符串切一遍再 Number，参数被序列化成字符串也吃得下。 */
    this.pickIds = String(p.pick || "")
      .split(",")
      .map(function (s) {
        return Number(s) || 0;
      })
      .filter(function (n) {
        return n > 0;
      });
    this.pickId = this.pickIds[0] || 0;
    this.pickName = p.pname || "";
    this.pickMode = this.pickIds.length > 0;
    this.source = p.source === "subscribed" ? "subscribed" : p.source === "artist" ? "artist" : "created";
    this.tab = this.source === "subscribed" ? "subscribed" : "created";
    if (this.pickMode) {
      // 选择目标只有「创建」页签（含「我喜欢」置顶）；订阅歌单实测 401 加不了歌
      this.source = "created";
      this.tab = "created";
    }
    this.artistId = p.id || 0;
    this.artistName = p.name || "";
    log(
      "playlists",
      "onLoad page=" + this._routePage + " source=" + this.source + " id=" + this.artistId + " pick=" + this.pickId,
    );
    this.load();
  },
  beforeDestroy() {
    this._dead = true;
    // 提示计时器由 ui/toast.js 的 beforeDestroy 自动清（页面弹掉后回调再 setData 没意义）；
    // 返回后的 toast 走播放页的监听
  },
  methods: {
    /* ---- 左栏（分派骨架见 ui/frame.js：onBack / onRailKey 两个钩子）---- */
    onRailKey(key) {
      if (key === "newpl") {
        this.onCreate();
        return;
      }
    },
    async load() {
      try {
        if (this.isArtist) {
          await this.loadAlbums(false);
          return;
        }
        if (!loggedIn()) {
          this.hint = "未登录";
          return;
        }
        const uid = config.get("userId") || 0;
        const r = await loadUserPlaylists(uid);
        this.all = { liked: r.liked, created: r.created, subscribed: r.subscribed };
        this.loaded = true;
        this.hint = "没有歌单";
        log(
          "playlists",
          "歌单就绪 创建=" + r.created.length + " 收藏=" + r.subscribed.length + " 我喜欢=" + (r.liked ? 1 : 0),
        );
      } catch (e) {
        this.hint = "加载失败: " + ((e && e.message) || e);
        log("playlists", "加载失败 " + ((e && e.message) || e));
      }
    },
    /** 歌手专辑：分页拉取，映射成 PlaylistCard 的通用形状（id 加 al 前缀避免撞歌曲线图缓存） */
    async loadAlbums(more) {
      const r = await fetchArtistAlbums(this.artistId, more ? this.albums.length : 0, ALBUM_PAGE);
      const cards = [];
      for (let i = 0; i < r.albums.length; i++) {
        const a = r.albums[i];
        cards.push({ id: "al" + a.id, albumId: a.id, name: a.name, count: a.size, cover: a.cover });
      }
      this.albums = more ? this.albums.concat(cards) : cards;
      this.more = r.more;
      this.hint = "没有专辑";
      log("playlists", "歌手专辑 " + this.albums.length + " more=" + r.more);
    },
    async loadMore() {
      if (this.loadingMore || !this.hasMore) return;
      // 歌手专辑：服务端 offset 分页；用户歌单：本地分片（数据早已全量拉回）
      if (!this.isArtist) {
        this.shown = Math.min(this.shown + PAGE_CARD, this.sorted.length);
        return;
      }
      this.loadingMore = true;
      try {
        await this.loadAlbums(true);
      } catch (e) {
        log("playlists", "加载更多失败 " + ((e && e.message) || e));
      }
      this.loadingMore = false;
    },
    /** 「加载更多」文案（import 的 helper 模板里不能裸调，走 methods 暴露） */
    moreLabel(n, unit) {
      return moreText(n, unit);
    },
    /* ---- pivot ---- */
    switchTab(k) {
      if (this.tab === k) return;
      this.tab = k;
      // 切换页签 = 换一份列表，展开进度从头算（否则短页签会继承长页签的 shown）
      this.shown = PAGE_CARD;
      log("playlists", "页签 -> " + k + "（" + this.sorted.length + " 张卡）");
    },
    /** 页签选中态：只有文字颜色/字重变化（内联样式；平台不支持 .a.b 复合选择器）；色走主题色 */
    tabTextStyle(k) {
      return this.tab === k ? { color: this.accent.light, fontWeight: "bold" } : { color: TOK.text3 };
    },
    /** 右上角计数的颜色跟随页签选中态（字号/间距在样式里，不在这里内联） */
    tabCountStyle(k) {
      return { color: this.tab === k ? this.accent.light : TOK.text3 };
    },
    openItem(p) {
      if (!p) return;
      if (this.pickMode) {
        this.addTo(p); // 选歌单：点卡片 = 把当前歌曲加进去
        return;
      }
      if (this.isArtist) {
        go("album", { id: p.albumId, name: p.name });
        return;
      }
      // 「我喜欢」是一张普通卡，但点它进的是 liked 列表（不是普通歌单 id 分支）
      if (this.all.liked && p.id === this.all.liked.id) {
        go("list", { kind: "liked", id: p.id, name: p.name });
        return;
      }
      go("list", { kind: "playlist", id: p.id, name: p.name });
    },
    /* ---- 创建歌单 ---- */
    /**
     * 名字走系统输入法（与 plinfo 改名同款），创建完：
     *   - 普通浏览态：重拉列表，新歌单按 updateTime 排在最前（「我喜欢」置顶之后）
     *   - 选歌单态（添加到歌单）：紧接着把选中的歌加进去再退页 ——
     *     实测新建完**立刻**就能 manipulate/tracks 加歌，不用等列表刷新
     * 名字先按服务端口径（显示宽度 ≤40）截断再发，避免 400「标题字数异常」。
     */
    async onCreate() {
      if (this.busy) return;
      if (!(await imeAvailable())) {
        this.showToast("系统输入法不可用");
        return;
      }
      this.busy = true;
      const text = await openTextEdit({
        text: "",
        placeholder: "歌单名",
        enterButtonText: "创建",
        maxlength: NAME_MAX,
        inputType: "ZhCNPreferred"
      });
      if (this._dead) return; // 输入法是长异步（等用户敲名字），期间页面可能已被弹掉
      if (text === null) {
        this.busy = false;
        log("playlists", "创建歌单：取消输入");
        return;
      }
      const name = String(text).replace(/^\s+|\s+$/g, "");
      if (!name) {
        this.busy = false;
        this.showToast("名字不能为空");
        return;
      }
      const fit = fitPlaylistName(name);
      const r = await createPlaylist(fit.name);
      this.busy = false;
      if (this._dead) return; // 请求期间页面可能已被弹掉（toast/reload 都没有落点了）
      if (!r.ok || !r.id) {
        this.showToast(
          r.needLogin ? "未登录，无法创建" : r.code === 405 ? "操作过于频繁，请稍后再试" : r.message || "创建失败",
        );
        log("playlists", "创建歌单失败 code=" + r.code + " " + (r.message || ""));
        return;
      }
      log("playlists", "创建歌单 id=" + r.id + " name=" + r.name + (fit.cut ? "（名字已截断）" : ""));
      if (this.pickMode) {
        await this.addTo({ id: r.id, name: r.name }, true);
        return;
      }
      await this.reload();
      this.showToast((fit.cut ? "名字太长已截断，" : "") + "已创建「" + r.name + "」");
    },
    /** 重拉用户歌单并覆盖本地（建/删/改名后用；createPlaylist 已作废缓存，这里 force 只是双保险） */
    async reload() {
      try {
        const uid = config.get("userId") || 0;
        const r = await loadUserPlaylists(uid, true);
        this.all = { liked: r.liked, created: r.created, subscribed: r.subscribed };
      } catch (e) {
        log("playlists", "重拉歌单失败 " + ((e && e.message) || e));
      }
    },
    /* ---- pick 模式（添加到歌单） ---- */
    /** 加入歌单：订阅歌单实测 401，所以选择页只显示创建列表。
     *  单曲走 addToPlaylist（回包会明确说「重复」），多选走 addToPlaylistMany（批量 + 重复计数）。
     *  created=true 表示目标歌单是本次刚新建的（文案里带出来）。 */
    async addTo(p, created) {
      if (this.busy) return;
      this.busy = true;
      const ids = this.pickIds;
      const r = ids.length > 1 ? await addToPlaylistMany(p.id, ids) : await addToPlaylist(p.id, this.pickId);
      this.busy = false;
      if (!r.ok && r.dup) {
        this.showToast("歌曲已在「" + p.name + "」里");
        log("playlists", "pick 重复 id=" + this.pickId + " -> " + p.id);
        return;
      }
      if (!r.ok) {
        this.showToast(r.needLogin ? "未登录，无法添加" : r.denied ? "订阅的歌单不能加歌" : r.message || "添加失败");
        log("playlists", "pick 失败 code=" + r.code + " -> " + p.id);
        return;
      }
      const msg = r.dup
        ? "已加入「" + p.name + "」· " + r.dup + " 首本就在里面"
        : ids.length > 1
          ? created
            ? "已创建「" + p.name + "」并添加 " + r.added + " 首"
            : "已添加 " + r.added + " 首到「" + p.name + "」"
          : created
            ? "已创建「" + p.name + "」并添加"
            : "已添加到「" + p.name + "」";
      log("playlists", "pick 完成 ids=" + ids.length + " -> " + p.id + " " + msg);
      /* global $falcon */
      try {
        $falcon.trigger("bpncm:toast", msg);
      } catch (e) {}
      this.$page.finish();
    },
  },
};
</script>

<style lang="less" scoped>
@import "../../styles/common.less";

/* 顶栏里的页签（顶栏 15vh 高，页签占满其高度 = 整个 15vh×N 都可点） */
.pls-tabs {
  height: @topbar-h;
  flex-direction: row;
  align-items: center;
}
.pls-tab {
  height: @topbar-h;
  justify-content: center;
  padding-left: 5vh;
  padding-right: 5vh;
}
/* 页签行 = 文字 + 右上角计数。**align-items: flex-start 是上标的关键**：
   计数（@fs-mute 6vh）顶部与页签名（@fs-strong 8.5vh）顶部齐平、字号小一号，
   视觉上就落在文字的右上角（网易云手机客户端页签上标的做法）。
   用顶对齐而不是绝对定位的负偏移——平台会把负偏移当 0（AGENTS.md 平台坑 17）。 */
.pls-tabrow {
  flex-direction: row;
  align-items: flex-start;
}
.pls-tab-t {
  font-size: @fs-strong;
}
/* 计数的水平间距取小值（「间距要很小」），紧贴文字右上方 */
.pls-tab-c {
  font-size: @fs-mute;
  margin-left: 0.5vh;
}

.pls-list {
  flex: 1;
  padding-top: 4vh;
  padding-left: 6vh;
  /* 每张卡自带 5vh 右边距，右侧 padding 相应减掉，左右留白对称 */
  padding-right: 1vh;
}
.pls-row {
  flex-direction: row;
  margin-bottom: 5vh;
}
.pls-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.pls-more-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
</style>
