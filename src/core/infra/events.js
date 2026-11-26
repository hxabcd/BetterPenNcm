// 跨页事件（$falcon.on）的负载解包。
// 框架会给负载套一层壳：FalconEvent.trigger(name, options) 实际回调的是
// {type, timestamp, data: options || {}}，不是 options 本身（设备端 jsfm-nvue 字节码同构）。
// 监听端不脱壳就会拿到对象、字段全 undefined —— 静默失效（bpncm:toast 曾因此显示成 [object Object]）。
// trigger 端不用改，壳只出现在回调侧

export function evtData(evt) {
  if (evt && typeof evt === 'object' && evt.data !== undefined) return evt.data
  return evt
}

// 本项目跨页事件约定传 JSON.stringify({...})，这里是脱壳 + parse 的便捷版本
export function evtJson(evt) {
  const raw = evtData(evt)
  if (!raw) return null
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(String(raw))
  } catch (e) {
    return null
  }
}
