/* bpnnet_fs.c —— fs 能力：同步文件系统实现（stat / 递归目录 / 读文本 / 原子写）+ JS 绑定。 */

#include "bpnnet_internal.h"

/* ---------------- 文件系统（同步、供 JS 线程直接调用） ---------------- */

static int path_exists(const char *p) {
    struct stat st;
    return stat(p, &st) == 0;
}

int fs_stat_size(const char *p, long long *size, double *mtimeMs) {
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
char *ensure_parent(const char *path) {
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

/* ---------------- JS 绑定 ---------------- */

JSValue js_fs_exists(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

JSValue js_fs_size(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

JSValue js_fs_mtime(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

JSValue js_fs_readdir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

JSValue js_fs_read_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

JSValue js_fs_write_text(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

JSValue js_fs_mkdir(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

JSValue js_fs_rm(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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

JSValue js_fs_rename(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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
