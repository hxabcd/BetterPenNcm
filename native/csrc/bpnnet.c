/*
 * bpnnet —— BetterPenNcm 的原生扩展（纯 C；X3S 主用，同一份 C 也可编 armhf 给 X5）
 *
 * 存在原因：X3S（RK3566「CHERRY」，fw 3.4.5）运行时没有 S7 的 `http` / `fs` /
 * `process` 裸模块，也没有 `process.exec` 兜底——BPN 的下载引擎（系统 curl）、
 * 本地库（fs 读写）、Cookie 会话（响应头 set-cookie）全部失去入口。
 * 本模块随 .amr 打进 libs/arm64-cherry3566/，由 libfalcon 的 dynamic_load_jsapi
 * dlopen 后调用 custom_init_jsapis，经 registerCModuleLoader 重建裸模块：
 *
 *   1. bpnnet —— fs / http / process.exec（本文件）
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

#define BPNNET_VERSION "1.0.0"

static long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/* ---------------- libcurl 最小声明（无需 curl 头文件；数值与 PenBili 同款核对） ---------------- */
typedef void CURL;
struct curl_slist;
typedef struct curl_slist CURL_slist;

extern CURL *curl_easy_init(void);
extern void curl_easy_cleanup(CURL *handle);
extern int curl_easy_setopt(CURL *handle, int option, ...);
extern int curl_easy_perform(CURL *handle);
extern int curl_easy_getinfo(CURL *handle, int info, ...);
extern CURL_slist *curl_slist_append(CURL_slist *list, const char *s);
extern void curl_slist_free_all(CURL_slist *list);
extern const char *curl_easy_strerror(int code);

#define CURLOPT_WRITEDATA 10001
#define CURLOPT_URL 10002
#define CURLOPT_POSTFIELDS 10015
#define CURLOPT_HTTPHEADER 10023
#define CURLOPT_HEADERDATA 10029
#define CURLOPT_POST 47
#define CURLOPT_POSTFIELDSIZE 60
#define CURLOPT_FOLLOWLOCATION 52
#define CURLOPT_SSL_VERIFYPEER 64
#define CURLOPT_SSL_VERIFYHOST 81
#define CURLOPT_NOSIGNAL 99
#define CURLOPT_WRITEFUNCTION 20011
#define CURLOPT_HEADERFUNCTION 20079
#define CURLOPT_TIMEOUT_MS 155
#define CURLOPT_CONNECTTIMEOUT_MS 156
#define CURLINFO_RESPONSE_CODE 0x200002

/* ---------------- 通用小工具 ---------------- */

