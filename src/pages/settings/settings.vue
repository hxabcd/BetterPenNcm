<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="设置" :sub="buildTag" />
    <scroller class="st-list">
      <!-- 账户入口不属于任何一组设置，单独放在最前 -->
      <cue-row name="个人中心" :sub="accountText" @open="openAccount" />

      <!-- 四组二级菜单：每组一个子页面（播放 = 原播放选项页，与播放器内入口同一个） -->
      <cue-row v-for="g in groups" :key="g.key" :name="g.name" :sub="g.sub" @open="openGroup(g.key)" />

      <!-- 关于：静态信息，不挂 handler。dim 标题降一档、无 › —— 与上面的入口区分开 -->
      <cue-row name="关于" :sub="'BetterPenNcm · appid ' + appid + ' · 构建 ' + buildTag" :cue="false" :dim="true" />

    </scroller>
  </page-shell>
</template>

<script>

import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import CueRow from '../../components/CueRow.vue'
import { go } from '../../core/infra/nav.js'
import { cachedProfile, loggedIn } from '../../services/ncm/login.js'
import { BUILD_TAG } from '../../core/infra/buildInfo.js'

// 二级菜单：key = 页面名（app.json 的 pages key），sub = 这一组里有什么（副行）
const GROUPS = [
  /* 副行分隔符统一用**、**别用 `·`：`·` 在本页别处是「状态分隔」（如「未登录 · 扫码登录」），
     两处同形会看着像同类信息 */
  { key: 'playeropts', name: '播放', sub: '倍速、歌词、退出时暂停' },
  { key: 'setdl', name: '音质与存储', sub: '播放音质、下载音质、缓存上限、存储管理' },
  { key: 'setlook', name: '个性化', sub: '背景色、主题色' }
]

/** appid 优先取运行时全局（真机实测存在），取不到用字面量兜底 */
function readAppid() {
  try {
    /* global $appid */
    if (typeof $appid !== 'undefined' && $appid) return String($appid)
  } catch (e) {}
  return '8000200708310039'
}

// 登录事件只注册一次（页面会挂两遍；pagebus 同一事件只由页面栈上层存活实例处理）
import { pageFrameMixin } from '../../ui/mixins/frame.js'
import { pageBusMixin } from '../../ui/mixins/pagebus.js'

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
    // 登录完成 → 重读登录态（注册/退役见 ui/mixins/pagebus.js）
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
      // ⚠ go() 只认逻辑页名字面量（静态自检据此核对；变量传参会绕过校验）
      if (key === 'playeropts') go('playeropts')
      else if (key === 'setdl') go('setdl')
      else if (key === 'setlook') go('setlook')
    },
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* ⚠ 平台只认单类名选择器（.a.b 复合选择器会被丢弃），状态色只能走内联 :style */
.st-list {
  flex: 1;
  padding-top: 3vh;
}

.st-foot {
  font-size: @fs-mute;
  color: @text-3;
  margin-top: 4vh;
  margin-left: 6vh;
}
</style>
