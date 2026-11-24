# BetterPenNcm

为有道词典笔重做的网易云音乐客户端（QuickJS 小程序 + Vue 2 SFC）。界面按词典笔的屏幕比例与触控操作重新设计，常用功能不缺席；已单独适配 **S7** 与 **X3S**，X5 适配即将推出。

> [!WARNING]
> 本项目是非官方第三方客户端，与网易云音乐官方无关，仅供学习与个人使用。

## 简介

功能不缺项的词典笔网易云客户端，界面专为小屏重做。

社区现存的大多第三方网易云客户端界面交互体验不尽人意，功能也只称得上够用。BetterPenNCM 不同：界面针对词典比比例与触控操作设计，优雅美观，易于操作。多选操作、歌单管理、评论查看、逐字歌词、定时播放……常用功能也一个不落。更支持下载歌曲本地索引，支持查看本地下载所属的歌单和歌手详情，即便没网也依旧从容。除此之外，还有更多功能即将推出，等你探索。

## 功能

### 账号与发现

- 登录：二维码、验证码、密码；二维码确认可能被风控拦截，实际优先验证码
- 搜索、每日推荐、播放历史、我喜欢的音乐
- 歌曲评论：查看、点赞、发表

### 播放

- 本地文件与在线直链统一走 `playFile(locator, pos, rate)`：seek、续播、倍速、列表循环 / 顺序 / 单曲 / 随机
- 播放队列，支持多选移除
- 定时播放（睡眠定时，可自定义时长）
- 逐字歌词与翻译；双击歌词行跳转到对应位置

### 歌单与列表

- 歌单：我的歌单、创建 / 收藏 / 重命名 / 删除、添加 / 移除歌曲
- 列表多选：批量下载、批量删除
- 长按歌曲行进入歌曲详情

### 下载与本地

- 音质档位：标准（128k）、较高（192k）、极高（320k）、无损、Hi-Res；高码率能否拿到取决于账号与曲目
- 下载队列、缓存上限、存储管理
- 本地索引：下载内容按歌单 / 歌手 / 专辑归类；歌单详情页可为本地歌曲建立索引
- 断网时仍可浏览并播放已下载的歌曲

### 界面

- 左栏导航 + 播放页三栏布局；背景色与主题色可换
- 图标由 Lucide SVG 生成，样式令牌统一维护

## 适配设备

| 设备 | 状态 | 说明 |
|---|---|---|
| S7 | 已适配 | 当前主力机型 |
| X3S | 已适配 | RK3566，页面视口 800×254；由原生扩展补齐 `fs` / `http` / `exec` / `sqlite3` |
| X5 | 计划中 | — |
| 其他 | 欢迎适配 | 提交 PR 或 Issue 说明机型与能力 |

X3S 的适配细节、原生扩展与真机验证清单见 [`docs/X3S适配.md`](docs/X3S适配.md)。

## 操作提示

- **长按**列表中的歌曲行 → 进入歌曲详情
- **双击**歌词行 → 跳转到该句
- 歌单详情页 → 可为本地歌曲添加索引

## 路线图

- 心动模式
- 「声音」播放
- 系统播控集成
- X5 适配

## 构建与运行

项目用 `aiot-vue-cli` 打包成 `.amr` 小程序包。构建需要：

- **Node 18**（22 可用；26 会让 aiot-cli 崩溃）
- `aiot-vue-cli`
- Python 3（生成构建期常量、跑自检）
- bash（Git Bash）；装机与截图另需 `adb` 与词典笔

仓库不包含便携 Node 与 `aiot-vue-cli`。`scripts/build.sh` / `scripts/install.sh` 是作者工作区 `devctl` 工具链的薄壳；独立克隆可直接手动构建：

```bash
# 1) 生成构建期常量（buildInfo.js / logconfig.generated.js，均不入库）
python scripts/gen-buildinfo.py

# 2) 在项目根执行 aiot-cli，产物为 *.amr
node /path/to/aiot-vue-cli/src/cli.js -c -q -p
```

> `buildInfo.js` 与 `logconfig.generated.js` 被 `.gitignore` 忽略，新克隆缺它们时 IDE / 静态检查会报模块缺失，所以首次构建前必须先跑 `gen-buildinfo.py`。

若使用作者的 `devctl` 工具链：

