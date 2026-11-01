# UI 架构与自检

`src/utils/ui/` 收敛页面公共 UI 能力；本文件说明当前结构与组合规则。平台渲染约束见 [`平台约束与自检.md`](平台约束与自检.md)。

## 一、模块与契约

| 模块 | 对外接口 | 解决的问题 |
|---|---|---|
| `tokens.js` | `TOK.xxx` 读静态视觉值；改值后跑 `scripts/gen_tokens.py --write` | 共享颜色/字号/结构尺寸的权威值表；颜色字面量由自检强制，字号/尺寸仍靠评审；LESS 侧由脚本生成令牌段 |
| `toast.js` → `toastMixin` | `showToast(text, ms?)` / `hideToast()`；模板 `<hint-toast :text="toast" />` | 各页自己的 set/timer/复位；默认 2000ms |
| `arm.js` → `armMixin` | `arm(id)` / `isArmed(id)` / `disarm()`；文案 `armRailText` / `armConfirmText` | 「点两次确认」的 3 秒语义 |
| `multi.js` → `multiSelectMixin` | 页面提供 `multiList()`（范围）、`multiTotal()`（计数口径），可选 `onMultiEnter/Exit()`；得到 `multi/selIds/isSel/toggleSel/toggleAll/multiBarSub/exitMultiIfAny` | 多选态状态机 |
| `frame.js` → `pageFrameMixin` | 覆写 `rail()` / `onBack()` / `onRailKey(key)`；默认 `rail=[返回]`、`onBack=$page.finish()` | 页面骨架分派 |
| `pagebus.js` → `pageBusMixin` | `onPageEvent(evt, '方法名')`；同一事件由页面栈上层存活实例处理、实例销毁自动退役并回落给下层 | `$falcon.on` 订阅的注册/退役 |

## 二、组合规则

- 一个实例只绑一次主题：混了 `accentMixin` 就别再自己 `bindTheme`。
- chrome 组件（PageShell / NavRail / PageTopbar 等）也混 `accentMixin`，不要再手写主题订阅。
- `pageFrameMixin` 的 `rail` **必须在 computed**，不能放 methods：模板 `:rail="rail"` 编译成取字段（`get_field`），methods 会取到函数，NavRail 拿它 `slice` 会炸，整条左栏消失。
- **播放页也用 page-shell**（2026-10-29 按设计稿重做、2026-10-30 调整；左栏 60px 样式已全局化到 NavRail）：`.psh-body` 里是控制区 `ControlPanel.vue`（480px）+ 子面板容器（480×240：`LyricBoard` / `CommentPanel` / `SeekPanel` / `SeekPanel` 内的 `TimerPanel`）。默认空面板（EmptyExtraPanel），三个切换键各自开合；`SeekPanel` 与 `TimerPanel` 是同一子面板内的两级页面（`seekView`）。子面板组件都不含 slot，所以页面级 `v-if` 整体切换安全；新增面板沿用同一约定（props/computed 驱动、提示走 `$emit('toast')`、不自上底色）。
- boot 一次性启动链的 Promise 回调不走 pageBus（它不是订阅）；index 的 boot 仍用模块级 live。

## 三、设计决定

1. **用 mixin 而不是一个大 `<page-frame>` 组件**：平台硬约束「含 slot 的组件模板结构恒定」（`v-if` 增删兄弟节点会插错位）+ 插槽补插不稳，所以框架能力全走 JS 混合，模板保持各页原样。
2. **值表放 JS、LESS 段生成**：LESS 是编译期，换色必须内联，所以「书面值」天然是第二来源；把共享的静态值收进 `tokens.js`、生成 `common.less` 令牌段，才能让共享值只有一个权威来源。运行时可换的 bg/accent 系仍归 `theme.js`。
3. **改动以「零视觉变化」或「单点语义」为验收目标**：能静态证明的（值逐一相同、单一来源进包）先做静态验证；动像素的改动单独截图核对。

## 四、自检

改 UI 后跑三项自检；命令、判据与失败处理见 [`平台约束与自检.md`](平台约束与自检.md) §四：

```bash
python scripts/theme_verify.py
python scripts/gen_tokens.py
python scripts/gen_icons.py --no-fetch --check
```

三项都应以退出码 0 结束。第四、五道是硬失败；判据会随新的失败方式升级，改自检时同步更新本文件与 `平台约束与自检`。
