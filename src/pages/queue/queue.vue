<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar :title="'播放列表'" :sub="barSub">
      <!-- 多选态顶栏右侧的全选/全不选（同曲目列表页的既有做法） -->
      <div class="qu-all" v-if="multi" @click="toggleAll">
        <text class="qu-all-t" :style="{ color: accent.light }">{{ allPicked ? "全不选" : "全选" }}</text>
      </div>
    </page-topbar>
    <scroller class="qu-list" @scroll="onScroll">
      <!-- 当前曲不在窗口里（播放自动往后走了 / 用户展开过别处）→ 一键回到当前曲；
           窗口本身以当前曲为锚点（见 initWindow），所以第一次进来当前曲一定可见。 -->
      <div class="qu-loc" v-if="songs.length && !inWindow" @click="recenter">
        <text class="qu-loc-t" :style="{ color: accent.light }">当前播放第 {{ st.index + 1 }} 首 · 点此定位</text>
      </div>
      <!-- 前向折叠：当前曲之前（已播过）的部分折起来，不在首屏铺几百行；
           点一次往前展开一段，展开量同样按 PAGE_QUEUE 递增。 -->
      <div class="qu-more" v-if="beforeCount" @click="expandBefore">
        <text class="qu-more-t" :style="{ color: accent.light }">前面还有 {{ beforeCount }} 首 · 点此展开</text>
      </div>
      <!-- 锚点：零高度、固定在顶部装饰之后、所有行之前。
           用 v-for 行的 ref 数组做锚点不可靠——窗口上滑后平台会复用同 key 的行，
           $refs 数组顺序会混入「旧窗口的行」，锚点位置就错了；单例 ref 没有这个问题。 -->
      <div class="qu-anchor" ref="topAnchor" />
      <div class="qu-row" v-for="(s, i) in win.list" :key="s.id" :style="rowStyle(i)" @click="onRow(i)">
        <!-- 多选态：序号列换成勾选圈（未选 = 空心环，已选 = 红底白勾），
             与其它列表页的选中视觉一致（两个独立 v-if，不用 v-else——平台编译器不稳） -->
        <div class="qu-markbox" v-if="multi">
          <div class="qu-mark" :style="markStyle(s.id)">
            <!-- 勾选圈底是实心主题色 → 图标走 fgIcon（亮色预设自动换深色版，否则白图标看不见） -->
            <image v-if="isSel(s.id)" class="qu-chk" :src="fgIcon('check')" />
          </div>
        </div>
        <text class="qu-i" :style="idxStyle(i)" v-if="!multi">{{ win.start + i + 1 }}</text>
        <text class="qu-nm" :style="nameStyle(i)">{{ s.name }}</text>
        <text class="qu-ar">{{ s.artist }}</text>
        <text class="qu-du">{{ dur(s) }}</text>
      </div>
      <div class="qu-more" v-if="afterCount" @click="expandAfter">
        <text class="qu-more-t" :style="{ color: accent.light }">{{ moreLabel(afterCount, "首") }}</text>
      </div>
      <empty-hint v-if="!songs.length" text="播放列表为空" />
    </scroller>

    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 播放列表页（当前播放队列，独立页面）
 *
 * 显示当前播放队列，当前曲高亮，点任意一首跳播（player.playAt）。
 * 行高 23vh（与 SongRow 一致）；不做封面下载 —— 队列页要的是"一眼看清顺序"，
 * 少一个异步源少一份坑。
 *
 * 多选（操作**只有移除出队列**）：
 *   左栏 [多选] → 多选态 [× 退出多选, 移除]；顶栏全选；点行勾选。
 *   移除 = player.removeFromQueue(ids)：原始队列与随机临时队列同删、index 重定位；
 *   **在播曲也能移除**：删到它 → 接着播「原来的下一首」
 *   （当前曲之后第一个活下来的，后面没了绕回队首；当时是暂停态则只换曲、不出声）；
 *   删完一首不剩 → 停播回空态（首页卡/播放页写「未在播放」，会话快照也一并删掉）。
 *   两次点按确认（同各页删除的既有做法）。
 * 随机模式下显示/操作的都是**临时队列**（切回其它模式即恢复原序）。
 *
 * 窗口与折叠：
 *   - 队列 ≤ PAGE_QUEUE（50 首）：一批就装得下 → **整列渲染、不折叠**；进页面若当前曲在
 *     首屏之外，用 `$page.$dom.scrollToElement` 滚到当前曲附近（上方留 2 行）。
 *   - 长队列：只渲染 [start, end) 窗口（当前曲为锚点，前面折成「前面还有 N 首」）。
 *   - 前向展开窗口**上滑**（start/end 同时前移、末尾丢弃补「加载更多」），并滚到
 *     「旧内容原地不动」的绝对位置——不这么做的话，插入的 50 行会把当前内容整体顶下去。
 */
