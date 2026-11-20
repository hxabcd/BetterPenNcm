/**
 * 曲目列表页的六-kind 路由表（list.vue 的取数知识集中地）。
 *
 * 每个 kind 一条描述：首屏取数 + 追加一页 + 各自的标题/副题/空态文案。
 * list.vue 只按 kind 查表分派，不再维护 115 行的 if/else（P1 拆解主件）。
 *
 * 三路取数形态（loadMore 同构地走这三路，见 each loadMore 描述）：
 *   - 本地切片：全量已在内存，songs 放全量、渲染取前 shown 行（history / recommend / search）
 *   - 网络 offset：服务端游标分页，cursor = 已消费条数（artistsongs）
 *   - trackIds 批量：按 id 批量取详情，cursor = trackIds 已消费下标（liked / playlist）
 *
 * 每条 handler(self, p) 返回 { title, sub, hint, log } 之外的字段由 handler 自己
 * 写进 self——这里集中的是「kind → 取数与文案」，视图状态（shown/cursor…）的
 * 推进规则与 list.vue 的渲染分片约定保持一致。
 */
import { fetchPlaylistTracks, fetchTracksMore } from '../ncm/playlist.js'
import { fetchArtistSongs, searchByType } from '../ncm/api.js'
import { list as histList, load as histLoad } from './history.js'
import { loadDailyRecommend } from '../ncm/recommend.js'

/** 一次网络取数的批量（list.vue 取 PAGE_SONG=50，与渲染分片同口径） */
export const PAGE = 50

/** 追加去重：同一 id 只留第一次（分页重叠、歌单里重复添加都不该渲染成两行） */
export function appendUnique(base, add) {
  const seen = {}
  const out = (base || []).slice()
  for (let i = 0; i < out.length; i++) {
    if (out[i] && out[i].id != null) seen[out[i].id] = 1
  }
  const more = add || []
  for (let i = 0; i < more.length; i++) {
    const s = more[i]
    if (!s || s.id == null || seen[s.id]) continue
    seen[s.id] = 1
    out.push(s)
  }
  return out
}

export const KINDS = {
  /* ---- 搜索：每类只取前 SEARCH_LIMIT 条且不翻页（总数仍要露出来）---- */
  search: {
    async load(self, p, ctx) {
      const kw = p.keyword || self.keyword || ''
      self.keyword = kw
      self.title = ctx.searchTitle(kw)
      const t = self.searchType
      const cat = ctx.catOf(t)
      const r = await searchByType(kw, t, 0, ctx.SEARCH_LIMIT)
      // 单曲走 songs（带播放器要的全部字段），其余三类走 items（行显示用的轻量结构）
      if (t === 1) {
        self.songs = r.items || []
        self.items = []
        self.total = self.songs.length
      } else {
        self.items = r.items || []
        self.songs = []
        self.total = 0
      }
      const n = t === 1 ? self.songs.length : self.items.length
      const tot = Number(r.total) || n
      self.sub =
        cat.label +
        ' · ' +
        (tot > n ? '共 ' + tot + cat.unit + ' · 显示前 ' + n : n + cat.unit)
      self.shown = self.songs.length
      self.cursor = self.songs.length
      self.allLoaded = true
      self.hint = '没有结果'
      return { log: '搜索 "' + kw + '" ' + cat.label + ' ' + n + '/' + r.total }
    },
    loadMore: null, // 搜索不翻页（老端点 offset 对非单曲类不可靠）
  },

  /* ---- 歌手曲目：服务端排序 + offset 分页 ---- */
  artistsongs: {
    async load(self, p, ctx) {
      const r = await fetchArtistSongs(self.artistId, self.order, 0, PAGE)
      self.songs = r.songs || []
      self.total = r.total || self.songs.length
      self.cursor = self.songs.length // 服务端 offset 的已消费位置
      self.shown = self.songs.length
      self.allLoaded = self.cursor >= self.total
      self.title = self.artistName + ' · 热门曲目'
      self.sub = self.total + ' 首 · ' + (self.order === 'hot' ? '按热度' : '按时间')
      self.hint = '没有曲目'
      return {
        log: '歌手 ' + self.artistId + ' 曲目 ' + self.songs.length + '/' + self.total +
          ' order=' + self.order,
      }
    },
    /** offset 分页：空页停（total 可能偏大）；整批重复也停 */
    async loadMore(self, ctx) {
      const r = await fetchArtistSongs(self.artistId, self.order, self.cursor, PAGE)
      const got = r.songs || []
      if (!got.length) {
        self.noMore = true
        return
      }
      self.cursor += got.length
      const merged = appendUnique(self.songs, got)
      const grew = merged.length > self.songs.length
      self.songs = merged
      self.shown = self.songs.length
      if (!grew) self.noMore = true // 返回的全是重复/取不回
      if (self.cursor >= self.total) self.allLoaded = true
    },
  },

  /* ---- 播放历史：纯本地全量，一次进内存 ---- */
  history: {
    async load(self, p) {
      await histLoad()
      const all = histList()
      const ids = []
      for (let i = 0; i < all.length; i++) ids.push(all[i].id)
      self.fullSongs = all
      self.trackIds = ids
      // 本地全量已在内存：songs 放全量，渲染只取前 PAGE 行（loadMore 只加 shown）
      self.songs = all
      self.cursor = ids.length
      self.allLoaded = true
      self.shown = Math.min(PAGE, all.length)
      self.title = p.name || '播放历史'
      self.sub = all.length + ' 首'
      self.hint = '还没有播放记录'
      return { log: '历史 ' + all.length + ' 首（显示 ' + self.shown + '）' }
    },
    loadMore: null, // 全量在内存，loadMore 只走本地展开
  },

  /* ---- 每日推荐：服务端一次给全（无分页参数）---- */
  recommend: {
    async load(self, p) {
      const songs = await loadDailyRecommend()
      const d = new Date()
      self.songs = songs || []
      self.cursor = self.songs.length
      self.allLoaded = true
      self.shown = self.songs.length
      self.title = p.name || '每日推荐'
      self.sub = d.getMonth() + 1 + '月' + d.getDate() + '日 · ' + self.songs.length + ' 首'
      self.hint = '暂无推荐'
      return { log: '每日推荐 ' + self.songs.length + ' 首' }
    },
    loadMore: null,
  },

  /* ---- liked / playlist：n=PAGE 内联 + trackIds 游标（两 kind 同一形态，共用 handlers）---- */
  liked: PLAYLIST_LIKE,
}
KINDS.playlist = PLAYLIST_LIKE

