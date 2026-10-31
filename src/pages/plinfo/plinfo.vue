<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar :title="name || '歌单'" :sub="barSub" />

    <div class="pi-body">
      <!-- 左：大封面（歌单封面是方图，不是歌手页那种正圆） -->
      <div class="pi-cvbox">
        <image v-if="cover" class="pi-cv" :src="cover" resize="cover" />
      </div>

      <!-- 右：名字（+ 本地索引标记）/ 创建者·曲目数 / 介绍 -->
      <div class="pi-info">
        <div class="pi-namerow">
          <text class="pi-name">{{ name || '加载中...' }}</text>
          <text class="pi-idx" v-if="indexed" :style="idxStyle">本地索引</text>
        </div>
        <text class="pi-meta" v-if="meta">{{ meta }}</text>

        <!-- 介绍区：**长文本默认就会自动换行**（渲染实验实证：不写 lines 的 <text>
             会折行，lines:N 才是「最多 N 行 + 省略号」），所以这里只约束宽度、包在 scroller 里滚动 -->
        <scroller class="pi-descbox">
          <text class="pi-desc" v-if="desc">{{ desc }}</text>
          <text class="pi-desc-empty" v-else>{{ hint || '暂无介绍' }}</text>
        </scroller>
      </div>
    </div>

    <!-- 上下文菜单（左栏「更多」展开）：下载全部 / 添加到本地索引 / 重命名。
         从「本地下载」进入时底键是「移除/添加到本地索引」，另有两项破坏性项
         「本地删除 / 删除」放在面板底部（见 script 头注释）。 -->
    <context-sheet
      v-if="panel"
      title="更多"
      :options="moreOptions"
      :active-key="armed"
      :dense="moreOptions.length > 3"
      mark-text=""
      @pick="pickMore"
      @close="closePanel"
    />
    <hint-toast :text="toast" />
  </page-shell>
</template>

