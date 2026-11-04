/**
 * 旧布局 → 新布局的**一次性**迁移。
 *
 * 映射表只有一份：docs/存储重构.md §4。本文件按表逐行执行，不在这里另辟路径
 * （目标路径一律从 utils/paths.js 取，源路径一律走它的 legacy* 系列）。
 *
 * 触发：boot 调一次 `run(config.json 里的 layoutVersion)`，`< 2` 才迁；
 * **全部关键步骤成功**才把 `layoutVersion: 2` 写回 config.json，失败保持旧版本、下次启动重试。
 *
 * ## 为什么要这么写
 *
 *   - `process.exec` 不解析命令串，必须 `/bin/sh -c`（统一走 utils/exec.js 的 run）。
 *   - 一次 exec ≈50ms，几百首逐首 mv 会把启动拖成几十秒，所以**命令合并**：
 *     整份迁移计划先排成一串 shell 语句，再按单条命令串的大小上限分批执行，
 *     几百次 mv 通常合并成个位数次 exec。
 *   - 读旧数据用原生 fs（不分叉）；写 JSON 只能 shell 重定向，所以写也和搬文件一起合并。
 *   - 单步/单项失败只记日志，不抛、不阻塞启动；失败项记进临时日志，迁完汇总后删掉。
 *   - **只搬不改源**：旧目录（music lrc store covers storage）全部保留，确认无误后由用户手动清。
 *
 * ## 幂等判据
 *
 * 一律看**目标文件是否已存在**，不看除版本号以外的任何标记：
 *   - 目标曲目目录里已有任一扩展名的正式文件（track.mp3 / track.flac）⇒ 整个 id 跳过，
 *     所以重跑不会产出 mp3 与 flac 并存；
 *   - cover.jpg / lyrics.json / metadata.json 已存在 ⇒ 跳过，不覆盖已迁好的内容；
 *   - 顶层 cookie.json / state.json / history.json 已存在 ⇒ 跳过（避免用旧 storage 的会话
 *     盖掉迁移失败后新写入的登录态）。
 *
 * ## 已知限制
 *
 *   - `bpncm_dl_origin` 里若出现本地索引中没有的 songId，就没有 track 行可挂，归属标记丢弃
 *     （旧语义「没有标记按 user 处理」仍然成立，只是歌单归属会退化成用户单曲）；
 *   - `lrc/<id>.json` 若对应曲目已经不在 downloads/ 下（音频被删只留了歌词），不落盘
 *     （避免造出只有歌词没有音频的孤儿目录），只计数；
 *   - 平台若没有 sqlite3（utils/db.js 会降级为空库），索引表这一步算失败、**不写版本号**：
 *     旧 store/*.json 原样保留，下次启动重试（迁移本身幂等，重试只跑没做完的部分）。
 *     设备实测有 `/usr/bin/sqlite3` 3.39.2，这条是兜底；
 *   - 迁移不做 CRC/回读校验，只以 mv/cp 与重定向的返回值为准。
 */
import {
  cacheDir,
  configFile,
  cookiesFile,
  downloadsDir,
  historyFile,
  legacyCoversDir,
  legacyLrcDir,
  legacyMusicDir,
  legacyStorageDir,
  legacyStoreDir,
  normDir,
  stateFile,
  thumbsDir,
  trackCover,
  trackFile,
  trackLyrics,
  trackMeta
} from './paths.js'
import { fileExists, readNames, readTextFile, removePath, writeTextFile } from './fsutil.js'
import { run as sh } from './exec.js'
import {
  ensureDb,
  exec as dbExec,
  flushAll as dbFlush,
  num as dbNum,
  reset as dbReset,
  upsertSql
} from './db.js'
import { log } from './log.js'

/** 当前布局版本。旧布局 = 1（没有 layoutVersion 字段），本次重构后的布局 = 2 */
export const LAYOUT_VERSION = 2

const AUDIO_EXT = ['mp3', 'flac']

/**
 * 单条 `/bin/sh -c` 命令串的字节上限。
 * Linux 单个 argv 上限 128KB，取 60KB 留足转义与路径余量（与 fsutil.writeTextFile 同口径）。
 */
/**
 * 单条 `/bin/sh -c` 命令串的字节上限。
 * Linux 单个 argv 上限 128KB，取 60KB 留足转义与路径余量（与 fsutil.writeTextFile 同口径）。
 * `run()` 的 opts.maxCmd 可覆盖（自检里本机 shell 对 -c 串另有更小的实际上限）。
 */
export const MAX_CMD = 60000

/** 单次批量命令的超时（一批可能包含上百个 mv） */
const BATCH_TIMEOUT = 120000

/* ---------------- 平台小工具 ---------------- */

