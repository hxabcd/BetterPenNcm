<template>
  <page-shell :rail="rail" @rail="onRail">
    <div class="lv" :style="bgStyle">
      <!-- 左侧边栏：三个入口竖直排列（节点常驻，选中态走内联样式 —— 该运行时同父下增删兄弟节点会让渲染错位） -->
      <div class="sidebar">
        <text class="sbtn" :style="tabStyle('qr')" @click="setMode('qr')">二维码</text>
        <text class="sbtn" :style="tabStyle('sms')" @click="setMode('sms')">验证码</text>
        <text class="sbtn" :style="tabStyle('pwd')" @click="setMode('pwd')">密码</text>
      </div>

      <div class="main">
        <!-- ⚠ 控件区用 v-if 切换而非内联 display：实测内联 display 在这个运行时不生效
             （会渲染出 console.error 且两个面板同时显示）。 -->
        <div class="cwrap">
          <!-- 控件一：二维码（行 div + 同色连续段 div，PenBili 在 S7 上验证过的做法）。
               canvas 与子组件两条路在这个运行时都不通。 -->
          <div class="pane" v-if="mode === 'qr'">
            <div class="qr-box" v-if="qrRows.length">
              <div class="qr-row" v-for="(row, ri) in qrRows" :key="ri">
                <div
                  v-for="(seg, si) in row"
                  :key="si"
                  :class="seg.dark ? 'qr-seg qr-dark ' + seg.cls : 'qr-seg ' + seg.cls"
                ></div>
              </div>
            </div>
            <div class="qph" v-else>
              <text class="qphtx">{{ qrHint }}</text>
            </div>
          </div>

          <div class="pane" v-else>
            <div class="form">
              <div class="frow" @click="editPhone">
                <text class="flabel">手机号</text>
                <text class="fval" :style="phone ? valFilled : valEmpty">{{ phoneText }}</text>
              </div>
              <div class="frow" @click="editSecret">
                <text class="flabel">{{ secretLabel }}</text>
                <text class="fval" :style="code ? valFilled : valEmpty">{{ secretText }}</text>
              </div>
            </div>
          </div>
        </div>

        <div class="pinfo">
          <text class="st" :style="{ color: accent.c }">{{ status }}</text>
          <text class="who">{{ whoText }}</text>
          <!-- 两个常驻按钮：节点常驻、靠**文本为空**隐形（该运行时同父下增删兄弟节点会让渲染错位），
               空文本时背景同步透明，避免留下一个可点的空白块 -->
          <div class="btns">
            <text class="btnmain" :style="{ backgroundColor: accent.c }" @click="onMain">{{ mainText }}</text>
            <text class="btn2" :style="btn2Style" @click="onSecond">{{ secondText }}</text>
          </div>

          <text class="tip">{{ tipText }}</text>
          <text class="tip">{{ tip2Text }}</text>
        </div>
      </div>
    </div>

  </page-shell>
</template>

<script>
/**
 * 三个入口（二维码 / 验证码 / 密码）：双端实测（笔 + PC，同一套 weapi）扫码「确认授权」
 * 一律被环境风控拦 8821，换号也一样 —— 属于通道级拦截。短信验证码是唯一实测能自助走通的
 * 方式，密码登录作为兜底（有云盾，成功率较低）。
 */
import QRCode from '../../vendor/qrcode.js'
import PageShell from '../../components/PageShell.vue'
import { accentMixin } from '../../ui/mixins/accent.js'
import { TOK } from '../../ui/tokens.js'
import { railBack } from '../../ui/rail.js'
import {
  createQr,
  pollQr,
  logout,
  cachedProfile,
  fetchProfile,
  CODE,
  loggedIn
} from '../../services/ncm/login.js'
import { loginAuthMixin } from './loginAuth.js'
import { openTextEdit } from '../../core/platform/systemKeyboard.js'
import { log } from '../../core/infra/log.js'
import { pageFrameMixin } from '../../ui/mixins/frame.js'

const POLL_MS = 2000
const MAX_POLLS = 90 // 3 分钟不扫就停
const QUIET = 4 // 静默区模块数，二维码标准要求 ≥4 手机才扫得稳
const CELL = 5 // 单元格边长 px。41 模块 × 5px = 205px

/* 运行时会把页面挂两遍（实测每次进登录页取到两个 unikey），
   只让最后挂载的那个实例干活，避免两个码互相打架 */
let ACTIVE = null

