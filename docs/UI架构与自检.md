# UI 架构与自检

`src/ui/` 收敛页面公共 UI 能力（mixin 集中在 `src/ui/mixins/`）；本文件说明当前结构与组合规则。平台渲染约束见 [`平台约束与自检.md`](平台约束与自检.md)。

## 一、模块与契约

`src/ui/`（非 mixin）：

| 模块 | 对外接口 | 解决的问题 |
|---|---|---|
| `tokens.js` | `TOK.xxx` 读静态视觉值；改值后跑 `scripts/gen_tokens.py --write` | 共享颜色/字号/结构尺寸的权威值表；颜色字面量由自检强制，字号/尺寸仍靠评审；LESS 侧由脚本生成令牌段 |
| `theme.js` | `PRESETS/ACCENTS/setAccent/setBg` + 换色广播 `THEME_EVENT`；状态本体（mixin 面在 `mixins/accent.js`） | 主题色/背景色的唯一可换来源（setlook 消费） |
| `rail.js` | `railBack/railBtn/ICON` | 左栏槽位工厂与图标注册表 |
| `paging.js` | `PAGE_*` 首屏批量、`AUTO_BATCH` 续批步长、`ROW_PX_*` 行高、`moreText` | 长列表渲染分片口径 |
| `dlselect.js` | `selHas/selToggle/selAllPicked/selAllIds/selPicked`（选择集纯函数；下载文案/空间预检在 `services/player/download.js`） | 多选下载的选择集合运算 |

`src/ui/mixins/`：

| 模块 | 对外接口 | 解决的问题 |
|---|---|---|
| `accent.js` → `accentMixin` / `bindTheme` / `unbindTheme` | `vm.accent` / `vm.bg` / `vm.fgIcon(key)` | 主题订阅 + 立即取当前色（状态本体在 `ui/theme.js`） |
| `toast.js` → `toastMixin` | `showToast(text, ms?)` / `hideToast()`；模板 `<hint-toast :text="toast" />` | 各页自己的 set/timer/复位；默认 2000ms |
| `arm.js` → `armMixin` | `arm(id)` / `isArmed(id)` / `disarm()`；文案 `armRailText` / `armConfirmText` | 「点两次确认」的 3 秒语义 |
| `multi.js` → `multiSelectMixin` | 页面提供 `multiList()`（范围）、`multiTotal()`（计数口径），可选 `onMultiEnter/Exit()`；得到 `multi/selIds/isSel/toggleSel/toggleAll/multiBarSub/exitMultiIfAny` | 多选态状态机 |
| `frame.js` → `pageFrameMixin` | 覆写 `rail()` / `onBack()` / `onRailKey(key)`；默认 `rail=[返回]`、`onBack=$page.finish()` | 页面骨架分派 |
| `pagebus.js` → `pageBusMixin` | `onPageEvent(evt, '方法名')`；同一事件由页面栈上层存活实例处理、实例销毁自动退役并回落给下层 | `$falcon.on` 订阅的注册/退役 |
| `infinite.js` → `infiniteScrollMixin` | 页面提供 `hasMore` / `loadMore()` / `infiniteBottomPx`（列表页由 `listPageMixin` 给）；模板 `@scroll="onInfiniteScroll"` | 滚到底自动续批（fail-closed 降级到「加载更多」按钮） |
| `listpage.js` → `listPageMixin` | `moreLabel(n, unit)`；本地切片 `loadMoreLocalSlice()`；`infiniteBottomPx`（按 `listPageConfig()` 声明的切片数组/行高）；`_dlOff` 兜底清理 | 列表页骨架样板（S3 收编） |
| `dlsub.js` → `bindDl` / `dlSubscriberMixin`（含页面可见性实现 `markVisible/onVisChange/bindPageVis/pageOf`，`core/infra/vis.js` 是转发层） | `this._dlOff = bindDl(vm, fn)`：订阅 + 可见性门控 + 挂载首帧快照 | 下载活动订阅的省渲染封装 |

## 二、组合规则