/** shell 单引号转义：内部的 ' 变成 '\''（引号内 $ ` \ 换行都不解释） */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** 字符串作为 argv 时的字节数（转义后的实际长度；ASCII 1、两字节 2、其余 3） */
function byteCost(s) {
  let n = 0
  const str = shq(s)
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
  }
  return n
}

/** 路径的父目录（本文件里全是 POSIX 风格的绝对路径） */
function parentOf(p) {
  const i = String(p).lastIndexOf('/')
  return i > 0 ? String(p).slice(0, i) : ''
}

/** 失败项记录文件（迁完删掉）；前缀字母即步骤：A 音频 C 曲目封面 T 缩略图 L 歌词 M/P 元数据 */
function errLogPath() {
  return normDir() + '/.migrate_err.log'
}

/** 整条命令链失败时把标签追加进日志（由 readFailures 汇总） */
function failCmd(label) {
  return 'printf \'%s\\n\' ' + shq(label) + ' >> ' + shq(errLogPath()) + ' 2>/dev/null'
}

/** 搬一个文件（目标父目录不存在就建） */
function mvCmd(from, to, label) {
  return 'mkdir -p ' + shq(parentOf(to)) + ' && mv -f ' + shq(from) + ' ' + shq(to) + ' || ' + failCmd(label)
}

/** 拷一个文件（目标父目录不存在就建） */
function cpCmd(from, to, label) {
  return 'mkdir -p ' + shq(parentOf(to)) + ' && cp -f ' + shq(from) + ' ' + shq(to) + ' || ' + failCmd(label)
}

/**
 * 排一条**原子写文件**命令（先 `.tmp` 再 mv，读到的永远是完整一版）。
 * 形状与 fsutil.writeTextFile 一致，区别是这里能塞进批量命令里一起跑。
 * 内容超过单条命令的余量时自动分片（首片 `>`、后续 `>>`、最后一片带 mv），每片一条命令。
 */
function pushWrite(cmds, path, text, label, maxCmd) {
  const s = text === undefined || text === null ? '' : String(text)
  const tmp = path + '.tmp'
  const head = 'mkdir -p ' + shq(parentOf(path)) + ' && '
  const tail = ' && mv -f ' + shq(tmp) + ' ' + shq(path) + ' || ' + failCmd(label)
  const budget = (maxCmd || MAX_CMD) - byteCost(head) - byteCost(tail) - 200
  const parts = splitByCost(s, budget > 4096 ? budget : 4096)
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    let c = i === 0 ? head : ''
    c += 'printf \'%s\' ' + shq(parts[i]) + (i === 0 ? ' > ' : ' >> ') + shq(tmp)
    if (last) c += tail
    cmds.push(c)
  }
}

/** 按「转义后字节数」切片（别把代理对劈开；空串返回 ['']） */
function splitByCost(s, max) {
  const out = []
  let buf = ''
  let cost = 0
  for (let i = 0; i < s.length; i++) {
    let c = s.charAt(i)
    let add = 0
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        c += s.charAt(++i)
        add = 4
      } else add = 3
    } else if (c === "'") {
      add = 4
    } else if (code < 0x80) {
      add = 1
    } else if (code < 0x800) {
      add = 2
    } else {
      add = 3
    }
    if (cost + add > max && buf) {
      out.push(buf)
      buf = ''
      cost = 0
    }
    buf += c
    cost += add
  }
  out.push(buf)
  return out
}

/**
 * 读一个 JSON 文件；不存在/损坏一律 null（不抛）。
 * 损坏只记日志并按空处理 —— 源文件坏了重试一万次也还是坏的，把它当失败会让
 * layoutVersion 永远写不上、每次启动都白跑一遍迁移。
 */
async function readJson(path) {
  const raw = await readTextFile(path)
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : null
  } catch (e) {
    log('migrate', 'JSON 损坏按空处理 ' + path + '（' + (e && e.message) + '）')
    return null
  }
}

/* ---------------- SQL 字面量小工具 ---------------- */

/** 数字：非有限数一律 0（避免拼出语法错误） */
function intOr0(v) {
  const n = Number(v)
  return isFinite(n) ? Math.round(n) : 0
}

/** 数字列（raw，不加引号） */
function intCol(name, v) {
  return { name: name, v: dbNum(v), raw: true }
}

/** 文本列（**给 '' 而不是 null**：表里这些列都是 NOT NULL） */
function txtCol(name, v) {
  return { name: name, v: v === undefined || v === null ? '' : String(v) }
}

/** 数组/对象 → JSON 文本列（序列化失败给空数组，不抛） */
function safeJson(v) {
  try {
    return JSON.stringify(v === undefined || v === null ? [] : v)
  } catch (e) {
    return '[]'
  }
}

