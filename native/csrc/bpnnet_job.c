/* bpnnet_job.c —— 任务队列：后台线程 + JS 轮询（takeResult/cancelAll）。 */

#include "bpnnet_internal.h"

/* ---------------- 任务队列（后台线程 + JS 轮询） ---------------- */

static struct job *g_jobs = NULL;
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static int g_next_id = 1;

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

void job_free(struct job *j) {
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

int start_job(struct job *j) {
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

/* takeResult(id) → 结果 JSON 字符串；未完成/不存在返回 null */
JSValue js_take_result(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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
JSValue js_cancel_all(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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
