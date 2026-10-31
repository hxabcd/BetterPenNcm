<template>
  <page-shell :rail="rail" @rail="onRail">
    <div class="lv" :style="bgStyle">
      <!-- 左侧边栏：三个入口竖直排列（节点常驻，选中态走内联样式） -->
      <div class="sidebar">
        <text class="sbtn" :style="tabStyle('qr')" @click="setMode('qr')">二维码</text>
        <text class="sbtn" :style="tabStyle('sms')" @click="setMode('sms')">验证码</text>
        <text class="sbtn" :style="tabStyle('pwd')" @click="setMode('pwd')">密码</text>
      </div>

      <!-- 右半边：登录控件（左＝控件本身，右＝状态与操作） -->
      <div class="main">
        <!-- ⚠ 控件区用 v-if 切换而非内联 display：实测内联 display 在这个运行时不生效
             （会渲染出 console.error 且两个面板同时显示）。登录页没有 slot，
             同父下增删兄弟节点是安全的（qr-box/qph 一直这么用）。 -->
        <div class="cwrap">
          <!-- 控件一：二维码（行 div + 同色连续段 div，PenBili 在 S7 上验证过的做法） -->
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

          <!-- 控件二：表单（点行才唤输入法，内容回填到行上，可先看再提交） -->
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
          <!-- 两个常驻按钮：主按钮（刷新/登录/完成）+ 次按钮（只在验证码模式显示「获取验证码」）。
               节点常驻、靠**文本为空**隐形（该运行时同父下增删兄弟节点会让渲染错位），
               空文本时背景同步透明，避免留下一个可点的空白块。 -->
          <div class="btns">
            <text class="btnmain" :style="{ backgroundColor: accent.c }" @click="onMain">{{ mainText }}</text>
            <text class="btn2" :style="btn2Style" @click="onSecond">{{ secondText }}</text>
          </div>
          <!-- 两行提示常驻（文本为空即隐形）：二维码是「怎么用 + 风控兜底」两行，
               密码只有风控兜底一行，验证码**不显示步骤提示**。
               位置在按钮**下面**。 -->
          <text class="tip">{{ tipText }}</text>
          <text class="tip">{{ tip2Text }}</text>
        </div>
      </div>
    </div>

  </page-shell>
</template>

<script>
/**
 * 登录页：三个入口（二维码 / 验证码 / 密码）
 *
 * 为什么不再用扫码作为唯一入口：双端实测（笔 + PC，同一套 weapi）
 * 扫码「确认授权」一律被环境风控拦 8821，换号也一样 —— 属于通道级拦截。
 * 短信验证码是唯一实测能自助走通的方式，密码登录作为兜底（有云盾，成功率较低）。
 *
 * 输入方式：验证码/密码两种**都在页面内填**，
 * 即「点输入框 → 唤系统输入法 → 内容回填到该行 → 自己点按钮提交」，
 * 而不是点一下就直接弹输入法、输入完直接提交（那样没法核对/修改）。
 *
 * 二维码渲染：行 div + 同色连续段 div + 静态 class（PenBili 在 S7 上验证过的做法），
 * canvas 与子组件两条路在这个运行时都不通。
 */
import QRCode from '../../vendor/qrcode.js'
import PageShell from '../../components/PageShell.vue'
import { accentMixin } from '../../utils/theme.js'
import { TOK } from '../../utils/ui/tokens.js'
import { railBack } from '../../utils/rail.js'
import {
  createQr,
  pollQr,
  logout,
  cachedProfile,
  fetchProfile,
  sendCaptcha,
  loginByCaptcha,
  loginByPassword,
  CODE,
  loggedIn
} from '../../utils/ncm/login.js'
import { openTextEdit } from '../../utils/systemKeyboard.js'
import { log } from '../../utils/log.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'

const POLL_MS = 2000
const MAX_POLLS = 90 // 3 分钟不扫就停
const QUIET = 4 // 静默区模块数，二维码标准要求 ≥4 手机才扫得稳
const CELL = 5 // 单元格边长 px。41 模块 × 5px = 205px

/* 运行时会把页面挂两遍（实测每次进登录页取到两个 unikey），
   只让最后挂载的那个实例干活，避免两个码互相打架 */
let ACTIVE = null

