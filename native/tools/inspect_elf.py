"""检查交叉编译出的 .so：架构、ELF class、依赖、glibc 版本需求、导出符号。

支持 ELF32（S7/X5 armhf）与 ELF64（X3S aarch64）。只依赖 Python 标准库，
构建脚本在编译后调用；导出符号里必须有 custom_init_jsapis。
"""
import struct
import sys

if len(sys.argv) > 1:
    PATH = sys.argv[1]
else:
    print("usage: inspect_elf.py <elf-path>")
    sys.exit(2)

with open(PATH, "rb") as fh:
    data = fh.read()

if data[:4] != b"\x7fELF":
    print("not ELF")
    sys.exit(1)
ei_class = data[4]
ei_data = data[5]
if ei_class not in (1, 2) or ei_data != 1:
    print("unsupported ELF class/data: %d/%d" % (ei_class, ei_data))
    sys.exit(1)
is64 = ei_class == 2

# ELF header（e_ident 之后）
if is64:
    (e_type, e_machine, e_version, e_entry, e_phoff, e_shoff, e_flags,
     e_ehsize, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx) = \
        struct.unpack_from("<HHIQQQIHHHHHH", data, 16)
    sh_fmt = "<IIQQQQIIQQ"
    sh_size = 64
else:
    (e_type, e_machine, e_version, e_entry, e_phoff, e_shoff, e_flags,
     e_ehsize, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx) = \
        struct.unpack_from("<HHIIIIIHHHHHH", data, 16)
    sh_fmt = "<IIIIIIIIII"
    sh_size = 40

MACHINES = {40: "ARM", 3: "x86", 62: "x86-64", 183: "AArch64"}
print("class   = ELF%s" % ("64" if is64 else "32"))
print("machine = %s (%d)" % (MACHINES.get(e_machine, "?"), e_machine))
print("type    = %d (3=DYN/shared)" % e_type)
print("flags   = 0x%x" % e_flags)

# section headers（索引 0 起；每项字段随 class 变化）
shdrs = []
for i in range(e_shnum):
    off = e_shoff + i * e_shentsize
    sh = struct.unpack_from(sh_fmt, data, off)
    # 统一成 (name, type, flags, addr, offset, size, link, info, addralign, entsize)
    shdrs.append(sh)
shstr = shdrs[e_shstrndx]
shstr_off = shstr[4]
shstr_size = shstr[5]


def shname(entry):
    o = shstr_off + entry[0]
    end = data.index(b"\0", o)
    return data[o:end].decode("utf-8", "replace")


sections = {}
for sh in shdrs:
    sections[shname(sh)] = sh

# dynamic section → NEEDED / SONAME
try:
    dyn_sh = sections[".dynamic"]
except KeyError:
    print("no .dynamic")
    sys.exit(1)
dyn_entries = []
off = dyn_sh[4]
ent = 16 if is64 else 8
while True:
    if is64:
        tag, val = struct.unpack_from("<qQ", data, off)
    else:
        tag, val = struct.unpack_from("<iI", data, off)
    off += ent
    if tag == 0:
        break
    dyn_entries.append((tag, val))
dynstr_sh = sections[".dynstr"]
strtab = data[dynstr_sh[4]:dynstr_sh[4] + dynstr_sh[5]]


def dstr(v):
    end = strtab.index(b"\0", v)
    return strtab[v:end].decode("utf-8", "replace")


DT = {1: "NEEDED", 14: "SONAME"}
print("--- dynamic ---")
for tag, val in dyn_entries:
    if tag in (1, 14):
        print("  %-8s %s" % (DT.get(tag, hex(tag)), dstr(val)))

# glibc version requirements（可选；缺失不挡）
print("--- glibc version requirements ---")
try:
    ver = sections[".gnu.version_r"]
except KeyError:
    print("  (none)")
else:
    try:
        off = ver[4]
        end = off + ver[5]
        vers = set()
        guard = 0
        while guard < 64 and off + 16 <= end:
            vn_file, vn_aux, vn_next = struct.unpack_from("<IHI", data, off + 4)
            print("  file: %s" % dstr(vn_file))
            ao = off + vn_aux
            inner = 0
            while inner < 256 and ao + 16 <= end:
                vna_hash, vna_flags, vna_other, vna_name, vna_next = \
                    struct.unpack_from("<IHHII", data, ao)
                vers.add(dstr(vna_name))
                if vna_next == 0:
                    break
                ao += vna_next
                inner += 1
            if vn_next == 0:
                break
            off += vn_next
            guard += 1
        print("  versions: %s" % ", ".join(sorted(vers)))
    except (struct.error, ValueError) as e:
        print("  (verneed parse aborted: %s)" % e)

# .dynsym 导出符号
print("--- dynamic symbols (defined) ---")
dynsym_sh = sections[".dynsym"]
ent = dynsym_sh[9]
count = dynsym_sh[5] // ent
found = []
for i in range(count):
    off = dynsym_sh[4] + i * ent
    if is64:
        st_name, st_info, st_other, st_shndx, st_value, st_size = \
            struct.unpack_from("<IBBHQQ", data, off)
    else:
        st_name, st_value, st_size, st_info, st_other, st_shndx = \
            struct.unpack_from("<IIIBBH", data, off)
    if st_shndx == 0:
        continue
    name = dstr(st_name)
    if name:
        found.append(name)
print("  " + ", ".join(sorted(set(found))))
ok = "custom_init_jsapis" in found
print("  custom_init_jsapis present: %s" % ok)
leaked = [n for n in ("js_fs_exists", "js_start_request", "run_command", "do_http",
                      "do_download", "job_thread", "db_ctor", "st_all")
          if n in found]
print("  internal symbols leaked: %s" % (leaked if leaked else "none"))
sys.exit(0 if ok else 1)
