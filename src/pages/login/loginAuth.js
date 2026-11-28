import { sendCaptcha, loginByCaptcha, loginByPassword } from '../../services/ncm/login.js'
import { log } from '../../core/infra/log.js'

export const loginAuthMixin = {
  methods: {
    checkPhone() {
      const p = String(this.phone || '').replace(/[^0-9]/g, '')
      if (p.length !== 11) {
        this.state = 'error'
        this.status = ''
        return ''
      }
      return p
    },

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
  }
}