import PageShell from "../../components/PageShell.vue";
import PageTopbar from "../../components/PageTopbar.vue";
import EmptyHint from "../../components/EmptyHint.vue";
import HintToast from "../../components/HintToast.vue";
import { railBack, railBtn, ICON } from "../../utils/rail.js";
import { player } from "../../utils/player/player.js";
import { downloadSongs } from "../../utils/player/download.js";
import { toPlaylist } from "../../utils/songact.js";
import { selPicked, startText, resultText } from "../../utils/multidl.js";
import { fmtDur } from "../../utils/format.js";
import { log } from "../../utils/log.js";
import { accentMixin } from "../../utils/theme.js";
import { TOK } from "../../utils/ui/tokens.js";
import { toastMixin } from "../../utils/ui/toast.js";
import { armMixin } from "../../utils/ui/arm.js";
import { multiSelectMixin } from "../../utils/ui/multi.js";
import { pageFrameMixin } from "../../utils/ui/frame.js";
import { PAGE_QUEUE, moreText } from "../../utils/ui/paging.js";
import { VH } from "../../utils/player/layout.js";

/* 与 LESS 成对维护的几何（px）：行高 .qu-row = @row-h 23vh，折叠条 18vh，定位行 14vh。
   窗口锚定滚动要用像素算「插入多少行 = 内容上移多少」，所以这里必须有一份。 */
const ROW_PX = 23 * VH;
const FOLD_PX = 18 * VH;
const LOC_PX = 14 * VH;
/* 前向展开的步长：比整页少 6 行。锚定后视口里的旧内容位于窗口第 K 行附近，
   再留 5～6 行给屏幕下方，窗口总行数仍 ≤ PAGE_QUEUE（平台一次渲染预算）。 */
const EXPAND = PAGE_QUEUE - 6;