/** 网易云时间戳秒/毫秒混用：统一成毫秒（与 localmeta / formatter 侧同一口径） */
function pubMs(v) {
  let n = Number(v) || 0
  if (n && n < 100000000000) n *= 1000
  return n
}

/** 任意值 → 数组（旧表里这些字段可能缺失或形态不对） */
function toArray(v) {
  return Array.isArray(v) ? v : []
}

/* ---------------- 入口 ---------------- */

let inflight = null

/**
 * 执行迁移（同一会话内只跑一次；重复调用返回同一个 Promise）。
 *
 * @param {number} [currentVersion] boot 读到的 layoutVersion；不传/非数字则自己读 config.json
 * @param {{maxCmd?:number}} [opts] 仅自检用（覆盖单批命令串上限）；生产调用不传
 * @returns {Promise<{from:number, to:number, migrated:boolean, ok:boolean}>} **不抛**
 */
export function run(currentVersion, opts) {
  if (!inflight) inflight = doRun(currentVersion, opts || {})
  return inflight
}

async function doRun(currentVersion, opts) {
  const maxCmd = Number(opts.maxCmd) > 0 ? Number(opts.maxCmd) : MAX_CMD
  const out = { from: 0, to: LAYOUT_VERSION, migrated: false, ok: false }
  try {
    const v = await versionOf(currentVersion)
    out.from = v
    if (v >= LAYOUT_VERSION) {
      log('migrate', '布局已是 v' + v + '，无需迁移')
      out.ok = true
      return out
    }
    const prefs = await readLegacyStorage()
    if (!(await hasLegacyData(prefs))) {
      log('migrate', 'v' + v + '：没有发现旧布局数据，只补写版本号')
      out.migrated = await commitVersion(prefs)
      out.ok = out.migrated
      return out
    }
    log('migrate', '检测到旧布局 v' + v + '，开始迁移到 v' + LAYOUT_VERSION)

    // 计划：文件搬家 + JSON 改写一起排队，合并成几次 exec
    const stat = { audio: 0, covers: 0, thumbs: 0, lyrics: 0, orphan: 0, meta: 0 }
    const ids = { dl: {}, ca: {} }
    const cmds = []
    await buildFilePlan(cmds, ids, stat)
    await buildWritePlan(cmds, ids, prefs, stat, maxCmd)
    const ran = await runBatched(cmds, maxCmd)
    const fail = await readFailures()

    // 旧表 → SQLite；旧 storage 的 key → 顶层 JSON
    const db = await stepDb(prefs, maxCmd)
    const storeOk = await stepStore(prefs)
    await cleanupErrLog()

    if (stat.audio || stat.covers || stat.thumbs) {
      log('migrate', '旧目录（music lrc store covers storage）保留，确认迁移无误后可手动删除')
    }
    log('migrate', '汇总：音频 ' + stat.audio + ' 首、曲目封面 ' + stat.covers + ' 张、缩略图 ' +
      stat.thumbs + ' 张、歌词 ' + stat.lyrics + ' 首、元数据 ' + stat.meta + ' 条' +
      (stat.orphan ? '（无对应曲目的歌词 ' + stat.orphan + ' 首未迁）' : ''))

    const cmdOk = ran.ok && !fail.A && !fail.C && !fail.T && !fail.L && !fail.M && !fail.P && !fail.X
    const keyOk = cmdOk && db.ok && storeOk
    if (!keyOk) {
      log('migrate', '有关键步骤失败，layoutVersion 保持 ' + v + '，下次启动重试')
      return out
    }
    out.migrated = await commitVersion(prefs)
    out.ok = out.migrated
    return out
  } catch (e) {
    log('migrate', '迁移异常（不影响启动）：' + ((e && e.message) || e))
    out.ok = false
    return out
  }
}

/* ---------------- 版本号 ---------------- */

/** 当前版本：优先用 boot 传进来的，没有就自己读 config.json（读不到当 1 = 旧布局） */
async function versionOf(passed) {
  const n = Number(passed)
  if (isFinite(n) && n > 0) return n
  const cur = await readJson(configFile())
  const v = cur ? Number(cur.layoutVersion) : 0
  return isFinite(v) && v > 0 ? v : 1
}

/**
 * 回写 `layoutVersion`，顺带把 storage 的 ncm_settings 落到 config.json。
 *
 * 合并规则：**旧 storage 的设置优先**（那才是用户迁移前的真实设置），
 * 只在 config.json 里有、storage 里没有的键保留原值，最后强制写 layoutVersion。
 * 之所以不让 config.json 盖住旧设置：迁移期 config.json 可能只存着默认值，
 * 拿默认值覆盖用户的真实设置就是静默丢配置。迁移只会跑一次（版本号一写就不再进来），
 * 所以不存在「把迁移后改过的设置又改回去」。
 */