export default {
  name: 'login',
  mixins: [accentMixin, pageFrameMixin, loginAuthMixin],
  data() {
    return {
      mode: 'qr', // qr | sms | pwd
      state: 'init', // init | qr | scanned | ok | expired | error

      status: '二维码登录',
      unikey: '',
      qrRows: [],
      phone: '',
      code: '', // 验证码 或 密码（按 mode 语义不同，切换模式时清空）
      smsSent: false,
      profile: { nickname: '', avatarUrl: '', userId: 0 },
      polls: 0,
    }
  },
  components: { 'page-shell': PageShell },
  computed: {
    bgStyle() {
      return { backgroundColor: this.bg }
    },

    rail() {
      return [railBack()]
    },

    mainText() {
      if (this.state === 'ok') return '完成'
      if (this.mode === 'qr') return '刷新二维码'
      return '登录'
    },

    secondText() {
      if (this.state === 'ok') return ''
      if (this.mode !== 'sms') return ''
      return this.smsSent ? '重发验证码' : '获取验证码'
    },
    btn2Style() {
      // 无文本时整体透明（该运行时不认内联 display，只能靠颜色隐形）
      if (!this.secondText) return { backgroundColor: 'transparent', color: 'transparent' }
      return { backgroundColor: TOK.panel2, color: TOK.text }
    },
    secretLabel() {
      return this.mode === 'pwd' ? '密码' : '验证码'
    },
    phoneText() {
      return this.phone || '点击输入'
    },

    secretText() {
      if (!this.code) return '点击输入'
      if (this.mode === 'pwd') return '●●●●●●●●'
      return this.code
    },

    qrHint() {
      return this.state === 'ok' ? '已登录' : '二维码生成中...'
    },

    whoText() {
      return this.state === 'ok' && this.profile.nickname ? '已登录：' + this.profile.nickname : ''
    },

    tipText() {
      if (this.state === 'ok') return ''
      if (this.mode === 'qr') return '使用手机客户端扫码登录。'
      if (this.mode === 'pwd') return '若遇风控，可尝试验证码登录'
      return '' 
    },

    tip2Text() {
      if (this.state === 'ok') return ''
      return this.mode === 'qr' ? '若遇风控，可尝试验证码登录' : ''
    },
    valFilled() {
      return { color: TOK.text }
    },
    valEmpty() {
      return { color: TOK.text3 }
    }
  },
  mounted() {
    this._dead = false
    this._busy = false
    this._timer = null
    this._sms = false
    ACTIVE = this
    const p = cachedProfile()
    if (p.nickname) this.profile = p
    if (loggedIn()) {
      this.state = 'ok'
      this.status = '已登录，正在校验...'
      this.verify()
    } else {
      this.restart()
    }
  },
  beforeDestroy() {
    this._dead = true
    if (ACTIVE === this) ACTIVE = null
    this.stopTimer()
  },
  methods: {

    tabStyle(m) {
      if (m === this.mode) {
        return { backgroundColor: this.accent.c, color: this.accent.on }
      }
      return { backgroundColor: TOK.panel2, color: TOK.text2 }
    },

    setMode(m) {
      if (this.state === 'ok') return // 已登录：换号请先退出登录
      if (m === this.mode) return
      this.mode = m
      // 切换模式：验证码/密码字段不通用的，必须清掉（密码绝不残留到验证码框）
      this.code = ''
      this.smsSent = false
      this.polls = 0
      if (m === 'qr') {
        this.status = '二维码登录'
        this.restart()
      } else {
        this.stopTimer()
        this.state = 'init'
        this.status = m === 'sms' ? '验证码登录' : '密码登录'
      }
    },

    buildQr(url) {
      const C = QRCode.CorrectLevel || { L: 1, M: 0, Q: 3, H: 2 }
      const t = QRCode.getTypeNumber(url, C.L)
      const model = new QRCode.QRCodeModel(t, C.L)
      model.addData(url)
      model.make()
      const n = model.getModuleCount()
      const total = n + QUIET * 2

      const rows = []
      const push = function (segs, dark, len) {
        const prev = segs[segs.length - 1]
        if (prev && prev.dark === dark) {
          prev.len += len
          prev.cls = 'qr-l-' + prev.len
          return
        }
        segs.push({ dark: dark, len: len, cls: 'qr-l-' + len })
      }

      for (let i = 0; i < QUIET; i++) {
        const top = []
        push(top, false, total)
        rows.push(top)
      }

      for (let y = 0; y < n; y++) {
        const segs = []
        push(segs, false, QUIET)
        let x = 0
        while (x < n) {
          const dark = !!model.isDark(y, x)
          let len = 1
          while (x + len < n && !!model.isDark(y, x + len) === dark) len++
          push(segs, dark, len)
          x += len
        }
        push(segs, false, QUIET)
        rows.push(segs)
      }

      for (let i = 0; i < QUIET; i++) {
        const bottom = []
        push(bottom, false, total)
        rows.push(bottom)
      }

      let segs = 0
      for (let i = 0; i < rows.length; i++) segs += rows[i].length
      this.qrRows = rows
      log('qr', 'v' + t + ' ' + n + 'x' + n + ' 行=' + rows.length + ' 段=' + segs + ' 边长=' + total * CELL + 'px')
      return true
    },

    notifyDone() {
      /* global $falcon */
      try {
        $falcon.trigger('bpncm:login-done')
      } catch (e) {}
    },

    async verify() {
      const p = await fetchProfile()
      if (this._dead) return
      if (p) this.profile = p
      this.status = this.profile.nickname ? '登录态有效' : '已登录'
      this.notifyDone()
    },

    stopTimer() {
      if (this._timer) {
        clearInterval(this._timer)
        this._timer = null
      }
    },

    async restart() {
      this.stopTimer()
      this.polls = 0
      this.state = 'init'
      this.status = '二维码登录'
      this.qrRows = []
      let r = null
      try {
        r = await createQr()
      } catch (e) {
        if (this._dead) return
        this.state = 'error'
        this.status = '获取二维码失败'
        log('login', '获取二维码失败: ' + String((e && e.message) || e))
        return
      }
      if (this._dead) return
      this.unikey = r.unikey
      try {
        this.buildQr(r.url)
      } catch (e) {
        log('qr', '生成二维码矩阵失败: ' + (e && e.message))
      }
      this.state = 'qr'
      this.status = '等待扫码...'
      this.startTimer()
    },

    startTimer() {
      const self = this
      this.stopTimer()
      this._timer = setInterval(function () {
        self.tick()
      }, POLL_MS)
    },

    async tick() {
      if (this._dead || this._busy) return
      if (ACTIVE && ACTIVE !== this) {
        this.stopTimer() 
        return
      }
      if (this.mode !== 'qr') {
        this.stopTimer()
        return
      }
      if (this.state === 'ok' || this.state === 'error') {
        this.stopTimer()
        return
      }
      if (this.polls++ > MAX_POLLS) {
        this.stopTimer()
        this.status = '超时未扫码，请点「刷新二维码」'
        return
      }
      this._busy = true
      let r = null
      try {
        r = await pollQr(this.unikey)
      } catch (e) {
        r = null
      }
      this._busy = false
      if (this._dead || !r) return

      if (r.code !== this._lastCode) {
        this._lastCode = r.code
        log('login', '轮询状态 ' + r.code + (r.message ? ' ' + r.message : ''))
      }

      if (r.code === CODE.WAITING) {
        if (this.state !== 'qr') this.state = 'qr'
        this.status = '等待扫码...'
      } else if (r.code === CODE.SCANNED) {
        this.state = 'scanned'
        this.status = '已扫码，请在手机上点确认'
        log('login', '已扫码，等待手机确认')
      } else if (r.code === CODE.EXPIRED) {
        this.state = 'expired'
        this.status = '二维码已过期，正在换一张...'
        log('login', '二维码过期，自动换新')
        this.stopTimer()
        const self = this
        setTimeout(function () {
          if (!self._dead && (!ACTIVE || ACTIVE === self)) self.restart()
        }, 800)
      } else if (r.code === CODE.RISKY) {
        // 8821 = 安全环境风控。继续轮询只会加重风控，停在这里等用户手动刷新
        this.stopTimer()
        this.state = 'error'
        this.status = '被安全风控拦截（8821）'
        log('login', '8821 风控：停止轮询，建议改用验证码登录')
      } else if (r.code === CODE.OK) {
        this.finishLogin(r.nickname, r.avatarUrl, r.userId, r.cookieCount, '扫码')
      } else {
        this.status = '状态 ' + r.code + ' ' + (r.message || '')
      }
    },

    async editPhone() {
      if (this.state === 'ok' || this.mode === 'qr') return
      const v = await openTextEdit({
        placeholder: '输入手机号',
        inputType: 'NumberPreferred',
        maxlength: 11,
        enterButtonText: '完成',
        text: this.phone
      })
      if (v === null) return 
      this.phone = String(v).replace(/[^0-9]/g, '')
    },

    async editSecret() {
      if (this.state === 'ok' || this.mode === 'qr') return
      const isPwd = this.mode === 'pwd'
      // 密码不回填到输入法（避免明文在输入法里二次出现）
      const v = await openTextEdit({
        placeholder: isPwd ? '输入密码' : '输入验证码',
        inputType: isPwd ? 'EnUSPreferred' : 'NumberPreferred',
        maxlength: isPwd ? 40 : 6,
        enterButtonText: '完成',
        text: isPwd ? '' : this.code
      })
      if (v === null) return
      this.code = isPwd ? String(v) : String(v).replace(/[^0-9]/g, '')
    },

    maskPhone(p) {
      return p.length > 7 ? p.slice(0, 3) + '****' + p.slice(-4) : '****'
    },

    onMain() {
      if (this.state === 'ok') return this.close()
      if (this.mode === 'qr') return this.restart()
      if (this.mode === 'sms') return this.smsLogin()
      return this.pwdSubmit()
    },

    onSecond() {
      if (this.state === 'ok') return
      if (this.mode !== 'sms') return
      return this.smsSend()
    },

    /** 登录成功收尾（三种方式共用） */
    finishLogin(nickname, avatarUrl, userId, cookieCount, how) {
      this.stopTimer()
      this.profile = { nickname: nickname, avatarUrl: avatarUrl || '', userId: userId }
      this.state = 'ok'
      // 以「有没有 MUSIC_U」为准，而不是 cookie 计数：计数只统计本次**新增**项，
      // 已存在的会话项不计入，光看计数会误报「登录成功但未取到 cookie」
      const ok = loggedIn()
      this.status = ok ? '登录成功' : '登录成功（未取到会话，看日志）'
      log('login', how + '登录成功 nickname=' + nickname + ' cookies=' + cookieCount)
      this.notifyDone()
    },

    async doLogout() {
      await logout()
      this.profile = { nickname: '', avatarUrl: '', userId: 0 }
      this.restart()
      this.notifyDone()
    },

    close() {
      this.stopTimer()
      this.$page.finish()
    },

    // 返回走自定义 close：必须先 stopTimer 再 finish（轮询不能等 beforeDestroy）
    onBack() {
      this.close()
    }
  }
}
</script>

