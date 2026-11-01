# 运行时 API 参考（词典笔 S7）

本文记录当前代码实际使用、且有代码或设备依据的运行时能力。API 签名与调用方式以当前代码为准；设备行为中尚未复核的条目列在文末「真机复核状态」。

## 1. 环境

| 项 | 值 |
|---|---|
| appid | `8000200708310039` |
| `$dataDir` | `/userdisk/secondary/miniapp/data/mini_app/pkg/8000200708310039/data/` |
| 逻辑视口 | **1020 × 240（横向）**，`$falcon.env.deviceWidth/Height` |
| 截图 | `miniapp_cli capture <path>`（UI 合成画面，直接可看；熄屏时返回空白帧，用 `hal-screen on` 点亮） |

`$dataDir` 末尾自带 `/`，字符串中间可能出现连续斜杠；路径归一化走 [`src/utils/paths.js`](../src/utils/paths.js)。

## 2. 存储：裸模块 `storage`

`$falcon.jsapi` 是点号展平的 API 表，不是模块注册表；编译器把 `import x from '$jsapi/x'` 替换成 `$falcon.jsapi['x']`。**本项目不用它做存储**——storage 走裸模块 `import('storage')`（构建时外部化，运行时由模块加载器提供），封装在 [`src/utils/store.js`](../src/utils/store.js)：

- 模块成员：`getStorage / setStorage / getStorageKeys / removeStorage / clearStorage`（**没有 `getStorageInfo`**）。
- 首次使用前要确保 `<appdata>/data/storage` 目录存在，否则 `setStorage` 会失败（`store.js` 顶部有自愈逻辑）。
- 大值写入可用：512KB 写入+回读成功（约 90~270ms）；**但全部 key 落在同一个 `preferences.json`，
  每次 `setStorage` 都重写整份** —— 所以大表不放这里，走文件（`store/` 与 `lrc/`），
  落点与取舍见 [存储层.md](存储层.md)，封装在 [`src/utils/filestore.js`](../src/utils/filestore.js)。

音频/传感器同样走裸模块导入（`soundPlayer` / `global` 等）。

## 3. 网络：内建 `http`

```js
const m = await import('http')
const http = (m && m.default) || m
```

成员：`request / download / postFormData / on / off`。

| 调用 | 结果 |
|---|---|
| `http.request({url, method:'GET', headers})` | `{status, headers, body}` |
| `http.request({url, method:'POST', data})` | **原始 body 必须放 `data` 字段** |
| `http.request(..., body/params/form/raw/query)` | 发出空 body，别用 |
| `http.postFormData({url, data:{...}})` | multipart/form-data |
| `http.download({url, outPath})` | 文件落盘 |

- 大文件建议走 `process.exec` + 系统 curl（续传/进度/取消）；`http` 的实测速度、落盘时序与二进制边界见 3.1。
- 业务请求统一走 [`src/utils/net/request.js`](../src/utils/net/request.js)（Cookie 维护在同目录 `cookies.js`）。
- [`src/utils/log.js`](../src/utils/log.js) 为日志直接使用内建 http，是刻意例外：避免 `request → cookies → log → request` 递归，日志也不带业务 Cookie。

### 3.1 实测边界（S7，2026-10-17）

- `http.request` 的响应体按 C 字符串返回，**遇到第一个 NUL 就截断**：`AB\0CD` 只回 `AB`，首字节为 0 的图片回 0 字节，MP3 只回 `ID3\x03`。**只用于文本/JSON；图片/音频/protobuf 用 `download` 或 curl。**
- `http.download` 返回时文件可能还没 flush 完：1KB 首次 `stat`=0、4KB=0、4097B=4096、1MB=1044480，100ms 后完整。**读大小/校验前至少等 100ms 或轮询到稳定。**
- 速度取决于站点/CDN，不是固定上限：局域网 10MB `http.request` 7.5MB/s、`http.download` 9.2MB/s、curl 9.2MB/s；163 CDN 10.69MB `http.download` 3.4~6.2MB/s、curl 4.8~9.3MB/s；慢 HTTPS 站点三者 0.2~0.4MB/s。
- 分片在快链路上更亏：局域网 10MB 整文件 1.09s、4MB 片 2.56s、512KB 片（2 exec/片）4.61s；片数/连接数比片大小更关键。完整 5 轮数据见父工作区 `docs/fetch通道速度实测_2026-10-17.md`。

