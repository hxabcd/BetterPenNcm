<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="下载队列" :sub="sub" />
    <scroller class="dlq-list">
      <!-- 进行中：点击 = 中断（两次点按确认） -->
      <div class="dlq-row" v-if="tasks.active" :style="rowStyle(tasks.active.id)" @click="onRow(tasks.active)">
        <image class="dlq-ico" :src="ICON.download" />
        <text class="dlq-nm">{{ tasks.active.name || ('歌曲 ' + tasks.active.id) }}</text>
        <text class="dlq-st">{{ activeText(tasks.active) }}</text>
      </div>
      <!-- 排队中（按 WAIT_PAGE 分片：一次多选几百首下载时队列会很长） -->
      <div
        class="dlq-row"
        v-for="t in waiting"
        :key="'w' + t.id"
        :style="rowStyle(t.id)"
        @click="onRow(t)"
      >
        <image class="dlq-ico" :src="ICON.seek" />
        <text class="dlq-nm">{{ t.name || ('歌曲 ' + t.id) }}</text>
        <text class="dlq-st">排队中</text>
      </div>
      <div class="dlq-more" v-if="waitingMore" @click="loadMoreWaiting">
        <text class="dlq-more-t" :style="{ color: accent.light }">{{ moreLabel(waitingMore, '个') }}</text>
      </div>
      <!-- 已完成（成功/失败/取消）：**展示一次后出列** —— 离开本页时 ackFinished() 清掉 -->
      <div class="dlq-row" v-for="t in finished" :key="'f' + t.id + '-' + t.at">
        <image class="dlq-ico" :src="stateIcon(t.state)" />
        <text class="dlq-nm">{{ t.name || ('歌曲 ' + t.id) }}</text>
        <text class="dlq-st" :style="stateStyle(t.state)">{{ stateText(t) }}</text>
      </div>
      <div class="dlq-more" v-if="finishedMore" @click="loadMoreFinished">
        <text class="dlq-more-t" :style="{ color: accent.light }">{{ moreLabel(finishedMore, '条') }}</text>
      </div>
      <empty-hint v-if="empty" :text="emptyText" />
    </scroller>
    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 下载队列页（入口：本地下载页左栏「下载队列」键）
 *
 * 三段：进行中（1 条，含百分比/正在停止）/ 排队中 / 已完成。
 *   - 数据来自 download.js 的 `dlTasks()`（counted 项 = 用户下载通道的任务；
 *     播放的后台缓存不算任务，不在这里显示）
 *   - **中断**：点未完成的行 → 两次点按确认（第一次行变红 + 顶栏常显提示 + toast，
 *     3 秒复位；第二次 `cancelTask(id)` —— 进行中的在分片边界停下、.part 保留可续传，
 *     排队中的直接摘除并按「已取消」结算）
 *   - **已完成的任务展示一次后从队列中移除**：本页展示它们，离开本页时
 *     调 `ackFinished()` 清空；没打开过队列页的话「已完成」会一直留着（下载页左栏
 *     队列键浅红高亮 = 有结果没看）
 *   - 完成列表只在内存里：应用重启即空（下载队列本身也不跨重启，未完成靠 .part 续传）
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import EmptyHint from '../../components/EmptyHint.vue'
import HintToast from '../../components/HintToast.vue'
import { ICON } from '../../utils/rail.js'
import { dlTasks, ackFinished, cancelTask, onDl, offDl } from '../../utils/player/download.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { TOK } from '../../utils/ui/tokens.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { armMixin } from '../../utils/ui/arm.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'
import { moreText } from '../../utils/ui/paging.js'

const EMPTY = { active: null, waiting: [], finished: [] }
const WAIT_PAGE = 30 // 排队中首屏 + 每次展开（与进行中/已完成合计控制在 50 行内）
const FIN_PAGE = 10 // 已完成首屏 + 每次展开