<style lang="less" scoped>

@import '../../styles/common.less';

.lv {
  flex: 1;
  flex-direction: row;
  /* 显式左上对齐：该运行时 flex 默认值不完全等同浏览器（实测内容会垂直居中） */
  align-items: flex-start;
  justify-content: flex-start;
  padding: 12px;

}

.sidebar {
  width: 104px;
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
  margin-right: 14px;
}
.sbtn {
  width: 100px;
  font-size: 16px;
  /* 不写 text-align：该运行时不一定支持，靠左右等宽 padding 让文字视觉居中 */
  padding-left: 14px;
  padding-right: 10px;
  padding-top: 11px;
  padding-bottom: 11px;
  border-radius: 8px;
  margin-bottom: 10px;
}

.main {
  flex: 1;
  flex-direction: row;
  align-items: flex-start;
  justify-content: flex-start;
}
.cwrap {
  width: 420px;
  height: 205px;
  align-items: center;
  justify-content: center;
}
.pane {
  align-items: center;
  justify-content: center;
}
.qr-box {
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background-color: @text;
  border-radius: 6px;
  overflow: hidden;
}
.qr-row {
  height: 5px;
  flex-direction: row;
}
.qr-seg {
  height: 5px;
}
.qr-dark {
  background-color: #000000; /* 二维码墨色：故意保留字面量（不随主题） */
}
.qph {
  width: 205px;
  height: 205px;
  align-items: center;
  justify-content: center;
  background-color: @panel-2;
  border-radius: 6px;
}
.qphtx {
  font-size: 16px;
  color: @text-2;
}

