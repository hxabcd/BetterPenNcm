<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="设置" :sub="buildTag" />
    <scroller class="st-list">
      <!-- 账户入口（不属于任何一组设置，单独放在最前） -->
      <cue-row name="个人中心" :sub="accountText" @open="openAccount" />

      <!-- 四组二级菜单：每组一个子页面（播放 = 原播放选项页，与播放器内入口同一个） -->
      <cue-row v-for="g in groups" :key="g.key" :name="g.name" :sub="g.sub" @open="openGroup(g.key)" />

      <!-- 关于：静态信息，不挂 handler。dim 标题降一档、无 › —— 与上面的入口区分开 -->
      <cue-row name="关于" :sub="'BetterPenNcm · appid ' + appid + ' · 构建 ' + buildTag" :cue="false" :dim="true" />

    </scroller>
  </page-shell>
</template>

<script>
/**
 * 设置页：左栏的账户入口改成设置；这里是分组索引，每组进一个子页面。
 *
 * 分组—— 每项都是**二级菜单**，点进去是独立页面：
 *   播放       → pages/playeropts（同一页也是播放器左栏「选项」键的落点，两边合并成一份）
 *               只管「怎么放」：倍速 / 歌词 / 退出时暂停
 *   音质与存储 → pages/setdl（播放音质 / 下载音质 / 缓存上限 / 存储管理入口）
 *               两档音质与缓存、存储是一类事，**不再按播放/下载拆开**
 *   个性化     → pages/setlook（背景色 / 主题色）
 * 组外：个人中心（跳 account）、关于（只读）。
 *
 * 本页只有一类行：**「点了会离开本页」的入口**（`CueRow` 组件：右端灰色 chevron + 加粗白标题，
 * 与「音质与存储」页的入口行共用同一实现）；
 * 副行写这一组里有什么，避免裸点进去。唯一例外是「关于」——不可点、标题降一档（CueRow 的 dim）。
 * 尺寸（放大，屏幕物理高仅 2.5cm）：行高 26vh ≈ 62px、箭头 11vh ≈ 26px。
 *
 * 平台样式约束：只认单类名选择器（.a.b 复合选择器会被丢弃），状态色走内联 :style。
 * （箭头为什么用 PNG 而不是顶栏 .ptb-cue 那种文本 ›：20.4px 的 › 墨迹只有 5.5×7.5px，
 *   比 14.4px 的副行字还矮一半，列表行右端扫视读不出来。详见 gen_icons.py 的 COLORS。）
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import CueRow from '../../components/CueRow.vue'
import { go } from '../../utils/nav.js'
import { cachedProfile, loggedIn } from '../../utils/ncm/login.js'
import { BUILD_TAG } from '../../utils/buildInfo.js'

/**
 * 二级菜单：key = 页面名（app.json 的 pages key），sub = 这一组里有什么（副行）。
 * ⚠ 副行的分隔符统一用**、**—— 别用 `·`：
 *   `·` 在本页别处是「状态分隔」（如「未登录 · 扫码登录」），两处同形会看着像同类信息。
 */
const GROUPS = [
  { key: 'playeropts', name: '播放', sub: '倍速、歌词、退出时暂停' },
  { key: 'setdl', name: '音质与存储', sub: '播放音质、下载音质、缓存上限、存储管理' },
  { key: 'setlook', name: '个性化', sub: '背景色、主题色' }
]

/** appid 优先取运行时全局（运行时API参考 §1 实测存在），取不到用字面量兜底 */
function readAppid() {
  try {
    /* global $appid */
    if (typeof $appid !== 'undefined' && $appid) return String($appid)
  } catch (e) {}
  return '8000200708310039'
}

// 登录事件只注册一次（页面会挂两遍；pagebus 同一事件只由页面栈上层存活实例处理）

import { pageFrameMixin } from '../../utils/ui/frame.js'
import { pageBusMixin } from '../../utils/ui/pagebus.js'

export default {
  name: 'settings',
  mixins: [pageBusMixin, pageFrameMixin],
  components: { 'page-shell': PageShell, 'page-topbar': PageTopbar, 'cue-row': CueRow },
  data() {
    return {
      buildTag: BUILD_TAG,
      appid: readAppid(),
      nickname: '',
      isLogged: false,
      groups: GROUPS
    }
  },
  computed: {
    accountText() {
      if (!this.isLogged) return '未登录 · 扫码登录'
      return (this.nickname || '已登录') + ' · 查看账号与操作'
    },
  },
  mounted() {
    this.sync()
    // 登录完成 → 重读登录态（注册/退役见 utils/ui/pagebus.js）
    this.onPageEvent('bpncm:login-done', 'sync')
  },
  methods: {
    sync() {
      this.isLogged = loggedIn()
      this.nickname = cachedProfile().nickname || ''
    },
    openAccount() {
      go('account')
    },
    openGroup(key) {
      // go() 只认逻辑页名字面量（静态自检据此核对；变量传参会绕过校验）
      if (key === 'playeropts') go('playeropts')
      else if (key === 'setdl') go('setdl')
      else if (key === 'setlook') go('setlook')
    },
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.st-list {
  flex: 1;
  padding-top: 3vh;
}
/* 行：整行可点（高 26vh ≈ 62px，点击区尽量给大） */
.st-foot {
  font-size: @fs-mute;
  color: @text-3;
  margin-top: 4vh;
  margin-left: 6vh;
}
</style>