```bash
# 构建 → build/8000200708310039.<x_y_z>.amr（自动先生成构建期常量）
bash scripts/build.sh

# 装机：推包 + install + start（内建互斥锁；不等就绪、不校 md5、不截图）
bash scripts/install.sh

# 装完要看画面：单独截图
devctl capture /tmp/shot.png
```

手动安装（Git Bash 下记得 `MSYS_NO_PATHCONV=1`）：

```bash
adb push build/8000200708310039.x_y_z.amr /userdisk/Favorite/
adb shell "miniapp_cli install /userdisk/Favorite/8000200708310039.x_y_z.amr"
adb shell "miniapp_cli start 8000200708310039"
```

同 appid 覆盖安装会保留应用 data（登录态、设置、下载）；`devctl install --fresh` 才会先卸载并清空。截图不在 `install.sh` 里：`devctl capture` 给出可直接观看的合成画面，熄屏时先点亮屏幕。

调试日志走 PC 上的 logserver，且**设备端地址必须在构建时注入**，否则静默发往 `127.0.0.1`：

```bash
python scripts/logserver.py                                  # 监听 0.0.0.0:8888 → device_log.txt
BPNCM_LOG_SRV=http://<你的PC>:8888/log bash scripts/build.sh  # 注入日志地址后重新构建
```

手动构建时，在跑 `gen-buildinfo.py` 前设置同一个 `BPNCM_LOG_SRV` 即可；也可以直接用 `--log-srv` 参数。

自检（提交前建议全跑）：

```bash
python scripts/theme_verify.py
python scripts/gen_tokens.py
python scripts/gen_icons.py --no-fetch --check
```

## 代码结构

```
src/app.json                    页面注册（每个 key 编译成一个 .falcon_/<key>.js.bin）
src/pages/<key>/<key>.vue       页面；入口页为 index
src/components/                 PageShell / NavRail / 列表行与卡片 / 播放页子面板
src/services/player/            播放单例、下载引擎、缓存、歌词、历史、本地索引、定时播放
src/services/ncm/               网易云接口归一化、歌单、喜欢、推荐、评论、weapi 与登录
src/services/cover/             封面获取与缓存、取色、歌手头像
src/core/infra/                 boot / nav / net / paths / log / store / util
src/core/platform/              db（SQLite）、exec、bridge、audio、输入法、触摸
src/ui/                         视觉令牌、主题、mixin
native/ + libs/                 X3S 原生扩展（bpnnet + sqlite3）源码与产物
scripts/                        构建 / 装机 / 自检 / 图标与令牌生成
docs/                           专题文档索引
```

- 多页面共享模块是同一实例，播放器等单例由各页直接 import
- 页面跳转统一走 `src/core/infra/nav.js`，页面代码不直接调用平台 `navTo`
- 下载引擎以 `services/player/download.js` 为门面，内部拆为 source / files / progress / scheduler / tasks / fetcher
- 是否编译只看 `src/app.json` 的注册

更细的约定与平台坑见 [`AGENTS.md`](AGENTS.md)，文档索引见 [`docs/README.md`](docs/README.md)。

## 已知边界

- 后台 JS 会冻结：切后台后下载跑完当前片就停，不承诺「后台继续下载」；应用退出后无后台，会直接关闭
- 平台 `fs` 模块无写接口：结构化数据统一进 SQLite，下载文件由系统 curl 写入，二进制资源走 `http.download`
- 播放缓存受「缓存上限」按播放顺序 LRU 滚动；用户主动下载永久保留，计入「本地下载」
- 与所有第三方网易云客户端一样，接口可能随官方调整而失效；登录二维码也可能被风控拦截，此时优先用验证码或密码

## 许可与第三方

Copyright (C) 2026 BetterPenNcm contributors

本项目代码以 GNU General Public License v3.0（GPL-3.0-only）发布；完整文本见 [LICENSE](LICENSE)。第三方组件保留各自许可证：

- 界面图标来自 [Lucide](https://lucide.dev)（ISC License，© Lucide Icons and Contributors），SVG 原件见 `scripts/lucide-svg/`（含 LICENSE），由 `scripts/gen_icons.py` 栅格化为 PNG。
- 二维码生成使用 `src/vendor/qrcode.js`（QRCode for JavaScript，MIT License，© 2009 Kazuhiko Arase）。

## 参与贡献

欢迎提交 Issue 与 PR：机型适配、UI 建议、问题反馈都可以。如果这个项目对你有帮助，欢迎给个 Star 支持一下。
