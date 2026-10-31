/* 应用入口：继承 $falcon.App，实现应用级生命周期 */
import { flushNow, pauseForExit } from './utils/player/player.js'
import { log } from './utils/log.js'
import { noteLifeCycle } from './utils/nav.js'

/** 异常转文本（错误对象经框架桥接会显示成 null，这里自己拼 message + 栈前几行） */
function errText(err) {
  try {
    if (!err) return String(err)
    const msg = err.message || ''
    const stack = String(err.stack || '').split('\n').slice(0, 4).join(' | ')
    if (msg || stack) return msg + ' @ ' + stack
    return String(err)
  } catch (e) {
    return 'errText 异常'
  }
}

class App extends $falcon.App {
  constructor() {
    super()
    /* 诊断钩子（多选重渲染崩溃排查）：框架把渲染/回调异常交给
       `$falcon.onAppError(err)`（jsfm-nvue 的 handleError 里**动态取字段**调用，
       所以覆盖有效），但它在控制台只打 null。这里把真实信息引到设备日志。 */
    try {
      /* global $falcon */
      const prev = $falcon.onAppError
      $falcon.onAppError = function (err) {
        try {
          log('app', 'onAppError: ' + errText(err))
        } catch (e) {}
        if (typeof prev === 'function') return prev.call($falcon, err)
      }
    } catch (e) {}
  }

  /** 框架的 app 级 onError 生命周期（_performAppLifeCycle('onError', err, 'error')） */
  onError(err) {
    try {
      log('app', 'App.onError: ' + errText(err))
    } catch (e) {}
    if (super.onError) super.onError(err)
  }

  /**
   * 框架的 app 级**页面**生命周期：每个页面的 load / newOptions / show / hide / unload
   * 都会转发到这里（设备端 jsfm-nvue 的 _performPageLifeCycle 调 _performAppLifeCycle('onPageLifeCycle')）。
   * 导航层用它记账页面实例的存活（槽位分配 / 回退判断），见 utils/nav.js。
   */
  onPageLifeCycle(options) {
    try {
      noteLifeCycle(options)
    } catch (e) {}
    if (super.onPageLifeCycle) super.onPageLifeCycle(options)
  }

  onLaunch(options) {
    super.onLaunch(options)
  }

  onShow() {
    super.onShow()
  }

  // 切后台/退出：把当前播放位置立刻写进「上次播放状态」快照（平时播放中每 5 秒节流存一次，
  // 大队列退回 15 秒；这里兜底存最准的一次）。失败无副作用。
  // ⚠️ 这里**不能**暂停音乐：设备实测 onHide 在「切到其他应用 / 锁屏 / closeApp 退出」时都会派发，
  // 挂暂停会把后台听歌打断 —— 只有 onDestroy 才是「退出」。
  onHide() {
    flushNow()
    super.onHide()
  }

  // 应用销毁（「退出时暂停音乐」的第二道保险）：正常退出路径是主页左栏「返回」→
  // index.vue 里 await player.pauseForExit() 后再 closeApp（那里最可靠，不等销毁时机）；
  // 这里兜底系统/框架直接销毁应用的情形，pauseForExit 幂等（已暂停就不动）。
  onDestroy() {
    flushNow()
    pauseForExit()
    super.onDestroy()
  }
}

export default App
