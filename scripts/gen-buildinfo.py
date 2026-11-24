#!/usr/bin/env python3
"""生成构建期常量：buildInfo.js（构建号）与 logconfig.generated.js（日志地址）。

这两个文件都是**构建生成物、不入库**（见 .gitignore），源码里被 import：
`src/pages/index/index.vue` 与 `settings.vue` 读 `BUILD_TAG` 显示在顶栏，
`src/core/infra/log.js` 读 `LOG_SRV` 决定日志往哪 POST。新克隆缺它们时
静态检查会报模块缺失，所以构建前必须先跑这一步。

原先这段逻辑写在 scripts/build.sh 里（bash + ipconfig + awk + grep）。搬进
Python 的原因：探测本机地址不该依赖 Windows 的 ipconfig 输出格式（中文系统
是「IPv4 地址」，英文是 "IPv4 Address"，本质都不该被解析）；`socket` 直接问
内核「到公网走哪张网卡、源地址是什么」更可靠，而且不启动子进程。

## 关于两个文件的格式

**内容格式必须与历史一致**：只有一行注释 + 一个 `export const`。源码按
ES module 静态 import，改格式会连带改导入方，没必要。注释里写的入口名保持
`scripts/build.sh`——它仍是构建入口，只是这一步现在由 Python 做。

## 日志地址取值（优先级从高到低）

1. `--log-srv <URL>`        显式地址
2. `--log-srv auto`         探测本机局域网 IPv4，拼成 `http://<IP>:8888/log`
3. `--log-srv --`           强制清空（连环境变量也不看），生成回环缺省
4. 环境变量 `BPNCM_LOG_SRV`  同 1/2 的语义（`auto` 也认）
5. 都没有                    生成空串

空串不是「没配好」而是**刻意的缺省**：log.js 里 `LOG_SRV || 'http://127.0.0.1:8888/log'`，
在设备上连不通、静默失败、功能零影响。这样仓库里不会落下内网 IP；要真机日志
必须显式传 `--log-srv` 或设环境变量。

`auto` 探测不到可用局域网地址时**报错退出非零**（而不是悄悄退化成回环）：
否则「以为注入了日志地址、跑完发现设备一句都没回传」这种排查很贵。

用法：
  python scripts/gen-buildinfo.py                        # 构建号 + 回环缺省
  python scripts/gen-buildinfo.py --log-srv auto         # 自动探测本机局域网 IP
  python scripts/gen-buildinfo.py --log-srv http://10.0.0.5:8888/log
  python scripts/gen-buildinfo.py --log-srv --             # 强制回环（忽略环境变量）
"""

from __future__ import annotations

import argparse
import datetime as _datetime
import os
import socket
import sys
from pathlib import Path

# Windows 控制台默认 GBK，中文帮助与中文报错会 UnicodeEncodeError 或变乱码。
# 必须在本文件里做，不能指望调用方：config.toml 的 pre_steps 直接以
# `["python", "scripts/gen-buildinfo.py"]` 执行，那条路径不经过 build.sh，
# 没有 PYTHONIOENCODING 兜底；手跑这个脚本的概率也很高。
# 写法与 tools/dictpen-dev/devctl.py 一致（失败就放过，不让编码问题反而弄崩脚本）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# 生成物相对项目根的位置。两个都在 src/core/infra/ 下（源码从这里 import）。
BUILD_INFO_REL = Path("src/core/infra/buildInfo.js")
LOG_CONFIG_REL = Path("src/core/infra/logconfig.generated.js")

# 与历史输出逐字节一致：这一行注释 + 一个 export const + 结尾换行。
HEADER = "/* 由 scripts/build.sh 自动生成，勿手改 */"

DEFAULT_LOG_PORT = 8888

# `--log-srv --` 的哨兵：显式要求「清空，连环境变量也别看」。用不可打印字符，
# 不会与真实 URL 撞上。
CLEAR = "\0clear"


class GenError(Exception):
    """生成失败（探测不到地址、写不进文件）。要打印给人看并退出非零。"""


def build_tag(now: _datetime.datetime | None = None) -> str:
    """构建号：`YYYYmmdd-HHMMSS`（与旧 `date +%Y%m%d-%H%M%S` 一致，本地时间）。"""
    return (now or _datetime.datetime.now()).strftime("%Y%m%d-%H%M%S")


def render_build_info(tag: str) -> str:
    return f"{HEADER}\nexport const BUILD_TAG = '{tag}'\n"


def render_log_config(srv: str) -> str:
    return f"{HEADER}\nexport const LOG_SRV = '{srv}'\n"


def _usable_lan_ip(ip: str) -> bool:
    """这个地址能不能当"设备要访问的 PC 地址"。

    排除：空、回环、0.0.0.0、169.254 链路本地（自分配，等于没有局域网）、
    以及 IPv6（设备侧用的是 IPv4 URL）。
    """
    if not ip:
        return False
    if ip.startswith("127.") or ip == "0.0.0.0":
        return False
    if ip.startswith("169.254."):
        return False
    parts = ip.split(".")
    if len(parts) != 4:
        return False
    return all(p.isdigit() and 0 <= int(p) <= 255 for p in parts)


