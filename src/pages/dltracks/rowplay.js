import { go } from '../../core/infra/nav.js'
import { player } from '../../services/player/player.js'
import { isOffline } from '../../core/infra/net/status.js'
import { log } from '../../core/infra/log.js'

export const dlRowPlayMixin = {
  methods: {
    onRow(i) {
      const r = this.rows[i]
      if (!r) return
      if (this.multi) {
        // A 条目还没下载，不能删/保留
        if (r.downloaded === false) return 
        this.toggleSel(r.song.id)
        return
      }
      this.play(i)
    },
    async play(i) {
      const r = this.rows[i]
      if (!r) return
      const off = await isOffline()
      if (r.downloaded === false && off) {
        this.showToast('离线，这首还没下载')
        return
      }

      // 离线时队列排除 A 条目（没有本地文件，轮到必失败）；在线保留完整顺序。
      // ⚠ 队列用**全量 fullRows**：只播可见的 50 行会让连播在分页边界断掉。
      const source = this.fullRows
      const pool = off ? source.filter(function (x) { return x.downloaded !== false }) : source
      let at = 0
      for (let k = 0; k < pool.length; k++) {
        if (String(pool[k].song.id) === String(r.song.id)) {
          at = k
          break
        }
      }
      if (!pool.length) return
      const songs = []
      for (let k = 0; k < pool.length; k++) songs.push(pool[k].song)
      player.playList(songs, at, 'downloads')
      log('dltracks', '播放 ' + this.kind + ' 第 ' + (at + 1) + ' 首 ' + (r.song.name || r.song.id))
      go('player', {})
    },
    async playAll() {
      const off = await isOffline()
      const source = this.fullRows
      const pool = off ? source.filter(function (x) { return x.downloaded !== false }) : source
      if (!pool.length) {
        this.showToast('没有可播放的曲目')
        return
      }
      const songs = []
      for (let i = 0; i < pool.length; i++) songs.push(pool[i].song)
      player.playList(songs, 0, 'downloads')
      log('dltracks', '播放全部 ' + songs.length + ' 首')
      go('player', {})
    },
    onHold(i) {
      if (this.multi) return
      const r = this.rows[i]
      if (!r || !r.song || !r.song.id) return
      log('dltracks', '长按 → 歌曲详情 id=' + r.song.id)
      go('songinfo', { id: r.song.id })
    },
  }
}