static char *dup_str(const char *s) {
    size_t n;
    char *p;
    if (!s) return NULL;
    n = strlen(s) + 1;
    p = (char *)malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

struct resp_buf {
    char *data;
    size_t len;
    size_t cap;
};

static size_t buf_reserve(struct resp_buf *b, size_t need) {
    if (b->len + need + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 4096;
        while (cap < b->len + need + 1) cap *= 2;
        char *p = (char *)realloc(b->data, cap);
        if (!p) return 0;
        b->data = p;
        b->cap = cap;
    }
    return 1;
}

static size_t write_cb(char *ptr, size_t size, size_t nmemb, void *userdata) {
    struct resp_buf *b = (struct resp_buf *)userdata;
    size_t n = size * nmemb;
    if (!buf_reserve(b, n)) return 0;
    memcpy(b->data + b->len, ptr, n);
    b->len += n;
    b->data[b->len] = '\0';
    return n;
}

/* 响应头原样累积（含 CRLF）——JS 侧解析成对象，set-cookie 多条靠它恢复 */
static size_t header_cb(char *ptr, size_t size, size_t nmemb, void *userdata) {
    return write_cb(ptr, size, nmemb, userdata);
}

/* ---------------- JSON 输出缓冲（结果序列化） ---------------- */

static void jbuf_put(struct resp_buf *b, const char *s, size_t n) {
    if (!buf_reserve(b, n)) return;
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

static void jbuf_puts(struct resp_buf *b, const char *s) {
    jbuf_put(b, s, strlen(s));
}

static void jbuf_putc2(struct resp_buf *b, char ch) {
    jbuf_put(b, &ch, 1);
}

static void jbuf_put_int(struct resp_buf *b, long long v) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%lld", v);
    jbuf_put(b, tmp, strlen(tmp));
}

/* JSON 字符串字面量（UTF-8 原样透传，控制字符转义；与 PenBili 同款） */
static void jbuf_put_jstr(struct resp_buf *b, const char *s, size_t n) {
    size_t i;
    jbuf_putc2(b, '"');
    for (i = 0; i < n; i++) {
        unsigned char ch = (unsigned char)s[i];
        switch (ch) {
            case '"': jbuf_put(b, "\\\"", 2); break;
            case '\\': jbuf_put(b, "\\\\", 2); break;
            case '\n': jbuf_put(b, "\\n", 2); break;
            case '\r': jbuf_put(b, "\\r", 2); break;
            case '\t': jbuf_put(b, "\\t", 2); break;
            default:
                if (ch < 0x20) {
                    char tmp[8];
                    snprintf(tmp, sizeof(tmp), "\\u%04x", ch);
                    jbuf_put(b, tmp, strlen(tmp));
                } else {
                    jbuf_putc2(b, (char)ch);
                }
        }
    }
    jbuf_putc2(b, '"');
}

/* ---------------- 文件系统（同步、供 JS 线程直接调用） ---------------- */

static int path_exists(const char *p) {
    struct stat st;
    return stat(p, &st) == 0;
}

static int fs_stat_size(const char *p, long long *size, double *mtimeMs) {
    struct stat st;
    if (stat(p, &st) != 0) return 0;
    if (size) *size = (long long)st.st_size;
    if (mtimeMs) *mtimeMs = (double)st.st_mtime * 1000.0;
    return 1;
}

/* 递归建目录（mkdir -p 语义） */
static int mkdirs(const char *path) {
    char copy[1024];
    size_t len;
    size_t i;
    if (!path || !path[0]) return 0;
    len = strlen(path);
    if (len >= sizeof(copy)) return 0;
    memcpy(copy, path, len + 1);
    /* 去尾斜杠 */
    while (len > 1 && copy[len - 1] == '/') copy[--len] = '\0';
    for (i = 1; i < len; i++) {
        if (copy[i] == '/') {
            copy[i] = '\0';
            if (mkdir(copy, 0755) != 0 && errno != EEXIST) return 0;
            copy[i] = '/';
        }
    }
    if (mkdir(copy, 0755) != 0 && errno != EEXIST) return 0;
    return 1;
}

/* 取路径的父目录并递归创建；返回父目录串（调用方 free），失败 NULL */
static char *ensure_parent(const char *path) {
    const char *slash = strrchr(path, '/');
    size_t n;
    char *parent;
    if (!slash || slash == path) return dup_str("/");
    n = (size_t)(slash - path);
    parent = (char *)malloc(n + 1);
    if (!parent) return NULL;
    memcpy(parent, path, n);
    parent[n] = '\0';
    if (!mkdirs(parent)) {
        free(parent);
        return NULL;
    }
    return parent;
}

static int rm_recursive(const char *path) {
    struct stat st;
    DIR *d;
    struct dirent *e;
    if (lstat(path, &st) != 0) return 1; /* 本来不存在 = 成功 */
    if (S_ISDIR(st.st_mode)) {
        d = opendir(path);
        if (d) {
            char child[1152];
            while ((e = readdir(d)) != NULL) {
                if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
                snprintf(child, sizeof(child), "%s/%s", path, e->d_name);
                rm_recursive(child);
            }
            closedir(d);
        }
        return rmdir(path) == 0;
    }
    return unlink(path) == 0;
}

/* 读文本（上限 maxBytes 截断）；返回 malloc 串（调用方 free），失败 NULL */
static char *read_text_file(const char *path, size_t maxBytes, size_t *outLen) {
    FILE *f;
    char *buf;
    long sz;
    if (!path_exists(path)) return NULL;
    f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz < 0) {
        fclose(f);
        return NULL;
    }
    if ((size_t)sz > maxBytes) sz = (long)maxBytes;
    buf = (char *)malloc((size_t)sz + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    if (sz > 0) {
        size_t got = fread(buf, 1, (size_t)sz, f);
        sz = (long)got; /* 短读不视为失败：给出实际读到的部分 */
    }
    buf[sz] = '\0';
    fclose(f);
    *outLen = (size_t)sz;
    return buf;
}

/* 原子写文本：先写 <path>.tmp 再 rename；父目录不存在则递归创建 */
static int write_text_file(const char *path, const char *data, size_t len) {
    char tmp[1152];
    FILE *f;
    if (snprintf(tmp, sizeof(tmp), "%s.tmp", path) >= (int)sizeof(tmp)) return 0;
    if (!ensure_parent(path)) return 0;
    f = fopen(tmp, "wb");
    if (!f) return 0;
    if (len > 0 && fwrite(data, 1, len, f) != len) {
        fclose(f);
        unlink(tmp);
        return 0;
    }
    fclose(f);
    if (rename(tmp, path) != 0) {
        unlink(tmp);
        return 0;
    }
    return 1;
}

/* ---------------- 命令执行（fork + /bin/sh -c + 超时强杀） ---------------- */

struct exec_result {
    int code;
    int timedOut;
    char *stdoutBuf;
    size_t stdoutLen;
    char *stderrBuf;
    size_t stderrLen;
};

/* 从 fd 读进缓冲（超出 maxBuffer 后只保留前段，继续排空保证管道不堵死） */
static void drain_fd(int fd, char **buf, size_t *len, size_t maxBuffer) {
    char tmp[4096];
    for (;;) {
        ssize_t n = read(fd, tmp, sizeof(tmp));
        if (n <= 0) {
            if (n < 0 && errno == EINTR) continue;
            break;
        }
        if (*len + (size_t)n > maxBuffer) {
            /* 截断：只保留 maxBuffer 内的部分，然后停止累积 */
            size_t keep = maxBuffer > *len ? maxBuffer - *len : 0;
            if (keep > 0) {
                char *p = (char *)realloc(*buf, *len + keep + 1);
                if (p) {
                    *buf = p;
                    memcpy(*buf + *len, tmp, keep);
                    *len += keep;
                    (*buf)[*len] = '\0';
                }
            }
            break;
        }
        {
            char *p = (char *)realloc(*buf, *len + (size_t)n + 1);
            if (!p) break;
            *buf = p;
        }
        memcpy(*buf + *len, tmp, (size_t)n);
        *len += (size_t)n;
        (*buf)[*len] = '\0';
    }
}

static void run_command(const char *cmd, int timeoutMs, int maxBuffer, struct exec_result *out) {
    int outPipe[2], errPipe[2];
    pid_t pid;
    struct pollfd fds[2];
    long long deadline;
    int timedOut = 0;
    int status = 0;
    int i;

    memset(out, 0, sizeof(*out));
    out->code = -1;
    if (maxBuffer <= 0) maxBuffer = 262144;
    if (timeoutMs <= 0) timeoutMs = 15000;

    if (pipe(outPipe) != 0) return;
    if (pipe(errPipe) != 0) {
        close(outPipe[0]);
        close(outPipe[1]);
        return;
    }

    pid = fork();
    if (pid < 0) {
        close(outPipe[0]); close(outPipe[1]);
        close(errPipe[0]); close(errPipe[1]);
        return;
    }
    if (pid == 0) {
        /* 子进程：接管 stdout/stderr，exec /bin/sh -c cmd */
        dup2(outPipe[1], 1);
        dup2(errPipe[1], 2);
        close(outPipe[0]); close(outPipe[1]);
        close(errPipe[0]); close(errPipe[1]);
        signal(SIGPIPE, SIG_DFL);
        execl("/bin/sh", "sh", "-c", cmd, (char *)NULL);
        _exit(127);
    }

    close(outPipe[1]);
    close(errPipe[1]);

    deadline = (long long)now_ms() + timeoutMs;
    fds[0].fd = outPipe[0]; fds[0].events = POLLIN;
    fds[1].fd = errPipe[0]; fds[1].events = POLLIN;
    for (;;) {
        int alive = 0;
        int waitMs = 200; /* 分片 poll：便于按时检查超时 */
        for (i = 0; i < 2; i++) {
            if (fds[i].fd >= 0) alive++;
        }
        if (!alive) break;
        if (timedOut) {
            waitMs = 300; /* kill 之后的最后一轮：排空残余输出就退出 */
        } else {
            long long remain = deadline - (long long)now_ms();
            if (remain <= 0) {
                timedOut = 1;
                kill(pid, SIGKILL);
                waitMs = 300;
            } else if (remain < waitMs) {
                waitMs = (int)remain;
            }
        }
        {
            int rc = poll(fds, 2, waitMs);
            if (rc < 0 && errno == EINTR) continue;
            if (rc > 0) {
                for (i = 0; i < 2; i++) {
                    if (fds[i].fd >= 0 && (fds[i].revents & (POLLIN | POLLHUP | POLLERR))) {
                        if (i == 0) drain_fd(fds[i].fd, &out->stdoutBuf, &out->stdoutLen, (size_t)maxBuffer);
                        else drain_fd(fds[i].fd, &out->stderrBuf, &out->stderrLen, (size_t)maxBuffer);
                        if (fds[i].revents & (POLLHUP | POLLERR)) {
                            close(fds[i].fd);
                            fds[i].fd = -1;
                        }
                    }
                }
            }
        }
        if (timedOut) break;
    }
    /* 兜底排空（kill 后的残余输出） */
    if (fds[0].fd >= 0) { drain_fd(fds[0].fd, &out->stdoutBuf, &out->stdoutLen, (size_t)maxBuffer); close(fds[0].fd); }
    if (fds[1].fd >= 0) { drain_fd(fds[1].fd, &out->stderrBuf, &out->stderrLen, (size_t)maxBuffer); close(fds[1].fd); }

    waitpid(pid, &status, 0);
    if (WIFEXITED(status)) out->code = WEXITSTATUS(status);
    else out->code = -1;
    out->timedOut = timedOut;
    if (!out->stdoutBuf) out->stdoutBuf = dup_str("");
    if (!out->stderrBuf) out->stderrBuf = dup_str("");
    if (out->timedOut) out->code = -1;
}

/* ---------------- HTTP（libcurl，job 线程里跑） ---------------- */

static int g_insecure_hint = 0; /* 见过一次证书错误后直接跳过校验（X5 无 CA 库） */

static int is_cert_error(int code) {
    switch (code) {
        case 35: case 51: case 58: case 59: case 60:
        case 66: case 77: case 83: case 90: case 91:
            return 1;
        default:
            return 0;
    }
}

/* headersText: "Key: value\nKey2: v2"（\r\n 或 \n 均可）→ CURL_slist */
static CURL_slist *parse_header_lines(const char *headersText) {
    CURL_slist *list = NULL;
    char *copy;
    char *save = NULL;
    char *line;
    if (!headersText || !headersText[0]) return NULL;
    copy = dup_str(headersText);
    if (!copy) return NULL;
    line = strtok_r(copy, "\n", &save);
    while (line) {
        size_t l = strlen(line);
        while (l && (line[l - 1] == '\r' || line[l - 1] == ' ')) line[--l] = '\0';
        if (l) list = curl_slist_append(list, line);
        line = strtok_r(NULL, "\n", &save);
    }
    free(copy);
    return list;
}

struct http_result {
    long status;
    int curlCode;
    char *errMsg;
    struct resp_buf body;
    struct resp_buf headers;
    int insecure;
};

/* method: "GET"/"POST"；body/bodyLen 为 POST 体（可为空） */
static void do_http(const char *url, const char *method, const char *headersText,
                    const char *body, long bodyLen, long timeoutMs, int insecure,
                    struct http_result *out) {
    CURL *h;
    CURL_slist *list = NULL;
    int code;
    int isPost = (method && strcmp(method, "POST") == 0);

    memset(out, 0, sizeof(*out));

    h = curl_easy_init();
    if (!h) {
        out->errMsg = dup_str("curl_easy_init failed");
        out->curlCode = -1;
        return;
    }
    list = parse_header_lines(headersText);

    curl_easy_setopt(h, CURLOPT_URL, url);
    if (list) curl_easy_setopt(h, CURLOPT_HTTPHEADER, list);
    if (isPost) {
        curl_easy_setopt(h, CURLOPT_POST, 1L);
        curl_easy_setopt(h, CURLOPT_POSTFIELDS, body ? body : "");
        curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, bodyLen);
    }
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &out->body);
    curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, header_cb);
    curl_easy_setopt(h, CURLOPT_HEADERDATA, &out->headers);
    curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, timeoutMs > 0 ? timeoutMs : 12000L);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT_MS, 15000L);
    curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);
    if (insecure) {
        curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, 0L);
        curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, 0L);
    } else {
        curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, 2L);
    }

    code = curl_easy_perform(h);
    out->curlCode = code;
    out->insecure = insecure;
    if (code == 0) {
        curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &out->status);
    } else {
        char tmp[128];
        const char *msg = curl_easy_strerror(code);
        snprintf(tmp, sizeof(tmp), "curl#%d: %s", code, msg ? msg : "unknown");
        out->errMsg = dup_str(tmp);
    }
    if (list) curl_slist_free_all(list);
    curl_easy_cleanup(h);
}