## 4. 音频：`soundPlayer`

```js
const { SoundPlayer } = await import('soundPlayer')
const sp = new SoundPlayer()
```

- `playFile(fileName, position, rate, interruptPowerOff, reportPosition)` → 任务 uuid
- `stop()` / `quickStop()` / `playOnlineAudio(url)` / `playMediaSection(paramDataJson)` / TTS 系列
- **无 pause / seek**：暂停 = `stop()`，续播/拖动/倍速 = `playFile(locator, 新位置, rate)`
- 事件是信号对象，必须 `.on(cb)` 订阅；属性赋值方式收不到回调
- `reportPosition=1` 时才持续上报位置；位置事件约每 50~60ms 一条
- SoundPlayer 是全系统单例、事件全服务广播：按 `playFile` 返回的 uuid 过滤
- 事件实参（当前固件实测）：
  - `mediaPlayerPositionChanged(uuid, ms)`
  - `mediaPlayerDurationChanged(uuid, ms)` —— **周期性重复上报**（与位置同频），不是一次性事件
  - `mediaPlayerEndChanged(uuid)` —— 单参
  - `mediaPlayerEndWithErrorChanged(uuid, code, sub, msg)` —— `stop()` 时也会派发（实测 `(uuid,2,0,"")` 等）
  - `mediaPlayerProgressChanged(uuid, n)` —— 语义未明（观察到 0/4 等小整数），不参与逻辑
- `playMediaSection` 的字段名是 **`fileName`**（不是 `url`）：`{fileName, position, endPosition, playBackRate, isInterruptPowerOff, reportPostion}`；`endPosition` 到点后位置停在终点、不再推进（实测 endPosition=4000 → 位置停在 4000ms）。

当前播放器实现见 [`src/utils/player/sound.js`](../src/utils/player/sound.js) 与 [`player.js`](../src/utils/player/player.js)。更细的定位/事件行为见 [`播放与定位能力.md`](播放与定位能力.md)。

## 5. 文件与路径

`fs` 裸模块：`exists / stat / statfs / readdir / readFile / mkdir / rm` —— **没有 writeFile**。

- 普通文件写入：`http.download({url, outPath})`；登录 Cookie / weapi 临时文件由 `wecurl` 通过 shell 重定向写。
- 下载引擎：`process.exec` + 系统 curl 写 `.part`，完成后由上层 promote。
- `fs.rm(path)` 可真删文件，删不存在的路径不抛异常；没有 `fs.unlink`。
- `fs.readdir` 当前固件返回**文件名数组（字符串）**；部分固件返回 `{name}` 对象，[`src/utils/fsutil.js`](../src/utils/fsutil.js) 兼容两种形状。
- `fs.statfs('/userdisk')` 的 `free/total` 语义可疑（可能 free > total），**可用空间用**：

```bash
df -k /userdisk | tail -1 | awk '{print $4}'
```

- 目录统计一次 exec 拿全：`ls -1 <dir> | grep -cE '[.](mp3|flac)$'` + `du -sk <dir> | cut -f1`；目录不存在时 du 的 KB 列可能是空串，解析要容忍。

## 6. 子进程 `process.exec` 与系统 curl

```js
const P = (await import('process')).default
const r = await P.exec('/bin/sh', ['-c', cmd], { timeout: 8000, maxBuffer: 262144 })
// -> { code, signal, stdout, stderr }
```

