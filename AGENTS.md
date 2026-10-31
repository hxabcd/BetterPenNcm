# AGENTS.md

This file provides guidance to AI Agent when working with code in this repository.

@../../AGENTS.md

> 上面导入的是**工作区级**指引（ADB、五区目录规范、qjs 逆向工具链）——该文件只在内部开发环境存在，公开克隆中可忽略；本文件只覆盖 BetterPenNcm 项目自身。

## 这是什么

有道词典笔 S7 上的自研网易云音乐客户端（QuickJS 小程序 + Vue 2 SFC）。appid `8000200708310039`。

- 页面入口 = `src/app.json` 的 `pages`；导航走 `utils/nav.js`（逻辑页 → 实例槽位，见 [`docs/页面导航.md`](docs/页面导航.md)）
- 运行时 API 与平台实测记录的索引见 [`docs/运行时API参考.md`](docs/运行时API参考.md)；引用其中结论时按 [`docs/文档维护规范.md`](@docs/文档维护规范.md) 核对对应证据
- 文档或注释任务（编写、核验、清理）先读 [`docs/文档维护规范.md`](@docs/文档维护规范.md)：以当前事实与当前意图为准，旧文档中的“用户定”归因和历史决策不作为依据
- 功能当前如何实现以代码和配置为准；注释只解释非显然的原因、约束或副作用，不代替实现事实

## 提交规范

- commit message 使用中文，遵循 Conventional Commits：`<type>(<scope>): <中文摘要>`。
- `type` / `scope` 保留英文（`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `build` / `perf` / `ci` / `revert`）；摘要与正文用中文。
- 示例：`fix(cover): 等待封面文件落盘后再交给 image`

## 分支与工作树

- **独立的新增功能与重构一律在独立工作树进行**，不在主工作树（`main`）上直接改：
  `git worktree add .agents/worktrees/<type>/<slug> -b <type>/<slug> main`
  （`.agents/worktrees/` 由其中的 `.gitignore` 整体忽略；分支名沿用 `feat/…`、`fix/…` 前缀）
- 在工作树内完成开发与自检（构建、`scripts/theme_verify.py` 等），按上方规范提交到该分支，不把半成品 merge 回 `main`。
- 完成后合回 `main`：先确认主工作树干净且与 `main` 同步 → `git merge --no-ff <type>/<slug>`（冲突在主工作树解决）→ 构建验证 → 清理：`git worktree remove .agents/worktrees/<type>/<slug>` + `git branch -d <type>/<slug>`。
- 文档与单文件小修不受此限，可直接在主工作树进行。

## 常用命令

> Git Bash 环境；adb 一律 `export MSYS_NO_PATHCONV=1`。需要 `-s` 时替换命令中的 `<设备序列号>`；`build.sh` 不访问设备，`install.sh` 直接调用 adb。仓库内不写具体序列号。

| 目的 | 命令 |
|---|---|
| 构建 | `bash scripts/build.sh` → `build/8000200708310039.<x_y_z>.amr` |
| 构建探针版（独立 appid） | `bash scripts/build_probe.sh`（默认 appid `8002026100500004`，入口 = `pages/probe`；脚本临时改 appid 后自动还原源码，不碰正式应用数据） |
| 构建+装机+截图 | `bash scripts/install.sh [等待秒数]`（截图 `shots/shot.png`） |
| 导航层真机自测 | `bash scripts/nav_selftest.sh`（探针构建 + 串行 go/close + 15 层深度压力 + 12 层内存采样，断言 `[nav]` 日志与栈快照；截图 `shots/nav_selftest.png`，不动正式应用数据） |
| 清互斥锁重来 | `bash scripts/build.sh --force`（`install.sh` 同理） |
| 收设备日志 | `python scripts/logserver.py`（PC 0.0.0.0:8888 → `device_log.txt`）；**设备端地址必须构建时注入**：`BPNCM_LOG_SRV=http://<你的PC>:8888/log bash scripts/build.sh` —— 未注入则发往 127.0.0.1、静默失败（默认发布形态） |
| 截图 | `install.sh` 内建 `miniapp_cli capture`，输出 `shots/shot.png`；直接查看，无需旋转/分帧。熄屏时返回空白帧，先 `hal-screen on` 点亮 |
| 重建图标 | `python scripts/gen_icons.py --preview`（需 ImageMagick 7 + Pillow） |

产物一律 `build/`、截图一律 `shots/`。

## 硬性约束

- **构建必须用便携 Node 18**（`tools/aiot-build/`，已在 build.sh 封装）；系统 Node 26 会让 aiot-cli 崩溃。
  该 exe 可能被安全软件拦成「无输出直接退出 1」——此时用 `BPNCM_NODE=<node.exe>` 指定替代（18 或 22 可用，26 不行）