/* download：整文件落盘（原子：tmp + rename）；JS 侧进度轮询走 fsSize */
struct dl_result {
    int ok;
    long status;
    long long size;
    char *errMsg;
    int insecure;
};

static void do_download(const char *url, const char *outPath, const char *headersText,
                        long timeoutMs, int insecure, struct dl_result *out) {
    CURL *h;
    CURL_slist *list = NULL;
    int code;
    char tmp[1152];
    FILE *f;

    memset(out, 0, sizeof(*out));
    if (snprintf(tmp, sizeof(tmp), "%s.tmp", outPath) >= (int)sizeof(tmp)) {
        out->errMsg = dup_str("path too long");
        return;
    }
    if (!ensure_parent(outPath)) {
        out->errMsg = dup_str("mkdir parent failed");
        return;
    }
    f = fopen(tmp, "wb");
    if (!f) {
        out->errMsg = dup_str("fopen failed");
        return;
    }

    h = curl_easy_init();
    if (!h) {
        fclose(f);
        unlink(tmp);
        out->errMsg = dup_str("curl_easy_init failed");
        return;
    }
    list = parse_header_lines(headersText);
    curl_easy_setopt(h, CURLOPT_URL, url);
    if (list) curl_easy_setopt(h, CURLOPT_HTTPHEADER, list);
    /* 不设 WRITEFUNCTION：curl 默认回调就是 fwrite，WRITEDATA 传 FILE* 直接落盘 */
    curl_easy_setopt(h, CURLOPT_WRITEDATA, f);
    curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, timeoutMs > 0 ? timeoutMs : 60000L);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT_MS, 15000L);
    curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 1L);
    curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);
    if (insecure) {
        curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, 0L);
        curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, 0L);
    } else {
        curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, 1L);
        curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, 2L);
    }

    code = curl_easy_perform(h);
    if (code == 0) {
        curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &out->status);
    } else {
        char t2[128];
        const char *msg = curl_easy_strerror(code);
        snprintf(t2, sizeof(t2), "curl#%d: %s", code, msg ? msg : "unknown");
        out->errMsg = dup_str(t2);
    }
    if (list) curl_slist_free_all(list);
    curl_easy_cleanup(h);
    fclose(f);

    if (code == 0 && out->status >= 200 && out->status < 400) {
        if (rename(tmp, outPath) == 0) {
            long long sz = 0;
            fs_stat_size(outPath, &sz, NULL);
            out->size = sz;
            out->ok = 1;
        } else {
            out->errMsg = dup_str("rename failed");
            unlink(tmp);
        }
    } else {
        unlink(tmp);
        if (!out->errMsg) out->errMsg = dup_str("http status error");
    }
    out->insecure = insecure;
}

