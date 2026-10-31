# 云音乐 · 词典笔版

有道词典笔 S7 上的网易云音乐客户端（QuickJS 小程序 + Vue 2 SFC），appid `8000200708310039`。

> 仓库内 appid 为作者自用配置；在自己设备上构建、安装或分发前，请确认该 appid 可用，或替换为自己的 appid。

## 功能

- 搜索：明文 `/api/` 接口；输入走系统输入法（`Global.startTextEdit`）
- 登录：二维码、验证码、密码（weapi 加密）；二维码确认可能被 8821 风控拦截，实际优先验证码，密码作为兜底
- 歌单：我的歌单、我喜欢、创建/收藏/重命名/删除、添加/移除歌曲
- 播放：本地文件与在线直链统一走 `playFile(locator, pos, rate)`；支持 seek、续播、倍速、列表循环/顺序/单曲/随机
- 歌词、播放历史、每日推荐
- 下载：四档音质（128k / 192k / 320k / 无损；无损是否可得取决于账号与曲目）；用户下载落 `music/`，边听边存落 `cache/`；下载队列、存储管理
- 主题：背景色与主题色；图标由 `scripts/gen_icons.py` 从 Lucide SVG 生成

## 技术栈

- 框架：有道词典笔小程序（QuickJS 20200705 字节码 + Vue 2 SFC），构建工具 `aiot-vue-cli`
- 网络：运行时内建 `http` 模块（curl 内核）；大文件走 `process.exec` + 系统 curl
- 音频：原生 `soundPlayer` 模块，裸导入 `import('soundPlayer')`
- 存储：裸模块 `storage`（`import('storage')`，字符串 KV）+ `http.download` 落盘（运行时 `fs` 无写入接口；Cookie/weapi 临时文件走 `wecurl`）

## 构建与装机

环境：Windows + Git Bash、便携 Node 18、`aiot-vue-cli`、adb 已连接词典笔。`scripts/build.sh` 默认从工作区 `tools/aiot-build/` 取 Node 与 CLI；独立克隆需把脚本顶部的 `NODE`/`CLI` 指向自己的便携 Node 18 与 `aiot-vue-cli`。自检（`theme_verify.py` / `gen_tokens.py`）需 Python 3；图标校验另需 Pillow，重建 PNG 还需 ImageMagick 7（`magick`）。

`build.sh` 会生成 `src/utils/buildInfo.js` 与 `src/utils/logconfig.generated.js`（均被 `.gitignore` 忽略）；新克隆在首次构建前不存在，直接跑 CLI 或 IDE 静态检查会报模块缺失。

```bash
# 构建 → build/8000200708310039.<x_y_z>.amr
bash scripts/build.sh

# 构建 + 卸载旧版 + 安装 + 启动 + 截图 → shots/
bash scripts/install.sh

# 可选：收设备日志到 PC（调试用）
python scripts/logserver.py     # 监听 0.0.0.0:8888，写 device_log.txt

# 设备端日志地址在构建时注入；不注入则发往 127.0.0.1，设备上静默失败
BPNCM_LOG_SRV=http://<你的PC>:8888/log bash scripts/build.sh
```

手动安装（Git Bash 下记得 `MSYS_NO_PATHCONV=1`）：

```bash
adb push build/8000200708310039.x_y_z.amr /userdisk/Favorite/
adb shell "miniapp_cli install /userdisk/Favorite/8000200708310039.x_y_z.amr"
adb shell "miniapp_cli start 8000200708310039"
```

改版后要先 `miniapp_cli uninstall 8000200708310039` 再安装，否则运行的是旧实例。`install.sh` 会在卸载前把 `cookie.txt`、`storage/preferences.json`、`music/`、`covers/` 暂存到设备内再恢复；`cache/` 可再生，不备份。

截图由 `install.sh` 调用 `miniapp_cli capture` 生成，直接得到可看的合成画面，无需旋转或分帧。capture 跟随当前前台画面；熄屏时返回空白帧，先执行 `hal-screen on` 点亮。

## 代码结构

```
src/app.json                    页面注册（每个 key 编译成一个 .falcon_/<key>.js.bin）
src/pages/<key>/<key>.vue       页面；入口页必须是 index
src/components/                 PageShell + NavRail + 歌词与行组件
src/utils/player/               播放单例、下载引擎（download.js 门面）、缓存、音质、会话、歌词
src/utils/ncm/                  网易云接口归一化、歌单、喜欢、weapi 加密与登录
src/utils/net/                  API 请求唯一入口 + Cookie 维护（log.js 为日志直连 http 的例外）
src/utils/ui/                   toast / arm / 多选 / 页面框架 / pagebus 的 mixin、视觉令牌
src/utils/                      boot / nav / theme / config / paths / exec / fsutil / 日志等
```

- 多页面共享模块是同一实例，播放器等单例由各页直接 import
- `download.js` 是下载门面，内部拆为 source / files / progress / scheduler / tasks / fetcher
- 是否编译只看 `src/app.json` 的注册

更细的约定与平台坑见 [`AGENTS.md`](AGENTS.md)，文档索引见 [`docs/README.md`](docs/README.md)。

## 已知边界

- 后台 JS 会冻结：切后台后下载跑完当前片就停，不承诺「后台继续下载」
- `fs` 模块无写接口；普通文件写入走 `http.download({outPath})`，下载引擎通过系统 curl 写 `.part`，登录 Cookie / weapi 临时文件由 `wecurl` 通过 shell 重定向写
- 播放缓存受「缓存上限」按播放顺序 LRU 滚动；用户主动下载永久保留，计入「本地下载」
- 应用退出后无后台，会直接关闭

## 许可与第三方

Copyright (C) 2026 BetterPenNcm contributors

本项目代码以 GNU General Public License v3.0（GPL-3.0-only）发布；完整文本见 [LICENSE](LICENSE)。第三方组件保留各自许可证：

- 界面图标来自 [Lucide](https://lucide.dev)（ISC License，© Lucide Icons and Contributors），SVG 原件见 `scripts/lucide-svg/`（含 LICENSE），由 `scripts/gen_icons.py` 栅格化为 PNG。
- 二维码生成使用 `src/vendor/qrcode.js`（QRCode for JavaScript，MIT License，© 2009 Kazuhiko Arase）。