async function commitVersion(prefs) {
  const cur = (await readJson(configFile())) || {}
  const legacy = parsePref(prefs, 'ncm_settings') || {}
  const next = {}
  const ck = Object.keys(cur)
  for (let i = 0; i < ck.length; i++) next[ck[i]] = cur[ck[i]]
  const lk = Object.keys(legacy)
  for (let i = 0; i < lk.length; i++) {
    if (lk[i] === 'layoutVersion') continue
    next[lk[i]] = legacy[lk[i]]
  }
  next.layoutVersion = LAYOUT_VERSION
  const ok = await writeTextFile(configFile(), JSON.stringify(next))
  log('migrate', '写入 layoutVersion=' + LAYOUT_VERSION +
    (ok ? '（配置项 ' + Object.keys(next).length + ' 个）' : ' 失败（下次启动重试）'))
  return ok
}

/* ---------------- 旧数据探测 ---------------- */

/** 旧平台 storage 的扁平 KV 文件：`data/storage/preferences.json` → { key: 字符串值 } */
async function readLegacyStorage() {
  const o = await readJson(legacyStorageDir() + '/preferences.json')
  if (!o) return null
  log('migrate', '旧 storage 读到 ' + Object.keys(o).length + ' 个 key')
  return o
}

/** 取一个旧 storage key 的 JSON 值（值是字符串，自己 parse） */
function parsePref(prefs, key) {
  if (!prefs || prefs[key] === undefined || prefs[key] === null) return null
  const raw = String(prefs[key])
  if (!raw) return null
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : null
  } catch (e) {
    log('migrate', '旧 storage 的 ' + key + ' 解析失败，跳过')
    return null
  }
}

/** 有没有值得迁的旧数据（四个旧目录 / 旧 cache 的平铺音频 / 旧 storage） */
async function hasLegacyData(prefs) {
  if (prefs && Object.keys(prefs).length) return true
  const dirs = [legacyMusicDir(), legacyLrcDir(), legacyCoversDir(), legacyStoreDir()]
  for (let i = 0; i < dirs.length; i++) {
    if ((await readNames(dirs[i])).length) return true
  }
  // 旧 cache 是**平铺文件**（cache/<id>.mp3）；新 cache 是 cache/<id>/ 目录 + cache/thumbs/
  const cn = await readNames(cacheDir())
  for (let i = 0; i < cn.length; i++) {
    if (/^\d+\.(mp3|flac)/.test(cn[i])) return true
  }
  return false
}

/* ---------------- 1. 文件搬家 ---------------- */

/** 收一遍目标通道下已有的 track 目录（上次迁移可能已经建过一部分） */
async function collectIds(root, into) {
  const names = await readNames(root)
  for (let i = 0; i < names.length; i++) {
    if (/^\d+$/.test(names[i])) into[names[i]] = 1
  }
}

/**
 * 列一个目录里的旧命名音频：`<id>.<ext>` 与续传残片 `<id>.<ext>.part(.cur)`。
 * 返回 { <id>: { ext, parts: [{name, ext, suffix}] } }。
 * 同一个 id 若两种扩展名都在（历史残留），优先 flac（无损胜过有损），只搬一个。
 */
async function listLegacyAudio(dir) {
  const names = await readNames(dir)
  const out = {}
  for (let i = 0; i < names.length; i++) {
    const n = names[i]
    if (!n) continue
    const m = /^(\d+)\.(mp3|flac)(\.part(\.cur)?)?$/.exec(n)
    if (!m) continue
    const id = m[1]
    const rec = out[id] || (out[id] = { ext: '', parts: [] })
    if (m[3]) rec.parts.push({ name: n, ext: m[2], suffix: m[3] })
    else if (!rec.ext || m[2] === 'flac') rec.ext = m[2]
  }
  return out
}

/** 目标目录里是否已有正式音频文件（任一扩展名）—— 幂等判据的关键 */
async function hasTrackFile(id, kind) {
  for (let i = 0; i < AUDIO_EXT.length; i++) {
    if (await fileExists(trackFile(id, AUDIO_EXT[i], kind))) return true
  }
  return false
}

/**
 * 排一个通道的音频搬家计划。
 *
 * **一律 mv**（同盘 rename，原子）。不用 cp 的理由不是省事：cp 中途被打断会在目标位置
 * 留下半截文件，而「缓存命中」的判据是「文件存在且 > 30KB」（media.hitAudio），
 * 半截文件正好会被当成有效缓存 → 播放到一半断掉，比没有缓存差得多。rename 要么成要么不成。
 *
 * `skipIds` 非空时：这些 id 若在**另一条通道**已有正式文件就跳过（同一首不留两份，§2.1）。
 */
