/*
 * bpnnet —— BetterPenNcm 的原生扩展（纯 C；X3S 主用，同一份 C 也可编 armhf 给 X5）
 *
 * 存在原因：X3S（RK3566「CHERRY」，fw 3.4.5）运行时没有 S7 的 `http` / `fs` /
 * `process` 裸模块，也没有 `process.exec` 兜底——BPN 的下载引擎（系统 curl）、
 * 本地库（fs 读写）、Cookie 会话（响应头 set-cookie）全部失去入口。
 * 本模块随 .amr 打进 libs/arm64-cherry3566/，由 libfalcon 的 dynamic_load_jsapi
 * dlopen 后调用 custom_init_jsapis，经 registerCModuleLoader 重建裸模块：
 *
 *   1. bpnnet —— fs / http / process.exec（注册入口在本文件；能力实现见
 *      bpnnet_{common,fs,exec,http,job}.c，共享声明在 bpnnet_internal.h）
 *   2. sqlite3 —— Database/Statement 最小面（native/csrc/sqlite3mod.c，设备自带
 *      libsqlite3，见 src/core/platform/db.js 的接口契约）
 *
 * 异步模型：长操作（网络 / 命令）一律「后台线程 + JS 轮询」——QuickJS 上下文非线程
 * 安全，不能从后台线程 resolve Promise（PenBili 在同款固件上验证过该模式）。
 * JS 侧封装见 src/core/platform/bridge.js；接线点是 request/log/fsutil/exec。
 *
 * 编译目标：aarch64-linux-gnu.2.29（X3S）；构建命令见 native/build-aarch64.sh。
 * S7/X5 是 armhf，动态加载器不会加载本 .so，既有裸模块路径不受影响。
 *
 * TLS：X3S 的 /etc/ssl/certs 为空（与 X5 相同）。首次遇证书类错误后置全局标志，
 * 之后所有请求直接跳过校验（与系统 jsapi.http 行为一致）。
 */

#include "bpnnet_internal.h"

#define BPNNET_VERSION "1.0.0"

/* ---------------- JS 绑定（version 无状态，随注册入口留在这里） ---------------- */

static JSValue js_version(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewString(ctx, BPNNET_VERSION);
}

/* ---------------- 模块注册 ---------------- */

static int bpnnet_module_init(JSContext *ctx, JSModuleDef *m) {
    JSValue def = JS_NewObject(ctx);
#define REG(name, fn, nargs) JS_SetPropertyStr(ctx, def, name, JS_NewCFunction(ctx, fn, name, nargs))
    REG("version", js_version, 0);
    REG("fsExists", js_fs_exists, 1);
    REG("fsSize", js_fs_size, 1);
    REG("fsMtime", js_fs_mtime, 1);
    REG("fsReaddir", js_fs_readdir, 1);
    REG("fsReadText", js_fs_read_text, 2);
    REG("fsWriteText", js_fs_write_text, 2);
    REG("fsMkdir", js_fs_mkdir, 1);
    REG("fsRm", js_fs_rm, 2);
    REG("fsRename", js_fs_rename, 2);
    REG("startRequest", js_start_request, 5);
    REG("startDownload", js_start_download, 4);
    REG("startExec", js_start_exec, 3);
    REG("takeResult", js_take_result, 1);
    REG("cancelAll", js_cancel_all, 0);
#undef REG
    JS_SetModuleExport(ctx, m, "default", def);
    return 0;
}

static JSModuleDef *bpnnet_module_load(JSContext *ctx, const char *moduleName) {
    if (strcmp(moduleName, "bpnnet") == 0) {
        JSModuleDef *m = JS_NewCModule(ctx, moduleName, bpnnet_module_init);
        if (!m) return NULL;
        JS_AddModuleExport(ctx, m, "default");
        return m;
    }
    return NULL;
}

extern void registerCModuleLoader(const char *moduleName, LoadCModuleFunction loader);

extern void bpn_sqlite3_register(void);

JQUICK_EXPORT void custom_init_jsapis(void) {
    registerCModuleLoader("bpnnet", &bpnnet_module_load);
    bpn_sqlite3_register();
}
