/*
 * bpnnet 内部头文件 —— 只在 native/csrc 内共用，不随 .so 导出。
 *
 * 组织：bpnnet.c 是唯一导出入口（custom_init_jsapis）与模块注册；能力实现按
 * fs / http / process.exec / 任务队列 分文件（bpnnet_fs.c / bpnnet_http.c /
 * bpnnet_exec.c / bpnnet_common.c / bpnnet_job.c），跨文件符号在此声明。
 *
 * 编译带 -fvisibility=hidden：本文件里声明的非 static 符号不会进 .dynsym
 * （native/tools/inspect_elf.py 会断言无内部符号泄漏）。
 */
#ifndef BPNNET_INTERNAL_H
#define BPNNET_INTERNAL_H

#include <jquick_config.h>
#include <jsmodules/JSCModuleExtension.h>
#include <quickjs/quickjs.h>

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

struct resp_buf {
    char *data;
    size_t len;
    size_t cap;
};

struct exec_result {
    int code;
    int timedOut;
    char *stdoutBuf;
    size_t stdoutLen;
    char *stderrBuf;
    size_t stderrLen;
};

struct http_result {
    long status;
    int curlCode;
    char *errMsg;
    struct resp_buf body;
    struct resp_buf headers;
    int insecure;
};

/* download：整文件落盘（原子：tmp + rename）；JS 侧进度轮询走 fsSize */
struct dl_result {
    int ok;
    long status;
    long long size;
    char *errMsg;
    int insecure;
};

struct job {
    int id;
    int state;      /* 0=进行中 1=完成 */
    int cancelled;
    int kind;
    /* req / dl */
    char *url;
    char *method;
    char *headers;
    char *body;
    long bodyLen;
    long timeoutMs;
    char *outPath;  /* dl */
    /* exec */
    char *cmd;
    int maxBuffer;
    char *result;   /* 完成后的 JSON 字符串 */
    struct job *next;
};

#define JOB_REQ 1
#define JOB_DL 2
#define JOB_EXEC 3

/* ---------------- 跨文件函数 ---------------- */

/* 跨文件符号一律 hidden：本模块对外只导出 custom_init_jsapis（见 bpnnet.c），
 * 这里显式标注，避免依赖编译参数、也避免 -fPIC 下多余的 GOT 间接寻址。 */
#define BPNNET_INTERNAL __attribute__((visibility("hidden")))

/* bpnnet_common.c */
BPNNET_INTERNAL long long now_ms(void);
BPNNET_INTERNAL char *dup_str(const char *s);
BPNNET_INTERNAL size_t buf_reserve(struct resp_buf *b, size_t need);
BPNNET_INTERNAL void jbuf_put(struct resp_buf *b, const char *s, size_t n);
BPNNET_INTERNAL void jbuf_puts(struct resp_buf *b, const char *s);
BPNNET_INTERNAL void jbuf_putc2(struct resp_buf *b, char ch);
BPNNET_INTERNAL void jbuf_put_int(struct resp_buf *b, long long v);
BPNNET_INTERNAL void jbuf_put_jstr(struct resp_buf *b, const char *s, size_t n);

/* bpnnet_fs.c */
BPNNET_INTERNAL int fs_stat_size(const char *p, long long *size, double *mtimeMs);
BPNNET_INTERNAL char *ensure_parent(const char *path);

/* bpnnet_exec.c */
BPNNET_INTERNAL void run_command(const char *cmd, int timeoutMs, int maxBuffer, struct exec_result *out);

/* bpnnet_http.c */
BPNNET_INTERNAL void do_http(const char *url, const char *method, const char *headersText,
             const char *body, long bodyLen, long timeoutMs, int insecure,
             struct http_result *out);
BPNNET_INTERNAL void do_download(const char *url, const char *outPath, const char *headersText,
                 long timeoutMs, int insecure, struct dl_result *out);

/* bpnnet_job.c */
BPNNET_INTERNAL int start_job(struct job *j);
BPNNET_INTERNAL void job_free(struct job *j);

/* JS 绑定：注册表在 bpnnet.c，定义在各能力文件 */
BPNNET_INTERNAL JSValue js_fs_exists(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_fs_size(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_fs_mtime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_fs_readdir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_fs_read_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_fs_write_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_fs_mkdir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_fs_rm(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_fs_rename(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_start_request(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_start_download(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_start_exec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_take_result(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);
BPNNET_INTERNAL JSValue js_cancel_all(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv);

#endif /* BPNNET_INTERNAL_H */