<script>
/**
 * 歌单详情页（从曲目列表页的**顶栏**点进来，见 components/PageTopbar.vue 的 link/tap）
 *
 * 两种入口，左栏上下文菜单不同：
 *
 * A. 普通入口（在线曲目列表页点顶栏）：
 *   返回 / 更多（下载全部、添加到本地索引、重命名）/ 播放全部 / 删除（可写歌单）
 *   返回 / 更多 / 播放全部（「我喜欢」：系统歌单，不能改名/删除）
 *
 * B. 从「本地下载」进入（dltracks 传 entry:'dl'，此时歌单必然已在本地索引里）：
 *   返回 / 更多 / 播放全部 / **移除本地索引**（索引切换键，底键）
 *   「更多」面板：下载全部 / 重命名（自己创建）/ 收藏切换（订阅）/ 本地删除 / 删除
 *   - **本地删除**：移除本地索引，并把「移出后会变成遗留歌曲」的文件直接删掉
 *     （不留孤儿；仍被其它索引歌单引用、或用户单曲归属的文件保留）。
 *   - **删除**：本地删除 + 调用接口把远端歌单也删掉（仅自己创建的歌单；云端删除不可逆）。
 *   两个破坏性项都在「更多」面板底部，仍是两次点按确认（armMixin）。
 *
 * 「添加到本地索引」是本模块的核心本地能力：
 *   - 只落歌单信息 + 全量 trackIds（local lists），不下载文件；
 *   - 再次点击 = 移出索引，**只删记录、不删文件**（策略 A）；
 *   - 移出后失去所有索引引用的歌单批量下载文件会自动归入「遗留歌曲」
 *     （见 dlorigin.js / locallists.js 的分类）。
 *
 * 删除成功后的返回逻辑保留：
 * 广播 → closePageById(fromPage) → finish，二级兜底是列表页自退。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import ContextSheet from '../../components/ContextSheet.vue'
import HintToast from '../../components/HintToast.vue'
import { railBack, railBtn, ICON } from '../../utils/rail.js'
import { go, paramsFor } from '../../utils/nav.js'
import {
  fetchPlaylistInfo,
  fetchPlaylistAllSongs,
  setSubscribed,
  renamePlaylist,
  deletePlaylist
} from '../../utils/ncm/playlist.js'
import { addList, removeList, removeListLocal, isIndexed, downloadAll } from '../../utils/player/locallists.js'
import { player } from '../../utils/player/player.js'
import { dlState, onDl, offDl } from '../../utils/player/download.js'
import { dlText } from '../../utils/multidl.js'
import { fmtSize } from '../../utils/format.js'
import { ensureCover, BIG_COVER } from '../../utils/cover.js'
import { openTextEdit, available as imeAvailable } from '../../utils/systemKeyboard.js'
import config from '../../utils/config.js'
import { log } from '../../utils/log.js'
import { accentMixin } from '../../utils/theme.js'
import { toastMixin } from '../../utils/ui/toast.js'
import { armMixin } from '../../utils/ui/arm.js'
import { pageFrameMixin } from '../../utils/ui/frame.js'

const NAME_MAX = 40 // 歌单名长度上限（网易云网页端同值）

export default {
  name: 'plinfo',
  mixins: [accentMixin, toastMixin, armMixin, pageFrameMixin],
  components: {
    'page-shell': PageShell,
    'page-topbar': PageTopbar,
    'context-sheet': ContextSheet,
    'hint-toast': HintToast
  },
  data() {
    return {
      ICON: ICON,
      pid: 0,
      name: '',
      desc: '',
      cover: '',
      subscribed: false,
      specialType: 0,
      creatorId: 0,
      creator: '',
      trackCount: 0,
      hint: '',
      indexed: false,
      panel: '',
      busy: '', // '' | 'rename' | 'sub' | 'del' | 'localdel' | 'index' | 'dlall' | 'playall'
      dl: null,
      fromPage: '',
      dlEntry: false // 从「本地下载」进入（dltracks 的 entry:'dl'）：左栏/更多面板换成本地语境
    }
  },
  computed: {
    role() {
      const me = Number(config.get('userId')) || 0
      if (!this.creatorId) return ''
      if (this.creatorId !== me) return 'subscribed'
      return this.specialType === 5 ? 'liked' : 'created'
    },
    meta() {
      if (!this.creatorId) return ''
      return (this.creator || '未知') + ' · ' + this.trackCount + ' 首'
    },
    idxStyle() {
      return { color: this.accent.light }
    },
    barSub() {
      const t = dlText(this.dl)
      if (t) return t
      if (this.busy === 'playall') return '载入曲目中...'
      if (this.busy === 'dlall') return '下载全部...'
      if (this.busy === 'localdel') return '本地删除中...'
      if (this.busy === 'del') return '删除中...'
      return this.indexed ? '已在本地索引' : ''
    },
    /**
     * 「更多」面板。
     * 普通入口：下载全部 / 添加(移出)本地索引 / 重命名。
     * 本地下载入口：下载全部 / 重命名（自己创建）/ 收藏切换（订阅）/
     *   本地删除（已索引时）/ 删除（仅自己创建，云端也删）。
     * 破坏性两项放面板底部，两次点按确认（第一次点按后标签变「再点一次确认」）。
     */
    moreOptions() {
      if (!this.dlEntry) {
        const out = [
          { key: 'dlall', label: '下载全部', icon: ICON.download },
          {
            key: 'index',
            label: this.indexed ? '移出本地索引' : '添加到本地索引',
            icon: this.indexed ? ICON.dbminus : ICON.dbplus
          }
        ]
        if (this.role === 'created') {
          out.push({ key: 'rename', label: '重命名', icon: ICON.penline })
        }
        return out
      }
      const out = [{ key: 'dlall', label: '下载全部', icon: ICON.download }]
      if (this.role === 'created') {
        out.push({ key: 'rename', label: '重命名', icon: ICON.penline })
      } else if (this.role === 'subscribed') {
        out.push({
          key: 'sub',
          label: this.subscribed ? '取消收藏' : '收藏',
          icon: ICON.star
        })
      }
      if (this.indexed) {
        out.push({
          key: 'localdel',
          label: this.isArmed('localdel') ? '再点一次确认' : '本地删除',
          icon: ICON.trash
        })
      }
      if (this.role === 'created') {
        out.push({
          key: 'del',
          label: this.isArmed('del') ? '再点一次确认' : '删除',
          icon: ICON.trash
        })
      }
      return out
    },
    /**
     * 左栏：返回 + 更多 + 播放全部 +（可写）删除 /（订阅）收藏。
     * 普通入口：更多 → ContextSheet：下载全部 / 添加到本地索引 / 重命名。
     * 本地下载入口：底键 = 移除本地索引（索引切换），删除收进「更多」面板
     *   —— 本语境优先本地动作，云端删除降级为面板项（见 script 头注释）。
     */
    rail() {
      if (this.dlEntry) {
        const out = [railBack()]
        if (!this.role) return out
        out.push(railBtn('more', ICON.more, this.panel === 'more'))
        out.push(railBtn('playall', ICON.play, this.busy === 'playall'))
        // 底键：已索引 = 移除本地索引（dbminus），未索引 = 添加到本地索引（dbplus）
        out.push(railBtn('index', this.indexed ? ICON.dbminus : ICON.dbplus, this.busy === 'index'))
        return out
      }
      const out = [railBack()]
      if (!this.role) return out
      out.push(railBtn('more', ICON.more, this.panel === 'more'))
      out.push(railBtn('playall', ICON.play, this.busy === 'playall'))
      if (this.role === 'created') {
        out.push(railBtn('del', this.fgIcon('trash'), false, '', this.isArmed('del')))
      } else if (this.role === 'subscribed') {
        out.push(railBtn('sub', ICON.star, this.subscribed))
      }
      return out
    }
  },
  mounted() {
    this._dead = false
    // 参数通道按实例槽位 key 记账，取参必须用真实页名（写死逻辑页名只在兜底时命中）
    const p = paramsFor((this.$page && this.$page.$pageName) || 'plinfo', this.$page ? this.$page.options : null)
    this.pid = Number(p.id) || 0
    this.fromPage = p.fromPage || ''
    this.dlEntry = p.entry === 'dl'
    if (p.name) this.name = p.name
    const self = this
    this._dlOff = onDl(function (s) {
      self.syncDl(s)
    })
    this.syncDl(dlState())
    log('plinfo', 'onLoad id=' + this.pid + ' name=' + this.name + ' entry=' + (this.dlEntry ? 'dl' : 'list'))
    this.load()
    this.loadIndexed()
  },
  beforeDestroy() {
    this._dead = true
    if (this._dlOff) offDl(this._dlOff)
    this._dlOff = null
  },
  methods: {
    async load() {
      if (!this.pid) {
        this.hint = '缺少歌单 id'
        return
      }
      const self = this
      try {
        const info = await fetchPlaylistInfo(this.pid)
        if (self._dead) return
        self.name = info.name || self.name
        self.desc = info.desc
        self.subscribed = info.subscribed
        self.specialType = info.specialType
        self.creatorId = info.creatorId
        self.creator = info.creator
        self.trackCount = info.trackCount
        self.hint = ''
        ensureCover({ id: 'pl' + self.pid, cover: info.cover }, function (cid, path) {
          if (path && !self._dead) self.cover = path
        }, BIG_COVER)
        log('plinfo', '详情就绪 ' + info.name + ' 曲目=' + info.trackCount + ' 归属=' + self.role)
      } catch (e) {
        if (self._dead) return
        self.hint = '加载失败: ' + ((e && e.message) || e)
        log('plinfo', '加载失败 ' + ((e && e.message) || e))
      }
    },
    async loadIndexed() {
      if (!this.pid) return
      try {
        const v = await isIndexed(this.pid)
        if (this._dead) return
        this.indexed = v
        log('plinfo', '本地索引状态 ' + (v ? '已添加' : '未添加'))
      } catch (e) {}
    },
    syncDl(s) {
      const d = s || {}
      const sig = (d.active ? 1 : 0) + '|' + d.total + '|' +
        (d.done + d.failed + (d.cancelled || 0)) + '|' + (d.stopping ? 1 : 0) + '|' + d.pct
      if (sig === this._dlSig) return
      this._dlSig = sig
      this.dl = d
    },
    /* ---- 更多面板 ---- */
    closePanel() {
      this.panel = ''
      this.disarm()
    },
    pickMore(key) {
      // 破坏性项（本地删除 / 删除）：第一次点按进入待确认，面板不关（标签与高亮变化）；
      // 第二次点按才执行 —— 与左栏破坏键的两次点按确认一致（armMixin）。
      if (key === 'localdel' || key === 'del') {
        if (this.busy) return
        if (this.isArmed(key)) {
          if (key === 'localdel') this.doLocalDelete()
          else this.doDelete()
          return
        }
        this.arm(key)
        return
      }
      this.panel = ''
      this.disarm()
      if (key === 'dlall') this.doDownloadAll()
      else if (key === 'index') this.toggleIndex()
      else if (key === 'rename') this.doRename()
      else if (key === 'sub') this.toggleSub()
    },
    /**
     * 下载全部：抓整张远端曲目 → downloadSongs。
     * 已索引时按 playlist 归属写标记（移出索引后会进「遗留歌曲」）；
     * 未索引时按用户单曲下载（不产生「没有索引却有遗留」的怪状态）。
     */
    async doDownloadAll() {
      if (this.busy) return
      this.busy = 'dlall'
      this.showToast('正在载入曲目...', 60000)
      const self = this
      const r = await downloadAll(this.pid, function (done, total) {
        self.showToast('载入中 ' + done + '/' + total, 60000)
      })
      this.busy = ''
      this.hideToast()
      if (this._dead) return
      if (!r.ok) {
        this.showToast(r.offline ? '离线，无法下载' : (r.error || '下载失败'))
        return
      }
      this.showToast('下载全部完成：成功 ' + r.downloaded + ' / 跳过 ' + r.skipped +
        ' / 失败 ' + r.failed, 4000)
      this.loadIndexed()
    },
    /** 添加 / 移出本地索引：只动索引记录，不下载/不删文件（策略 A） */
    async toggleIndex() {
      if (this.busy) return
      this.busy = 'index'
      if (this.indexed) {
        const r = await removeList(this.pid)
        this.busy = ''
        if (this._dead) return
        if (r.ok) {
          this.indexed = false
          this.showToast('已移出本地索引（已下载文件保留）')
          log('plinfo', '移出本地索引 ' + this.pid)
        } else {
          this.showToast('移出失败')
        }
        return
      }
      this.showToast('添加中...', 60000)
      const r = await addList(this.pid)
      this.busy = ''
      this.hideToast()
      if (this._dead) return
      if (!r.ok) {
        this.showToast(r.offline ? '离线，无法添加' : (r.error || '添加失败'))
        return
      }
      this.indexed = true
      this.showToast('已添加至本地索引')
      log('plinfo', '添加本地索引 ' + this.pid + ' 曲目=' + (r.count || 0))
    },
    /* ---- 本地删除 / 删除（仅「从本地下载进入」时出现在更多面板里） ---- */
    /** 播放队列里来自本地下载的曲目被删掉后同步移出队列（同 dltracks 的批量删除） */
    pruneQueue(ids) {
      try {
        if (ids && ids.length && player.state().queueSrc === 'downloads') player.removeFromQueue(ids)
      } catch (e) {}
    },
    /**
     * 本地删除：移除本地索引，并把「移出后会变成遗留歌曲」的文件直接删掉（不留孤儿）。
     * 仍被其它索引歌单引用的文件、用户单曲归属的文件保留（见 locallists.removeListLocal）。
     * 云端歌单不动；页面留在原地（索引状态变「未索引」，底键回到「添加到本地索引」）。
     */
    async doLocalDelete() {
      if (this.busy || !this.indexed) return
      this.disarm()
      this.panel = ''
      this.busy = 'localdel'
      const r = await removeListLocal(this.pid)
      this.busy = ''
      if (this._dead) return
      if (!r.ok) {
        this.showToast(r.error || '本地删除失败')
        return
      }
      this.indexed = false
      this.pruneQueue(r.deleted)
      const n = (r.deleted || []).length
      this.showToast('已本地删除：删掉 ' + n + ' 首 · 释放 ' + fmtSize(r.bytes), 4000)
      log('plinfo', '本地删除 ' + this.pid + ' 删除=' + n + ' 文件=' + r.files + ' 字节=' + r.bytes)
    },
    /* ---- 播放全部 ---- */
    async playAll() {
      if (this.busy) return
      this.busy = 'playall'
      this.showToast('正在载入曲目...', 60000)
      const self = this
      let songs = []
      try {
        songs = await fetchPlaylistAllSongs(this.pid, function (done, total) {
          self.showToast('载入中 ' + done + '/' + total, 60000)
        })
      } catch (e) {
        songs = []
        log('plinfo', '播放全部载入失败 ' + ((e && e.message) || e))
      }
      this.busy = ''
      this.hideToast()
      if (this._dead) return
      if (!songs.length) {
        this.showToast('没有可播放的曲目')
        return
      }
      player.playList(songs, 0)
      log('plinfo', '播放全部 ' + songs.length + ' 首')
      go('player', {})
    },
    /* ---- 重命名（系统输入法，index 搜索同款：先探测可用性，取消返回 null）---- */
    async doRename() {
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
    /* ---- 收藏 / 取消收藏（订阅别人的歌单；可逆操作，不做二次确认）---- */
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
    /* ---- 删除（两次点按确认，对齐 account 页退出登录）---- */
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
     * （移除索引 + 删掉会变成孤儿的文件；见 locallists.removeListLocal），
     * 然后广播并连带关掉下面的曲目列表页。
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
    /* ---- 杂项 ---- */
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
    onBack() {
      // 浮层打开时返回键先收起浮层，不退页
      if (this.panel) {
        this.panel = ''
        this.disarm()
        return
      }
      this.$page.finish()
    },
    onRailKey(key) {
      if (key === 'more') {
        const open = this.panel !== 'more'
        this.panel = open ? 'more' : ''
        if (!open) this.disarm()
      } else if (key === 'playall') this.playAll()
      else if (key === 'index') this.toggleIndex()
      else if (key === 'del') this.askDelete()
      else if (key === 'sub') this.toggleSub()
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 内容区 = 100vh − 顶栏 15vh = 85vh。
   横向两栏：左封面 60vh 见方 + 右信息列（吃满剩余宽度）。
   竖向：名字行 11vh + 小字 6vh + 介绍（flex:1）—— 父级 .pi-body 高度确定，
   所以介绍区的 flex:1 有高度可用（AGENTS 坑 19：flex:1 只在父容器高度确定时成立）。 */
.pi-body {
  flex: 1;
  flex-direction: row;
  padding: 4vh;
}
.pi-cvbox {
  width: 60vh;
  height: 60vh;
  flex: none;
  border-radius: 3vh;
  background-color: @panel-2;
  overflow: hidden;
}
.pi-cv {
  width: 60vh;
  height: 60vh;
}
.pi-info {
  flex: 1;
  min-width: 0;
  flex-direction: column;
  margin-left: 5vh;
}
.pi-namerow {
  flex-direction: row;
  align-items: center;
}
.pi-name {
  flex: 1;
  min-width: 0;
  font-size: @fs-title;
  font-weight: bold;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
/* 本地索引标记：主题色浅色小字，紧贴歌单名右侧 */
.pi-idx {
  flex: none;
  font-size: @fs-mute;
  color: @accent-2; /* 默认（红）的书面值；运行时由模板内联 style 给主题色 */
  margin-left: 2vh;
}
.pi-meta {
  font-size: @fs-mute;
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
  margin-top: 1.2vh;
}
/* 介绍区：滚动容器（长文本在这里换行，见模板注释）；不写 lines —— 写了就是截断。
   宽度显式写 100%（= .pi-info 的宽度）：换行要按容器宽度折，别指望 scroller 一定被拉伸 */
.pi-descbox {
  flex: 1;
  width: 100%;
  margin-top: 2vh;
}
.pi-desc {
  font-size: @fs-mute;
  color: @text-2;
}
.pi-desc-empty {
  font-size: @fs-mute;
  color: @text-3;
}
</style>
