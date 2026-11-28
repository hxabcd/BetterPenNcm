/* bpnnet_http.c —— http 能力：libcurl 请求 / 整文件下载 + JS 绑定（startRequest/startDownload）。 */

#include "bpnnet_internal.h"

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

/* ---------------- curl 回调 ---------------- */

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

/* ---------------- HTTP（libcurl，job 线程里跑） ---------------- */

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

/* method: "GET"/"POST"；body/bodyLen 为 POST 体（可为空） */
void do_http(const char *url, const char *method, const char *headersText,
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

void do_download(const char *url, const char *outPath, const char *headersText,
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

/* ---------------- JS 绑定 ---------------- */

/* startRequest(url, method, headersText, body|null, timeoutMs) → id */
JSValue js_start_request(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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
JSValue js_start_download(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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
