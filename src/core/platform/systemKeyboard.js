/**
 * 系统输入法调用（有道输入法面板）
 *
 * 结论来源（实测 + PenMusic 明文源码对照）：
 *   const { Global } = await import('global')
 *   const g = new Global()
 *   g.textEditFinished.on(cb)                 // 信号对象，用 .on()（不是属性赋值！）
 *   $falcon.on('textEditFinished', cb)        // 备用通道
 *   g.startTextEdit(JSON.stringify(cfg))      // **必须传 JSON 字符串**，传对象拉不起来
 *
 * 回调参数: (uuid, JSON字符串)，JSON 内含 contents / editCanceled / editConfirmed
 * cfg 字段: text / placeholder / placeholderColor / autofocus / maxlength / showCursor /
 *           cursorColor / cursorSize / cursorIndex / confirmButtonDisabledOnTextEmpty /
 *           inputType / multiLinesEditVisible / capsLockSwitchOn / enterButtonText /
 *           micInputVisible / closeButtonVisible
 * inputType 取值: ZhCNPreferred / ZhCNOnly / EnUSPreferred / EnUSOnly /
 *                 NumberPreferred / PunctuationPreferred / SymbolsPreferred / RecordPreferred
 *
 * 注意：不要调 closeTextEdit（PenMusic 也不调，调了在真机上有闪退风险）。
 */
let inst = null

async function getInst() {
  if (!inst) {
    const m = await import('global')
    const M = (m && m.default) || m
    const G = M.Global || M
    inst = new G()
  }
  return inst
}

/** 输入法是否可用 */
export async function available() {
  try {
    const g = await getInst()
    return !!(g && typeof g.startTextEdit === 'function')
  } catch (e) {
    return false
  }
}

/**
 * 打开系统输入法，返回 Promise<string|null>（null = 取消或不可用）
 * opts: { text, placeholder, inputType, maxlength, enterButtonText, multiLines }
 */
export async function openTextEdit(opts) {
  const o = opts || {}
  let g = null
  try {
    g = await getInst()
  } catch (e) {
    return null
  }
  if (!g || typeof g.startTextEdit !== 'function') return null

  const cfg = {
    text: o.text || '',
    placeholder: o.placeholder || '输入文字...',
    autofocus: true,
    maxlength: typeof o.maxlength === 'number' ? o.maxlength : 200,
    showCursor: true,
    confirmButtonDisabledOnTextEmpty: false,
    multiLinesEditVisible: !!o.multiLines,
    inputType: o.inputType || 'ZhCNPreferred',
    enterButtonText: o.enterButtonText || '完成'
  }

  return new Promise(function (resolve) {
    let done = false
    const finish = function (v) {
      if (done) return
      done = true
      // 清理信号
      try {
        if (g.textEditFinished && typeof g.textEditFinished.off === 'function') {
          g.textEditFinished.off(handle)
        }
      } catch (e) {}
      try {
        if ($falcon && typeof $falcon.off === 'function') $falcon.off('textEditFinished', handle)
      } catch (e) {}
      resolve(v)
    }

    // 从回调参数里提取文本（(uuid, jsonString) 或 (jsonString)）
    const handle = function () {
      const args = Array.prototype.slice.call(arguments)
      let payload = null
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (typeof a === 'string' && a.charAt(0) === '{') {
          try {
            payload = JSON.parse(a)
            break
          } catch (e) {}
        } else if (a && typeof a === 'object' && !payload) {
          payload = a
        }
      }
      // 备用通道（$falcon.on）拿到的是框架事件壳 {type,timestamp,data} —— 先脱壳再解析，
      // 否则会把壳当负载、解析出空文本（实证见 utils/events.js 顶部）
      if (payload && payload.type === 'textEditFinished' && payload.data !== undefined) {
        payload = payload.data
        if (typeof payload === 'string' && payload.charAt(0) === '{') {
          try {
            payload = JSON.parse(payload)
          } catch (e) {}
        }
      }
      if (!payload) return finish(null)
      if (payload.editCanceled) return finish(null)
      let text = payload.contents
      if (text === undefined) text = payload.text !== undefined ? payload.text : payload.inputText
      finish(text === undefined || text === null ? '' : String(text))
    }

    // 通道一：Global 信号
    try {
      if (g.textEditFinished && typeof g.textEditFinished.on === 'function') {
        g.textEditFinished.on(handle)
      }
    } catch (e) {}
    // 通道二：falcon 事件总线（备用）
    try {
      if ($falcon && typeof $falcon.on === 'function') $falcon.on('textEditFinished', handle)
    } catch (e) {}

    // 拉起键盘（必须 JSON 字符串）
    try {
      g.startTextEdit(JSON.stringify(cfg))
    } catch (e) {
      finish(null)
    }
  })
}

/** 清空输入框内容（可选） */
export async function clearContent() {
  try {
    const g = await getInst()
    if (typeof g.clearTextEditContent === 'function') g.clearTextEditContent()
  } catch (e) {}
}
