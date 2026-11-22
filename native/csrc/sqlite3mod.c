/*
 * sqlite3 —— 给 X3S 补回 S7 运行时的原生 sqlite3 裸模块（纯 C）
 *
 * 背景：X3S（RK3566，fw 3.4.5）的小程序运行时没有 sqlite3 裸模块，而本应用的
 * 状态库（state.db：配置/登录态/播放会话/每曲元数据与歌词）与索引库
 * （local_index.db）都建立在它之上（见 src/core/platform/db.js）。
 * 设备自带 libsqlite3.so.0，因此这里用同一套「随 .amr 打进 libs/ 的原生扩展」
 * 机制（由 libfalcon 的 dynamic_load_jsapi 加载 → custom_init_jsapis →
 * registerCModuleLoader）注册一个与 S7 模块同形状的 `sqlite3`：
 *
 *   const { Database } = (await import('sqlite3')).default
 *   const db = new Database(); await db.open(path); await db.exec(sql)
 *   const st = await db.prepare(sql); await st.bind([...]); await st.run()
 *   const rows = await st.all(); await st.columnNameList(); await st.finalize()
 *
 * 这是 db.js 实际使用的**最小面**（S7 原生模块的其他成员没有被本项目用到）。
 * 所有方法同步实现；上层 `await` 对非 Promise 值与 Promise 一视同仁。
 *
 * 只在 aarch64（X3S）上构建：S7/X5 是 armhf，动态加载器不会加载本 .so，
 * 因此两机型的既有行为不受影响。
 *
 * 行值约定与 S7 原生模块一致：`all()` 返回**按列顺序的数组的数组**，
 * 由 db.js 用 `columnNameList()` 对齐成对象（见 db.js 的 toObjects）。
 */

#include <jquick_config.h>
#include <jsmodules/JSCModuleExtension.h>
#include <quickjs/quickjs.h>

#include <sqlite3.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------------- 句柄 ---------------- */

typedef struct {
    sqlite3 *db;
} BpDb;

typedef struct {
    sqlite3_stmt *st;
    BpDb *owner;
} BpStmt;

static JSClassID db_class_id;
static JSClassID stmt_class_id;

static void db_finalizer(JSRuntime *rt, JSValue val) {
    BpDb *d = (BpDb *)JS_GetOpaque(val, db_class_id);
    (void)rt;
    if (!d) return;
    if (d->db) sqlite3_close(d->db);
    free(d);
}

static void stmt_finalizer(JSRuntime *rt, JSValue val) {
    BpStmt *s = (BpStmt *)JS_GetOpaque(val, stmt_class_id);
    (void)rt;
    if (!s) return;
    if (s->st) sqlite3_finalize(s->st);
    free(s);
}

static const JSClassDef db_class_def = {
    "Database",
    .finalizer = db_finalizer,
};

static const JSClassDef stmt_class_def = {
    "Statement",
    .finalizer = stmt_finalizer,
};

static BpDb *db_of(JSContext *ctx, JSValueConst val) {
    BpDb *d = (BpDb *)JS_GetOpaque(val, db_class_id);
    if (!d) {
        JS_ThrowTypeError(ctx, "非法 Database 实例");
        return NULL;
    }
    return d;
}

static BpStmt *stmt_of(JSContext *ctx, JSValueConst val) {
    BpStmt *s = (BpStmt *)JS_GetOpaque(val, stmt_class_id);
    if (!s) {
        JS_ThrowTypeError(ctx, "非法 Statement 实例");
        return NULL;
    }
    if (!s->st) {
        JS_ThrowTypeError(ctx, "Statement 已结束");
        return NULL;
    }
    return s;
}

/* ---------------- Database ---------------- */

static JSValue db_ctor(JSContext *ctx, JSValueConst new_target, int argc, JSValueConst *argv) {
    BpDb *d;
    JSValue obj;
    (void)new_target;
    (void)argc;
    (void)argv;
    d = (BpDb *)calloc(1, sizeof(BpDb));
    if (!d) return JS_ThrowOutOfMemory(ctx);
    obj = JS_NewObjectClass(ctx, db_class_id);
    if (JS_IsException(obj)) {
        free(d);
        return obj;
    }
    JS_SetOpaque(obj, d);
    return obj;
}

