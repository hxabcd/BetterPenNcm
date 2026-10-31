/**
 * 文件型存储层 —— 承接 storage 放不下的「大表」与歌词库。
 *
 * ## 约束：storage 是单文件 KV
 * 平台 storage 的全部 key 落在同一个文件（`<appdata>/data/storage/preferences.json`），
 * **每次 setStorage 都重写整份** —— 写代价 ∝ 全库总量，与这次写的是哪个 key 无关。
 * 所以「大块 + 低频」的数据不能放它：拆到文件后，单次写的代价只与那条数据本身有关。
 *
 * ## 落点（按「体积 × 写频次」定，不是见大就搬）
 *   | 数据 | 体积 | 写频次 | 落点 |
 *   |---|---|---|---|
 *   | 歌词（每首一个文件） | 均值 4.8KB | 一次/首 | `lrc/<songId>.json` |
 *   | 本地索引 | ~54KB | 一次/下载 | `store/local_index.json` |
 *   | 本地歌单索引 | ~63KB | 拉取/同步 | `store/local_playlists.json` |
 *   | 下载元数据 | ~37KB | 每下载/删除 | `store/cache_meta.json` |
 *   | 歌手资料 | ~19KB | 批量预热 | `store/artist_meta.json` |
 *   | 播放快照 / 历史 / 播放缓存元数据 / 设置 / cookie / 下载归属 | 合计 ~147KB | **5~15 秒一次** | 仍留 storage |
 *
 * 最后一行是关键：写文件要走 shell（`fs` 模块只读），**每次写 = 一次 fork（≈50ms）**，
 * 而原生 storage 写一个 147KB 的文件 ≈20ms 且不 fork。高频小块留在 storage 更快；
 * 拆出去的只有「低频 × 大块」—— 目标是「别为一条小数据重写整库」，不是「全搬出去」。
 *
 * ## 通道与一致性
 *   - 写：`fsutil.writeTextFile` —— `printf` 重定向 + `mv -f` 原子替换；
 *     单条命令是一个 argv（Linux 单参数上限 128KB），超 60KB 自动分片，每片一次 exec。
 *   - 读：`fsutil.readTextFile`（原生 fs.readFile，不 fork）。
 *   - 合并写：同一文件的并发写只保留**最新一版**，一次在飞；删除也走同一条队列。
 *   - 失败：只记日志，内存里的数据仍在（下一次写会重试）；这里**没有** storage 兜底 ——
 *     两处都写会让「哪份是真的」变成需要判断的事，而现在只有文件是真相。
 *
 * ## 不做数据迁移
 * 这里只认文件。storage 里若还留着历史 key（`bpncm_local_*` / `bpncm_cache_meta` /
 * `bpncm_artist_meta` / `bpncm_lrc.*`），本层既不读也不清 —— 需要保留的由人工搬一次。
 */
import { readTextFile, writeTextFile, removePath, removeTree } from './fsutil.js'
import { storeDir, lrcDir } from './paths.js'
import { log } from './log.js'

/* ---------------- 路径 ---------------- */

/** `store/<name>.json`（一张表一个文件） */
export function storePath(name) {
  return storeDir() + '/' + name + '.json'
}

/** `lrc/<songId>.json`（每首歌词一个文件） */
export function lrcPath(id) {
  return lrcDir() + '/' + String(id) + '.json'
}

/* ---------------- 读 ---------------- */

/** 读一个 JSON 文件；不存在/损坏一律给 null（损坏会记日志，调用方按「没有」处理） */
export async function readJsonAt(path) {
  const t = await readTextFile(path)
  if (!t) return null
  try {
    const o = JSON.parse(t)
    return o === undefined ? null : o
  } catch (e) {
    log('store', 'JSON 损坏按空处理: ' + path + ' len=' + t.length)
    return null
  }
}

/* ---------------- 写（每文件一条串行队列 + 最新一版覆盖） ---------------- */

const queues = {} // path → { busy, next:{text?,remove?,done} }

function enqueue(path, job) {
  let q = queues[path]
  if (!q) q = queues[path] = { busy: false, next: null }
  return new Promise(function (resolve) {
    // 上一版还没写就被新一版顶掉：老的那次也算「完成」（数据是同一份内存对象的最新态）
    if (q.next) q.next.done(false)
    job.done = resolve
    q.next = job
    if (!q.busy) drain(path, q)
  })
}

async function drain(path, q) {
  q.busy = true
  try {
    while (q.next) {
      const job = q.next
      q.next = null
      let ok = false
      try {
        ok = job.remove ? await removePath(path) : await writeTextFile(path, job.text)
      } catch (e) {
        ok = false
      }
      job.done(ok)
    }
  } finally {
    q.busy = false
  }
}

/** 写一个 JSON 文件（合并写：连续调用只有最新一版真正落盘）。返回 Promise<boolean> */
export function writeJsonAt(path, obj) {
  let text = '{}'
  try {
    text = JSON.stringify(obj)
  } catch (e) {
    log('store', 'JSON 序列化失败 ' + path)
    return Promise.resolve(false)
  }
  return enqueue(path, { text: text })
}

/** 删一个文件（**与写同一条队列**，排在在飞的旧写之后，失败不抛） */
export function removeAt(path) {
  return enqueue(path, { remove: true })
}

/** 删整个目录（歌词库清空用：一条 rm -rf）。
 *  不排队 —— 目录删掉后若还有一条在飞的歌词写，最多留下一个孤儿文件（不做索引就查不到）。 */
export function removeDirAt(dir) {
  return removeTree(dir)
}

/* ---------------- 表级便捷接口（一表一个文件） ---------------- */

/** 载入一张表；文件不存在/损坏给 null（调用方按空表处理） */
export function loadTable(name) {
  return readJsonAt(storePath(name))
}

/** 存一张表 */
export function saveTable(name, obj) {
  return writeJsonAt(storePath(name), obj)
}

/** 清一张表（删文件） */
export function dropTable(name) {
  return removeAt(storePath(name))
}