/* ---------------- 任务队列（后台线程 + JS 轮询） ---------------- */

#define JOB_REQ 1
#define JOB_DL 2
#define JOB_EXEC 3

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

static struct job *g_jobs = NULL;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static int g_next_id = 1;

static void job_free(struct job *j) {
    free(j->url);
    free(j->method);
    free(j->headers);
    free(j->body);
    free(j->outPath);
    free(j->cmd);
    free(j->result);
    free(j);
}

static void job_finish(struct job *j, char *resultJson) {
    pthread_mutex_lock(&g_mu);
    j->result = resultJson;
    j->state = 1;
    if (j->cancelled) {
        struct job **pp = &g_jobs;
        while (*pp && *pp != j) pp = &(*pp)->next;
        if (*pp == j) *pp = j->next;
        pthread_mutex_unlock(&g_mu);
        job_free(j);
        return;
    }
    pthread_mutex_unlock(&g_mu);
}

static void *job_thread(void *arg) {
    struct job *j = (struct job *)arg;
    struct resp_buf out;
    memset(&out, 0, sizeof(out));

    if (j->kind == JOB_REQ) {
        int insecure = g_insecure_hint;
        struct http_result r;
        memset(&r, 0, sizeof(r));
        do_http(j->url, j->method, j->headers, j->body, j->bodyLen, j->timeoutMs, insecure, &r);
        if (r.errMsg && !insecure && is_cert_error(r.curlCode)) {
            /* X5 无 CA 库：跳过校验重试一次，并记全局标志（后续请求不再双跑） */
            g_insecure_hint = 1;
            if (r.body.data) { free(r.body.data); r.body.data = NULL; r.body.len = 0; }
            if (r.headers.data) { free(r.headers.data); r.headers.data = NULL; r.headers.len = 0; }
            free(r.errMsg);
            r.errMsg = NULL;
            do_http(j->url, j->method, j->headers, j->body, j->bodyLen, j->timeoutMs, 1, &r);
            r.insecure = 1;
        }
        jbuf_puts(&out, "{\"kind\":\"req\",\"status\":");
        jbuf_put_int(&out, r.status);
        jbuf_puts(&out, ",\"curlCode\":");
        jbuf_put_int(&out, r.curlCode);
        jbuf_puts(&out, ",\"insecure\":");
        jbuf_put_int(&out, r.insecure ? 1 : 0);
        jbuf_puts(&out, ",\"error\":");
        if (r.errMsg) jbuf_put_jstr(&out, r.errMsg, strlen(r.errMsg));
        else jbuf_puts(&out, "null");
        jbuf_puts(&out, ",\"headers\":");
        jbuf_put_jstr(&out, r.headers.data ? r.headers.data : "", r.headers.len);
        jbuf_puts(&out, ",\"body\":");
        jbuf_put_jstr(&out, r.body.data ? r.body.data : "", r.body.len);
        jbuf_putc2(&out, '}');
        if (r.body.data) free(r.body.data);
        if (r.headers.data) free(r.headers.data);
        free(r.errMsg);
    } else if (j->kind == JOB_DL) {
        int insecure = g_insecure_hint;
        struct dl_result r;
        memset(&r, 0, sizeof(r));
        do_download(j->url, j->outPath, j->headers, j->timeoutMs, insecure, &r);
        if (!r.ok && !insecure) {
            /* X5 无 CA 库：失败（含证书错误）时跳过校验重试一次 */
            struct dl_result r2;
            memset(&r2, 0, sizeof(r2));
            do_download(j->url, j->outPath, j->headers, j->timeoutMs, 1, &r2);
            r2.insecure = 1;
            if (r2.ok) {
                if (r.errMsg) free(r.errMsg);
                r = r2;
            } else if (r2.errMsg) {
                free(r2.errMsg);
            }
        }
        jbuf_puts(&out, "{\"kind\":\"dl\",\"ok\":");
        jbuf_put_int(&out, r.ok ? 1 : 0);
        jbuf_puts(&out, ",\"status\":");
        jbuf_put_int(&out, r.status);
        jbuf_puts(&out, ",\"size\":");
        jbuf_put_int(&out, r.size);
        jbuf_puts(&out, ",\"insecure\":");
        jbuf_put_int(&out, r.insecure ? 1 : 0);
        jbuf_puts(&out, ",\"error\":");
        if (r.errMsg) jbuf_put_jstr(&out, r.errMsg, strlen(r.errMsg));
        else jbuf_puts(&out, "null");
        jbuf_putc2(&out, '}');
        free(r.errMsg);
    } else { /* JOB_EXEC */
        struct exec_result r;
        run_command(j->cmd, (int)j->timeoutMs, j->maxBuffer, &r);
        jbuf_puts(&out, "{\"kind\":\"exec\",\"code\":");
        jbuf_put_int(&out, r.code);
        jbuf_puts(&out, ",\"timedOut\":");
        jbuf_put_int(&out, r.timedOut ? 1 : 0);
        jbuf_puts(&out, ",\"error\":");
        if (r.timedOut) jbuf_puts(&out, "\"timeout\"");
        else jbuf_puts(&out, "null");
        jbuf_puts(&out, ",\"stdout\":");
        jbuf_put_jstr(&out, r.stdoutBuf ? r.stdoutBuf : "", r.stdoutLen);
        jbuf_puts(&out, ",\"stderr\":");
        jbuf_put_jstr(&out, r.stderrBuf ? r.stderrBuf : "", r.stderrLen);
        jbuf_putc2(&out, '}');
        free(r.stdoutBuf);
        free(r.stderrBuf);
    }

    job_finish(j, out.data); /* out.data 归 job 队列所有 */
    return NULL;
}

