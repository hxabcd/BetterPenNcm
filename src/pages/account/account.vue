<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="个人中心" :sub="status" />

    <div class="ac-body">
      <!-- 账号卡：头像 + 昵称 + UID -->
      <div class="ac-card">
        <div class="ac-avbox">
          <image v-if="avatar" class="ac-av" :src="avatar" resize="cover" />
        </div>
        <div class="ac-who">
          <text class="ac-nm">{{ logged ? (profile.nickname || '已登录') : '未登录' }}</text>
          <text class="ac-id" v-if="profile.userId">UID {{ profile.userId }}</text>
          <text class="ac-id" v-else>扫码后可读取个人歌单、解锁 VIP 曲目</text>
        </div>
      </div>

      <!-- 统计（登录后才有意义） -->
      <div class="ac-stats" v-if="logged">
        <text class="ac-stat">我喜欢 {{ likedCount }} 首</text>
        <text class="ac-stat">我创建 {{ createdCount }} 个歌单</text>
        <text class="ac-stat">我收藏 {{ subCount }} 个歌单</text>
      </div>

      <!-- 操作 -->
      <div class="ac-ops">
        <text class="ac-btnmain" :style="{ backgroundColor: accent.c }" v-if="!logged" @click="doLogin">登录</text>
        <text class="ac-btn" v-if="logged" @click="refresh">刷新资料</text>
        <text class="ac-btn" v-if="logged" :style="outStyle" @click="doLogout">{{ outText }}</text>
      </div>
    </div>
  </page-shell>
</template>