export default {
  name: 'dlqueue',
  mixins: [accentMixin, toastMixin, armMixin, pageFrameMixin],
  components: { 'page-shell': PageShell, 'page-topbar': PageTopbar, 'hint-toast': HintToast, 'empty-hint': EmptyHint },
  data() {
    return {
      ICON: ICON,
      tasks: EMPTY,
      waitShown: WAIT_PAGE, // 排队列表的渲染分片（一次多选几百首下载时 waiting 可能几百条）
      finShown: FIN_PAGE, // 已完成列表的渲染分片（内存上限 50 条，但一次全铺 + 排队页会超预算）
      armedName: '' // 待确认行提示里显示的歌名（armed 状态本体在 armMixin，id 为 'stop:<taskId>'）
    }
  },
  computed: {
    sub() {
      if (this.armed) return '双击' + this.armedName
      const a = this.tasks.active ? 1 : 0
      const w = this.tasks.waiting.length
      const f = this.tasks.finished.length
      if (!a && !w && !f) return ''
      const parts = []
      if (a) parts.push('下载中 1')
      if (w) parts.push('排队 ' + w)
      if (f) parts.push('已完成 ' + f)
      return parts.join(' · ')
    },
    empty() {
      return !this.tasks.active && !this.tasks.waiting.length && !this.tasks.finished.length
    },
    /** 排队中只渲染前 waitShown 条（sub 仍报整队数量） */
    waiting() {
      return this.tasks.waiting.slice(0, this.waitShown)
    },
    waitingMore() {
      return Math.max(0, this.tasks.waiting.length - this.waiting.length)
    },
    finished() {
      return this.tasks.finished.slice(0, this.finShown)
    },
    finishedMore() {
      return Math.max(0, this.tasks.finished.length - this.finished.length)
    },
    emptyText() {
      return '无下载任务'
    }
  },
  mounted() {
    this._dead = false
    const self = this
    this._dlOff = onDl(function () {
      self.refresh()
    })
    this.refresh()
    log('dlqueue', '下载队列页挂载')
  },
  beforeDestroy() {
    // armed / toast 的计时器由 ui/arm.js、ui/toast.js 的 beforeDestroy 自动清
    this._dead = true
    if (this._dlOff) offDl(this._dlOff)
    this._dlOff = null
    // 「已完成的任务在展示一次后从队列中移除」：本页已展示过 → 离开时出列
    ackFinished()
  },
  methods: {
    /** 「加载更多」文案（import 的 helper 模板里不能裸调，走 methods 暴露） */
    moreLabel(n, unit) {
      return moreText(n, unit)
    },
    loadMoreWaiting() {
      if (!this.waitingMore) return
      this.waitShown = Math.min(this.waitShown + 20, this.tasks.waiting.length)
    },
    loadMoreFinished() {
      if (!this.finishedMore) return
      this.finShown = Math.min(this.finShown + FIN_PAGE, this.tasks.finished.length)
    },
    /** 重读队列快照（签名判重：活动快照 ~400ms 一发，不判重就是持续重渲染，坑 16 同族） */
    refresh() {
      const t = dlTasks()
      const a = t.active
      const sig = (a ? a.id + ':' + a.pct + ':' + (a.stopping ? 1 : 0) : '') + '|' +
        t.waiting.length + '|' + t.finished.length +
        '|' + (t.finished.length ? t.finished[0].id + ':' + t.finished[0].at : '')
      if (sig === this._sig) return
      this._sig = sig
      // 新的一轮下载会话开始：排队列表的展开进度复位（否则上一轮展开到几百条会带进来）
      const wasActive = this.tasks.active
      this.tasks = t
      if (t.active && !wasActive) this.waitShown = WAIT_PAGE
    },
    activeText(t) {
      if (t.stopping) return '正在停止…'
      return t.pct ? t.pct + '%' : '下载中'
    },
    stateIcon(st) {
      if (st === 'done') return ICON.ok
      if (st === 'failed') return ICON.fail
      return ICON.cancel
    },
    stateText(t) {
      if (t.state === 'done') return '已完成'
      if (t.state === 'failed') return '失败' + (t.error ? '：' + t.error : '')
      return '已取消'
    },
    /** 状态文字颜色（内联 style —— 平台不支持 .a.b 复合选择器；色值同 styles/common.less 的 token） */
    stateStyle(st) {
      if (st === 'done') return { color: TOK.ok }
      if (st === 'failed') return { color: this.accent.light } // 主题色浅色（原 @accent-2）
      return { color: TOK.text3 }
    },
    rowStyle(id) {
      return this.isArmed('stop:' + id) ? { backgroundColor: this.accent.a16 } : {}
    },
    /**
     * 点未完成的行：两次点按确认中断（同各页「删除」的既有做法 —— 本平台没有对话框设施）。
     * 已完成的行不挂点击（模板上只有未完成行挂了 @click）。
     */
    onRow(t) {
      const id = String(t.id)
      if (this.isArmed('stop:' + id)) {
        this.disarm()
        this.armedName = ''
        const ok = cancelTask(id)
        this.showToast(ok ? '已中断：' + (t.name || id) : '任务已结束')
        log('dlqueue', '中断任务 ' + id + ' ok=' + ok)
        this.refresh()
        return
      }
      this.armedName = t.name || id
      this.arm('stop:' + id)
      this.showToast('双击' + this.armedName)
    },
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.dlq-list {
  flex: 1;
  padding-top: 1vh;
}
/* 行高 20vh ≈ 48px：点击区给大（本页是唯一的中断入口） */
.dlq-row {
  height: 20vh;
  flex-direction: row;
  align-items: center;
  padding-left: 4vh;
  padding-right: 4vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.dlq-ico {
  width: 9vh;
  height: 9vh;
  flex: none;
  margin-right: 3vh;
}
.dlq-nm {
  flex: 1;
  font-size: @fs-strong;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
  padding-right: 2.5vh;
}
.dlq-more {
  height: 18vh;
  align-items: center;
  justify-content: center;
}
.dlq-more-t {
  font-size: @fs-dim;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
}
/* 状态列：固定宽度 + 省略号（失败原因可能较长） */
.dlq-st {
  width: 165vh;
  flex: none;
  font-size: @fs-mute;
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
  text-align: right;
}
</style>