- 一个实例只绑一次主题：混了 `accentMixin` 就别再自己 `bindTheme`。
- chrome 组件（PageShell / NavRail / PageTopbar 等）也混 `accentMixin`，不要再手写主题订阅。
- `pageFrameMixin` 的 `rail` **必须在 computed**，不能放 methods：模板 `:rail="rail"` 编译成取字段（`get_field`），methods 会取到函数，NavRail 拿它 `slice` 会炸，整条左栏消失。
- **播放页也用 page-shell**（2026-10-29 按设计稿重做、2026-10-30 调整；左栏 60px 样式已全局化到 NavRail）：`.psh-body` 里是控制区 `ControlPanel.vue`（480px）+ 子面板容器（480×240：`LyricBoard` / `CommentPanel` / `SeekPanel` / `SeekPanel` 内的 `TimerPanel`）。默认空面板（EmptyExtraPanel），三个切换键各自开合；`SeekPanel` 与 `TimerPanel` 是同一子面板内的两级页面（`seekView`）。子面板组件都不含 slot，所以页面级 `v-if` 整体切换安全；新增面板沿用同一约定（props/computed 驱动、提示走 `$emit('toast')`、不自上底色）。
- boot 一次性启动链的 Promise 回调不走 pageBus（它不是订阅）；index 的 boot 仍用模块级 live。

## 三、设计决定

1. **用 mixin 而不是一个大 `<page-frame>` 组件**：含 slot 的组件模板结构保持恒定（不靠 `v-if` 增删兄弟节点切换形态），这样页框架能力只能走 JS 混合、模板保持各页原样。约束的依据与复验方法见 [`待验证-slot补插错位.md`](待验证-slot补插错位.md)。
2. **值表放 JS、LESS 段生成**：LESS 是编译期，换色必须内联，所以「书面值」天然是第二来源；把共享的静态值收进 `tokens.js`、生成 `common.less` 令牌段，才能让共享值只有一个权威来源。运行时可换的 bg/accent 系归 `theme.js`（mixin 在 `mixins/accent.js`）。
3. **改动以「零视觉变化」或「单点语义」为验收目标**：能静态证明的（值逐一相同、单一来源进包）先做静态验证；动像素的改动单独截图核对。

## 四、框架层边界与所有权（未抽离的现状）

框架能力全在本工程内：`src/components/` 的 chrome 组件与 `src/ui/`（值表、主题、rail、paging、mixin），没有独立目录也没有共享包；页面只留业务。依赖方向由 `scripts/theme_verify.py` 第七道（R1-R6）硬校验：`pages → {components, ui, services, core}`；`components` 按轴引用，域组件引 `services/cover` 属允许范围，收进 `components/chrome/` 的 chrome 组件则禁引 services；`ui` 只许引 `core` / `assets`。

问题不在方向，在**同一层里混了两种命**：chrome 与网易云域组件同在 `src/components/`；`theme.js` 里既有可复用的运行时（`bindTheme` / `accentMixin` / `pickOn`）又有本工程的品牌预设（`PRESETS` / `ACCENTS`）。

**不建 `src/fw/` 目录「先整齐后搬家」**：`.vue` 不能用转发文件掩盖搬家（SFC 不能整体 re-export），一搬就要改 22 个页面的 import，收益归零。

### 4.1 改动即全量回归的边界

- chrome 组件（`PageShell` / `NavRail` / `PageTopbar` / `ContextSheet`）与小件（`OptChip` / `OptToggle` / `HintToast` / `EmptyHint` / `CueRow`）改动 = **全部 22 个页面**要回归。
- `NavRail` 几何改动 = 所有贴栏浮窗都要重新对位（浮层以 `.psh-body` 为定位基准）。

### 4.2 与 BetterPenSys 的三条语义分叉

`dev/BetterPenSys`（系统管理工具，9 页）是另一个消费者：它的 chrome 与 Ncm 已经分叉，差异是**语义**而非样式，合库必须先裁决「以谁为准」。