/* 同色连续段宽度：qr-l-N = N 个单元格。LESS 循环生成，笔上不能用内联样式以外的方式算宽度 */
.gen-len(@n) when (@n > 0) {
  .qr-l-@{n} {
    width: (@n * 5px);
  }
  .gen-len(@n - 1);
}
.gen-len(41);

.pinfo {
  flex: 1;
  align-items: flex-start;
  justify-content: flex-start;
  padding-left: 18px;
  padding-top: 2px; 
}

.form {
  flex-direction: column;
}
.frow {
  width: 400px;
  flex-direction: row;
  align-items: center;
  background-color: @panel-2;
  border-radius: 8px;
  padding-left: 12px;
  padding-right: 12px;
  padding-top: 9px;
  padding-bottom: 9px;
  margin-bottom: 8px;
}
.flabel {
  font-size: 15px;
  color: @text-2;
  width: 62px;
}
.fval {
  font-size: 17px;
  flex: 1;
}
.st {
  font-size: 19px;
  color: @accent; 
  margin-bottom: 6px;
}
.who {
  font-size: 18px;
  color: @ok;
  margin-bottom: 8px;
}

.tip {
  font-size: 15px;
  color: @text-2;
  margin-top: 8px;
}
.btns {
  flex-direction: row;
  margin-top: 2px;
}

.btn2 {
  font-size: 17px;
  color: @text;
  background-color: @panel-2; 
  padding-left: 18px;
  padding-right: 18px;
  padding-top: 10px;
  padding-bottom: 10px;
  border-radius: 8px;
}

.btnmain {
  font-size: 17px;
  color: @text;
  background-color: @accent; 
  padding-left: 18px;
  padding-right: 18px;
  padding-top: 10px;
  padding-bottom: 10px;
  border-radius: 8px;
  margin-right: 12px;
}
</style>