/** liked/playlist 共用描述（两 kind 同一取数与文案形态） */
const PLAYLIST_LIKE = {
  async load(self, p) {
    const r = await fetchPlaylistTracks(p.id, PAGE)
    applyPlaylistPage(self, r)
    self.title = p.name || r.name || '歌单'
    self.sub = r.trackCount + ' 首'
    self.hint = '歌单为空'
    return {
      log: '歌单 ' + p.id + ' 曲目 ' + self.songs.length + '/' + self.trackIds.length +
        ' inline=' + (r.inline != null ? r.inline : self.songs.length),
    }
  },
  async loadMore(self) {
    await loadTracksBatch(self)
  },
}

/** liked/playlist 共用的首屏落位（内联条数 ≠ songs.length：下架歌被接口丢掉） */
export function applyPlaylistPage(self, r) {
  self.addTimes = r.addTimes || {}
  self.songs = self.dedupe(self.attachTimes(r.songs || []))
  self.trackIds = r.trackIds || []
  /* 首屏内联了 inline 条 → trackIds 的前 inline 个已被消费。
     **不能写 songs.length**：内联曲目里取不回的下架歌会被接口丢掉，
     用显示条数当游标会少算、下一页从偏小的下标开始（重复行）。 */
  const inline = r.inline != null ? Number(r.inline) : self.songs.length
  self.cursor = Math.min(Math.max(0, inline), self.trackIds.length)
  self.allLoaded = self.cursor >= self.trackIds.length
  self.shown = self.songs.length
}

/** liked/playlist 的下一批：按 trackIds 已消费下标取，取完推进游标（一次至多跳 5 批） */
export async function loadTracksBatch(self) {
  const ids = self.trackIds
  let tries = 0
  while (self.cursor < ids.length && tries < 5) {
    const batch = ids.slice(self.cursor, self.cursor + PAGE)
    if (!batch.length) {
      self.allLoaded = true
      return
    }
    // 请求成功后再推进游标：失败时保持原位置，用户重试不会跳过这一批
    const more = await fetchTracksMore(batch)
    self.cursor += batch.length
    const merged = self.appendUnique(self.songs, self.attachTimes(more || []))
    if (merged.length > self.songs.length) {
      self.songs = merged
      self.shown = self.songs.length
      break
    }
    tries++ // 整批不可用：继续取下一批
  }
  if (self.cursor >= ids.length) self.allLoaded = true
  self.shown = self.songs.length
}
