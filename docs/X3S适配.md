# X3S 机型适配

2026-11-22 起在 X3S（RK3566「CHERRY」，固件 `DictPen_APP 3.4.5`）上适配。设备硬件与
系统事实见工作区 [`docs/词典笔X3S_设备事实与能力_2026-11-22.md`](../../../docs/词典笔X3S_设备事实与能力_2026-11-22.md)，
小程序 API 面见 [`docs/词典笔X3S_小程序运行时API清单_2026-11-22.md`](../../../docs/词典笔X3S_小程序运行时API清单_2026-11-22.md)；
本文只落**本仓库的结论与实现**：当前能在 X3S 上跑到哪、靠什么补的能力、UI 改了哪里、
还剩什么没验证。

> 设备名：工作区工具链 `devctl --device x3s`（config `[devices.x3s] adb:<设备串号>`）。
> 本项目默认设备仍是 S7；在 X3S 上开发时用项目级 `.dictpen-dev.toml` 写 `device = "x3s"`
> （文件不入库），或命令里 `BPNCM_DEVICE=<串号>`。

## 一、两条关键事实（别照抄工作区 API 文档的字面值）

### 1. 页面视口是 800×254，不是 800×480

- `$falcon.env` 只有 `deviceWidth=800` / `deviceHeight=480`（**物理面板尺寸**，X3S 是
  480×800 竖屏，运行时旋转 90°）。
- 小程序**页面布局视口**由 `/etc/miniapp/resources/cfg.json` 的 `800×254 / yoffset 113`
  决定：在 480×800 面板中间渲染一条 800 宽的横条。真机 `miniapp_cli capture` 输出就是
  **800×254**；首页按 `1vh = 2.54px` 渲染（左栏 25vh≈63.5px，与截图一致）。
- 这与 X5 的页面视口同族（X5 也是 800×254）。**UI 适配按 800×254 做**，不要按
  480 高设计；否则整套 vh 会放大一倍。

### 2. 四个能力裸模块在 X3S 上不存在

| 能力 | S7 | X3S |
|---|---|---|
| `fs` 裸模块 | 有（无写接口） | **没有**（import 抛 `could not load module filename`） |
| `http` 裸模块 | 有 | **没有**（只有 `$falcon.jsapi['http.*']`，未验证参数形状） |
| `process` / `process.exec` | 有 | **没有**（没有子进程 API） |
| `sqlite3` 裸模块 | 有 | **没有** |
| `soundPlayer` / `global` | 有 | **有**（soundPlayer 8 方法 / 5 信号，事件名与 S7 同） |
| 设备自带库 | — | `libcurl.so.4`、`libsqlite3.so.0`、`libquickjs.so` 齐全 |

因此不能直接复用 X5 的「点号 jsapi」方案（没有文件写、没有 sqlite、下载无法落盘到指定目录），
走 **原生扩展** 补齐（见下节）。

## 二、能力适配：原生扩展 libjsapi_bpnnet.so

X3S 的 libfalcon 支持 `libs/<平台>/libjsapi_*.so` 扩展（官方应用同款）；`libs/arm64-cherry3566/`
是本机平台目录。扩展由 `dynamic_load_jsapi` 加载后调用 `custom_init_jsapis()`，注册：

| 裸模块 | 能力 | 本仓库 JS 侧接线 |
|---|---|---|
| `bpnnet` | fs exists/stat/readdir/readText/writeText/mkdir/rm/rename；libcurl request（**收响应头**，Cookie 会话可维护）/ download；fork + `/bin/sh -c` exec（带超时强杀） | `src/core/platform/bridge.js`；`request.js` / `log.js` / `fsutil.js` / `exec.js` 先试原生模块，import 失败才回退 |
| `sqlite3` | `Database(open/exec/prepare/close)`、`Statement(bind/run/all/columnNameList/finalize)`，与 S7 原生模块同形状 | `src/core/platform/db.js`（接口零改动；SQL 侧有 3.21 兼容修正，见下） |

- 产物与构建：`native/`（C 源码 + `build-aarch64.sh`，zig 交叉编译 aarch64/glibc 2.29；
  产物已入库，日常 `scripts/build.sh` 不需要 zig）。详见 [`native/README.md`](../native/README.md)。
- 兼容性：`.so` 是 aarch64，S7/X5 是 armhf，动态加载器不会加载；那边的 `import('bpnnet')`
  抛错 → `bridge()` 返回 null，全部走原生模块，行为与改动前一致。
