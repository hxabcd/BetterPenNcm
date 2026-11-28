import {
  deleteCached,
  deleteBatch,
  deleteBatchState
} from '../../services/player/download.js'
import { player } from '../../services/player/player.js'
import { markUser } from '../../services/player/dlorigin.js'
import { selPicked } from '../../ui/dlselect.js'
import { toPlaylist, playNext, playNextText } from '../../services/player/acts.js'
import { fmtSize } from '../../core/infra/format.js'
import { log } from '../../core/infra/log.js'
import { PAGE_SONG as PAGE } from '../../ui/paging.js'

export const dlBatchMixin = {
  methods: {
    armDelete() {
      if (!this.selIds.length) {
        this.showToast('未选中歌曲')
        return
      }
      if (this.isArmed('del')) {
        this.doDeleteSelected()
        return
      }
      this.arm('del')
    },

    /* 多选删除：**乐观更新 + 后台删除**。数百首逐首删（目录 rm + 3 条 SQLite 写）要十几秒，
       等整批删完才刷新会让 UI 长时间停在旧列表「像没反应」。所以：点删除 → 立即退出多选、
       立即从 fullRows/rows 摘掉行 → deleteBatch 在服务层后台逐首跑（不依赖本页存活，
       中途退出页面删除继续）→ 每首回调更新进度副题 → 结束后 loadView() 对账一次。
       数据安全：deleteCached 目录与元数据成对增删，中途打断只意味着「剩下的没删」。 */
    async doDeleteSelected() {
      const ids = this.selIds.slice()
      if (!ids.length) {
        this.showToast('未选中歌曲')
        return
      }
      // 有正在跑的批量删除时并入会丢事件顺序，直接拒绝（deleteBatch 单例不会重叠，
      // 但上一场还没结束时 selIds 可能又攒了一波）
      if (deleteBatchState().running) {
        this.showToast('正在删除上一批，稍候再试')
        return
      }
      this.disarm()
      this.exitMulti()
      this.removeRowsLocal(ids)
      const self = this
      log('dltracks', '批量删除 ' + ids.length + ' 首（乐观摘行，后台跑）')
      deleteBatch(ids, {
        onEach: function (id, r, st) {
          // 顶栏副题给进度；失败的那首行会留在列表上（loadView 对账会兜）
          if (!self._dead && st.running) {
            self.showToast('正在删除 ' + (st.done + st.failed + 1) + '/' + st.total, 1200)
          }
        },
        onLast: function (st) {
          if (self._dead) return
          self.showToast('已删除 ' + st.done + ' 首' +
            (st.failed ? ' · ' + st.failed + ' 首失败' : '') +
            ' · 释放 ' + fmtSize(st.bytes))
          // 对账：服务层删干净后列表与磁盘一致；失败的行还在
          self.loadView() 
        }
      })
    },

    /** 乐观摘行：从 fullRows/rows 同步剔除 ids（字符串比较；不存在的 id 静默跳过） */
    removeRowsLocal(ids) {
      const kill = {}
      for (let i = 0; i < ids.length; i++) kill[String(ids[i])] = 1
      const keepRows = this.rows.length
      const full = []
      for (let i = 0; i < this.fullRows.length; i++) {
        const it = this.fullRows[i]
        if (it && it.song && !kill[String(it.song.id)]) full.push(it)
      }
      this.fullRows = full
      this.rows = full.slice(0, Math.max(keepRows, PAGE))
      this.hasMore = full.length > this.rows.length
      // 删除后队列里若是这批歌，一并摘除（在播的由 player 自己处理 fd 与下一首）
      try {
        if (player.state().queueSrc === 'downloads') player.removeFromQueue(ids)
      } catch (e) {}
    },

    /** 遗留歌曲 → 保留为单曲：改归属标记，文件不动；重新分类后从遗留页消失 */
    async keepSelected() {
      if (!this.selIds.length) {
        this.showToast('未选中歌曲')
        return;
      }
      const n = await markUser(this.selIds);
      this.exitMulti();
      await this.loadView();
      this.showToast('已保留为单曲 ' + n + ' 首');
    },

    /** 选中的曲目对象（顺序 = 列表顺序）；A 条目不在 selIds 里，取不到就跳过 */
    selectedSongs() {
      return selPicked(this.selIds, this.multiList());
    },

    /** 下一首播放：插到当前曲之后（player.insertNext），完成后退出多选 */
    doNext() {
      const picked = this.selectedSongs();
      if (!picked.length) {
        this.showToast('未选中歌曲');
        return;
      }
      const r = playNext(picked);
      log('dltracks', '下一首播放 ' + picked.length + ' 首 ' + JSON.stringify(r));
      this.exitMulti();
      const t = playNextText(r);
      if (t) this.showToast(t);
    },

    /** 收藏到歌单：跳歌单选择页（pick 模式带一批 id） */
    doToPlaylist() {
      const picked = this.selectedSongs();
      if (!picked.length) {
        this.showToast('未选中歌曲');
        return;
      }
      const n = toPlaylist(picked);
      if (!n) {
        this.showToast('未选中歌曲');
        return;
      }
      log('dltracks', '收藏到歌单 ' + n + ' 首 → 选择页');
      this.exitMulti();
    },
  }
}