| 维度 | BetterPenNcm | BetterPenSys |
|---|---|---|
| chrome 组件 | `PageShell` 87 / `NavRail` 178 / `PageTopbar` 104 / `HintToast` 64 | 76 / 186 / 128 / 54 |
| 主题 | 运行时 `ui/theme.js`（`PRESETS` 4 种底色 × `ACCENTS` 7 色）+ 内联 `:style`，设置页可换 | 编译期 LESS 写死 `@accent` 青绿 `#1f9d77`，无 theme 模块 |
| 左栏槽位状态 | `{on, danger, disabled}` 三个布尔 | `{nav, busy, on, off, danger}` 五语义 + spinner 帧 + `off` 变体图标 + 左侧竖条 |
| 令牌 | `tokens.js` 唯一值表 → 生成 `common.less` 令牌段 | 手写 `common.less`，无值表、无 `gen_tokens.py` |
| 行高/主色 | `@row-h` 23vh、`@accent` 重音红 `#D93A49` | `@row-h` 18vh、`@accent` 青绿 `#1f9d77` |

1. **主题**：`PageShell` 现在自己混 `accentMixin` 取色。共享版要么改成吃 `:bg` prop（22 个页面全改调用点），要么框架自带 theme 模块、由 app 注入 `PRESETS` / `ACCENTS` 与配置读写（`ui/theme.js:30` 直接 import `core/infra/config.js`，那是本应用的 `ncm_settings` KV）。
2. **左栏状态词汇**：Sys 的 `busy` / `off` 是 Ncm 没有的。做成并集则 Ncm 的 `btnStyle`（`NavRail.vue:80`）多两条永不命中的分支；做成插件式则要先把 `btnStyle` / `iconOf` 从组件里提成可注入函数。
3. **令牌基准**：两个 `common.less` 的行高与主色不同，共享值表得先定「谁迁就谁」，而 Ncm 那套被 `gen_tokens.py` 硬校验（`scripts/gen_tokens.py:28` 固定生成到 `src/styles/common.less`）。

### 4.3 抽离要付的账

| 项 | 具体代价 |
|---|---|
| 双端回归 | 框架改动要在两个应用各构建 + 装机一次。构建实测 **2m10s**；装机是覆盖安装（同 appid 直接装，data 原样保留） |
| 自检脚本 | `scripts/theme_verify.py` 的 `CHECKS` 按 **44 条** `src/...` 路径逐文件断言，缺 import 检查也只巡这份清单；`scripts/gen_tokens.py:28` 写死生成到 `src/styles/common.less`。框架搬家 = 两个脚本重写路径与规则 |
| LESS 解析面与样式模块 | `lessPaths` 只解析到 `<appRoot>/src/<item>`；样式 import 按文件名 + importer 目录解析；同目录禁同名 `.vue`。机制见 [`miniapp-template-参考摘要_2026-10-07.md`](../../../docs/miniapp-template-参考摘要_2026-10-07.md) |
| 依赖管理 | 本机 pip 无网（npm 未验证），「框架包」只能是兄弟目录 + alias：无版本号、无锁、无 CI，回滚靠人 |
| 文档 | `AGENTS.md` 的结构表、本文件的契约表、`docs/README.md` 的索引都要改 |

### 4.4 跨目录 `.vue` 构建实测

**做法**：工程根目录之外放一个带 scoped LESS 的最小组件（`dev/shared/pen-fw/spike/FwSpike.vue`）；`src/app.json` 加 `"options": {"alias": {"@fw": "../shared/pen-fw"}}`；消费页 `import` 它并挂在 `v-if="fwSpikeOn"`（`false`）上；跑 `bash scripts/build.sh`。

**结果**：构建成功，产物里能查到该组件 —— `strings .falcon_/settings.js.bin` 出现 `FwSpike`、`fws-t`、`../shared/pen-fw/spike/FwSpike.vue`。跨目录 `.vue` 被正常编译、scoped 类名正常生成，并**内联进消费页的 chunk**（未单独切 chunk）。机制（`options.alias` 按工程根解析、`.vue` 过滤器无路径限制）见 [`miniapp-template-参考摘要_2026-10-07.md`](../../../docs/miniapp-template-参考摘要_2026-10-07.md)。

**未验证**：真机运行（只到构建期）；两个应用共用同一份框架时的 chunk 归属与包体积变化。

### 4.5 物理抽离的触发条件