export default {
  name: "queue",
  mixins: [accentMixin, toastMixin, armMixin, multiSelectMixin, pageFrameMixin],
  components: { "page-shell": PageShell, "page-topbar": PageTopbar, "hint-toast": HintToast, "empty-hint": EmptyHint },
  data() {
    return {
      ICON: ICON,
      st: player.state(),
      /* 渲染窗口（全局下标，左闭右开）：**只渲染 [start, end)**，不是整个队列。
         队列可能来自「播放全部」的整张歌单（几百上千首），整列铺出来会撞平台的
         一次渲染 ≤50 行预算；窗口以当前曲为锚点，前面已播部分「前向折叠」成一行。 */
      start: 0,
      end: 0,
    };
  },
  computed: {
    songs() {
      return this.st.queue || [];
    },
    /** 实际窗口（把 start/end 夹进当前队列长度，删除/清空后不会越界）。
        队列总长 ≤ PAGE_QUEUE 时**整列渲染、不折叠**（一批就装得下，没有「前面还有 N 首」的意义）。 */
    win() {
      const n = this.songs.length;
      if (!n) return { start: 0, end: 0, list: [] };
      if (n <= PAGE_QUEUE) return { start: 0, end: n, list: this.songs };
      let start = Math.max(0, Math.min(this.start, n - 1));
      let end = Math.min(Math.max(this.end, start + 1), n);
      if (end <= start) {
        start = 0;
        end = Math.min(n, PAGE_QUEUE);
      }
      return { start: start, end: end, list: this.songs.slice(start, end) };
    },
    /** 窗口前面折起来的条数（已播部分） */
    beforeCount() {
      return this.win.start;
    },
    /** 窗口后面还没展开的条数 */
    afterCount() {
      return this.songs.length - this.win.end;
    },
    /** 当前曲是否在窗口里（不在就给「点此定位」；没有当前曲时不提示） */
    inWindow() {
      const i = Number(this.st.index);
      if (!(i >= 0)) return true;
      return i >= this.win.start && i < this.win.end;
    },
    sub() {
      const n = this.songs.length;
      if (!n) return "";
      // 随机模式下列表是**打乱后的临时队列**（原始顺序没动，切回其它模式即恢复）
      return (
        "共 " +
        n +
        " 首 · 正在播第 " +
        (this.st.index + 1) +
        " 首" +
        (this.st.loopMode === "shuffle" ? " · 随机顺序" : "")
      );
    },
    /** 顶栏副题：多选态显示勾选/待确认（待确认提示必须常显，不能放 toast） */
    barSub() {
      if (this.isArmed("rm")) return this.armRailText("移除", this.selIds.length);
      if (this.multi) return this.multiBarSub; // 句式由 multiSelectMixin 统一（缺省 M = songs.length）
      return this.sub;
    },
    /** 左栏（CSV「播放列表」行）：返回 +（多选｜多选态为 收藏到歌单 / 下载 / 移除）。
        多选态第一槽位变「退出多选」（× 图标） */
    rail() {
      if (this.multi) {
        return [
          railBack(ICON.stop), // × 退出多选
          railBtn("topl", ICON.plplus),
          railBtn("dl", this.fgIcon("download")),
          // armed → 实心主题色底：图标必须走 fgIcon（亮色预设换深色版，白图标压亮底看不见）
          railBtn("rm", this.fgIcon("trash"), false, "", this.isArmed("rm")),
        ];
      }
      // 空列表 → 置灰
      return [railBack(), railBtn("multi", ICON.multi, false, "", false, !this.songs.length)];
    },
  },
  created() {
    // 首帧就用当前曲做窗口锚点（mounted 之前先算好，避免闪一下空列表）
    this.initWindow();
  },
  mounted() {
    const self = this;
    this._scrollY = 0; // 滚动位置只用于锚定计算，不进 data（高频更新不需要重渲染）
    this._off = player.on(function (s) {
      self.st = s;
    });
    log("queue", "播放列表页挂载，队列 " + this.songs.length + " 首");
    // 整列渲染（≤50 首）时窗口覆盖全部，当前曲可能在首屏之外 → 进来先滚到当前曲附近
    this.locateOnOpen();
  },
  beforeDestroy() {
    // armed / toast 的计时器由 ui/arm.js、ui/toast.js 的 beforeDestroy 自动清
    this._destroyed = true; // 延迟的滚动锚定回调不要再碰已退出的页面
    if (this._off) player.off(this._off);
    this._off = null;
  },
  methods: {
    dur(s) {
      return fmtDur(s.durationMs);
    },
    /** 窗口内行下标 → 队列全局下标（窗口只渲染一段，播放/勾选必须用全局下标） */
    globalIndex(i) {
      return this.win.start + i;
    },
    /**
     * 以当前曲为锚点初始化渲染窗口（最多 PAGE_QUEUE 行）。
     * 队列总长 ≤ PAGE_QUEUE：一批就装得下，整列渲染、**不折叠**（滚动定位交给 locateOnOpen）。
     * 长队列：**当前曲放在窗口顶部附近**（上方只留 2 行上下文）—— 本机一屏只显示约 4 行，
     * 若把当前曲居中在 50 行窗口里，它仍在首屏下方好几屏，等于没「定位到当前」。
     * 前面的已播段折成一行「前面还有 N 首」，窗口往后的行数不足 50 时保持短窗口，不回头凑数。
     */
    initWindow() {
      const n = this.songs.length;
      if (!n) {
        this.start = 0;
        this.end = 0;
        return;
      }
      if (n <= PAGE_QUEUE) {
        this.start = 0;
        this.end = n;
        log("queue", "短队列 " + n + " 首，整列渲染（不折叠）");
        return;
      }
      const idx = Math.max(0, Math.min(Number(this.st.index) || 0, n - 1));
      const lead = idx > 2 ? 2 : 0; // 当前曲上方留 2 行，窗口顶部就是折叠条
      this.start = Math.max(0, idx - lead);
      this.end = Math.min(n, this.start + PAGE_QUEUE);
      log("queue", "窗口 " + this.start + ".." + this.end + "（当前第 " + (idx + 1) + " 首）");
    },
    /* ---- 滚动锚定：前向展开时把旧内容钉在原位置（不跳页） ----
       平台没有通用的 scrollTop setter，但 `$page.$dom.scrollToElement(el, { offset })`
       （weex 同款 dom 模块）会把滚动位置设成「元素内容位置 + offset」——传绝对 offset
       就等价于一次 scrollTo。两条实测依据（见 docs/运行时API参考.md 的 dom 记录）：
         - 它内部会先 tryLayoutImmediately，布局脏也能量到元素位置；
         - 参数只有 offset/int 与 smooth/bool（反汇编 DomModule::scrollToElement 确认），
           这里固定 smooth:false，避免 50 行长距离滚动被动画拉长。
       本页不依赖 `$nextTick`（本项目未实测），统一用 setTimeout 等一帧布局再滚动。 */
    /** 顶部装饰（定位行 + 折叠条）当前占的高度 px，锚定 offset 要减掉它 */
    chromePx() {
      let h = 0;
      if (!this.inWindow) h += LOC_PX;
      if (this.beforeCount) h += FOLD_PX;
      return h;
    },
    /** 把「首行之前」的锚点滚到 offset 处（30ms 后布局已更新；重复调用是绝对定位，幂等） */
    scrollToOffset(offset, why) {
      const self = this;
      setTimeout(function () {
        if (self._destroyed) return;
        const el = self.$refs && self.$refs.topAnchor;
        const dom = self.$page && self.$page.$dom;
        if (!el || !dom || typeof dom.scrollToElement !== "function") {
          log("queue", "滚动锚定不可用（" + why + "）");
          return;
        }
        dom.scrollToElement(el, { offset: offset, smooth: false });
      }, 30);
    },
    /** 短队列（整列渲染）进来时滚到当前曲附近：上方留 2 行上下文 */
    locateOnOpen() {
      const n = this.songs.length;
      const idx = Number(this.st.index);
      if (!n || !(idx >= 0)) return;
      const full = this.win.start === 0 && this.win.end === n;
      if (!full || idx < 3) return; // 长队列的窗口本身就以当前曲为锚点；短队列前 3 首在首屏
      // 整列渲染时顶部没有折叠/定位行，锚点就在第一行之前：直接滚到第 idx-2 行的顶部
      this.scrollToOffset((idx - 2) * ROW_PX, "locate");
      log("queue", "短队列定位到第 " + (idx + 1) + " 首（上方留 2 行）");
    },
    /** 滚动位置（原生 px）；只做锚定计算，不进 data */
    onScroll(e) {
      const c = e && e.contentOffset;
      const y = c ? Number(c.y) : NaN;
      if (y === y && y >= 0) this._scrollY = y;
    },
    /**
     * 把前面的已播部分再展开一段。
     * 关键：**展开后窗口上滑（start/end 同时前移），而不是只减 start**——只减 start 会把
     * 窗口撑到 50 行以上，撞平台渲染预算。上滑会丢掉窗口末尾的行，但那些行在视口下方，
     * 靠底部「加载更多」再补回来。
     * 视口内容不动：新布局里「首行元素位置 + offset = 旧 scrollTop + 新增行高」，
     * 而 scrollToElement 的滚动位置正是「首行位置 + offset」。
     */
    expandBefore() {
      const n = this.songs.length;
      const old = this.win;
      if (!old.start) return;
      const k = Math.min(EXPAND, old.start);
      if (k <= 0) return;
      const s = this._scrollY || 0; // 旧滚动位置（原生 px）
      const chrome = this.chromePx(); // 展开前的顶部装饰高度
      const start = old.start - k;
      const end = Math.min(n, start + PAGE_QUEUE);
      this.start = start;
      this.end = end;
      /* 目标滚动位置 = s + k*ROW + (新 chrome − 旧 chrome)；
         scrollToElement 定的是「第 0 行位置(新 chrome) + offset」，所以
         offset = s + k*ROW − 旧 chrome（与新 chrome 无关，定位行出现/消失都成立）。 */
      const offset = s + k * ROW_PX - chrome;
      this.scrollToOffset(offset, "expandBefore");
      // 布局如果比 30ms 慢，90ms 再兜一次（绝对定位，不会累积误差）
      const self = this;
      setTimeout(function () {
        self.scrollToOffset(offset, "expandBefore+");
      }, 90);
      log(
        "queue",
        "向前展开 " + k + " 首 -> " + start + ".." + end +
          "，锚定 offset=" + Math.round(offset) + "（scrollY=" + Math.round(s) + "，chrome=" + Math.round(chrome) + "）"
      );
    },
    /** 把后面的待播部分再展开一段 */
    expandAfter() {
      if (!this.afterCount) return;
      this.end = Math.min(this.songs.length, this.win.end + PAGE_QUEUE);
      log("queue", "向后展开 -> end=" + this.end);
    },
    /** 播放自动往后走了、当前曲离开窗口时，一键回到当前曲 */
    recenter() {
      this.initWindow();
      this.locateOnOpen();
    },
    moreLabel(n, unit) {
      return moreText(n, unit);
    },
    /** 点行：多选态 = 勾选，否则跳播（在播那首 = 退出本页回到播放页） */
    onRow(i) {
      const g = this.globalIndex(i);
      if (this.multi) {
        const s = this.songs[g];
        if (s) this.toggleSel(s.id); // 选择变化自动 disarm（ui/multi.js）
        return;
      }
      this.pick(g);
    },
    pick(g) {
      if (g === this.st.index) {
        this.$page.finish();
        return;
      }
      player.playAt(g);
      log("queue", "跳播第 " + (g + 1) + " 首");
      this.$page.finish();
    },
    /* ---- 多选 / 移除 ——状态机在 ui/multi.js，本页只给范围与计数口径 ---- */
    multiList() {
      return this.songs;
    },
    onMultiEnter() {
      log("queue", "进入多选，队列 " + this.songs.length + " 首");
    },
    /** 移除键：两次点按确认（第一次 → 实心红 + 顶栏常显「再点一次」）——状态/计时走 armMixin */
    armRemove() {
      if (!this.selIds.length) {
        this.showToast("未选中歌曲");
        return;
      }
      if (this.isArmed("rm")) {
        this.doRemove();
        return;
      }
      this.arm("rm");
    },
    /**
     * 执行移除（起**在播曲也可以移除**）：
     *   删完一首不剩 → 停播回空态（`emptied`）；
     *   删到了在播曲 → 接着播「原来的下一首」（`switched`；当时是暂停态则只换曲不出声）。
     */
    doRemove() {
      this.disarm();
      const ids = this.selIds.slice();
      const r = player.removeFromQueue(ids);
      if (!r.removed) {
        this.showToast("没有可移除的歌曲");
        return;
      }
      this.exitMulti();
      // 队列长度/当前曲都变了：窗口重新以当前曲为锚点（否则可能停在只剩一行的旧窗口）
      this.initWindow();
      // 删到 ≤50 首后窗口整列渲染，当前曲可能不在首屏 → 重新定位
      this.locateOnOpen();
      if (r.emptied) {
        this.showToast("播放列表已清空，停止播放");
        log("queue", "移除 " + r.removed + " 首 → 队列清空，播放器空态");
        return;
      }
      if (r.switched) {
        this.showToast("已移除 " + r.removed + " 首，接着播放下一首");
        log("queue", "多选移除 " + r.removed + " 首（含在播曲）→ 接下一首");
        return;
      }
      this.showToast("已从播放队列移除 " + r.removed + " 首");
      log("queue", "多选移除 " + r.removed + " 首");
    },
    /* ---- 行样式（色值全部走主题色，见 utils/theme.js） ---- */
    rowStyle(i) {
      const g = this.globalIndex(i);
      const s = this.songs[g];
      if (this.multi && s && this.isSel(s.id)) return { backgroundColor: this.accent.a12 };
      return g === this.st.index ? { backgroundColor: this.accent.a14 } : {};
    },
    idxStyle(i) {
      return { color: this.globalIndex(i) === this.st.index ? this.accent.light : TOK.text3 };
    },
    nameStyle(i) {
      return { color: this.globalIndex(i) === this.st.index ? this.accent.light : TOK.text };
    },
    /** 勾选圈两态（内联 style —— 平台不支持 .a.b 复合选择器） */
    markStyle(id) {
      return this.isSel(id)
        ? { backgroundColor: this.accent.c, borderColor: TOK.text }
        : { backgroundColor: TOK.none, borderColor: TOK.markBorder };
    },
    /* ---- 左栏（分派骨架见 ui/frame.js）---- */
    onBack() {
      // 多选态：返回键是「退出多选」（图标 ×，见 rail()），不退页面
      if (this.exitMultiIfAny()) return;
      this.$page.finish();
    },
    onRailKey(key) {
      if (key === "multi") this.enterMulti();
      else if (key === "rm") this.armRemove();
      else if (key === "topl") this.doToPlaylist();
      else if (key === "dl") this.doDownload();
    },
    /** 收藏到歌单：把选中的队列曲目带去歌单选择页（顺序 = 队列顺序） */
    doToPlaylist() {
      if (!this.selIds.length) {
        this.showToast("未选中歌曲");
        return;
      }
      const picked = selPicked(this.selIds, this.songs);
      const n = toPlaylist(picked);
      if (!n) {
        this.showToast("未选中歌曲");
        return;
      }
      log("queue", "收藏到歌单 " + n + " 首 → 选择页");
      this.exitMulti();
    },
    /** 下载选中：走用户下载通道（按设置里的下载音质），完成后 toast 汇总 */
    async doDownload() {
      if (!this.selIds.length) {
        this.showToast("未选中歌曲");
        return;
      }
      const picked = selPicked(this.selIds, this.songs);
      if (!picked.length) return;
      const n = picked.length;
      this.exitMulti();
      this.showToast(startText(n));
      log("queue", "多选下载 " + n + " 首");
      const self = this;
      downloadSongs(picked).then(function (r) {
        if (self._dead) return;
        self.showToast(resultText(r));
        log("queue", "下载结果 " + JSON.stringify(r));
      });
    },
  },
};
</script>

