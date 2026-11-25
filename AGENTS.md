# AGENTS.md

This file provides guidance to AI Agent when working with code in this repository.

@../../AGENTS.md

> 上面导入的是**工作区级**指引（ADB、五区目录规范、qjs 逆向工具链）——只在内部开发环境存在，公开克隆中可忽略。
> 本文件只留「不查就会踩」的项目事实与入口；细节按最后一节进 `docs/`。改文档或注释前先读 [`../../DOCS_SPEC.md`](../../DOCS_SPEC.md)。

## 这是什么

有道词典笔 S7 上的自研网易云音乐客户端（QuickJS 小程序 + Vue 2 SFC），appid `8000200708310039`；2026-11-22 起适配 **X3S**（RK3566，视口 800×254，能力靠原生扩展补齐，见 [`docs/X3S适配.md`](docs/X3S适配.md)）。

- 页面入口 = `src/app.json` 的 `pages`；导航只写逻辑页名，走 `src/core/infra/nav.js`（[`docs/页面导航.md`](docs/页面导航.md)）
- 平台渲染/模板绑定/导航的硬约束见 [`docs/平台约束与自检.md`](docs/平台约束与自检.md)；运行时 API 见 [`docs/运行时API参考.md`](docs/运行时API参考.md)
- **注释只写代码说不清的事**：外部事实（平台行为、真机实测数字、接口边界）和别人会踩的坑。代码本身能表达清楚的——包括「为什么这么做」的推理——不写成注释；该改的是代码
- 实现以代码与配置为准；文档只写当前事实与当前意图

## 提交规范

- commit message 用中文 Conventional Commits：`<type>(<scope>): <中文摘要>`（`type`/`scope` 英文，摘要与正文中文），例 `fix(cover): 等待封面文件落盘后再交给 image`
- **提交被钩子拒了**（`scripts/githooks/pre-commit`：单文件 >5000 token ≈ 20KB）→ 照报错把文件按功能拆开再提交，别靠压注释/合并行糊过去
- **写新函数、新规则前先搜仓库里有没有现成的**：多数领域（音质、缓存上限、路径、分页、选择集、曲目归一）都已经有唯一出处，新建第二份就是下次「改东忘西」的起点

## 分支与工作树

- 新功能与重构一律在独立工作树：`git worktree add .agents/worktrees/<type>/<slug> -b <type>/<slug> main`（目录已整体忽略）；在里面自检（构建、`scripts/theme_verify.py`）后提交，完成后 `git merge --no-ff` 回 `main`、再 `git worktree remove` + `git branch -d`
- 文档与单文件小修可直接在主工作树

## 常用命令

> 设备操作统一走工作区工具链 `devctl`：除非用户明确要求，禁止直接用 adb / ssh / scp；本项目的 `install.sh` / `shot.sh` 内部已接传输层，命令行无需（也不该）指定连接方式。

| 目的 | 命令 |
|---|---|
| 构建 | `bash scripts/build.sh` → `build/8000200708310039.<x_y_z>.amr` |
| 构建+装机 | `bash scripts/install.sh`（推包 + install + start，内建互斥锁；不等就绪、不校 md5、不截图） |
| 探针版构建（独立 appid） | `bash scripts/build_probe.sh`（入口 `pages/probe`，不碰正式应用数据；用完 `miniapp_cli uninstall` 清） |
| 一次性设备命令 / 截图 | `devctl run '...'` / `devctl capture /tmp/shot.png`（或 `bash scripts/shot.sh` → `shots/shot.png`） |
| 收设备日志 | `python scripts/logserver.py`（PC `0.0.0.0:8888` → `device_log.txt`）；**设备端地址必须构建时注入**：`BPNCM_LOG_SRV=http://<PC>:8888/log bash scripts/build.sh`，未注入则发 127.0.0.1、静默失败 |
| 导航层真机自测 | `bash scripts/nav_selftest.sh`（探针版 push/pop + 深度压力，断言 `[nav]` 日志） |
| 清残留锁重来 | `bash scripts/build.sh --force` / `bash scripts/install.sh --force`（锁在 `tools/dictpen-dev/dpd/lock.py`） |
| 重建图标 | `python scripts/gen_icons.py --preview`（需 ImageMagick 7 + Pillow） |