- **SQLite 版本差异（能力适配的隐藏坑）**：X3S 的 `/usr/lib/libsqlite3.so.0` 是 **3.21.0**
  （2017），不支持 UPSERT（`INSERT ... ON CONFLICT ... DO UPDATE`，3.24+）。真机表现：
  下载成功、`track_meta`/`track_lyric` 正常，但 `[db] 写索引库失败：near "ON": syntax error`，
  `local_index.db` 的 track/artist/album 全空，「本地下载」显示 0 首。
  已把 `db.js` 的 `upsertSql` 改成 `INSERT OR IGNORE` + `UPDATE`（等价语义、S7 兼容），
  并在 `theme_verify` 第一道钉住；`replaceRowsSql` 的 `INSERT OR REPLACE` 本来就兼容 3.21。
- 为什么不用 `$falcon.jsapi` 的 http/storage：`http` 只够点式请求，登录/评论要保响应头
  Cookie，下载要指定落盘路径；`storage.*` 的容量与性能未验证，且现有存储模型是 SQLite
  两库（state.db / local_index.db），用原生 sqlite3 才能零改动复用 db.js 与上层全部逻辑。

## 三、音频：默认静音 + 输出路径 OFF

X3S 的 ALSA 混音器默认 `Master Playback Volume=0`（−50 dB）、`Playback Path=OFF`；
`volume` 模块的 `setVolume()` 实测返回 undefined 且不改 ALSA。`SoundPlayer.playFile`
本身能播（事件、时长、结束都正常），但必须先把混音器打开：

- `amixer -c 0 cset numid=3 150,150`（Master 是 2-value 原始控制，不能用 `sset` 名字）
- 仅在 `Playback Path` 为 `OFF` 时切 `SPK`（已插耳机/蓝牙时不覆盖系统选择）
- 实现：`src/core/platform/audio.js` 的 `ensureOutput()`，`sound.js` 的 `playFile` 前调一次
  （懒加载 + 缓存；`import('volume')` 失败即非 X3S，直接 no-op，S7/X5 零影响）

## 四、UI 适配

- **播放页**：三列 63.5+480+480 在 800 宽下装不下 → 控制区铺满 736px（左列 172 / 右列 564），
  辅助面板改为右侧抽屉（480 宽、`subBg`、左圆角，点遮罩/再点同键收回），进页默认焦点态。
  与 X5 同方案；实现见 `src/pages/player/player.vue`、`src/components/player/ControlPanel.vue`、
  `src/services/player/layout.js` 的 `isNarrow()` / `vhPx()`。
- **其它页面**：布局全部基于 vh/百分比，随 800×254 自动缩放；2026-11-22 逐页截图核对
  index / settings / account / login / storage / setdl / setlook / downloads / dlplaylists /
  dlalbums / dlartists / dlqueue / queue / playeropts / playlists，均无溢出裁切。
- `isNarrow()` 判定：env 优先 `screenWidth/screenHeight`，其次 `deviceWidth/deviceHeight`；
  宽度 ≤900 时页面高按 254、`1vh=2.54px`。S7（1020）走原值 2.4px，行为不变。

## 五、构建与装机

```bash
# 1) 项目级设备覆盖（本地文件，不入库）
printf 'device = "x3s"\n' > .dictpen-dev.toml

# 2) 构建（Linux 主机的系统 Node 26 会崩 aiot-cli；用便携 Node 18 或指定 DPD_NODE）
DPD_NODE=/path/to/node18 bash scripts/build.sh
# 产物 build/8000200708310039.<version>.amr，libs/arm64-cherry3566/ 会一起打包

# 3) 装机（覆盖安装，data 保留；--fresh 才会清 data）
bash scripts/install.sh --no-build --wait 15

# 4) 截图（X3S 熄屏时先点亮屏幕：miniapp_cli capture 拿空白帧）
devctl --device x3s run -- 'echo 0 > /sys/class/backlight/backlight/bl_power; echo 128 > /sys/class/backlight/backlight/brightness'
devctl --device x3s capture /tmp/x3s.png
```

改 C 源码后重建扩展：`bash native/build-aarch64.sh`（见 `native/README.md`）。

## 六、2026-11-22 真机验证清单