static int start_job(struct job *j) {
    pthread_t th;
    struct job **pp;
    pthread_mutex_lock(&g_mu);
    j->id = g_next_id++;
    j->next = g_jobs;
    g_jobs = j;
    pthread_mutex_unlock(&g_mu);
    if (pthread_create(&th, NULL, job_thread, j) != 0) {
        pthread_mutex_lock(&g_mu);
        pp = &g_jobs;
        while (*pp && *pp != j) pp = &(*pp)->next;
        if (*pp == j) *pp = j->next;
        pthread_mutex_unlock(&g_mu);
        job_free(j);
        return 0;
    }
    pthread_detach(th);
    return j->id;
}

/* ---------------- JS 绑定 ---------------- */

static JSValue js_version(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    (void)this_val; (void)argc; (void)argv;
    return JS_NewString(ctx, BPNNET_VERSION);
}

static JSValue js_fs_exists(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *p;
    int ok;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fsExists(path)");
    p = JS_ToCString(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    ok = path_exists(p);
    JS_FreeCString(ctx, p);
    return JS_NewBool(ctx, ok);
}

static JSValue js_fs_size(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *p;
    long long sz = 0;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fsSize(path)");
    p = JS_ToCString(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    fs_stat_size(p, &sz, NULL);
    JS_FreeCString(ctx, p);
    return JS_NewInt64(ctx, sz);
}

static JSValue js_fs_mtime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *p;
    double ms = 0;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fsMtime(path)");
    p = JS_ToCString(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    fs_stat_size(p, NULL, &ms);
    JS_FreeCString(ctx, p);
    return JS_NewFloat64(ctx, ms);
}

static JSValue js_fs_readdir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *p;
    JSValue arr;
    DIR *d;
    uint32_t i = 0;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fsReaddir(path)");
    p = JS_ToCString(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    arr = JS_NewArray(ctx);
    d = opendir(p);
    if (d) {
        struct dirent *e;
        while ((e = readdir(d)) != NULL) {
            if (strcmp(e->d_name, ".") == 0 || strcmp(e->d_name, "..") == 0) continue;
            JS_DefinePropertyValueUint32(ctx, arr, i++, JS_NewString(ctx, e->d_name), JS_PROP_C_W_E);
        }
        closedir(d);
    }
    JS_FreeCString(ctx, p);
    return arr;
}

static JSValue js_fs_read_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *p;
    int maxBytes = 2 * 1024 * 1024;
    size_t len = 0;
    char *buf;
    JSValue s;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fsReadText(path[, maxBytes])");
    p = JS_ToCString(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &maxBytes, argv[1]);
    if (maxBytes <= 0) maxBytes = 2 * 1024 * 1024;
    buf = read_text_file(p, (size_t)maxBytes, &len);
    JS_FreeCString(ctx, p);
    if (!buf) return JS_NewString(ctx, "");
    s = JS_NewStringLen(ctx, buf, len);
    free(buf);
    return s;
}

static JSValue js_fs_write_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *p;
    const char *text;
    const char *toFree = NULL;
    size_t len = 0;
    int ok;
    (void)this_val;
    if (argc < 2) return JS_ThrowTypeError(ctx, "fsWriteText(path, text)");
    p = JS_ToCString(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    if (JS_IsUndefined(argv[1]) || JS_IsNull(argv[1])) {
        text = "";
        len = 0;
    } else {
        text = JS_ToCStringLen(ctx, &len, argv[1]);
        if (!text) {
            JS_FreeCString(ctx, p);
            return JS_EXCEPTION;
        }
        toFree = text;
    }
    ok = write_text_file(p, text, len);
    JS_FreeCString(ctx, p);
    if (toFree) JS_FreeCString(ctx, toFree);
    return JS_NewBool(ctx, ok);
}

static JSValue js_fs_mkdir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *p;
    int ok;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fsMkdir(path)");
    p = JS_ToCString(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    ok = mkdirs(p);
    JS_FreeCString(ctx, p);
    return JS_NewBool(ctx, ok);
}

static JSValue js_fs_rm(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *p;
    int recursive = 0;
    int ok;
    struct stat st;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "fsRm(path[, recursive])");
    p = JS_ToCString(ctx, argv[0]);
    if (!p) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &recursive, argv[1]);
    if (recursive) {
        ok = rm_recursive(p);
    } else {
        if (lstat(p, &st) == 0 && S_ISDIR(st.st_mode)) ok = (rmdir(p) == 0);
        else ok = (unlink(p) == 0) || (lstat(p, &st) != 0); /* 不存在也算成功 */
    }
    JS_FreeCString(ctx, p);
    return JS_NewBool(ctx, ok);
}