static JSValue db_open(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpDb *d = db_of(ctx, this_val);
    const char *path;
    int rc;
    if (!d) return JS_EXCEPTION;
    if (argc < 1) return JS_ThrowTypeError(ctx, "open(path) 缺 path");
    path = JS_ToCString(ctx, argv[0]);
    if (!path) return JS_EXCEPTION;
    if (d->db) {
        sqlite3_close(d->db);
        d->db = NULL;
    }
    rc = sqlite3_open(path, &d->db);
    if (rc != SQLITE_OK) {
        JSValue out = JS_NewString(ctx, d->db ? sqlite3_errmsg(d->db) : "sqlite3_open 失败");
        if (d->db) {
            sqlite3_close(d->db);
            d->db = NULL;
        }
        JS_FreeCString(ctx, path);
        return out;
    }
    sqlite3_busy_timeout(d->db, 3000);
    JS_FreeCString(ctx, path);
    return JS_NewInt32(ctx, 0);
}

static JSValue db_exec(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpDb *d = db_of(ctx, this_val);
    const char *sql;
    char *err = NULL;
    int rc;
    if (!d) return JS_EXCEPTION;
    if (argc < 1) return JS_ThrowTypeError(ctx, "exec(sql) 缺 sql");
    if (!d->db) return JS_NewString(ctx, "数据库未打开");
    sql = JS_ToCString(ctx, argv[0]);
    if (!sql) return JS_EXCEPTION;
    rc = sqlite3_exec(d->db, sql, NULL, NULL, &err);
    JS_FreeCString(ctx, sql);
    if (rc != SQLITE_OK) {
        JSValue out = JS_NewString(ctx, err ? err : sqlite3_errmsg(d->db));
        if (err) sqlite3_free(err);
        return out;
    }
    if (err) sqlite3_free(err);
    return JS_NewInt32(ctx, 0);
}

static JSValue db_prepare(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpDb *d = db_of(ctx, this_val);
    const char *sql;
    sqlite3_stmt *st = NULL;
    BpStmt *s;
    JSValue obj;
    int rc;
    if (!d) return JS_EXCEPTION;
    if (argc < 1) return JS_ThrowTypeError(ctx, "prepare(sql) 缺 sql");
    if (!d->db) return JS_NULL;
    sql = JS_ToCString(ctx, argv[0]);
    if (!sql) return JS_EXCEPTION;
    rc = sqlite3_prepare_v2(d->db, sql, -1, &st, NULL);
    JS_FreeCString(ctx, sql);
    if (rc != SQLITE_OK || !st) {
        if (st) sqlite3_finalize(st);
        return JS_NULL;
    }
    s = (BpStmt *)calloc(1, sizeof(BpStmt));
    if (!s) {
        sqlite3_finalize(st);
        return JS_ThrowOutOfMemory(ctx);
    }
    s->st = st;
    s->owner = d;
    obj = JS_NewObjectClass(ctx, stmt_class_id);
    if (JS_IsException(obj)) {
        sqlite3_finalize(st);
        free(s);
        return obj;
    }
    JS_SetOpaque(obj, s);
    return obj;
}

static JSValue db_close(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpDb *d = db_of(ctx, this_val);
    (void)argc;
    (void)argv;
    if (!d) return JS_EXCEPTION;
    if (d->db) {
        sqlite3_close(d->db);
        d->db = NULL;
    }
    return JS_UNDEFINED;
}

static int js_array_len(JSContext *ctx, JSValueConst arr) {
    JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
    int32_t n = 0;
    if (JS_IsException(lenv)) return 0;
    if (JS_ToInt32(ctx, &n, lenv) < 0) n = 0;
    JS_FreeValue(ctx, lenv);
    return n > 0 ? (int)n : 0;
}

/* ---------------- Statement ---------------- */

