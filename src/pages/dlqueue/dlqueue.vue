<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="下载队列" :sub="sub" />
    <scroller class="dlq-list">
      <!-- 进行中：始终只有一条。取消入口 = 行右侧按钮（单击即取消，不确认） -->
      <div class="dlq-row" v-if="tasks.active">
        <image class="dlq-ico" :src="ICON.download" />
        <text class="dlq-nm">{{ tasks.active.name || ('歌曲 ' + tasks.active.id) }}</text>
        <text class="dlq-st">{{ activeText(tasks.active) }}</text>
        <div class="dlq-x" @click="onCancel(tasks.active)">
          <image class="dlq-x-ico" :src="ICON.stop" />
        </div>
      </div>
      <!-- 排队中（按 WAIT_PAGE 分片：一次多选几百首下载时队列会很长） -->
      <div class="dlq-row" v-for="t in waiting" :key="'w' + t.id">
        <image class="dlq-ico" :src="ICON.seek" />
        <text class="dlq-nm">{{ t.name || ('歌曲 ' + t.id) }}</text>
        <text class="dlq-st">排队中</text>
        <div class="dlq-x" @click="onCancel(t)">
          <image class="dlq-x-ico" :src="ICON.stop" />
        </div>
      </div>
      <div class="dlq-more" v-if="waitingMore" @click="loadMoreWaiting">
        <text class="dlq-more-t" :style="{ color: accent.light }">{{ moreLabel(waitingMore, '个') }}</text>
      </div>
      <!-- 已完成（成功/失败/取消）：已经结束，没有取消按钮；仍保留一格同宽的空位
           （`.dlq-xgap`），三个分组的「状态」列才对得齐。
           **展示一次后出列** —— 离开本页时 ackFinished() 清掉 -->
      <div class="dlq-row" v-for="t in finished" :key="'f' + t.id + '-' + t.at">
        <image class="dlq-ico" :src="stateIcon(t.state)" />
        <text class="dlq-nm">{{ t.name || ('歌曲 ' + t.id) }}</text>
        <text class="dlq-st" :style="stateStyle(t.state)">{{ stateText(t) }}</text>
        <div class="dlq-xgap"></div>
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
 * 三段：进行中（1 条，含百分比/正在停止）/ 排队中 / 已完成。数据来自 download.js 的
 * `dlTasks()`（counted 项 = 用户下载通道的任务；播放的后台缓存不算任务，不在这里显示）。
 *
 * **两个取消入口，确认强度不同**（本页是唯一的取消入口）：左栏「取消全部」整批作废、
 * 两次点按确认；每行右侧按钮只中断这一首、**单击即生效**。整行**不是**取消目标 ——
 * 20vh 全宽命中区误触的代价是断掉排队中的一批下载，按钮是明确的 14vh 目标。
 * 取消后 `.part` 与元数据保留（重新下载会续传），已完成的任务不受影响。
 *
 * 已完成列表只活在内存里：本页展示，离开时调 `ackFinished()` 清空；没打开过队列页的话
 * 「已完成」会一直留着（下载页左栏队列键浅红高亮 = 有结果没看）。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import EmptyHint from '../../components/EmptyHint.vue'