static JSValue js_fs_rename(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *from, *to;
    int ok;
    (void)this_val;
    if (argc < 2) return JS_ThrowTypeError(ctx, "fsRename(from, to)");
    from = JS_ToCString(ctx, argv[0]);
    to = JS_ToCString(ctx, argv[1]);
    if (!from || !to) {
        if (from) JS_FreeCString(ctx, from);
        if (to) JS_FreeCString(ctx, to);
        return JS_EXCEPTION;
    }
    ok = (rename(from, to) == 0);
    JS_FreeCString(ctx, from);
    JS_FreeCString(ctx, to);
    return JS_NewBool(ctx, ok);
}

/* startRequest(url, method, headersText, body|null, timeoutMs) → id */
static JSValue js_start_request(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *url, *method = NULL, *headers = NULL, *body = NULL;
    size_t bodyLen = 0;
    int timeoutMs = 12000;
    struct job *j;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "startRequest(url, method, headers, body, timeoutMs)");
    url = JS_ToCString(ctx, argv[0]);
    if (!url) return JS_EXCEPTION;
    if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) method = JS_ToCString(ctx, argv[1]);
    if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) headers = JS_ToCString(ctx, argv[2]);
    if (argc > 3 && !JS_IsUndefined(argv[3]) && !JS_IsNull(argv[3])) body = JS_ToCStringLen(ctx, &bodyLen, argv[3]);
    if (argc > 4) JS_ToInt32(ctx, &timeoutMs, argv[4]);

    j = (struct job *)calloc(1, sizeof(struct job));
    if (!j) {
        JS_FreeCString(ctx, url);
        if (method) JS_FreeCString(ctx, method);
        if (headers) JS_FreeCString(ctx, headers);
        if (body) JS_FreeCString(ctx, body);
        return JS_ThrowInternalError(ctx, "bpnnet: out of memory");
    }
    j->kind = JOB_REQ;
    j->url = dup_str(url);
    j->method = dup_str(method ? method : "GET");
    j->headers = dup_str(headers ? headers : "");
    j->body = body ? dup_str(body) : dup_str("");
    j->bodyLen = (long)bodyLen;
    j->timeoutMs = timeoutMs > 0 ? timeoutMs : 12000;
    j->state = 0;
    JS_FreeCString(ctx, url);
    if (method) JS_FreeCString(ctx, method);
    if (headers) JS_FreeCString(ctx, headers);
    if (body) JS_FreeCString(ctx, body);
    if (!j->url || !j->method || !j->headers || !j->body) {
        job_free(j);
        return JS_ThrowInternalError(ctx, "bpnnet: out of memory");
    }
    return JS_NewInt32(ctx, start_job(j));
}