static JSValue st_bind(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpStmt *s = stmt_of(ctx, this_val);
    int len, i;
    if (!s) return JS_EXCEPTION;
    if (argc < 1) return JS_ThrowTypeError(ctx, "bind(params) 缺 params");
    if (!JS_IsArray(ctx, argv[0])) return JS_ThrowTypeError(ctx, "bind 参数必须是数组");
    len = js_array_len(ctx, argv[0]);
    for (i = 0; i < len; i++) {
        JSValue v = JS_GetPropertyUint32(ctx, argv[0], (uint32_t)i);
        int idx = i + 1;
        int rc = SQLITE_OK;
        if (JS_IsException(v)) return JS_EXCEPTION;
        if (JS_IsNull(v) || JS_IsUndefined(v)) {
            rc = sqlite3_bind_null(s->st, idx);
        } else if (JS_IsBool(v)) {
            rc = sqlite3_bind_int(s->st, idx, JS_ToBool(ctx, v) ? 1 : 0);
        } else if (JS_IsNumber(v)) {
            double d = 0;
            if (JS_ToFloat64(ctx, &d, v) < 0) {
                JS_FreeValue(ctx, v);
                return JS_EXCEPTION;
            }
            if (d == (double)(int64_t)d) {
                rc = sqlite3_bind_int64(s->st, idx, (sqlite3_int64)d);
            } else {
                rc = sqlite3_bind_double(s->st, idx, d);
            }
        } else if (JS_IsString(v)) {
            size_t n = 0;
            const char *str = JS_ToCStringLen(ctx, &n, v);
            if (!str) {
                JS_FreeValue(ctx, v);
                return JS_EXCEPTION;
            }
            rc = sqlite3_bind_text(s->st, idx, str, (int)n, SQLITE_TRANSIENT);
            JS_FreeCString(ctx, str);
        } else {
            size_t n = 0;
            const char *str = JS_ToCStringLen(ctx, &n, v);
            if (!str) {
                JS_FreeValue(ctx, v);
                return JS_EXCEPTION;
            }
            rc = sqlite3_bind_text(s->st, idx, str, (int)n, SQLITE_TRANSIENT);
            JS_FreeCString(ctx, str);
        }
        JS_FreeValue(ctx, v);
        if (rc != SQLITE_OK) {
            return JS_ThrowInternalError(ctx, "bind 失败：%s", sqlite3_errmsg(s->owner->db));
        }
    }
    return JS_NewInt32(ctx, 0);
}

static JSValue st_run(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpStmt *s = stmt_of(ctx, this_val);
    int rc;
    (void)argc;
    (void)argv;
    if (!s) return JS_EXCEPTION;
    rc = sqlite3_step(s->st);
    if (rc == SQLITE_DONE || rc == SQLITE_ROW) {
        sqlite3_reset(s->st);
        return JS_NewInt32(ctx, 0);
    }
    return JS_NewString(ctx, sqlite3_errmsg(s->owner->db));
}

static JSValue column_value(JSContext *ctx, sqlite3_stmt *st, int col) {
    switch (sqlite3_column_type(st, col)) {
        case SQLITE_NULL:
            return JS_NULL;
        case SQLITE_INTEGER:
            return JS_NewInt64(ctx, sqlite3_column_int64(st, col));
        case SQLITE_FLOAT:
            return JS_NewFloat64(ctx, sqlite3_column_double(st, col));
        case SQLITE_BLOB: {
            const void *p = sqlite3_column_blob(st, col);
            int n = sqlite3_column_bytes(st, col);
            return JS_NewStringLen(ctx, (const char *)(p ? p : ""), (size_t)(n > 0 ? n : 0));
        }
        case SQLITE_TEXT:
        default: {
            const unsigned char *p = sqlite3_column_text(st, col);
            int n = sqlite3_column_bytes(st, col);
            return JS_NewStringLen(ctx, (const char *)(p ? p : (const unsigned char *)""),
                                   (size_t)(n > 0 ? n : 0));
        }
    }
}

static JSValue st_all(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpStmt *s = stmt_of(ctx, this_val);
    JSValue rows;
    int row = 0;
    int rc;
    (void)argc;
    (void)argv;
    if (!s) return JS_EXCEPTION;
    rows = JS_NewArray(ctx);
    if (JS_IsException(rows)) return rows;
    while ((rc = sqlite3_step(s->st)) == SQLITE_ROW) {
        int n = sqlite3_column_count(s->st);
        int i;
        JSValue r = JS_NewArray(ctx);
        if (JS_IsException(r)) {
            JS_FreeValue(ctx, rows);
            return r;
        }
        for (i = 0; i < n; i++) {
            JSValue v = column_value(ctx, s->st, i);
            if (JS_IsException(v)) {
                JS_FreeValue(ctx, r);
                JS_FreeValue(ctx, rows);
                return v;
            }
            JS_SetPropertyUint32(ctx, r, (uint32_t)i, v);
        }
        JS_SetPropertyUint32(ctx, rows, (uint32_t)row, r);
        row++;
    }
    sqlite3_reset(s->st);
    if (rc != SQLITE_DONE) {
        JS_FreeValue(ctx, rows);
        return JS_ThrowInternalError(ctx, "查询失败：%s", sqlite3_errmsg(s->owner->db));
    }
    return rows;
}