<style lang="less" scoped>
@import "../../styles/common.less";

.qu-list {
  flex: 1;
}
/* 滚动锚点：高度 0、不参与视觉，只为拿到「第一行之前」的位置 */
.qu-anchor {
  height: 0;
}
/* 折叠 / 加载更多行的几何与其它列表页一致（18vh 居中） */
.qu-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.qu-more-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
/* 「当前曲不在窗口里」的定位行：比普通行矮，不抢列表焦点 */
.qu-loc {
  height: 14vh;
  align-items: center;
  justify-content: center;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.qu-loc-t {
  font-size: @fs-mute;
  color: @accent-2;
}
.qu-row {
  height: @row-h;
  flex-direction: row;
  align-items: center;
  /* 左右留白 4vh：与 SongRow 的行几何保持一致（加宽） */
  padding-left: 4vh;
  padding-right: 4vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
/* 序号列宽 10.6vh = 勾选圈 9vh + 两侧描边 0.8vh×2（圈与 SongRow 对齐后
   随之加宽，且与 .qu-markbox 同宽 —— 进出多选时后续列不跳动） */
.qu-i {
  width: 10.6vh;
  flex: none;
  font-size: @fs-mute;
  color: @text-3;
}
/* 多选态的勾选圈容器：宽度与序号列一致，行不跳动 */
.qu-markbox {
  width: 10.6vh;
  flex: none;
  align-items: center;
}
/* 勾选圈：直径 9vh → 圆角写半值 4.5vh（平台不认 50%）。
   与 SongRow 对齐：圈 7→9vh、边 0.6→0.8vh、勾 4→5.4vh、圈径/勾 ≈0.6 */
.qu-mark {
  width: 9vh;
  height: 9vh;
  border-radius: 4.5vh; /* 平台不认 50%，写半值 */
  border-width: 0.8vh;
  border-style: solid;
  align-items: center;
  justify-content: center;
}
.qu-chk {
  width: 5.4vh;
  height: 5.4vh;
}
.qu-nm {
  flex: 1;
  font-size: @fs-strong;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
  padding-right: 3vh;
}
.qu-ar {
  width: 104vh;
  flex: none;
  font-size: @fs-dim;
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
  padding-right: 2.5vh;
}
.qu-du {
  width: 26vh;
  flex: none;
  font-size: @fs-mute;
  color: @text-3;
  text-align: right;
}
/* 多选态顶栏右侧的「全选 / 全不选」：占满顶栏高度当点击区（同曲目列表页 .lst-all） */
.qu-all {
  height: @topbar-h;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding-left: 5vh;
  padding-right: 5vh;
}
.qu-all-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
</style>