- **构建/装机互斥**：已有实例在跑时第二个直接报错退出、不排队。确认无人运行时 `rm -rf .build.lock/`（或 `.install.lock/`）或加 `--force`
- **`miniapp_cli uninstall` 会清空整个 data 目录**：install.sh 在设备内暂存并恢复 `cookie.txt`、`storage/preferences.json`、`music/`、`covers/`、`store/`、`lrc/`；`cache/` 可再生，故意不备份（`store/` 与 `lrc/` 是拆分后的索引与歌词库，漏了会「有文件没索引」）
- 改版必须先 uninstall 再 install，否则跑的是旧实例
- 构建号写入生成物 `src/utils/buildInfo.js`（build.sh 生成，勿手改）并显示在首页顶栏，供核对设备版本
- 平台能力的统一入口（别再各写各的）：可写路径一律走 `src/utils/paths.js`；`process.exec`/`curl`/`du`/`stat` 等能力探测走 `src/utils/exec.js`；`import('fs')` 句柄与 `fileSize` 等小工具走 `src/utils/fsutil.js`；单步超时护栏 `raceTimeout` 走 `src/utils/util.js`；**共享的 UI 视觉常量走 `src/utils/ui/tokens.js`**（唯一值表，改值改它再跑 `scripts/gen_tokens.py --write`；JS 用 `TOK.xxx`、LESS 用生成段里的 `@xxx`）。颜色字面量由 `theme_verify.py` 第五道强制拦截；字号/尺寸目前不巡，仍按值表与评审维护
- **导航一律走 `src/utils/nav.js` 的 `go('<逻辑页名>')`**：不直接 `$falcon.navTo`、不写槽位 key、不传变量页名；参数用 `paramsFor()`。新增页面 / 调整层级见 [`docs/页面导航.md`](docs/页面导航.md)
- **注释里别写 `**/`**：`*/` 会提前闭合块注释，rollup 报错且行号指向注释后一行

## 结构

| 层 | 职责 |
|---|---|
| `src/pages/**` | 页面（见下表），除 probe 外根节点是 `<page-shell>` |
| `src/components/` | 可复用 UI：PageShell + NavRail（左操作栏与页面外壳，`.psh-body` 是浮层定位基准；左栏 60px 样式 2026-10-30 起全应用统一）、LyricPanel、NowLyric、各类行组件 |
| `src/components/player/` | 播放页专用（2026-10-29 按 Figma 设计稿重做）：ControlPanel（封面/切换键/标题歌手专辑/进度/控制；右列 2026-10-30 按 13:1335 改为 3:2:2:1.5:5）、LyricBoard、CommentPanel、TimerPanel、SeekPanel；布局/几何/接口见 [`docs/播放页.md`](docs/播放页.md) |
| `src/utils/player/` | 播放器与媒体：播放单例、下载引擎（**download.js 是门面**，内部拆为 source/files/progress/scheduler/tasks/fetcher，对外 API 不变）、curl 传输、下载/缓存两个目录与元数据、音质档位、历史、会话快照、歌词、本地库（localmeta.js）、**本地歌单索引/拉取同步（locallists.js）、下载归属标记（dlorigin.js）**、播放页几何常量、**定时播放单例（sleeptimer.js，跨页面存活、不持久化）** |
| `src/utils/ncm/` | 网易云：接口归一化、歌单、喜欢、每日推荐、**歌曲评论（comments.js：读明文匿名可用的 `/api/v1/resource/comments/R_SO_4_<id>`，点赞/发评论走 weapi）**、weapi 加密与登录（二维码 / 验证码 / 密码） |
| `src/utils/net/` | API 请求的唯一入口 + Cookie 维护；`src/utils/log.js` 为日志直连内建 http，是刻意例外（避免 request→cookies→log 递归、日志不带业务 Cookie） |
| `src/utils/`（其余） | boot（启动序列）、cover（封面缓存）、**artistavatar / artistmeta（歌手头像唯一来源与预热）**、**nav（导航层：逻辑页 → 实例槽位，见 [`docs/页面导航.md`](docs/页面导航.md)）**、rail、theme、config、format、touch、multidl、**util（raceTimeout/sleep）、fsutil（fs 句柄、读写文本文件走 shell）、exec（process.exec 能力探测）、paths（可写目录单一来源）、filestore（大表落文件 + 合并写）** |
| `src/assets/` + `scripts/gen_icons.py` | 图标 = Lucide SVG → PNG（平台不能给 `<image>` 染色，颜色必须生成进 PNG）；**`icons.js` 注册表是纯生成物**（`gen_icons.py --emit-js` 生成、`--check` 逐字节校验——别手改） |
| `src/styles/common.less` | 设计 token：颜色 / 字号阶梯 / 结构尺寸（1vh = 2.4px）；**令牌段是生成物**（源头 = `src/utils/ui/tokens.js`，生成/校验走 `scripts/gen_tokens.py`） |