| 项 | 结果 | 证据 |
|---|---|---|
| 构建 / 安装 / 启动 | ✓ | `bash scripts/install.sh --no-build`（`.dictpen-dev.toml` = x3s），`miniapp_cli memoryApp` 见 App(8000200708310039) |
| 首页渲染 | ✓ | 800×254 截图：顶栏/左栏/横向卡片正常 |
| 所有页面截图 | ✓ | 15 个页面逐页启动截图无裁切（播放页改抽屉后） |
| 存储目录 | ✓ | applog `[boot] 存储目录 downloads=true cache=true thumbs=true` |
| sqlite3 两库 | ✓ | `[db] 状态库就绪 state.db` / `索引库就绪 local_index.db`；设备上 `sqlite3 state.db .tables` 见 kv/track_meta/track_lyric |
| fs / exec / http 桥 | ✓ | 自检 `fs=true proc=true http=true`；`echo hi` code=0；music.163.com status=200 body 144245 |
| weapi + Cookie | ✓ | 二维码登录 `unikey` 创建成功（code=200）；响应 set-cookie 的 `NMTID` 进会话 |
| 音频出声 | ✓ | 设混音器后 `SoundPlayer.playFile` 3 秒样本，`/proc/asound/card0/pcm0p/sub0/status` = RUNNING，时长事件 3239ms |
| curl 下载引擎 | ✓ | `fetchToFile` 下 52,079 B 整文件成功（`{ok:true,size:52079,mode:"whole"}`，rc=0），进度轮询与 `.part` 落盘正常 |
| 在线 URL 起播 | ✓ | `playFile(https://…mp3)` 起播，时长事件 3239ms；结束/错误语义（error 2）待复核 |
| 封面取图/显示 | ✓ | 搜到曲目后 `downloads/<id>/cover.jpg` 落盘，首页「正在播放」卡与播放页封面正常显示 |
| 状态持久化 | ✓ | 播放快照写入 `state.db` 的 `kv`（447 B），重进页面恢复当前曲/标题/歌手/专辑/时长 |
| 完整下载 + 本地库 | ✓ | 免费曲 139774 下载 8.94MB + cover.jpg + 歌词 680B；`track_meta`(kind=1)、`local_index.db` 1 track/1 artist/1 album（修掉 3.21 UPSERT 后） |
| 本地库页面 | ✓ | downloads / dlplaylists / dltracks / dlalbums / dlartists / storage / queue 均出真实数据（8.6MB、1 首、1 张专辑、1 位歌手、1.2GB 可用） |
| 播放（在线/免费曲） | ✓ | `resolveUrl` 得直链（m801.music.126.net），`player.playList` 后 `isPlaying=true`，播放缓存 10.3MB |
| 播放页抽屉三面板 | ✓ | 右侧抽屉打开评论（43 条、头像/点赞/发布按钮）、歌词（纯音乐提示）、进度控制（0:00/4:17、±5/±30s）均正常 |
| 播放页抽屉布局 | ✓ | 控制区铺满 736px，右侧无裁切（抽屉默认收起；打开态的样式与 S7 子面板同源） |

## 七、未验证 / 待办

- **触摸**：X3S 上真实点击（左栏、抽屉、列表行）未逐项验证。已试两条注入路径均未打通：
  ① 自建 uinput 虚拟触摸屏（libinput/udev 能识别为 touchscreen，但 miniapp 不读它）；
  ② 直接 write `/dev/input/event5`（write 返回成功，但界面无反应）。
  页面/抽屉的显示与数据已用「临时把默认 `sub` 设为 comment/lyric/seek」逐项截图验证，
  交互命中仍需真实手指或找到系统输入转发通道后补测。
- **登录**：二维码 unikey/ Cookie 链已通，但「手机扫码 → 登录成功 → 拉取用户信息」未走完
  （需要人工扫码）；验证码/密码登录同理。另：匿名搜索可用，但 VIP 曲目无直链（平台限制，
  不是适配问题）。
- **下载全流程**：免费曲已跑通「解析直链 → 下载 → cover/歌词 → track_meta → 本地索引」，
  登录态/VIP 曲目仍未验（VIP 无直链是平台限制）；`.part` 续传、取消/重试、封面缓存 LRU
  及「下载一首歌后自动拉取/歌单归属」待补。
- **封面取色**：`ffmpeg` 在 X3S 上存在且可执行，但 `cover/color.js` 的实际取色输出未截图核对。
- **歌词/评论**：接口请求走 bridge 应可用，页面未在 X3S 上打开有内容的数据验证。
- **存储**：缓存上限 LRU、`du`/`df` 空间统计、`/userdisk` 仅剩 1.3G 时的空间预检文案待核对。
- **后台/熄屏**：X3S 的 `S99input-event-daemon` 有 270s 熄屏、600s 休眠；应用切后台冻结行为与 S7 是否一致未测。
- **X5**：本次只在 X3S 上验证；X5 分支的 armhf `.so` 未合入，X5 仍走 `feat/x5-adapt` 的旧方案。