产物一律 `build/`、截图一律 `shots/`。传输层契约、日志、崩溃排查、设备驱动与截图坑见 [`docs/调试与设备操作.md`](docs/调试与设备操作.md)。

## 硬性约束

- **构建必须用便携 Node 18**（`tools/aiot-build/`，`scripts/build.sh` 是薄壳、没有 Node 路径可改）：系统 Node 26 会让 aiot-cli 崩；便携 exe 被安全软件拦成「无输出退出 1」时用 `BPNCM_NODE=<node.exe>` 或 `DPD_NODE=` 指定替代（18/22 可用）
- **构建与装机互斥**：已有实例在跑时第二个直接报错退出、不排队；确认无人运行再加 `--force` 清锁接管
- **更新应用直接 `install` 覆盖**：同 appid 直接装，data（登录态、设置、下载）原样保留；**`--fresh` 与 `miniapp_cli uninstall` 会清空整个 data**，只在彻底重置时用
- **设备临时文件写 `/tmp`**（tmpfs，重启自清）；`/tmp` 放不下的大文件才落 `/userdisk`；持久文件只进 `/userdisk/path/` 等既有子目录
- **平台能力统一入口，别再各写各的**：可写路径 → `src/core/infra/paths.js`；文本/结构化数据 → `src/core/platform/db.js`（原生 `import('sqlite3')`，索引库与状态库的分工见 [`docs/存储重构.md`](docs/存储重构.md)）；`process.exec`/`curl`/`du`/`stat` → `core/platform/exec.js`；`import('fs')` 与 `fileSize` → `core/platform/fsutil.js`（**没有写函数**）；超时护栏 `raceTimeout` → `core/infra/util.js`
- **不要用 shell 重定向写文本文件、不要用 `sqlite3` CLI**：一次 exec = 一次 fork（真机 92~139ms），超 60KB 还要分片；CLI 还会把 SQL 经代码页转成 GBK、中文变乱码。134KB 快照实测 2511ms，改走 SQLite 后 10ms
- **视觉常量只走 `src/ui/tokens.js`**（改值 → `scripts/gen_tokens.py --write`；JS 用 `TOK.xxx`、LESS 用生成段里的 `@xxx`）；颜色字面量由 `theme_verify.py` 第五道拦，分层方向（R1-R6）由第七道拦
- **导航只 `go('<逻辑页名>', params)`、返回只 `this.$page.finish()`**：不直连 `$falcon.navTo`、不写槽位 key（`list2` 等）、不传变量页名；`theme_verify.py` 第六道硬校验
- **注释里别写 `**/`**：`*/` 会提前闭合块注释，rollup 报错且行号指向注释后一行

## 结构

| 层 | 职责 |
|---|---|
| `src/pages/**` | 页面（key 与职责见 [`docs/页面导航.md`](docs/页面导航.md)「页面一览」），除 probe 外根节点是 `<page-shell>` |
| `src/components/` | 可复用 UI：chrome 外壳、播放页子面板（`player/`，见 [`docs/播放页.md`](docs/播放页.md)）、列表行与卡片、首页状态对、搜索侧栏；`.psh-body` 是浮层定位基准 |
| `src/ui/` | UI 辅助层：tokens（视觉常量值表）、theme、rail、paging（渲染分片口径）、dlselect（选择集）+ `mixins/`（accent/toast/arm/multi/frame/pagebus/infinite/listpage/dlsub），契约见 [`docs/UI架构与自检.md`](docs/UI架构与自检.md) |
| `src/services/{player,ncm,cover}/` | 播放器与媒体（下载引擎门面 = `player/download.js`）、网易云接口与登录、图片获取与缓存域 |
| `src/core/{infra,platform}/` | 平台无关设施（nav/vis/paths/config/log/store/format/events/util/net）与平台适配（db/exec/fsutil/touch/systemKeyboard/bridge/audio） |
| `native/` + `libs/` | **X3S 原生扩展**：`bpnnet`（fs/http/exec）+ `sqlite3` 的 C 源码与 aarch64 产物；S7/X5 不加载 |
| `src/assets/` + `src/styles/` | 图标 PNG（`icons.js` 是纯生成物，`--check` 逐字节校验）与设计 token（`common.less` 令牌段是生成物） |