/* startDownload(url, outPath, headersText, timeoutMs) → id */
static JSValue js_start_download(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *url, *outPath, *headers = NULL;
    int timeoutMs = 60000;
    struct job *j;
    (void)this_val;
    if (argc < 2) return JS_ThrowTypeError(ctx, "startDownload(url, outPath, headers, timeoutMs)");
    url = JS_ToCString(ctx, argv[0]);
    outPath = JS_ToCString(ctx, argv[1]);
    if (!url || !outPath) {
        if (url) JS_FreeCString(ctx, url);
        if (outPath) JS_FreeCString(ctx, outPath);
        return JS_EXCEPTION;
    }
    if (argc > 2 && !JS_IsUndefined(argv[2]) && !JS_IsNull(argv[2])) headers = JS_ToCString(ctx, argv[2]);
    if (argc > 3) JS_ToInt32(ctx, &timeoutMs, argv[3]);

    j = (struct job *)calloc(1, sizeof(struct job));
    if (!j) {
        JS_FreeCString(ctx, url);
        JS_FreeCString(ctx, outPath);
        if (headers) JS_FreeCString(ctx, headers);
        return JS_ThrowInternalError(ctx, "bpnnet: out of memory");
    }
    j->kind = JOB_DL;
    j->url = dup_str(url);
    j->outPath = dup_str(outPath);
    j->headers = dup_str(headers ? headers : "");
    j->timeoutMs = timeoutMs > 0 ? timeoutMs : 60000;
    j->state = 0;
    JS_FreeCString(ctx, url);
    JS_FreeCString(ctx, outPath);
    if (headers) JS_FreeCString(ctx, headers);
    if (!j->url || !j->outPath || !j->headers) {
        job_free(j);
        return JS_ThrowInternalError(ctx, "bpnnet: out of memory");
    }
    return JS_NewInt32(ctx, start_job(j));
}

