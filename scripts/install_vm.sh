#!/bin/bash
# 兼容入口：等价于 `bash scripts/install.sh --vm`。逻辑只有一行转发。
#
#   bash scripts/install_vm.sh              → bash scripts/install.sh --vm（构建 + 装 + 起）
#   bash scripts/install_vm.sh --no-build   → 同上，跳过构建
#
# 与真机的差异：s7pro 包没配 adbd，走 SSH/dpctl 而不是 adb；VM 分支不备份数据、
# 不做失败回滚（dpctl 的退出码语义不如 adb 干净），装坏了重装即可。
#
# 薄壳，只转发：参数归一与报错都在 devctl 侧（--vm 是 --via vm 的兼容别名，
# 已移除的旧参数由 devctl 明确拒绝）。
exec bash "$(cd "$(dirname "$0")" && pwd)/install.sh" --vm "$@"