多页面机制：`pages` 每个 key 编成一个 `.falcon_/<key>.js.bin`，跨页 ES 模块是**同一实例**（播放器等单例各页直接 import）；同一 .vue 注册多个 key 时，基础 key = 逻辑页名，其余 = 实例槽位别名（只有几百字节 re-export）。左栏是全应用统一的 `NavRail`（栏宽 60px、最多 3 个上下文键），几何与点击分派见 [`docs/UI架构与自检.md`](docs/UI架构与自检.md)。

## 最容易踩的五条

1. **模板 `:x="x"` 是「取字段」不是调用**（字节码实证 `get_field`）：裸绑定只能来自 props / computed / data，来自 methods 会拿到函数 —— 轻则静默失效，重则子组件炸掉、整块 UI 消失。`theme_verify.py` 第四道按此硬判
2. **一次渲染 ≤50 行、页面会挂两遍**：长列表必须分片（`ui/paging.js` 口径 + `mixins/infinite.js` 续批），`mounted` 初始化必须幂等
3. **任何宽度 >100vh 都被静默截到 100vh**（1vh = 2.4px）→ 超限写 px 或百分比；改完截图 + 像素扫描
4. **`fs` 无写接口、写文件不能走 shell**：结构化数据进 SQLite，二进制走 `http.download({outPath})`，下载引擎用 `process.exec` + 系统 curl 写 `.part`
5. **平台 `navTo` 命中栈内同名页会「弹掉上层 + 复用旧实例」**：所以只能走导航层，页面代码按标准 push/pop 写

完整 25 条平台坑（含样式、事件、浮层、Flex、`<text>` 折行、设备驱动）见 [`docs/平台约束与自检.md`](docs/平台约束与自检.md)「平台坑清单」。

## 边界

- **下载**（用户主动）→ `$dataDir/downloads/<id>/`，永久保留；**缓存**（边听边存）→ `$dataDir/cache/<id>/`，受缓存上限 LRU 滚动、不计入本地下载；每曲目录只有音频与封面，**元数据与歌词在 `state.db` 的 `track_meta` / `track_lyric`**（[`docs/存储重构.md`](docs/存储重构.md) §2）
- **后台 JS 会冻结**：切后台时下载跑完当前片就停，别承诺「后台继续下载」；应用退出后无后台
- 退出登录会清空 `kv` 表的 `ncm_cookies` 行并删 curl 的 jar 文件
- 长列表首屏批量渲染、滚到底自动续批；拿不到滚动位移时降级为「加载更多」按钮
- 原生 `.so` 只在 **X3S** 加载，S7/X5 是 armhf 不加载；`global` 已用于输入法与网络状态，其它能力动前先用探针页验证

## 文档索引

[`docs/README.md`](docs/README.md) 是完整索引；按任务先看这几篇：

| 任务 | 文档 |
|---|---|
| 改页面 / 新增页面 / 跳转与返回 | [`页面导航.md`](docs/页面导航.md) |
| 改样式、模板绑定、视觉常量、跑自检 | [`平台约束与自检.md`](docs/平台约束与自检.md)、[`UI架构与自检.md`](docs/UI架构与自检.md) |
| 碰存储、路径、元数据、歌词落点 | [`存储重构.md`](docs/存储重构.md) |
| 碰下载 / 缓存 / 队列 | [`下载引擎.md`](docs/下载引擎.md)、[`本地下载.md`](docs/本地下载.md) |
| 碰播放器、定位、歌词渲染 | [`播放页.md`](docs/播放页.md)、[`播放与定位能力.md`](docs/播放与定位能力.md) |
| 上设备、取日志、探针 | [`调试与设备操作.md`](docs/调试与设备操作.md)、[`运行时API参考.md`](docs/运行时API参考.md) |
| 机型差异（X3S/S7） | [`X3S适配.md`](docs/X3S适配.md) |