/* startExec(cmd, timeoutMs, maxBuffer) → id */
static JSValue js_start_exec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    const char *cmd;
    int timeoutMs = 15000, maxBuffer = 262144;
    struct job *j;
    (void)this_val;
    if (argc < 1) return JS_ThrowTypeError(ctx, "startExec(cmd, timeoutMs, maxBuffer)");
    cmd = JS_ToCString(ctx, argv[0]);
    if (!cmd) return JS_EXCEPTION;
    if (argc > 1) JS_ToInt32(ctx, &timeoutMs, argv[1]);
    if (argc > 2) JS_ToInt32(ctx, &maxBuffer, argv[2]);

    j = (struct job *)calloc(1, sizeof(struct job));
    if (!j) {
        JS_FreeCString(ctx, cmd);
        return JS_ThrowInternalError(ctx, "bpnnet: out of memory");
    }
    j->kind = JOB_EXEC;
    j->cmd = dup_str(cmd);
    j->timeoutMs = timeoutMs > 0 ? timeoutMs : 15000;
    j->maxBuffer = maxBuffer > 0 ? maxBuffer : 262144;
    j->state = 0;
    JS_FreeCString(ctx, cmd);
    if (!j->cmd) {
        job_free(j);
        return JS_ThrowInternalError(ctx, "bpnnet: out of memory");
    }
    return JS_NewInt32(ctx, start_job(j));
}

/* takeResult(id) → 结果 JSON 字符串；未完成/不存在返回 null */
static JSValue js_take_result(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    int id = 0;
    struct job *j = NULL;
    struct job **pp = NULL;
    JSValue res;
    (void)this_val;
    if (argc < 1) return JS_NULL;
    JS_ToInt32(ctx, &id, argv[0]);
    if (id <= 0) return JS_NULL;

    pthread_mutex_lock(&g_mu);
    pp = &g_jobs;
    while (*pp && (*pp)->id != id) pp = &(*pp)->next;
    j = *pp;
    if (!j || j->state != 1) {
        pthread_mutex_unlock(&g_mu);
        return JS_NULL;
    }
    *pp = j->next;
    pthread_mutex_unlock(&g_mu);

    res = JS_NewString(ctx, j->result ? j->result : "{}");
    job_free(j);
    return res;
}

/* cancelAll()：丢弃所有已完成结果，进行中的标记取消（完成后自行回收） */
static JSValue js_cancel_all(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    struct job **pp = NULL;
    (void)this_val; (void)argc; (void)argv;
    pthread_mutex_lock(&g_mu);
    pp = &g_jobs;
    while (*pp) {
        struct job *j = *pp;
        if (j->state == 1) {
            *pp = j->next;
            job_free(j);
        } else {
            j->cancelled = 1;
            pp = &j->next;
        }
    }
    pthread_mutex_unlock(&g_mu);
    return JS_UNDEFINED;
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
