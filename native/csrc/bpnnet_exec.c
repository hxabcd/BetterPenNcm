/* bpnnet_exec.c —— process.exec 能力：fork + /bin/sh -c + 超时强杀 + JS 绑定。 */

#include "bpnnet_internal.h"

/* ---------------- 命令执行（fork + /bin/sh -c + 超时强杀） ---------------- */

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

void run_command(const char *cmd, int timeoutMs, int maxBuffer, struct exec_result *out) {
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

/* startExec(cmd, timeoutMs, maxBuffer) → id */
JSValue js_start_exec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
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