多页面机制：`pages` 的每个 key 编成一个 `.falcon_/<key>.js.bin`，共享模块自动切 chunk；**跨页面 ES 模块是同一实例**，播放器等单例各页直接 import。app.json 里同一个 .vue 会注册多个 key：基础 key = **逻辑页名**，其余 = **实例槽位别名**（`list2`/`songinfo2`…，只编译成几百字节的 re-export）。页面代码只写逻辑页名，`utils/nav.js` 负责挑不在栈里的槽位再 navTo，从而得到标准 push/pop 语义（平台 navTo 对同名页是「弹掉中间层并复用旧实例」）。

### 左栏导航

- 页面根节点 `<page-shell :rail="rail" @rail="onRail">`；**返回不在 PageShell 里处理**（组件内 `this.$page` 不可靠），`@rail` 抛给页面；页面混 `pageFrameMixin` 后由它把 back 分派到 `onBack()`、上下文键分派到 `onRailKey()`
- 第一个槽位永远是返回：主页 = 退出应用（退出前暂停播放），其余页 = `this.$page.finish()`
- 其余槽位贴栏底、按页面上下文给，**最多 3 个**（返回 + 3 恰好等距排满 100vh）；多选态下返回键变 × 退出多选
- 槽位几何（浮窗要贴着某按钮时按此算）：返回 3.33~23.33vh；底部组最下一个 76.67~96.67vh，往上每个 −24.44vh
- **左栏样式是全应用统一的**（2026-10-30 起采用播放页设计稿：栏宽 25vh=60px、键 48×48/圆角 12px/`#242424`）：改 NavRail.vue 一处即全应用生效；播放页也走 PageShell/NavRail，没有单独的左栏组件

### 导航（页面栈）

- **跳转一律 `go('<逻辑页名>', params)`**（`utils/nav.js`）；不直接 `$falcon.navTo`、不写槽位 key（`list2` 等）、不传变量页名。菜单表驱动的跳转用字面量分支；`theme_verify.py` 第六道硬校验逻辑页 / 槽位 / app.json / 调用点一致性。
- **返回一律 `this.$page.finish()`**（`pageFrameMixin.onBack` 默认实现 = pop 一层）。
- **参数**在 `mounted` 里用 `paramsFor((this.$page && this.$page.$pageName) || '<逻辑页名>', this.$page ? this.$page.options : null)` 取一次；`onPageParams` 已删除（每次跳转都是新实例，不存在「复用页接新参数」）。
- **实例槽位**登记在 `utils/nav.js` 的 `PAGES` 表：`slots[0]` 必须与逻辑页同名，其余是 app.json 别名 key；槽位数按「可能同时存活的视图层数」给（list/songinfo/album/artist 6、playlists 4、部分页 2、叶子页 1）。连点（同一逻辑页 + 同一参数 500ms 内）会被 `go()` 合并；槽位耗尽时复用最上层同类实例并记 `degrade`（异常路径，正常不应出现）。
- **目的地页**（当前只有 `player`；根页 `index` 同理）标 `reuse: true`：已在栈中时按平台语义回退到它（不叠新层），页面代码侧无需特殊处理。
- **新增页面**：.vue → app.json 注册基础 key（需要叠层时再加槽位别名）→ `PAGES` 登记同名逻辑页 → `theme_verify.py` 通过。完整规则见 [`docs/页面导航.md`](docs/页面导航.md)。
- 跨页业务事件走 `pagebus`（注册栈）：页面栈上层优先处理，实例销毁后回落给下层。
- 导航日志 `[nav]`（go/push/reuse/dup-ignore/degrade、page-load/unload/options）走 logserver；真机自测用 `bash scripts/nav_selftest.sh`（含 15 层深度压力与 12 层内存采样）。

### 页面