async function planAudio(srcDir, kind, ids, cmds, stat, skipIds) {
  const legacy = await listLegacyAudio(srcDir)
  const keys = Object.keys(legacy)
  for (let i = 0; i < keys.length; i++) {
    const id = keys[i]
    const rec = legacy[id]
    // 本通道已排过这个 id，或目标目录里已有正式文件（上次迁过）：整个 id 跳过，
    // 避免 track.mp3 与 track.flac 并存
    if (ids[id] || (await hasTrackFile(id, kind))) {
      ids[id] = 1
      continue
    }
    // 同一首不留两份（§2.1）：另一通道已排/已有正式文件就跳过。
    // 计划阶段目标文件还没落盘，所以要**同时**看计划集合 skipIds 与磁盘
    if (skipIds && (skipIds[id] || (await hasTrackFile(id, 'download')))) continue
    if (!rec.ext) continue
    cmds.push(mvCmd(srcDir + '/' + id + '.' + rec.ext, trackFile(id, rec.ext, kind), 'A|' + id))
    stat.audio++
    ids[id] = 1
    // 续传残片跟着走（新布局的残片名是 track.<ext>.part(.cur)），保住断点
    for (let p = 0; p < rec.parts.length; p++) {
      const part = rec.parts[p]
      cmds.push(mvCmd(srcDir + '/' + part.name,
        trackFile(id, part.ext, kind) + part.suffix, 'A|' + id + '|part'))
    }
  }
}

/**
 * 封面两件事（§0.1.1 的「拆成两份数据」）：
 *   1. 已下载曲目的单尺寸封面：`covers/<id>_200.jpg` → `downloads/<id>/cover.jpg`
 *      （**拷**，源留着当浏览缩略图）
 *   2. 其余浏览缩略图：`covers/*.jpg` → `cache/thumbs/`（原地改名，键形态不变）
 * 命令顺序保证「先拷后搬」。
 */
async function planCovers(dlIds, cmds, stat) {
  const dir = legacyCoversDir()
  const names = await readNames(dir)
  const thumbs = []
  for (let i = 0; i < names.length; i++) {
    const n = names[i]
    if (!n || !/\.jpg$/i.test(n)) continue
    thumbs.push(n)
    const m = /^(\d+)_200\.jpg$/i.exec(n)
    if (!m) continue
    const id = m[1]
    if (!dlIds[id]) continue
    if (await fileExists(trackCover(id, 'download'))) continue
    cmds.push(cpCmd(dir + '/' + n, trackCover(id, 'download'), 'C|' + id))
    stat.covers++
  }
  for (let i = 0; i < thumbs.length; i++) {
    const dest = thumbsDir() + '/' + thumbs[i]
    if (await fileExists(dest)) continue
    cmds.push(mvCmd(dir + '/' + thumbs[i], dest, 'T|' + thumbs[i]))
    stat.thumbs++
  }
}

/** 文件搬家的完整计划（音频 + 封面 + 缩略图），并回填两条通道的 id 集合 */
async function buildFilePlan(cmds, ids, stat) {
  await collectIds(downloadsDir(), ids.dl)
  await collectIds(cacheDir(), ids.ca)
  await planAudio(legacyMusicDir(), 'download', ids.dl, cmds, stat, null)
  await planAudio(cacheDir(), 'cache', ids.ca, cmds, stat, ids.dl)
  await planCovers(ids.dl, cmds, stat)
}

/* ---------------- 2. JSON 改写（歌词 / 元数据） ---------------- */

/**
 * 歌词：`lrc/<id>.json` {l,t,pm,y} → `downloads/<id>/lyrics.json` {v,lrc,tlyric,yrc,pureMusic}。
 * 落盘形状与 media.writeLyrics 一致（同 key 顺序），避免两处写出两种文件；
 * 「没词又不是纯音乐就不落盘」的规则也与它相同。
 */
async function planLyrics(dlIds, cmds, stat, maxCmd) {
  const dir = legacyLrcDir()
  const names = await readNames(dir)
  for (let i = 0; i < names.length; i++) {
    const m = /^(\d+)\.json$/.exec(names[i] || '')
    if (!m) continue
    const id = m[1]
    if (!dlIds[id]) { // 音频已不在下载目录：不造只有歌词的孤儿目录
      stat.orphan++
      continue
    }
    if (await fileExists(trackLyrics(id, 'download'))) continue
    const o = await readJson(dir + '/' + names[i])
    if (!o || (!o.l && !o.pm)) continue
    pushWrite(cmds, trackLyrics(id, 'download'),
      JSON.stringify({ v: 1, lrc: o.l || '', tlyric: o.t || '', yrc: o.y || '', pureMusic: o.pm ? 1 : 0 }),
      'L|' + id, maxCmd)
    stat.lyrics++
  }
}