做法固定为 `dev/shared/pen-fw/` + `app.json` 的 `options.alias`（§4.4 已实测）+ `lessPaths`（未实测，先单独冒烟），1.5–2 天。任一条件成立才做：

- 第三个应用或正式化探针需要同一套页面骨架；
- BetterPenSys 再次需要同步改 chrome（说明复制已开始腐化）；
- 框架层改动频率上升到跨端回归成本可以摊销的程度。

届时 `theme.js` 拆成 `theme-runtime`（`bindTheme` / `accentMixin` / `pickOn` / `fgIcon` 契约）+ 各 app 自己的 `PRESETS` / `ACCENTS`；Sys 只迁 chrome（`PageShell` / `NavRail` / `PageTopbar` / `HintToast` + `frame` / `toast` mixin），左栏状态词汇做成可注入的 `btnStyle` / `iconOf`，Sys 的五语义留在 Sys 侧。

**不抽离清单**：`SongRow` / `LibraryRow` / `ArtistRow` / `PlaylistCard` / `AlbumCard` / `LyricBoard` / `NowLyric` / `NowProgress` / `cover` / `artistavatar` / `quality` / `download` 系列 —— 这些编码的是网易云域知识（封面缓存、音质档位、下载归属、歌词定位），放进共享层只会把域知识搬到错误的位置。

## 五、自检

改 UI 后跑三项自检；命令、判据与失败处理见 [`平台约束与自检.md`](平台约束与自检.md) §五：

```bash
python scripts/theme_verify.py
python scripts/gen_tokens.py
python scripts/gen_icons.py --no-fetch --check
```

三项都应以退出码 0 结束。第四至第八道是硬失败；判据会随新的失败方式升级，改自检时同步更新本文件与 `平台约束与自检`。

## 六、左栏（NavRail）与槽位几何

左栏是全应用统一的一份（`components/NavRail.vue`，2026-10-30 起采用播放页设计稿：栏宽 25vh = 60px、键 48×48、圆角 12px、键底 `#242424`）；播放页也走 `PageShell`/`NavRail`，没有单独的左栏组件。

- 页面根节点 `<page-shell :rail="rail" @rail="onRail">`。**返回不在 PageShell 里处理**（组件内 `this.$page` 不可靠）：`@rail` 抛给页面，页面混 `pageFrameMixin` 后由它把 back 分派到 `onBack()`、上下文键分派到 `onRailKey()`
- 第一个槽位永远是返回：主页 = 退出应用（退出前暂停播放），其余页 = `this.$page.finish()`
- 其余槽位贴栏底、按页面上下文给，**最多 3 个**（返回 + 3 恰好等距排满 100vh）；多选态下返回键变 × 退出多选
- 槽位几何（浮窗要贴着某按钮时按此算）：返回 3.33~23.33vh；底部组最下一个 76.67~96.67vh，往上每个 −24.44vh
- 槽位由各页拼（`ui/rail.js` 的 `railBack`/`railBtn`）；三键上限不是审值决策而是几何：`2×3.33 + 4×20 + 3×4.44 = 100vh`，第 4 个物理放不下
- 目标布局与各页当前落点的对照见 [`上下文菜单与图标.md`](上下文菜单与图标.md)
- 键态只能走内联 `:style`（平台不认复合选择器、也不能给 PNG 染色）：默认底 `TOK.btnBg`、选中 `TOK.surface3` + `TOK.text3` 描边、危险态 `accent.c`、禁用去底色；亮色主题上的图标由页面用 `fgIcon()` 取深色版（白版在亮色主题上对比度仅约 1.5:1）
- 栏宽与 `core/platform/viewport.js` 的 `RAIL_W`（=25）成对维护；`PageShell` 先过 `railItems` 收敛（非数组兜底 `[railBack()]`），`railSig` 键集合变化时整体重建 NavRail（修「点多选键界面不切换」）
- 浮窗贴某个键时按槽位几何反推：1 个上下文键 → 键上沿 76.67vh；2 个 → 52.22 / 76.67；3 个 → 27.78 / 52.22 / 76.67（浮层定位基准仍是 `.psh-body`，只盖内容区、不盖左栏）