def _probe_via_udp() -> str:
    """问内核：去公网方向的源地址是什么。

    UDP `connect` 只做路由查找、**不发包**，所以不依赖网络可达、也不需要权限。
    这是拿"默认出口网卡地址"最省事且跨平台的办法。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return str(s.getsockname()[0])
    finally:
        s.close()


def _probe_via_hostname() -> str:
    """兜底：本机名解析。多网卡时可能拿到任意一个，所以只在 UDP 失败后用。"""
    try:
        name = socket.gethostname()
        for ip in socket.gethostbyname_ex(name)[2]:
            if _usable_lan_ip(ip):
                return ip
    except (OSError, socket.gaierror):
        pass
    return ""


def detect_lan_ip() -> str:
    """探测本机局域网 IPv4。探不到抛 GenError（绝不静默返回空串）。"""
    for probe in (_probe_via_udp, _probe_via_hostname):
        try:
            ip = probe()
        except OSError:
            continue
        if _usable_lan_ip(ip):
            return ip
    raise GenError(
        "--log-srv auto 探测不到本机局域网 IPv4。\n"
        "  常见原因：没有任何网络连接（网线/Wi-Fi 都断）、只有回环、\n"
        "  或者地址是 169.254.x.x（DHCP 失败后的自分配地址）。\n"
        "  直接给地址即可，例如：\n"
        "    python scripts/gen-buildinfo.py --log-srv http://192.168.1.5:8888/log"
    )


def resolve_log_srv(arg: str | None, env_value: str | None) -> str:
    """把各种来源合成最终要写进文件的 LOG_SRV。

    arg 为 None 表示命令行没给（此时才看环境变量）；arg 为 CLEAR 表示「强制清空」。
    优先级的理由见模块 docstring。
    """
    raw = arg
    if raw is None:
        raw = env_value or ""
    if raw == CLEAR:
        return ""
    raw = raw.strip()
    if raw == "auto":
        return f"http://{detect_lan_ip()}:{DEFAULT_LOG_PORT}/log"
    return raw


def _write(path: Path, text: str) -> None:
    """写文件（先写临时文件再 replace，避免构建途中被读到半截）。

    写 **bytes** 而不是 `write_text(..., newline="\\n")`：后者是 3.10 才有的参数，
    而这个脚本由 config.toml 的 pre_steps 以裸 `python` 执行——PATH 上那个解释器
    的版本不受我们控制，不该因为一个换行参数就崩。自己编码更稳，也保证产物恒为
    LF（`\\n` 不会被平台改写成 CRLF）。
    """
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(text.encode("utf-8"))
        os.replace(tmp, path)
    except OSError as exc:
        raise GenError(f"写不进 {path}：{exc}") from exc


def generate(project: Path, log_srv: str, tag: str) -> tuple[Path, Path]:
    """写出两个生成物，返回它们的路径。重复执行只会覆盖，不会追加。"""
    bi = project / BUILD_INFO_REL
    lc = project / LOG_CONFIG_REL
    _write(bi, render_build_info(tag))
    _write(lc, render_log_config(log_srv))
    return bi, lc


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="gen-buildinfo.py",
        description="生成 buildInfo.js / logconfig.generated.js（构建期常量）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="--log-srv -- 表示强制清空（连 BPNCM_LOG_SRV 也不看）。",
    )
    p.add_argument("--log-srv", metavar="URL|auto|--", default=None,
                   help="日志服务器地址；auto=探测本机局域网 IP；--=强制清空")
    p.add_argument("--build-tag", metavar="TAG", default=None,
                   help="覆盖构建号（缺省 YYYYmmdd-HHMMSS；仅自测用）")
    p.add_argument("--project", metavar="DIR", default=None,
                   help="项目根（缺省按脚本位置推：scripts/ 的上一层）")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    # 手工处理 `--log-srv --`：argparse 会把它当成「选项结束」分隔符而拒绝取值。
    argv = list(sys.argv[1:] if argv is None else argv)
    force_clear = False
    for i, tok in enumerate(argv):
        if tok == "--log-srv" and i + 1 < len(argv) and argv[i + 1] == "--":
            argv[i + 1] = "__CLEAR__"
            force_clear = True
        elif tok == "--log-srv=--":
            argv[i] = "--log-srv=__CLEAR__"
            force_clear = True

    args = _parse_args(argv)
    arg = CLEAR if (force_clear or args.log_srv == "__CLEAR__") else args.log_srv

    project = (Path(args.project).resolve() if args.project
               else Path(__file__).resolve().parent.parent)

    try:
        srv = resolve_log_srv(arg, os.environ.get("BPNCM_LOG_SRV"))
        tag = args.build_tag or build_tag()
        bi, lc = generate(project, srv, tag)
    except GenError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        return 1

    # 输出口径与旧 build.sh 一致（构建号与日志地址各一行），便于肉眼核对。
    print(f"构建号: {tag}")
    if srv:
        print(f"日志服务器: {srv}")
    else:
        print("日志服务器: （未注入，回环缺省 127.0.0.1:8888 —— 设备上连不通）")
    print(f"  {bi.relative_to(project).as_posix()}")
    print(f"  {lc.relative_to(project).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