/**
 * 元数据两套（结构一样、落点不同，见 §2）：
 *   `store/cache_meta.json`         → `downloads/<id>/metadata.json`（用户下载）
 *   storage `bpncm_playcache_meta`  → `cache/<id>/metadata.json`（播放缓存，多一个 u=lastUsed）
 * 记录**原样落盘**（不重排字段、不删 p/t），媒体层按「有就用、没有按默认」读。
 */
async function planMeta(ids, prefs, cmds, stat, maxCmd) {
  const dlMeta = (await readJson(legacyStoreDir() + '/cache_meta.json')) || {}
  const dk = Object.keys(dlMeta)
  for (let i = 0; i < dk.length; i++) {
    const id = dk[i]
    const rec = dlMeta[id]
    if (!rec || typeof rec !== 'object') continue
    if (!ids.dl[id]) continue // 没有文件的不落盘（元数据不单独存在）
    if (await fileExists(trackMeta(id, 'download'))) continue
    pushWrite(cmds, trackMeta(id, 'download'), JSON.stringify(rec), 'M|' + id, maxCmd)
    stat.meta++
  }
  const pcMeta = parsePref(prefs, 'bpncm_playcache_meta') || {}
  const pk = Object.keys(pcMeta)
  for (let i = 0; i < pk.length; i++) {
    const id = pk[i]
    const rec = pcMeta[id]
    if (!rec || typeof rec !== 'object') continue
    if (!ids.ca[id]) continue
    if (await fileExists(trackMeta(id, 'cache'))) continue
    pushWrite(cmds, trackMeta(id, 'cache'), JSON.stringify(rec), 'P|' + id, maxCmd)
    stat.meta++
  }
}

async function buildWritePlan(cmds, ids, prefs, stat, maxCmd) {
  await planLyrics(ids.dl, cmds, stat, maxCmd)
  await planMeta(ids, prefs, cmds, stat, maxCmd)
}

/* ---------------- 批量执行 ---------------- */

/**
 * 按命令串大小分批执行（每批一次 exec）。批内用换行分隔，单项失败不影响后续
 * （失败项由 `|| printf ... >> 日志` 记下，见 failCmd）。
 * **批命令本身非 0 也算失败**：那说明本批有命令没按预期跑（shell 语法错、整批被截断），
 * 而失败日志里可能根本没有它 —— 不能因为「日志里没有」就当成成功。
 */
async function runBatched(cmds, maxCmd) {
  let i = 0
  let execs = 0
  let ok = true
  while (i < cmds.length) {
    let body = ''
    let size = 0
    while (i < cmds.length) {
      const cost = byteCost(cmds[i]) + 1
      if (body && size + cost > maxCmd) break
      body += cmds[i] + '\n'
      size += cost
      i++
    }
    const r = await sh(body, BATCH_TIMEOUT)
    execs++
    if (!r) {
      ok = false
      log('migrate', '命令通道不可用，剩余 ' + (cmds.length - i) + ' 条迁移命令未执行')
      break
    }
    if (r.code !== 0) {
      ok = false
      log('migrate', '批命令 rc=' + r.code + ' err=' + String(r.stderr || '').slice(0, 120))
    }
  }
  if (execs) log('migrate', '迁移命令 ' + cmds.length + ' 条合并成 ' + execs + ' 次 exec')
  return { ok: ok, execs: execs }
}

/** 读失败项日志并按步骤计数 */
async function readFailures() {
  const out = { A: 0, C: 0, T: 0, L: 0, M: 0, P: 0, X: 0 }
  const raw = await readTextFile(errLogPath())
  if (!raw) return out
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const step = line.charAt(0)
    if (out[step] === undefined) out.X++
    else out[step]++
  }
  const total = out.A + out.C + out.T + out.L + out.M + out.P + out.X
  if (total) {
    log('migrate', '失败明细：音频 ' + out.A + '、曲目封面 ' + out.C + '、缩略图 ' + out.T +
      '、歌词 ' + out.L + '、元数据 ' + (out.M + out.P) + (out.X ? '、未知 ' + out.X : ''))
  }
  return out
}

async function cleanupErrLog() {
  try {
    await removePath(errLogPath())
  } catch (e) {}
}

/* ---------------- 3. 四张旧表 → SQLite ---------------- */

/**
 * `store/local_index.json` → track / album / artist / track_artist
 * `store/local_playlists.json` → playlist / playlist_track
 * `store/artist_meta.json` → artist.avatar / av_at
 * storage `bpncm_dl_origin` → track.dl_origin
 *
 * 一条 SQL 一次 exec 太贵，所以先攒成语句数组，再按大小分批提交（§1.2）。
 * sqlite3 不可用时**跳过但不阻塞版本号**（见文件头「已知限制」）。
 */