- **exec 不解析 shell 命令串**：`P.exec('echo hi')` 会把整串当可执行文件路径（code=127）；必须 `P.exec('/bin/sh', ['-c', cmd])`。
- 以 root 运行；`/bin/sh`、`curl`、`wget`、`busybox`、`dd`、`cat` 都在。
- 系统 curl 7.77.0 带 OpenSSL，支持 Range：`curl -r 0-262143` → 206；`-w '%{http_code} %{size_download} %{speed_download}'` 可取码/字节/速度。
- 续传：`-C -` 或按 `.part` 大小自己算 `-r` 起点；`-C -` 与 `-r a-b` 同用会丢掉范围终点，别混用。
- 低速与断线：`--speed-limit 49152 --speed-time 10`（低于 48KB/s 持续 10s → rc=28）、`--connect-timeout 8 --max-time 120`。

## 7. 网易云接口

搜索/直链/歌曲详情走明文 `/api/`；歌单详情、曲目批量详情、登录与写操作走 weapi。实现见 [`src/utils/ncm/`](../src/utils/ncm/)。

| 用途 | 接口 |
|---|---|
| 搜索 | `GET /api/search/get/web?s=&type=1&offset=&limit=`（支持拼音） |
| 直链 | `GET /api/song/enhance/player/url/v1?ids=[id]&level=<level>&encodeType=flac`（`level`/`encodeType` 均必需，见第 11 节） |
| 歌曲详情 | `GET /api/song/detail?ids=[id]`（封面 `album.picUrl`）；`/api/v3/song/detail?c=[{"id":…}]` 字段更全 |
| 歌词 | **一条明文请求全拿**：`GET /api/song/lyric/v1?id=&lv=-1&kv=-1&tv=-1&yv=-1`（明文匿名可用）。参数是必带的版本选择器（只带 id 则响应无歌词字段）：`lv`/`kv`/`tv` 选原文/卡拉OK/翻译组，`yv` 选逐字组（`yrc`/`ytlrc`/`yromalrc`），`-1` = 最新版；`lv/kv/tv` 带上后 `yrc` 无论 `yv` 取值都会返回。`pureMusic` 标记 v1 同样返回。**不需要 weapi**（2026-11-01 PC 匿名对照实测，勘误早先「明文无 yrc」的结论）。解析见 `utils/player/lyric.js` |
| 歌曲评论 | 读取：`GET /api/v1/resource/comments/R_SO_4_<songId>?limit=20&offset=0`（**明文，匿名可用**；回 `hotComments/comments/total/more`，只有 offset=0 带热门、热门与最新会重复）；点赞 / 发评论：`POST /weapi/v1/comment/like`、`POST /weapi/resource/comments/add`（weapi，未登录 code=301）。实现见 `utils/ncm/comments.js` |
| 歌单详情/曲目 | 经 `weapiPost` 转 `/weapi/v6/playlist/detail` 与 `/weapi/v3/song/detail` |
| 登录 | `POST /weapi/login/qrcode/unikey` 等（`utils/ncm/login.js`） |
| 喜欢/歌单写操作 | `POST /weapi/...`（`utils/ncm/weapi.js`、`playlist.js`） |

请求头需带 `User-Agent` + `Referer: https://music.163.com/`。直链有时效，需即时下载。歌单接口边界（1000 首内联上限、批量删除、404）见 [`歌单接口边界.md`](歌单接口边界.md)。

## 8. 输入法

`<input>` / `<textarea>` 元素在第三方应用里唤不起系统输入法；本项目不使用它们，统一走 `Global.startTextEdit`。

```js
const { Global } = await import('global')
const g = new Global()
g.textEditFinished.on(cb)
g.startTextEdit(JSON.stringify(cfg))
```

- 必须传 JSON 字符串；封装在 [`src/utils/systemKeyboard.js`](../src/utils/systemKeyboard.js)。
- 自绘键盘兜底已移除；`startTextEdit` 不可用时只提示。
- 网易云搜索接口直接支持拼音（`qingtian` → 晴天），不需要中文输入。

## 9. 应用与页面生命周期