<script>
/**
 * 个人中心（「重做，完善信息显示及操作」）
 *
 * 原来左栏「账户」直接跳的就是扫码登录页 —— 现在拆成两件事：
 *   个人中心（本页）= 信息显示（头像/昵称/UID/歌单统计）+ 操作（扫码登录 / 刷新资料 / 退出登录）
 *   扫码登录 = pages/login（二维码那套逻辑一行没动，是踩坑跑通的代码）
 *
 * 退出登录是**按钮内二次确认**（文案先变「双击确认退出登录」3 秒，模板与计时在 ui/arm.js）—— 本平台没有对话框基础设施，
 * 不为它引入浮层；误触代价是重新扫码，值得这一步。
 * logout() 会清 cookie.txt（否则重启后 boot 的 importFromFile 会把会话灌回来，等于没退）。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import { go } from '../../utils/nav.js'
import { boot } from '../../utils/boot.js'
import { cachedProfile, loggedIn, fetchProfile, logout } from '../../utils/ncm/login.js'
import { loadUserPlaylists } from '../../utils/ncm/playlist.js'
import { ensureCover, BIG_COVER } from '../../utils/cover.js'
import config from '../../utils/config.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { TOK } from '../../utils/ui/tokens.js'
import { armMixin } from '../../utils/ui/arm.js'
import { pageBusMixin } from '../../utils/ui/pagebus.js'

import { pageFrameMixin } from '../../utils/ui/frame.js'

export default {
  name: 'account',
  mixins: [accentMixin, armMixin, pageBusMixin, pageFrameMixin],
  components: { 'page-shell': PageShell, 'page-topbar': PageTopbar },
  data() {
    return {
      logged: false,
      profile: { nickname: '', avatarUrl: '', userId: 0 },
      avatar: '',
      likedCount: '—',
      createdCount: '—',
      subCount: '—',
      status: '' // 顶栏状态行（退出登录的二次确认态在 armMixin：isArmed('logout')）
    }
  },
  computed: {
    outText() {
      return this.isArmed('logout') ? this.armConfirmText('退出登录') : '退出登录'
    },
    /** 二次确认时按钮变主题色（内联样式覆盖 .ac-btn 的底色） */
    outStyle() {
      return this.isArmed('logout') ? { backgroundColor: this.accent.c } : { backgroundColor: TOK.panel2 }
    },
  },
  mounted() {
    this._dead = false
    this.load()
    // 登录完成 → 重读（注册/退役见 utils/ui/pagebus.js）
    this.onPageEvent('bpncm:login-done', 'load')
  },
  beforeDestroy() {
    this._dead = true
  },
  methods: {
    async load() {
      this.disarm()
      this.logged = loggedIn()
      this.profile = cachedProfile()
      if (!this.logged) {
        this.avatar = ''
        this.likedCount = '—'
        this.createdCount = '—'
        this.subCount = '—'
        this.status = '未登录'
        return
      }
      // boot() 是幂等的：启动链已经取过 profile 就直接拿那次结果，不重复打接口
      const p = await boot()
      if (this._dead) return
      if (p && p.nickname) this.profile = p
      this.syncAvatar()
      await this.loadStats(false)
      if (this._dead) return
      this.status = ''
      log('account', '个人中心就绪 ' + this.profile.nickname + ' uid=' + this.profile.userId)
    },
    async loadStats(force) {
      const uid = config.get('userId') || this.profile.userId || 0
      if (!uid) return
      try {
        const r = await loadUserPlaylists(uid, force)
        this.likedCount = r.liked ? r.liked.count : 0
        this.createdCount = r.created.length
        this.subCount = r.subscribed.length
      } catch (e) {
        log('account', '歌单统计失败 ' + ((e && e.message) || e))
      }
    },
    /** 头像走封面缓存（id 加 ac 前缀避免与歌曲/歌手 id 撞车），圆形用半边长的 vh 半径（平台不认 50%） */
    syncAvatar() {
      const self = this
      const id = this.profile.userId
      const url = this.profile.avatarUrl
      this.avatar = ''
      if (!id || !url) return
      ensureCover({ id: 'ac' + id, cover: url }, function (cid, p) {
        if (p && !self._dead) self.avatar = p
      }, BIG_COVER)
    },
    /** 刷新资料：显式重取 profile（boot 那次可能是很久以前的），并强制刷新歌单统计 */
    async refresh() {
      if (this._busy) return
      this._busy = true
      this.disarm()
      this.status = '刷新资料...'
      try {
        const p = await fetchProfile()
        if (p) this.profile = p
        this.logged = loggedIn()
        this.syncAvatar()
        await this.loadStats(true)
        this.status = this.logged ? '资料已刷新' : '未登录'
        log('account', '资料已刷新 ' + this.profile.nickname)
      } catch (e) {
        this.status = '刷新失败'
        log('account', '刷新失败 ' + ((e && e.message) || e))
      }
      this._busy = false
    },
    doLogin() {
      go('login')
    },
    async doLogout() {
      if (!this.isArmed('logout')) {
        // 待确认文案走统一模板：'双击确认退出登录'（见 ui/arm.js）
        this.arm('logout')
        this.status = '退出会清掉本机登录状态'
        return
      }
      this.disarm()
      this.status = '正在退出...'
      try {
        await logout() // 清 cookie + 资料 + cookie.txt，并 invalidate 歌单缓存
      } catch (e) {
        log('account', '退出异常 ' + ((e && e.message) || e))
      }
      this.logged = false
      this.profile = { nickname: '', avatarUrl: '', userId: 0 }
      this.avatar = ''
      this.likedCount = '—'
      this.createdCount = '—'
      this.subCount = '—'
      this.status = '已退出登录'
      log('account', '已退出登录')
    },
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 横向三段：账号卡 | 统计 | 操作；内容区宽 400vh（1020/2.4 − 左栏 25vh），
   6vh 左右内边距后按下面宽度分配，剩余全给操作列（flex:1） */
.ac-body {
  flex: 1;
  flex-direction: row;
  align-items: center;
  padding: 4vh 6vh;
}
.ac-card {
  width: 172vh;
  flex: none;
  flex-direction: row;
  align-items: center;
}
.ac-avbox {
  width: 48vh;
  height: 48vh;
  flex: none;
  border-radius: 24vh; /* 48vh 见方 → 正圆；平台不认 50% */
  background-color: @panel-2;
  overflow: hidden;
}
.ac-av {
  width: 48vh;
  height: 48vh;
}
.ac-who {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  flex-direction: column;
  margin-left: 4vh;
}
.ac-nm {
  font-size: @fs-title;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.ac-id {
  font-size: @fs-mute;
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
  margin-top: 1.4vh;
}
.ac-stats {
  width: 108vh;
  flex: none;
  flex-direction: column;
  margin-left: 6vh;
}
.ac-stat {
  font-size: @fs-dim;
  color: @text-2;
  lines: 1;
  margin-bottom: 3vh;
}
.ac-ops {
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  margin-left: 4vh;
}
/* 按钮做成 text + 内边距（对齐登录页 .btn/.btnmain 的写法）。
   主/次按钮各自是完整单类名 —— 平台不支持 .a.b 复合选择器。 */
.ac-btn {
  font-size: @fs-dim;
  color: @text;
  background-color: @panel-2;
  padding-left: 7vh;
  padding-right: 7vh;
  padding-top: 3.2vh;
  padding-bottom: 3.2vh;
  border-radius: 7vh;
  margin-bottom: 3vh;
}
.ac-btnmain {
  font-size: @fs-dim;
  color: @text;
  background-color: @accent; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
  padding-left: 7vh;
  padding-right: 7vh;
  padding-top: 3.2vh;
  padding-bottom: 3.2vh;
  border-radius: 7vh;
  margin-bottom: 3vh;
}
</style>