async function stepDb(prefs, maxCmd) {
  try {
    if (!(await ensureDb())) {
      log('migrate', 'sqlite3 不可用，索引表迁移失败（旧 store/*.json 保留，下次启动重试）')
      return { ok: false, skipped: true }
    }
    const stmts = []
    const stat = { track: 0, album: 0, artist: 0, ta: 0, playlist: 0, pt: 0, origin: 0, lost: 0 }
    const origin = parsePref(prefs, 'bpncm_dl_origin') || {}
    const albums = {}
    const artists = {}

    // ---- 曲目索引 ----
    const idx = (await readJson(legacyStoreDir() + '/local_index.json')) || {}
    const ids = Object.keys(idx)
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const rec = idx[id]
      const tid = intOr0(id)
      if (!tid || !rec || typeof rec !== 'object') continue
      const al = rec.al && typeof rec.al === 'object' ? rec.al : {}
      const ars = toArray(rec.ars)
      const aid = intOr0(al.i)
      const pub = pubMs(rec.pub)
      stmts.push(upsertSql('track', [
        intCol('id', tid),
        txtCol('name', rec.n),
        txtCol('alias', safeJson(toArray(rec.alia))),
        intCol('album_id', aid),
        intCol('duration', intOr0(rec.d)),
        intCol('pub', pub),
        intCol('track_no', intOr0(rec.no)),
        txtCol('disc', rec.cd),
        intCol('pop', intOr0(rec.pop)),
        intCol('fee', intOr0(rec.fee)),
        txtCol('cover', al.c),
        intCol('dl_origin', intOr0(origin[id])),
        intCol('added_at', 0) // 旧表没有下载时间，交给新下载重新记
      ], 'id'))
      stat.track++
      if (intOr0(origin[id])) stat.origin++

      if (aid) {
        const a = albums[String(aid)] || (albums[String(aid)] = { id: aid, name: '', cover: '', pub: 0 })
        if (!a.name && al.n) a.name = String(al.n)
        if (!a.cover && al.c) a.cover = String(al.c)
        if (pub > a.pub) a.pub = pub
      }
      for (let k = 0; k < ars.length; k++) {
        const ar = ars[k]
        const arid = ar && typeof ar === 'object' ? intOr0(ar.i) : 0
        if (!arid) continue
        stmts.push(upsertSql('track_artist', [
          intCol('track_id', tid),
          intCol('artist_id', arid),
          intCol('ord', k)
        ], 'track_id,artist_id'))
        stat.ta++
        const a = artists[String(arid)] || (artists[String(arid)] = { id: arid, name: '', avatar: '', avAt: 0 })
        if (!a.name && ar.n) a.name = String(ar.n)
      }
    }

    // ---- 专辑 ----
    const ak = Object.keys(albums)
    for (let i = 0; i < ak.length; i++) {
      const a = albums[ak[i]]
      stmts.push(upsertSql('album', [
        intCol('id', a.id),
        txtCol('name', a.name),
        txtCol('cover', a.cover),
        intCol('pub', a.pub)
      ], 'id'))
      stat.album++
    }

    // ---- 歌手（索引里的名字 + artist_meta 的头像/时间）----
    const am = (await readJson(legacyStoreDir() + '/artist_meta.json')) || {}
    const mk = Object.keys(am)
    for (let i = 0; i < mk.length; i++) {
      const arid = intOr0(mk[i])
      if (!arid) continue
      const rec = am[mk[i]] && typeof am[mk[i]] === 'object' ? am[mk[i]] : {}
      const a = artists[String(arid)] || (artists[String(arid)] = { id: arid, name: '', avatar: '', avAt: 0 })
      if (rec.p) a.avatar = String(rec.p)
      if (intOr0(rec.t)) a.avAt = intOr0(rec.t)
      if (!a.name && rec.n) a.name = String(rec.n)
    }
    const arKeys = Object.keys(artists)
    for (let i = 0; i < arKeys.length; i++) {
      const a = artists[arKeys[i]]
      stmts.push(upsertSql('artist', [
        intCol('id', a.id),
        txtCol('name', a.name),
        txtCol('avatar', a.avatar),
        intCol('av_at', a.avAt)
      ], 'id'))
      stat.artist++
    }

    // ---- 歌单索引 ----
    const pl = (await readJson(legacyStoreDir() + '/local_playlists.json')) || {}
    const pks = Object.keys(pl)
    for (let i = 0; i < pks.length; i++) {
      const rec = pl[pks[i]]
      if (!rec || typeof rec !== 'object') continue
      const pid = intOr0(rec.id) || intOr0(pks[i])
      if (!pid) continue
      const base = toArray(rec.baseIds)
      const remote = toArray(rec.remoteIds)
      stmts.push(upsertSql('playlist', [
        intCol('id', pid),
        txtCol('name', rec.name),
        txtCol('cover', rec.cover),
        txtCol('creator', rec.creator),
        intCol('track_cnt', intOr0(rec.trackCount) || remote.length),
        txtCol('base_ids', safeJson(base)),
        txtCol('remote_ids', safeJson(remote)),
        intCol('pulled_at', intOr0(rec.lastPullAt))
      ], 'id'))
      stat.playlist++
      // playlist_track = base ∪ remote（base 在前、remote 补后），
      // 与 locallists 的 referencedIds()「该歌单本地认为属于它」的语义一致
      const seen = {}
      const union = []
      for (let k = 0; k < base.length; k++) {
        const kk = String(base[k])
        if (seen[kk]) continue
        seen[kk] = 1
        union.push(base[k])
      }
      for (let k = 0; k < remote.length; k++) {
        const kk = String(remote[k])
        if (seen[kk]) continue
        seen[kk] = 1
        union.push(remote[k])
      }
      for (let k = 0; k < union.length; k++) {
        const tid = intOr0(union[k])
        if (!tid) continue
        stmts.push(upsertSql('playlist_track', [
          intCol('playlist_id', pid),
          intCol('track_id', tid),
          intCol('ord', k)
        ], 'playlist_id,track_id'))
        stat.pt++
      }
    }

    // 归属标记里不在索引中的 id：没有 track 行可挂（旧语义「无标记按 user」仍成立）
    const ok2 = Object.keys(origin)
    for (let i = 0; i < ok2.length; i++) {
      if (!idx[ok2[i]]) stat.lost++
    }

    const ok = await flushStmts(stmts, maxCmd)
    dbReset() // 丢弃内存态：后续 open() 重新从库里导出
    log('migrate', '索引库：track=' + stat.track + '（带归属 ' + stat.origin + '）album=' + stat.album +
      ' artist=' + stat.artist + ' ta=' + stat.ta + ' playlist=' + stat.playlist + ' pt=' + stat.pt +
      (stat.lost ? '；' + stat.lost + ' 个归属标记无对应曲目，已丢弃' : ''))
    return { ok: ok, skipped: false }
  } catch (e) {
    log('migrate', '索引表迁移异常：' + ((e && e.message) || e))
    return { ok: false, skipped: false }
  }
}