- 退出应用：`$falcon.closeApp()`（`index.vue` 使用）。
- `App.onHide` 在**切到其他应用**时派发；`closeApp()` 退出时也会先派发一次 onHide，随后 `onDestroy`。可挂「退出前存盘」；注意 onHide 不能当「退出」用（切后台也会触发）。
- **app 级页面生命周期**：每个页面 `load / newOptions / show / hide / unload` 都会经 JS 框架 `_performPageLifeCycle` → `_performAppLifeCycle('onPageLifeCycle', { page, lifeCycle })` 调 `App.onPageLifeCycle`。本项目用它给导航层记账页面实例存活（见 [`页面导航.md`](页面导航.md)）。页面侧也可 `$page.on('show' / 'unload', cb)`。
- `$page` 原生对象提供 `on / off / setSupportBack / setAutoPop / moveToBack / setSupportTopPanel / setDisableLeftSwipeBack` 等；返回键接管与页面退栈用它。**页面跳转不要直接 `$falcon.navTo`**（平台对同名页是「弹掉上层 + 复用旧实例」），统一走 `utils/nav.js` 的 `go('<逻辑页名>')`。
- **滚动定位**：`$page.$dom.scrollToElement(ref, { offset, smooth })`（weex 同款 dom 模块）实测可用（S7，2026-10-18）：
  - `ref` 传模板 `ref` 拿到的组件（`this.$refs.x`，单例 ref）；滚动位置 = 元素内容顶部 + `offset`（px，1:1；`$falcon.env.deviceWidth = 1020`、viewport 未设置，故无缩放）。
  - 参数只有 `offset:int` 与 `smooth:bool`（反汇编 `DomModule::scrollToElement` 确认），`smooth` 缺省 false；内部布局脏时先 `tryLayoutImmediately` 再滚。
  - `offset` 传绝对值即等价于一次 `scrollTo`（队列页「前向展开后内容原地不动」实测目标 2428px 落地 2428px）；负值会被夹到 0。
  - 注意：**不要用 v-for 行的 ref 数组做锚点**——窗口滑动后平台会复用同 key 的行，`$refs` 数组顺序会混入旧窗口的行；用 v-for 之外的零高度单例锚点。
- `miniapp_cli` 常用：`install / uninstall / start / capture / injectKey / memoryApp / setRenderConfig`。截图用 `capture`；本项目不用 `captureFB`（原始帧缓冲，需额外解码）。
- 设备驱动：`miniapp_cli start <appid> <裸页名>` 的页名写裸名；**应用运行中页名同样生效**（实测 settings / queue / downloads 均可直接切页）；带 flag（如 `--settings`）会被当成页面文件名 → 黑屏。`injectKey` 不驱动 UI，遥控走 `/tmp/bpncm_cmd.log`。注意这里是**直接 navTo 页面 key**（绕过本项目导航层），只适合调试单页显示。

## 10. 原生库

当前不使用原生扩展库；构建不再打包 `.so`。

## 11. 音质与 FLAC

直链走 **v1 接口**（2026-10-22 起；老接口 `/player/url?br=` 已不再使用，它没有 hires 档）：

`GET /api/song/enhance/player/url/v1?ids=[id]&level=<level>&encodeType=flac`

| level | 回包（账号有该档权益时） |
|---|---|
| standard | mp3，约 3.5MB/首 |
| higher | mp3，约 5.2MB |
| exhigh | mp3，约 8.7MB |
| lossless | flac，25~32MB/首（回包 `d.br` 是实际码率，实测 ~947k） |
| hires | flac 24bit，体积按回包 `d.size` 为准 |

参数约束（PC 端 2026-10-22 实测：匿名免费歌 + 带黑胶 cookie 的 Hi-Res 曲目）：