export default {
  name: 'login',
  mixins: [accentMixin, pageFrameMixin],
  data() {
    return {
      mode: 'qr', // qr | sms | pwd
      state: 'init', // init | qr | scanned | ok | expired | error
      // 顶部红字常态显示「XXX登录」；流程中由进度/报错临时覆盖
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
    /** 左栏：登录页只需要返回（唯一的返回入口，去掉了右侧那个重复的） */
    rail() {
      return [railBack()]
    },
    /* 控件区由模板的 v-if/v-else 切换（内联 display 在这个运行时不生效，见模板注释） */
    /** 主按钮：只管「提交」这一步（刷新二维码 / 登录 / 完成） */
    mainText() {
      if (this.state === 'ok') return '完成'
      if (this.mode === 'qr') return '刷新二维码'
      return '登录'
    },
    /** 次按钮：只有验证码模式有（发码与登录是两个独立动作） */
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
    /** 密码一律显示为圆点，不回显明文 */
    secretText() {
      if (!this.code) return '点击输入'
      if (this.mode === 'pwd') return '●●●●●●●●'
      return this.code
    },
    /** 二维码占位区文字（二维码没出来时） */
    qrHint() {
      return this.state === 'ok' ? '已登录' : '二维码生成中...'
    },
    /** 登录成功后显示昵称（未登录为空串，节点常驻靠文本隐形） */
    whoText() {
      return this.state === 'ok' && this.profile.nickname ? '已登录：' + this.profile.nickname : ''
    },
    /** 右侧提示第 1 行（节点常驻，按模式换文本；验证码模式为空） */
    tipText() {
      if (this.state === 'ok') return ''
      if (this.mode === 'qr') return '使用手机客户端扫码登录。'
      if (this.mode === 'pwd') return '若遇风控，可尝试验证码登录'
      return '' // 验证码：不显示步骤提示
    },
    /** 右侧提示第 2 行：只有二维码模式多一行风控兜底 */
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
    /* ---- 页签 ---- */
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

    /* ---- 二维码：把矩阵转成「行 → 同色段」---- */
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

      // 上静区：QUIET 行整宽空白（少了手机扫不稳）
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

      // 下静区
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
        this.stopTimer() // 另一个实例在跑，本实例退让
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

      // 只在状态变化时记日志，避免每 2 秒刷屏
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

    /* ---- 表单输入：点行 → 唤输入法 → 回填（不自动提交） ---- */

    async editPhone() {
      if (this.state === 'ok' || this.mode === 'qr') return
      const v = await openTextEdit({
        placeholder: '输入手机号',
        inputType: 'NumberPreferred',
        maxlength: 11,
        enterButtonText: '完成',
        text: this.phone
      })
      if (v === null) return // 取消
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

    /* ---- 提交 ---- */

    onMain() {
      if (this.state === 'ok') return this.close()
      if (this.mode === 'qr') return this.restart()
      if (this.mode === 'sms') return this.smsLogin()
      return this.pwdSubmit()
    },

    /** 次按钮：只在验证码模式下发码（与「登录」是两个独立动作，可重发） */
    onSecond() {
      if (this.state === 'ok') return
      if (this.mode !== 'sms') return
      return this.smsSend()
    },

    /** 校验手机号（两个按钮共用），通过返回 11 位号码，不通过返回 '' 并提示 */
    checkPhone() {
      const p = String(this.phone || '').replace(/[^0-9]/g, '')
      if (p.length !== 11) {
        this.state = 'error'
        this.status = ''
        return ''
      }
      return p
    },

    /** 第 1 步（次按钮）：发送短信验证码 */
    async smsSend() {
      if (this._sms) return
      const p = this.checkPhone()
      if (!p) return
      this._sms = true
      this.status = '正在发送验证码...'
      try {
        const s = await sendCaptcha(p)
        if (this._dead) return
        if (s.code !== 200) {
          this.state = 'error'
          this.status = '验证码发送失败（' + s.code + '）'
          // 灰字行已去掉，失败原因只进日志
          log('login', '验证码发送失败 ' + s.code + ' ' + (s.message || ''))
          return
        }
        this.smsSent = true
        this.state = 'init'
        this.status = '验证码已发送，填写后点「登录」'
      } catch (e) {
        this.state = 'error'
        this.status = '发送出错'
        log('login', '发送验证码异常: ' + String((e && e.message) || e))
      } finally {
        this._sms = false
      }
    },

    /** 第 2 步（主按钮）：用验证码登录 */
    async smsLogin() {
      if (this._sms) return
      const p = this.checkPhone()
      if (!p) return
      if (!this.smsSent) {
        this.status = '请先获取验证码'
        return
      }
      if (!this.code) {
        this.status = '请先填写验证码'
        return
      }
      this._sms = true
      this.status = '正在登录...'
      try {
        const r = await loginByCaptcha(p, this.code)
        if (this._dead) return
        if (r.code === 200) {
          this.finishLogin(r.nickname, '', r.userId, r.cookieCount, '验证码')
        } else {
          this.state = 'error'
          this.status = '登录失败（' + r.code + '）'
          log('login', '验证码登录失败 ' + r.code + ' ' + (r.message || ''))
        }
      } catch (e) {
        this.state = 'error'
        this.status = '登录出错'
        log('login', '验证码登录异常: ' + String((e && e.message) || e))
      } finally {
        this._sms = false
      }
    },

    async pwdSubmit() {
      if (this._sms) return
      const p = String(this.phone || '').replace(/[^0-9]/g, '')
      if (p.length !== 11) {
        this.state = 'error'
        this.status = ''
        return
      }
      if (!this.code) {
        this.status = '请先填写密码'
        return
      }
      this._sms = true
      this.status = '正在登录...'
      try {
        const r = await loginByPassword(p, this.code)
        if (r.code === 200) {
          this.finishLogin(r.nickname, '', r.userId, r.cookieCount, '密码')
        } else {
          this.state = 'error'
          this.status = '登录失败（' + r.code + '）'
          log('login', '密码登录失败 ' + r.code + ' ' + (r.message || ''))
        }
      } catch (e) {
        this.state = 'error'
        this.status = '登录出错'
        log('login', '密码登录异常: ' + String((e && e.message) || e))
      } finally {
        this._sms = false
        // 密码用完即弃，别留在内存里
        this.code = ''
      }
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

    /** 左栏分派（返回只在这里，右侧控件区不再放第二个返回按钮） */
    /* ---- 左栏（分派骨架见 ui/frame.js）：本页返回 = 自定义 close（先 stopTimer 再 finish）---- */
    onBack() {
      this.close()
    }
  }
}
</script>

<style lang="less" scoped>
/* 本页使用全局 LESS 令牌与主题色；尺寸仍按登录流程单独排版。 */
@import '../../styles/common.less';

.lv {
  flex: 1;
  flex-direction: row;
  /* 显式左上对齐：该运行时 flex 默认值不完全等同浏览器（实测内容会垂直居中） */
  align-items: flex-start;
  justify-content: flex-start;
  padding: 12px;
  /* 底色由内联 :style 给（主题可换，见 utils/theme.js）；本页其余仍是硬编码 px/色值 */
}
/* 左侧边栏：三个入口竖直排列 */
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
/* 右半边：控件在左，状态与操作在右 */
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
  padding-top: 2px; /* 屏高只有 240，纵向间距收紧（灰字行已删，底部不再有内容被裁） */
}
/* 表单：两行输入，点行唤系统输入法后回填（不直接提交） */
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
  color: @accent; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
  margin-bottom: 6px;
}
.who {
  font-size: 18px;
  color: @ok;
  margin-bottom: 8px;
}
/* 提示语（按模式换文案），位置在按钮**下方**，所以这里用 margin-top 与按钮间隔。
   ⚠ 这个类漏过一次：没有 color 时文字取运行时默认色（纯黑），压在深色背景上完全读不出
   —— 右边「有个黑色文本看不清」就是它。别再删。 */
.tip {
  font-size: 15px;
  color: @text-2;
  margin-top: 8px;
}
.btns {
  flex-direction: row;
  margin-top: 2px;
}
/* 次按钮（验证码模式才有）：独立单类名；文本为空时由内联 style 置为透明而隐形 */
.btn2 {
  font-size: 17px;
  color: @text;
  background-color: @panel-2; /* 书面值，实际由模板内联 style 给（含隐形态的 transparent） */
  padding-left: 18px;
  padding-right: 18px;
  padding-top: 10px;
  padding-bottom: 10px;
  border-radius: 8px;
}
/* 主按钮：独立单类名（平台不支持 .btn.main 复合选择器）；底色走主题色（模板内联 style） */
.btnmain {
  font-size: 17px;
  color: @text;
  background-color: @accent; /* 默认（红）的书面值 */
  padding-left: 18px;
  padding-right: 18px;
  padding-top: 10px;
  padding-bottom: 10px;
  border-radius: 8px;
  margin-right: 12px;
}
</style>
