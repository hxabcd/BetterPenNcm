# native/ —— X3S 原生扩展（libjsapi_bpnnet.so）

X3S（RK3566「CHERRY」，aarch64，fw 3.4.5）的小程序运行时没有 S7 的 `fs` / `http` /
`process` 裸模块，也没有 `sqlite3`；下载引擎、本地库、Cookie 会话、状态库都失去入口。
本目录把这几块能力编成一个随 `.amr` 分发的原生扩展，运行时由 libfalcon 的
`dynamic_load_jsapi` 加载，`custom_init_jsapis()` 里注册两个裸模块：

| 模块 | 内容 | JS 侧 |
|---|---|---|
| `bpnnet` | fs exists/stat/readdir/readText/writeText/mkdir/rm/rename、libcurl request（收响应头）/ download、fork + `/bin/sh -c` exec | `src/core/platform/bridge.js`（request/log/fsutil/exec 的 import 失败回退） |
| `sqlite3` | `Database`（open/exec/prepare/close）、`Statement`（bind/run/all/columnNameList/finalize），与 S7 原生模块同形状 | `src/core/platform/db.js` 零改动 |

设备自带 `libcurl.so.4` 与 `libsqlite3.so.0`，扩展通过 DT_NEEDED 使用它们；
`libquickjs.so` 由宿主进程已加载。

## 构建

产物已入库（`libs/arm64-cherry3566/libjsapi_bpnnet.so`），正常 `bash scripts/build.sh`
不需要 zig。只有改 C 源码时才重新编：

```bash
python -m venv .venv-zig
.venv-zig/bin/pip install ziglang
bash native/build-aarch64.sh
```

`build-aarch64.sh` 用 zig 交叉编译 **aarch64-linux-gnu.2.29**，链接 `native/stubs-aarch64/`
里的设备原件（只满足链接期符号解析），产物落到 `libs/arm64-cherry3566/`，随后用
`native/tools/inspect_elf.py` 自检：ELF64 / AArch64 / glibc 需求 / `custom_init_jsapis`
导出 / 无内部符号泄漏。

S7 / X5 是 armhf，不会加载这个 .so：`import('bpnnet')` 在那边抛错 → `bridge()` 返回 null，
全部调用方走原生裸模块，行为与改动前一致。

## 设备侧验证（真机）

```bash
devctl --device x3s run -- 'L=$(ls -t /userdata/applog/DictPen_*.log | head -1); grep -aE "@@|\[db\]|\[boot\]" $L | tail'
```

预期启动日志：`[boot] 存储目录 downloads=true cache=true thumbs=true`、
`[db] 状态库就绪 state.db` / `[db] 索引库就绪 local_index.db`。