- **`level` 和 `encodeType` 都是必需参数**，缺任一个回 `{"code":400,"msg":"参数错误"}`，且响应体是**两段拼接的 JSON**（`JSON.parse` 直接抛，调用方要吃掉）。
- `ids` 必须带方括号，`ids=123` 同为参数错误。
- 无权益时静默降级：匿名请求 `lossless`/`hires` 回 `type='mp3'`、`br=320000`、`code=200`。
- ⚠ **`d.level` 只是档位标签，不可靠**：带 cookie 请求 `level=hires` 回 `level='lossless'`；24bit 曲目（51.8MB、`br=1798863`）与 16bit 曲目（32.5MB、`br=797831`）**都标 `lossless`**。判「拿到什么」只能看 `d.type` + `d.br`；要辨 24bit 得解 flac STREAMINFO（本应用未做）。
- **`level=hires`、`level=lossless`、老接口 `br=999000` 返回同一个文件**（两首样本 size 与 CDN path 全同）：换 v1 不额外解锁 Hi-Res，旧接口本来就能拿到 24bit 资源；能不能拿取决于账号会员与曲目是否提供。
- 受限/VIP 歌匿名请求回 `code=-110`；老接口行为相同。

- 是否给 flac/hires 取决于账号权益与曲目：历史实测（老接口时代）非 VIP 账号 41 首登录态 + 221 首匿名全部降级为 mp3/320k。权益缺失时选「无损 / Hi-Res」只是每首歌多一到两次降级请求。
- flac 直链支持 Range 分片（206 + Content-Range 正确，尾片魔数 `fLaC`）。
- 播放器支持 flac 流：用 PC 自建支持 Range 的 flac 直链实测（20 秒文件，`DurationChanged=20000`，位置正常推进；从 5000ms 起播 4 秒后到 8823ms）。

## 12. EQ / 音效

当前没有可用的自由 EQ：

- 系统 HAL 有 EQ/DRC 后处理链，但只暴露 3 个开关与 6 个 DRC 数值，没有频段 EQ；改配置要 bind mount + 重启 SoundPlayer，未做。
- 官方 `mediaPlayer` 的 4 档 AI 音效需要重新引入其原生库并切换播放引擎；当前未采用。
- 设备自带 `ffmpeg` / `sox`，可通过 `process.exec` 离线转 WAV 实现应用内 EQ（旧评估实测 PCM 通路约 21× 实时），但播放链路要改成缓存优先，未实施。

## 13. 日志

- `console.log` 不会进 `/data/applog/YD_PEN_APP.log`。
- 应用日志走 [`src/utils/log.js`](../src/utils/log.js) 的 `log()`，POST 回 PC 的 `scripts/logserver.py`（默认 8888）。
- `console.warn` 会以 `console(<appid>).warn` 前缀进系统日志，可作兜底；远程回归脚本抽的就是它。
- 设备端日志地址在构建时注入：`BPNCM_LOG_SRV=http://<PC>:8888/log bash scripts/build.sh`；未注入时回环缺省，设备上静默失败。

## 14. 真机复核状态

当前设备固件已复核通过：

1. `miniapp_cli start` 页名：裸名生效（**含应用运行中**），带 flag 会被当页面文件名 → 黑屏。
2. SoundPlayer 事件实参：`(uuid, ms)` / `(uuid)`，`.on` 订阅稳定；DurationChanged 周期性重报。
3. `playFile(url, pos, rate)`：在线 60s 起播、1.5x 倍速生效。
4. 裸 `storage` 模块**没有** `getStorageInfo`；512KB 值写入+回读成功。
5. `fs.readdir` 返回字符串数组。
6. `playMediaSection` 用 `fileName` 字段，`endPosition` 到点自动停。
7. FLAC 直链 `playFile` 可播（自建支持 Range 的 flac 源验证；当前账号无 flac 回包）。
8. `position:absolute` 的 `top` / `left` / `right` / `bottom` 均可用。
9. 页面级 `v-if` 整体挂载/卸载含 slot 与不含 slot 的组件均正常渲染。
10. `App.onHide` 切后台派发；`closeApp()` 退出时也先派发。
11. `miniapp_cli capture`：亮屏前台实时；切到其他应用后截到当前前台应用；**熄屏（`screen_on=0`）时返回空白帧**（纯白，约 1KB）。

尚未复核：

- `playMediaSection` 自然播完时是否同时派发 EndChanged / EndWithErrorChanged（自动停已确认）。
- 远端列表 P2 不实施，`http.request` 拉 1.7MB JSON 不再复核。
