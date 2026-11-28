import { setSubscribed, renamePlaylist, deletePlaylist } from '../../services/ncm/playlist.js'
import { removeListLocal } from '../../services/player/locallists.js'
import { openTextEdit, available as imeAvailable } from '../../core/platform/systemKeyboard.js'
import { log } from '../../core/infra/log.js'

const NAME_MAX = 40 // 歌单名长度上限（网易云网页端同值）

export const plEditMixin = {
  methods: {
    async doRename() {
      // 系统输入法：先探测可用性；取消返回 null
      if (this.busy) return
      this.disarm()
      this.busy = 'rename'
      if (!(await imeAvailable())) {
        this.busy = ''
        this.showToast('系统输入法不可用')
        return
      }
      const text = await openTextEdit({
        text: this.name,
        placeholder: '歌单名',
        enterButtonText: '确定',
        maxlength: NAME_MAX,
        inputType: 'ZhCNPreferred'
      })
      if (this._dead) return
      if (text === null) {
        this.busy = ''
        log('plinfo', '改名取消')
        return
      }
      let name = String(text).replace(/^\s+|\s+$/g, '')
      if (!name) {
        this.busy = ''
        this.showToast('名字不能为空')
        return
      }
      let cut = false
      if (name.length > NAME_MAX) {
        name = name.slice(0, NAME_MAX)
        cut = true
      }
      if (name === this.name) {
        this.busy = ''
        this.showToast('名字没有变化')
        return
      }
      const r = await renamePlaylist(this.pid, name)
      this.busy = ''
      if (this._dead) return
      if (!r.ok) {
        this.showToast(this.failText(r))
        log('plinfo', '改名失败 code=' + r.code + ' ' + (r.message || ''))
        return
      }
      this.name = name
      const shown = name.length > 12 ? name.slice(0, 12) + '…' : name
      this.showToast((cut ? '名字已截到 40 字，' : '') + '已改名为「' + shown + '」')
      log('plinfo', '改名成功 ' + this.pid + ' -> ' + name)
      this.notify('rename', { name: name })
    },

    async toggleSub() {
      if (this.busy) return
      this.disarm()
      const on = !this.subscribed
      this.busy = 'sub'
      const r = await setSubscribed(this.pid, on)
      this.busy = ''
      if (this._dead) return
      if (!r.ok) {
        this.showToast(r.code === 401 ? '这是自己的歌单，不用收藏' : this.failText(r))
        log('plinfo', (on ? '收藏' : '取消收藏') + '失败 code=' + r.code + ' ' + (r.message || ''))
        return
      }
      this.subscribed = on
      this.showToast(on ? '已收藏' : '已取消收藏')
      log('plinfo', (on ? '已收藏 ' : '已取消收藏 ') + this.pid)
      this.notify(on ? 'subscribe' : 'unsubscribe')
    },

    askDelete() {
      if (this.busy) return
      if (this.isArmed('del')) {
        this.disarm()
        this.doDelete()
        return
      }
      this.arm('del')
    },

    /**
     * 删除：调用 /api/playlist/remove 删远端歌单（不可逆，仅自己创建的歌单）。
     * 从本地下载进入时「本地也删」：**先删远端**，成功后再做本地删除
     * （移除索引 + 删掉会变成孤儿的文件），然后广播并连带关掉下面的曲目列表页。
     */
    async doDelete() {
      if (this.busy) return
      this.disarm()
      this.panel = ''
      this.busy = 'del'
      const r = await deletePlaylist(this.pid)
      if (!r.ok) {
        this.busy = ''
        if (this._dead) return
        this.showToast(this.failText(r))
        log('plinfo', '删除失败 code=' + r.code + ' ' + (r.message || ''))
        return
      }
      log('plinfo', '已删除远端歌单 ' + this.pid + ' ' + this.name)
      let purge = null
      if (this.dlEntry) {
        // 远端没了，本地索引不能继续指过去；顺手清掉会变成孤儿的文件
        purge = await removeListLocal(this.pid)
        if (purge && purge.ok) this.pruneQueue(purge.deleted)
      }
      this.busy = ''
      if (this._dead) return
      if (purge && purge.ok) {
        log('plinfo', '删除连带本地清理：删 ' + (purge.deleted || []).length +
          ' 首 / ' + purge.files + ' 个文件 / ' + purge.bytes + ' 字节')
      }
      this.notify('delete')
      if (this.fromPage) {
        try {
          /* global $falcon */
          $falcon.closePageById(this.fromPage)
        } catch (e) {
          log('plinfo', 'closePageById 失败 ' + ((e && e.message) || e))
        }
      }
      this.$page.finish()
    },

    notify(op, extra) {
      const d = { id: this.pid, op: op }
      if (extra) {
        for (let k in extra) d[k] = extra[k]
      }
      /* global $falcon */
      try {
        $falcon.trigger('bpncm:playlist-changed', JSON.stringify(d))
      } catch (e) {}
    },
    failText(r) {
      if (r.needLogin) return '未登录'
      return '操作失败' + (r.message ? '：' + r.message : '（' + r.code + '）')
    },
  }
}
