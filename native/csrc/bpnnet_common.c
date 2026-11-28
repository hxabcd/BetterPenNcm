/* bpnnet_common.c —— 跨能力共用的最小工具：时间、字符串、响应/JSON 输出缓冲。 */

#include "bpnnet_internal.h"

long long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

/* ---------------- 通用小工具 ---------------- */

char *dup_str(const char *s) {
    size_t n;
    char *p;
    if (!s) return NULL;
    n = strlen(s) + 1;
    p = (char *)malloc(n);
    if (p) memcpy(p, s, n);
    return p;
}

size_t buf_reserve(struct resp_buf *b, size_t need) {
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

/* ---------------- JSON 输出缓冲（结果序列化） ---------------- */

void jbuf_put(struct resp_buf *b, const char *s, size_t n) {
    if (!buf_reserve(b, n)) return;
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

void jbuf_puts(struct resp_buf *b, const char *s) {
    jbuf_put(b, s, strlen(s));
}

void jbuf_putc2(struct resp_buf *b, char ch) {
    jbuf_put(b, &ch, 1);
}

void jbuf_put_int(struct resp_buf *b, long long v) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%lld", v);
    jbuf_put(b, tmp, strlen(tmp));
}

/* JSON 字符串字面量（UTF-8 原样透传，控制字符转义；与 PenBili 同款） */
void jbuf_put_jstr(struct resp_buf *b, const char *s, size_t n) {
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
