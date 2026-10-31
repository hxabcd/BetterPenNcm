# Lucide SVG 原件（vendored）

这些 SVG 是 `src/assets/icon-*.png` 的**设计来源**，由 `scripts/gen_icons.py` 在 PC 端栅格化。

- 来源：`https://unpkg.com/lucide-static@1.52.0/icons/<name>.svg`
- 版本：**lucide-static 1.52.0**（固定，勿随手升级——升级后要重跑 `gen_icons.py` 并核对对照图）
- 许可：**ISC License**，© Lucide Icons and Contributors（基于 Feather，MIT）。原件每个文件头部带
  `<!-- @license lucide-static v1.52.0 - ISC -->` 注释，请勿删除。

为什么 vendor 到本地而不是构建时下载：生成图标是**离线可重复**的操作，且要锁定版本
（上游改名/改几何会让设备上的图标悄悄变样）。

用到的图标（→ 应用里的 key）：

| Lucide | key | | Lucide | key |
|---|---|---|---|---|
| `chevron-left` | back | | `skip-back` | prev |
| `check` | check | | `list-music` | queue |
| `chevron-down` | chevdown | | `search` | search |
| `pencil` | edit | | `clock` | seek |
| `heart` | like / liked | | `settings` | settings |
| `ellipsis` | more | | `arrow-up-down` | sort |
| `skip-forward` | next | | `trash-2` | trash |
| `sliders-horizontal` | options | | `user` | user |
| `pause` / `play` | pause / play | | `repeat` | loop |
| `repeat-1` | loop1 | | `arrow-right` | order |
| `shuffle` | shuffle | | | |

缺失的文件会被 `python scripts/gen_icons.py` 自动拉取；`--fetch` 强制全部重拉。
