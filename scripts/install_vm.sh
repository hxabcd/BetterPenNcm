#!/bin/bash
# 已并入 install.sh（--vm），此文件仅为兼容旧习惯与旧文档而保留，逻辑只有一行转发。
#
#   bash scripts/install_vm.sh              → bash scripts/install.sh --vm（构建 + 装 + 起）
#   bash scripts/install_vm.sh --build 20   → 同上（--build 是默认，20 = 就绪等待秒数）
#
# 与真机的差异（原 install_vm.sh 的说明）：s7pro 包没配 adbd，走 SSH/dpctl 而不是 adb；
# VM 分支不备份数据、不做失败回滚（dpctl 的退出码语义不如 adb 干净），装坏了重装即可。
exec bash "$(cd "$(dirname "$0")" && pwd)/install.sh" --vm "$@"
