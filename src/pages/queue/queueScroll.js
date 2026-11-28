import { log } from '../../core/infra/log.js';
import { PAGE_QUEUE, ROW_PX_SONG } from '../../ui/paging.js';
import { vhPx } from '../../core/platform/viewport.js';

/* 与 LESS 成对维护的几何（vh）：折叠条 18vh、定位行 14vh、行高 @row-h 23vh（paging.ROW_PX_SONG）。
   锚定滚动要用像素算「插入多少行 = 内容上移多少」，所以这里必须有一份 px 副本。 */
const FOLD_PX_CONST = 18;
const LOC_PX_CONST = 14;

/* 按本机型换算（S7 2.4 / X3S·X5 2.54）——写死 2.4 会在窄屏上错 6% */
const FOLD_PX = FOLD_PX_CONST * vhPx();
const LOC_PX = LOC_PX_CONST * vhPx();

/* 前向展开步长：比整页少 6 行，锚定后窗口总行数仍 ≤ PAGE_QUEUE（平台一次渲染 ≤50 行预算） */
const EXPAND = PAGE_QUEUE - 6;

export const queueScrollMixin = {
  methods: {
    /* 以当前曲为锚点初始化渲染窗口。长队列把当前曲放在窗口顶部附近（上方只留 2 行）——
       本机一屏只显示约 4 行，若把当前曲居中在 50 行窗口里，它仍在首屏下方好几屏，等于没「定位到当前」。
       队列总长 ≤ PAGE_QUEUE 时整列渲染、不折叠（滚动定位交给 locateOnOpen）。 */
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
       平台没有通用 scrollTop setter，但 `$page.$dom.scrollToElement(el, { offset })`
       （weex 同款 dom 模块）会把滚动位置设成「元素内容位置 + offset」——传绝对 offset
       就等价于一次 scrollTo。两条实测依据（见 docs/运行时API参考.md 的 dom 记录）：
         - 它内部会先 tryLayoutImmediately，布局脏也能量到元素位置；
         - 参数只有 offset/int 与 smooth/bool（反汇编 DomModule::scrollToElement 确认），
           这里固定 smooth:false，避免 50 行长距离滚动被动画拉长。
       本页不依赖 `$nextTick`（本项目未实测），统一用 setTimeout 等一帧布局再滚动。 */
    // 顶部装饰（定位行 + 折叠条）当前占的高度 px，锚定 offset 要减掉它
    chromePx() {
      let h = 0;
      if (!this.inWindow) h += LOC_PX;
      if (this.beforeCount) h += FOLD_PX;
      return h;
    },

    // 把「首行之前」的锚点滚到 offset 处（30ms 后布局已更新；重复调用是绝对定位，幂等）
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

    // 短队列（整列渲染）进来时滚到当前曲附近：上方留 2 行上下文
    locateOnOpen() {
      const n = this.songs.length;
      const idx = Number(this.st.index);
      if (!n || !(idx >= 0)) return;
      const full = this.win.start === 0 && this.win.end === n;
      if (!full || idx < 3) return; 

      this.scrollToOffset((idx - 2) * ROW_PX_SONG, "locate");
      log("queue", "短队列定位到第 " + (idx + 1) + " 首（上方留 2 行）");
    },

    // 滚动位置（原生 px）；只做锚定计算，不进 data
    onScroll(e) {
      const c = e && e.contentOffset;
      const y = c ? Number(c.y) : NaN;
      if (y === y && y >= 0) this._scrollY = y;
    },

    /* 把前面的已播部分再展开一段。
       关键：展开后窗口上滑（start/end 同时前移），而不是只减 start——只减 start 会把窗口撑到
       50 行以上，撞平台渲染预算；丢掉的行在视口下方，靠底部「加载更多」补回。
       视口内容不动：新布局里「首行元素位置 + offset = 旧 scrollTop + 新增行高」。 */
    expandBefore() {
      const n = this.songs.length;
      const old = this.win;
      if (!old.start) return;
      const k = Math.min(EXPAND, old.start);
      if (k <= 0) return;
      const s = this._scrollY || 0; 
      const chrome = this.chromePx(); 
      const start = old.start - k;
      const end = Math.min(n, start + PAGE_QUEUE);
      this.start = start;
      this.end = end;

      /* 目标滚动位置 = s + k*ROW + (新 chrome − 旧 chrome)；
         scrollToElement 定的是「第 0 行位置(新 chrome) + offset」，所以
         offset = s + k*ROW − 旧 chrome（与新 chrome 无关，定位行出现/消失都成立）。 */
      const offset = s + k * ROW_PX_SONG - chrome;
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

    // 把后面的待播部分再展开一段
    expandAfter() {
      if (!this.afterCount) return;
      this.end = Math.min(this.songs.length, this.win.end + PAGE_QUEUE);
      log("queue", "向后展开 -> end=" + this.end);
    },

    // 播放自动往后走了、当前曲离开窗口时，一键回到当前曲
    recenter() {
      this.initWindow();
      this.locateOnOpen();
    },
  },
};