| key | 说明 |
|---|---|
| index | 门户：横向卡片流（当前播放 / 每日推荐 / 我的歌单 / 本地下载 / 播放历史）+ 顶栏构建号 |
| playlists | 歌单列表，创建/收藏 pivot；亦作「添加到歌单」的选择页（选择态 = 同一逻辑页的第二层实例，槽位 `playlists2`，由导航层分配） |
| list | 曲目列表（歌单 / 搜索 / 歌手曲目 / 历史）：排序、播放全部、多选下载/删除 |
| songinfo / plinfo / artist / album | 歌曲信息 / 歌单详情 / 歌手 / 专辑 |
| player | 播放页（设计稿重做）：全局 60px 左栏 + 控制区（封面/三切换键/标题·歌手·专辑/进度/控制；右列 3:2:2:1.5:5）+ 480×240 子面板；默认空面板，三键各自开合，进度控制内含定时子页。**全局目的地页（`reuse`）：已在栈中时回退到它，不叠新层** |
| playeropts | 播放设置（倍速 / 歌词 / 退出时暂停等），与设置→播放共用；**音质不在此页** |
| queue | 当前队列，多选可移除 |
| settings | 设置索引页：个人中心 / 播放 / 音质与存储 / 个性化可跳转；关于为只读信息行 |
| setdl | 音质与存储：播放音质、下载音质、缓存上限、自动拉取、存储管理入口 |
| setlook | 个性化（背景色 / 主题色） |
| downloads | 本地下载总览：同主页的横向卡片流（歌单 / 歌手 / 专辑），点卡进分类页 |
| dlplaylists | 本地下载-歌单索引：全部下载 / 已索引歌单 / 单曲下载 / 遗留歌曲 |
| dltracks | 本地下载-曲目列表：kind=all/single/orphan/playlist；歌单内视图带拉取/同步与 A/D |
| dlartists | 本地下载-歌手：头像 + 名称 + 数量，左栏排序（标题/数量） |
| dlalbums | 本地下载-专辑：封面网格，左栏排序（标题/年份/数量）与列数（2/3/4） |
| dlqueue | 下载队列：进行中 / 排队中 / 已完成，可中断 |
| storage | 存储管理：已下载 / 自动缓存 / 封面 / 可用空间 + 清空 |
| account / login | 个人中心 / 登录（二维码 / 验证码 / 密码） |
| probe | 临时能力探针（仅 `build_probe.sh` 构建，不随正式版发布） |

## 平台坑（真机实测）

1. **样式只认单类名选择器**：复合选择器被丢弃 → 状态样式走内联 style 或独立完整类名
2. **嵌套 `<text>` 富文本会让渲染器崩溃** → 用并排的独立 text
3. **`<image>` 必须 `file://` 前缀**（裸路径黑块）；http 直链也可用
4. **页面 data 动态 key + `$set` 不触发重渲染** → 增量更新走组件自己的普通属性
5. **一次渲染 ≤50 行**，长列表分页加载
6. **页面会挂两遍**：mounted 初始化必须幂等
7. `$dataDir` 末尾自带 `/`；**`fs` 模块无写入接口**——普通文件写入走 `http.download({outPath})`，下载引擎通过 `process.exec` + 系统 curl 写 `.part`，登录 Cookie / weapi 临时文件由 `wecurl` 通过 shell 重定向写
8. 别名拆分只用 `/` `;` `；`（逗号顿号都不行）
9. **`border-radius: 50%` 不生效** → 圆形写等价 vh 值
10. **固定宽标签容器要按最长标签算宽度**：装不下会折行，把整块撑高并溢出
11. **浮层穿透**：遮罩挂关闭、内层面板挂空方法（平台无 `stopPropagation`）；互斥点击区各自挂 handler、共同父节点不挂
12. **无系统 dblclick**，双击自己用时间戳判定；**长按有原生 `@longpress`**（500ms，触发后不再走 click）
13. **浮层的绝对定位基准是 `.psh-body`**，遮罩只盖内容区、不盖左栏
14. **图标用 data-URI PNG**（`?base64` 导入被内联）；别改 SVG data URI
15. **触摸坐标字段因固件而异**（`utils/touch.js` 兜底）；拖动只用两点之差，坐标系无关
16. **`watch` 不去重**：依赖高频变化的 computed 的 watch 会被反复回调 → 带副作用的回调一律在入口自己判重
17. **绝对定位别用负偏移**（会被当 0 或被父容器裁）→ 父元素放大到最大子元素尺寸 + 子元素零偏移
18. **任何宽度 >100vh 都会被静默截到 100vh** → 超限一律写 px（1vh = 2.4px）或百分比（基准 ≈953px）；改完截图 + 像素扫描验证
19. **横向 scroller**：卡片必须显式 `width` + `height` 且**不写 `flex: none`**；竖向各段别贴满可用高度（取整会静默裁 1px）
20. **`flex: 1` 只在父容器高度确定时才有高度**，父高由内容撑出时塌成 0
21. **`<text>` 默认自动折行，`lines` 是「最多几行」**：要读完整就「scroller + 不写 lines」，要截断才写
22. **设备驱动**：`miniapp_cli start` 的页名写裸名（带 flag 会被当成页面文件名 → 黑屏）；应用运行中页名同样生效（实测可直接切页）；`injectKey` 不驱动 UI，遥控走 `/tmp/bpncm_cmd.log`
23. **截图用 `miniapp_cli capture`**（UI 合成画面，直接可看，无需旋转/分帧）；capture 跟随当前前台画面（切到其他应用后截到的是那个应用），应用切换瞬间可能拿到空白帧；**熄屏时返回空白帧**（`/tmp/.screen_state` 为 `screen_on=0` 即熄屏），截图前先 `adb shell hal-screen on` 点亮
24. **模板 `:x="x"` 是「取字段」不是调用**（字节码实证 `get_field`）：裸绑定的名字必须来自 props / computed / data（含 mixin 提供的）——**来自 methods 会拿到函数**：轻则静默失效（`:style="transStyle"`），重则子组件炸掉、整块 UI 消失（`pageFrameMixin.rail` 写进 methods → 取到函数，NavRail `slice` 直接炸，11 个页面左栏全没）。`theme_verify.py` 第四道按此硬判定
25. **平台 `navTo` 对已在页面栈里的同名页不新建实例**：会弹掉它上面的页面（销毁）、把旧实例挪回栈顶并只补发 `onNewOptions`（不重挂载）——页面代码按 push/pop 写就会「层级退回」。本项目用导航层（逻辑页 → 实例槽位）绕开：页面只调 `go('逻辑页名')`，**不要直接 `$falcon.navTo` / 不要写槽位 key（list2 等）**；`theme_verify.py` 第六道硬校验。详见 [`docs/页面导航.md`](docs/页面导航.md)

