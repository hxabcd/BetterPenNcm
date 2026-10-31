<template>
  <div class="rail" :style="bgStyle">
    <!-- 顶部：第一个槽位（约定固定是「返回」） -->
    <div class="rail-slot" v-if="first">
      <div class="rail-btn" :style="btnStyle(first)" @click="tap(first)">
        <image v-if="first.icon" class="rail-ico" :src="first.icon" />
        <text v-else class="rail-ico-t">{{ first.text || '' }}</text>
      </div>
    </div>

    <div class="rail-fill"></div>

    <!-- 底部：其余上下文槽位（默认贴底） -->
    <div class="rail-slot-b" v-for="it in rest" :key="it.key">
      <div class="rail-btn" :style="btnStyle(it)" @click="tap(it)">
        <image v-if="it.icon" class="rail-ico" :src="it.icon" />
        <text v-else class="rail-ico-t">{{ it.text || '' }}</text>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * 左侧操作栏（全局导航）—— 2026-10-30 起统一采用播放页设计稿的左栏样式
 * （Figma PlayerPage 14:1570 的 RailNav）：栏宽 60px、键 48×48、圆角 12px、
 * 键底 #242424（TOK.btnBg）。**全应用共用这一份，不再有「播放页单独左栏」**。
 *
 * 几何（设计稿 px ↔ vh，1vh=2.4px）：
 *   栏宽 25vh（60px）= 键 20vh + 两侧各 2.5vh；
 *   上下 padding 3.33vh（8px）、底部组键间距 4.44vh（10.67px）。
 *   返回 + 3 个上下文键 = 2×3.33 + 4×20 + 3×4.44 = 100vh —— 四键恰好等距排满，
 *   这也是「最多 3 个上下文键」的依据（第 4 个键物理放不下）。
 *
 * 竖排布局（**除返回外默认底部对齐**）：
 *   返回固定在顶部（3.33~23.33vh）；
 *   其余槽位从底部往上排（最下一个 76.67~96.67vh，再往上每个 -24.44vh = 20 键 + 4.44 间距）。
 *   ⚠ 各页若把浮窗「贴着左栏按钮」定位，几何按上面这两个数算：
 *     一个上下文按钮 → 按钮上沿 76.67vh；两个 → 52.22~72.22、76.67~96.67；
 *     三个 → 27.78~47.78、52.22~72.22、76.67~96.67。
 *
 * 约定：第一个槽位是全局固定的「返回」，其余由各页按上下文给（见 utils/rail.js）。
 * 图标是 data-URI PNG（assets/icons.js），纯白带 alpha——平台不支持给 image 染色，
 * 所以「选中」状态靠按钮底色体现，用内联 :style（平台不支持 .a.b 复合选择器）。
 *
 * 事件：@action(key) —— 各页自己处理（返回也由各页处理，组件里 $page 不可靠）。
 */
import { accentMixin } from '../utils/theme.js'
import { TOK } from '../utils/ui/tokens.js'
import { log } from '../utils/log.js'

export default {
  name: 'NavRail',
  // 栏底与顶栏/页面底同色且运行时可换；选中/危险态的主题色同理 —— 都由 accentMixin 管
  mixins: [accentMixin],
  props: {
    items: { type: Array, default: function () { return [] } }
  },
  computed: {
    bgStyle() {
      return { backgroundColor: this.bg }
    },
    /** 顶部槽位（约定是返回） */
    first() {
      return this.items.length ? this.items[0] : null
    },
    /** 底部槽位：其余全部。用两个独立 v-for 分段，不用 template v-for 插 spacer（该写法在本平台编译器上不稳） */
    rest() {
      return this.items.slice(1)
    }
  },
  mounted() {
    // 上限告警：返回 + 3 个上下文键 = 2×3.33 + 4×20 + 3×4.44 = 100vh，恰好排满；
    // 第 4 个上下文键物理放不下（翻页/浮层式折叠 「留上限、折叠延后」）。
    if (this.items.length > 4) {
      log('rail', '槽位超上限：' + this.items.length + ' 个（最多 4 = 返回 + 3）—— 折叠机制未实现')
    }
  },
  methods: {
    tap(it) {
      if (it && it.disabled) return
      this.$emit('action', it.key)
    },
    btnStyle(it) {
      /* 危险态优先级最高（如「删除键已按下一次、正在等第二次确认」）：
         实心主题色比 on 的浅色描边更醒目。色值走主题（设置页 → 主题色），
         所以是内联 style 而非 LESS token。
         ⚠ 图标**不是**纯白 PNG 就完事：Vocaloid 七色里 6 个是亮色，白图标压上去
         对比度只有 ~1.5:1（看不见）—— 本组件不管取图，是各页传 icon 时用
         theme.js 的 fgIcon() 按 accent.dark 选深色版（白/深两版都生成了）。 */
      /* 禁用态（如空列表时的「多选」键）：点击已被 tap() 拦掉，
         观感用「去掉按钮底色」（透明）表达 —— 平台不能给 PNG 染色，无法直接置灰图标；
         若日后要更强的观感，用图标管线生成暗色变体（gen_icons.py）。 */
      if (it && it.disabled) {
        return {
          backgroundColor: TOK.none,
          borderWidth: '0px',
          borderStyle: 'solid',
          borderColor: 'transparent'
        }
      }
      if (it && it.danger) {
        return {
          backgroundColor: this.accent.c,
          borderWidth: '0px',
          borderStyle: 'solid',
          borderColor: 'transparent'
        }
      }
      if (it && it.on) {
        return {
          /* 上下文按钮的选中态使用固定中性色，避免主题色的亮暗版本把底色压成黑色。 */
          backgroundColor: TOK.surface3,
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: TOK.text3
        }
      }
      return {
        backgroundColor: TOK.btnBg,
        borderWidth: '0px',
        borderStyle: 'solid',
        borderColor: 'transparent'
      }
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

/* 栏宽 25vh（60px）= 键 20vh + 两侧各 2.5vh —— 与播放页设计稿的 RailNav 一致。
   栏宽与 utils/player/layout.js 的 RAIL_W 成对维护。 */
.rail {
  width: 25vh;
  height: 100vh;
  flex: none;
  flex-direction: column;
  align-items: center;
  padding-top: 3.33vh; /* 8px */
  padding-bottom: 3.33vh;
  padding-left: 2.5vh;
  padding-right: 2.5vh;
  /* 与顶栏、页面底同色：整块 chrome 一个色，层次全靠卡片/按钮。
     颜色由内联 :style 给（主题可换，见 utils/theme.js） */
}
/* 撑开顶部与底部两组按钮。父容器 .rail 高度确定（100vh），所以 flex:1 有效——
   这正是「flex:1 需要父级高度确定」那条平台坑的例外情形。 */
.rail-fill {
  flex: 1;
}
/* 顶部槽位：不设下边距（它与下面那组之间的空隙由 rail-fill 决定） */
.rail-slot {
  flex: none;
}
/* 底部槽位：靠 margin-top 保持 4.44vh（10.67px）间距（最下一个的下方是 .rail 的 padding-bottom） */
.rail-slot-b {
  flex: none;
  margin-top: 4.44vh;
}
.rail-btn {
  width: 20vh; /* 48px */
  height: 20vh;
  border-radius: 5vh; /* 12px */
  align-items: center;
  justify-content: center;
}
/* 24px 图标（20vh 的 50%），48px 源图仍有 2 倍余量 */
.rail-ico {
  width: 10vh;
  height: 10vh;
}
.rail-ico-t {
  font-size: @fs-mute;
  color: @text-2;
}
</style>