static JSValue st_column_names(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpStmt *s = stmt_of(ctx, this_val);
    JSValue out;
    int n, i;
    (void)argc;
    (void)argv;
    if (!s) return JS_EXCEPTION;
    out = JS_NewArray(ctx);
    if (JS_IsException(out)) return out;
    n = sqlite3_column_count(s->st);
    for (i = 0; i < n; i++) {
        const char *name = sqlite3_column_name(s->st, i);
        JS_SetPropertyUint32(ctx, out, (uint32_t)i,
                             JS_NewString(ctx, name ? name : ""));
    }
    return out;
}

static JSValue st_finalize(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv) {
    BpStmt *s = (BpStmt *)JS_GetOpaque(this_val, stmt_class_id);
    (void)argc;
    (void)argv;
    if (s) {
        if (s->st) {
            sqlite3_finalize(s->st);
            s->st = NULL;
        }
        free(s);
        JS_SetOpaque(this_val, NULL);
    }
    return JS_UNDEFINED;
}

/* ---------------- 模块注册 ---------------- */

static const JSCFunctionListEntry db_funcs[] = {
    JS_CFUNC_DEF("open", 1, db_open),
    JS_CFUNC_DEF("exec", 1, db_exec),
    JS_CFUNC_DEF("prepare", 1, db_prepare),
    JS_CFUNC_DEF("close", 0, db_close),
};

static const JSCFunctionListEntry stmt_funcs[] = {
    JS_CFUNC_DEF("bind", 1, st_bind),
    JS_CFUNC_DEF("run", 0, st_run),
    JS_CFUNC_DEF("all", 0, st_all),
    JS_CFUNC_DEF("columnNameList", 0, st_column_names),
    JS_CFUNC_DEF("finalize", 0, st_finalize),
};

static void ensure_classes(JSContext *ctx) {
    JSRuntime *rt = JS_GetRuntime(ctx);
    if (!db_class_id) {
        JS_NewClassID(&db_class_id);
        JS_NewClass(rt, db_class_id, &db_class_def);
        JS_NewClassID(&stmt_class_id);
        JS_NewClass(rt, stmt_class_id, &stmt_class_def);
    }
}

static JSValue make_class(JSContext *ctx, JSClassID id, const char *name,
                          const JSCFunctionListEntry *funcs, int nfuncs,
                          JSCFunction *ctor) {
    JSValue proto = JS_NewObject(ctx);
    JSValue c;
    if (JS_IsException(proto)) return proto;
    JS_SetPropertyFunctionList(ctx, proto, funcs, nfuncs);
    JS_SetClassProto(ctx, id, JS_DupValue(ctx, proto));
    c = JS_NewCFunction2(ctx, ctor, name, 0, JS_CFUNC_constructor, 0);
    JS_SetPropertyStr(ctx, c, "prototype", JS_DupValue(ctx, proto));
    JS_FreeValue(ctx, proto);
    return c;
}

static int sqlite3_module_init(JSContext *ctx, JSModuleDef *m) {
    JSValue def, dbc;
    ensure_classes(ctx);
    def = JS_NewObject(ctx);
    dbc = make_class(ctx, db_class_id, "Database", db_funcs,
                     (int)(sizeof(db_funcs) / sizeof(db_funcs[0])), db_ctor);
    /* Statement 不对外构造：只建原型挂到类上，不导出构造函数 */
    {
        JSValue proto = JS_NewObject(ctx);
        JS_SetPropertyFunctionList(ctx, proto, stmt_funcs,
                                   (int)(sizeof(stmt_funcs) / sizeof(stmt_funcs[0])));
        JS_SetClassProto(ctx, stmt_class_id, proto);
    }
    JS_SetPropertyStr(ctx, def, "Database", dbc);
    JS_SetModuleExport(ctx, m, "default", def);
    return 0;
}

static JSModuleDef *sqlite3_module_load(JSContext *ctx, const char *moduleName) {
    if (strcmp(moduleName, "sqlite3") == 0) {
        JSModuleDef *m = JS_NewCModule(ctx, moduleName, sqlite3_module_init);
        if (!m) return NULL;
        JS_AddModuleExport(ctx, m, "default");
        return m;
    }
    return NULL;
}

void bpn_sqlite3_register(void) {
    registerCModuleLoader("sqlite3", &sqlite3_module_load);
}