## 调试

- `console.log` **不进**设备日志 → 用 `utils/log.js` 的 `log()`（POST 回 PC 的 logserver）；排查前先确保 logserver 在跑，**且本次构建注入了 `BPNCM_LOG_SRV`**（见上表；缺省 127.0.0.1 在设备上连不通、静默失败）。远程回归不受影响 —— 脚本抽的是系统日志里的 `console.warn`
- 崩溃排查：设备 `/data/applog/YD_PEN_APP.log`（框架层）+ `device_log.txt`（应用日志，**崩前最后一条即断点**）
- **被框架吞掉的页面异常**只显示 `console().error: null`；`app.js` 已常备 `App.onError` + 覆盖 `$falcon.onAppError`，抛错以 `[app] onAppError: ...` 进日志
- **下载慢先查 WiFi 链路速率**（`iw dev wlan0 link` 的 rx bitrate）：这台笔须钉在 2.4GHz BSS，改配置走 `wpa_cli` + `save_config`，别直接编辑 `wpa_supplicant.conf`（会被回写覆盖）
- **自动化探针**：用 `bash scripts/build_probe.sh` 构建**独立 appid** 的探针版（入口 = `pages/probe`；脚本临时改 appid 后自动还原源码），安装/启动用产物的探针 appid，不会卸载或清空正式应用数据；用完 `miniapp_cli uninstall <探针appid>` 清理。探针日志同样走 logserver（构建时注入 `BPNCM_LOG_SRV`）；安装命令见脚本头部注释
- **导航层排查**：`[nav]` 日志（`go … (push|reuse|degrade)`、`page-load/unload`、`page-options`）走 logserver；返回落错层 / 页面被意外销毁时先看槽位与栈顺序；`bash scripts/nav_selftest.sh` 可在探针版上跑 push/pop 自测（不动正式应用数据）。详见 [`docs/页面导航.md`](docs/页面导航.md)
- 设备保持已登录；`$dataDir/cookie.txt` 与 storage 里有会话凭据，**日志/汇报中不要回显**

## 边界

- **下载**（用户主动）→ `music/`，永久保留，计入「本地下载」；**缓存**（边听边存）→ `cache/`，受缓存上限 LRU 滚动，不计入本地下载
- **后台 JS 会冻结**：切后台时下载跑完当前片就停，别承诺「后台继续下载」；应用退出后无后台，会直接关闭
- 退出登录会**删掉 `$dataDir/cookie.txt`**（否则 boot 会把会话灌回来）
- 歌曲列表的浏览方案：已用「加载更多」分页（渲染每批 50 首，网络游标见 `list.vue`）；列表内搜索仍待定
- 原生 `.so` 模块、官方虚拟列表等扩展方向未在当前代码中启用；`global` 已用于输入法与网络状态（`systemKeyboard.js` / `net/status.js`），其它能力动前先用探针页验证
