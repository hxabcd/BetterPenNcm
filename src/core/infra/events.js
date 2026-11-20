/**
 * 跨页事件（$falcon.on）的负载解包
 *
 * **框架会给事件负载套一层壳**：`FalconEvent.trigger(name, options)` 实际回调的是
 * `{type, timestamp, data: options || {}}`，不是 `options` 本身。实证两处：
 *   1) 厂商框架源码 `refs/aiot-packages/aiot-vue-cli/package/cli-libs/falcon-jsfm/dist/falcon-js-web.js`
 *      的 `trigger()`：`const data = { type: name, timestamp: Date.now(), data: options || {} }`
 *      然后 `listeners.forEach(l => l.callback(data))`；
 *   2) 设备端框架 `/etc/miniapp/resources/framework/jsfm-nvue.js.bin` 的字节码同构（Plan agent 反汇编核对）。
 *
 * 所以监听端一律要脱壳，否则 `trigger('x', 'A')` 拿到的是对象、字段全 undefined —— **静默失效**
 * （本项目 `bpncm:toast` 就曾因此显示成 `[object Object]`）。
 *
 * 用法：`$falcon.on('bpncm:xxx', function (evt) { const p = evtData(evt); … })`
 * 注意：**`trigger` 端不用改**（照常传字符串/对象），壳只出现在回调侧。
 */
export function evtData(evt) {
  if (evt && typeof evt === 'object' && evt.data !== undefined) return evt.data
  return evt
}

/**
 * 跨页事件负载是 JSON 字符串时的便捷解包：脱壳 + parse，失败给 null。
 * （本项目跨页事件约定传 `JSON.stringify({...})`，见 pages/plinfo 的 notify。）
 */
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