/** 按大小分批提交 SQL（一批只 fork 一次），返回是否都没报错 */
async function flushStmts(stmts, maxCmd) {
  if (!stmts.length) return true
  let batch = []
  let size = 0
  let ok = true
  for (let i = 0; i < stmts.length; i++) {
    const s = stmts[i]
    if (batch.length && size + s.length > maxCmd) {
      if ((await dbExec(batch)) === false) ok = false
      batch = []
      size = 0
    }
    batch.push(s)
    size += s.length + 1
  }
  if (batch.length) {
    if ((await dbExec(batch)) === false) ok = false
  }
  if ((await dbFlush()) === false) ok = false
  return ok
}

/* ---------------- 4. 旧 storage 的 key → 顶层 JSON ---------------- */

/**
 * `ncm_cookies` / `bpncm_player_state` / `bpncm_playhist` → cookie.json / state.json / history.json。
 * 值是 JSON 文本，**原样落盘**（不经手 parse，避免格式漂移）。
 * 目标文件已存在就跳过：迁移失败后新写入的登录态/历史可能比旧 storage 里的新。
 * ncm_settings 不在这里写 —— 它与 layoutVersion 一起由 commitVersion 收尾（同一份文件）。
 */
async function stepStore(prefs) {
  try {
    const plan = [
      ['ncm_cookies', cookiesFile()],
      ['bpncm_player_state', stateFile()],
      ['bpncm_playhist', historyFile()]
    ]
    let n = 0
    let ok = true
    for (let i = 0; i < plan.length; i++) {
      const key = plan[i][0]
      const dest = plan[i][1]
      const raw = prefs && prefs[key] !== undefined && prefs[key] !== null ? String(prefs[key]) : ''
      if (!raw) continue
      if (await fileExists(dest)) continue
      if (await writeTextFile(dest, raw)) n++
      else ok = false
    }
    if (!ok) log('migrate', '顶层 JSON 有写入失败，' + n + ' 个已写入')
    else log('migrate', '顶层 JSON：写入 ' + n + ' 个（config.json 在收尾时写）')
    return ok
  } catch (e) {
    log('migrate', '顶层 JSON 迁移异常：' + ((e && e.message) || e))
    return false
  }
}