import HintToast from '../../components/HintToast.vue'
import { ICON, railBack, railBtn } from '../../ui/rail.js'
import { dlTasks, ackFinished, cancelTask, cancelDownload, dlApi } from '../../services/player/download.js'
import { bindDl } from '../../ui/mixins/dlsub.js'
import { log } from '../../core/infra/log.js'
import { accentMixin } from '../../ui/mixins/accent.js'
import { TOK } from '../../ui/tokens.js'
import { toastMixin } from '../../ui/mixins/toast.js'
import { armMixin } from '../../ui/mixins/arm.js'
import { pageFrameMixin } from '../../ui/mixins/frame.js'
import { moreText } from '../../ui/paging.js'

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
      finShown: FIN_PAGE // 已完成列表的渲染分片（内存上限 50 条，但一次全铺 + 排队页会超预算）
    }
  },
  computed: {
    sub() {
      // 「取消全部」的待确认提示只能靠这条常显副题撑住（toast 两秒就没了，见 ui/mixins/toast.js）
      if (this.isArmed('stopall')) return this.armRailText('取消', this.cancelable)
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
    },
    /** 「取消全部」的作用范围：进行中 + 排队中（已完成的不是任务了） */
    cancelable() {
      return (this.tasks.active ? 1 : 0) + this.tasks.waiting.length
    },
    /**
     * 左栏「取消全部」键的图标：未按下时压在深色键底（TOK.btnBg）上 → 白版；
     * 按下后键底变实心主题色 → 亮色预设必须换深色版（fgIcon，否则白图标看不见）。
     * 行内取消按钮没有待确认态（单击即取消），因此固定用白版 ICON.stop + 次级面底。
     */
    railIcon() {
      return this.isArmed('stopall') ? this.fgIcon('stop') : ICON.stop
    },
    rail() {
      return [
        railBack(),
        railBtn('stopall', this.railIcon, false, '', this.isArmed('stopall'), !this.cancelable)
      ]
    }
  },
  mounted() {
    this._dead = false
    const self = this
    // 下载活动订阅（可见性门控，见 ui/mixins/dlsub.js；回调体是整页刷新，门控收益最大）
    this._dlOff = bindDl(this, dlApi, function () {
      self.refresh()
    })
    log('dlqueue', '下载队列页挂载')
  },
  beforeDestroy() {
    // armed / toast 的计时器由 ui/arm.js、ui/toast.js 的 beforeDestroy 自动清
    this._dead = true
    if (this._dlOff) this._dlOff()
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
      // 队列已经空了：「取消全部」失去目标，待确认态不要悬在左栏上（键此刻也已置灰）
      if (!t.active && !t.waiting.length && this.isArmed('stopall')) this.disarm()
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
    /**
     * 行右侧的取消按钮：**单击即取消**，不做二次确认（目标只有这一首；
     * 误触的代价是重新点一次下载，`.part` 与元数据都还在，续传即可）。
     * 「取消全部」才需要确认 —— 那是一次点掉一整批。
     */
    onCancel(t) {
      const id = String(t.id)
      const ok = cancelTask(id)
      this.showToast(ok ? '已取消：' + (t.name || id) : '任务已结束')
      log('dlqueue', '中断任务 ' + id + ' ok=' + ok)
      this.refresh()
    },
    /** 左栏「取消全部」：整批作废（两次点按确认；范围 = 进行中 + 排队中） */
    onRailKey(key) {
      if (key !== 'stopall') return
      const n = this.cancelable
      if (!n) return
      if (this.isArmed('stopall')) {
        this.disarm()
        cancelDownload()
        this.showToast('已取消 ' + n + ' 个任务')
        log('dlqueue', '取消全部任务 ' + n + ' 个')
        this.refresh()
        return
      }
      this.arm('stopall')
    }
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
/* 行内取消按钮：14vh ≈ 34px（与本地下载页状态卡的拉取/同步按钮同高，小屏够点）。
   单击即取消，所以**固定**次级面底 + 白 ×，没有待确认态。 */
.dlq-x {
  width: 14vh;
  height: 14vh;
  flex: none;
  background-color: @panel-2;
  border-radius: @radius;
  margin-left: 2.5vh;
  align-items: center;
  justify-content: center;
}
.dlq-x-ico {
  width: 8vh;
  height: 8vh;
}
/* 已完成分组的同宽占位（没有取消按钮，但状态列要对齐）：宽度/左边距与 .dlq-x 成对维护，
   且**不带底色**（带底色就成了一个空方块） */
.dlq-xgap {
  width: 14vh;
  height: 14vh;
  flex: none;
  margin-left: 2.5vh;
}
</style>
