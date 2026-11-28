<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar :title="name || '歌单'" :sub="barSub" />

    <div class="pi-body">

      <div class="pi-cvbox">
        <image v-if="cover" class="pi-cv" :src="cover" resize="cover" />
      </div>

      <div class="pi-info">
        <div class="pi-namerow">
          <text class="pi-name">{{ name || '加载中...' }}</text>
          <text class="pi-idx" v-if="indexed" :style="idxStyle">本地索引</text>
        </div>
        <text class="pi-meta" v-if="meta">{{ meta }}</text>

        <scroller class="pi-descbox">
          <!-- 长文本默认就会自动换行（渲染实验实证：不写 lines 的 <text> 会折行，
               lines:N 才是「最多 N 行 + 省略号」），所以这里只约束宽度、包在 scroller 里滚动 -->
          <text class="pi-desc" v-if="desc">{{ desc }}</text>
          <text class="pi-desc-empty" v-else>{{ hint || '暂无介绍' }}</text>
        </scroller>
      </div>
    </div>

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
 * 「添加到本地索引」只落歌单信息 + 全量 trackIds，不下载文件；再次点击 = 移出索引，
 * **只删记录、不删文件**（策略 A），失去所有索引引用的歌单文件自动归入「遗留歌曲」。
 * 「我喜欢」是系统歌单，不能改名/删除。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import ContextSheet from '../../components/ContextSheet.vue'
import HintToast from '../../components/HintToast.vue'
import { railBack, railBtn, ICON } from '../../ui/rail.js'
import { go, paramsFor } from '../../core/infra/nav.js'
import { fetchPlaylistInfo, roleOf } from '../../services/ncm/playlist.js'
import { playlistQueue, PLAYLIST_QUEUE_HEAD } from '../../services/player/playqueue.js'
import { addList, removeList, removeListLocal, isIndexed, downloadAll } from '../../services/player/locallists.js'
import { player } from '../../services/player/player.js'
import { bindDl } from '../../ui/mixins/dlsub.js'
import { dlText, dlSig, dlApi } from '../../services/player/download.js'
import { fmtSize } from '../../core/infra/format.js'
import { ensureCover, coverKey, BIG_COVER } from '../../services/cover/cover.js'
import config from '../../core/infra/config.js'
import { log } from '../../core/infra/log.js'
import { accentMixin } from '../../ui/mixins/accent.js'
import { toastMixin } from '../../ui/mixins/toast.js'
import { armMixin } from '../../ui/mixins/arm.js'
import { pageFrameMixin } from '../../ui/mixins/frame.js'
import { plEditMixin } from './edit.js'

export default {
  name: 'plinfo',
  mixins: [accentMixin, toastMixin, armMixin, pageFrameMixin, plEditMixin],
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
      trackIds: [], // 详情接口带回来的全量 id（「播放全部」起播首段用，不必再请求一次）
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
    /** 歌单归属（决定可写键/收藏键）：判定口径唯一在 ncm/playlist.js 的 roleOf */
    role() {
      return roleOf({
        creatorId: this.creatorId,
        specialType: this.specialType,
        me: config.get('userId')
      })
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

    rail() {
      if (this.dlEntry) {
        const out = [railBack()]
        if (!this.role) return out
        out.push(railBtn('more', ICON.more, this.panel === 'more'))
        out.push(railBtn('playall', ICON.play, this.busy === 'playall'))

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

    this._dlOff = bindDl(this, dlApi, function (s) {
      self.syncDl(s)
    })
    log('plinfo', 'onLoad id=' + this.pid + ' name=' + this.name + ' entry=' + (this.dlEntry ? 'dl' : 'list'))
    this.load()
    this.loadIndexed()
  },
  beforeDestroy() {
    this._dead = true
    if (this._dlOff) this._dlOff()
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
        self.trackIds = info.trackIds || []
        self.hint = ''
        ensureCover({ id: coverKey('playlist', self.pid), cover: info.cover }, function (cid, path) {
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
      const sig = dlSig(d)
      if (sig === this._dlSig) return
      this._dlSig = sig
      this.dl = d
    },

    closePanel() {
      this.panel = ''
      this.disarm()
    },
    pickMore(key) {
      // 破坏性项（本地删除 / 删除）：第一次点按进入待确认、面板不关（标签与高亮变化），
      // 第二次点按才执行 —— 与左栏破坏键的两次点按确认一致（armMixin）
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

    async doDownloadAll() {
      // 已索引时按 playlist 归属写标记（移出索引后会进「遗留歌曲」）；
      // 未索引时按用户单曲下载（不产生「没有索引却有遗留」的怪状态）
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

    /** 播放队列里来自本地下载的曲目被删掉后同步移出队列（只在 queueSrc === 'downloads' 时动） */
    pruneQueue(ids) {
      try {
        if (ids && ids.length && player.state().queueSrc === 'downloads') player.removeFromQueue(ids)
      } catch (e) {}
    },

    /**
     * 本地删除：移除本地索引，并把「移出后会变成遗留歌曲」的文件直接删掉（不留孤儿）。
     * 仍被其它索引歌单引用的文件、用户单曲归属的文件保留（见 locallists.removeListLocal）。
     * 云端歌单不动；页面留在原地。
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

    /**
     * 起播首段 300 首（一次 song/detail 请求），剩余曲目由 playqueue.js 在后台逐批
     * 追加到队尾 —— 不再等整张歌单拉完（几千首的索引歌单要几十秒）。
     */
    async playAll() {
      if (this.busy) return
      this.busy = 'playall'
      this.showToast('正在载入曲目...', 60000)
      try {
        let ids = this.trackIds
        if (!ids || !ids.length) {

          const info = await fetchPlaylistInfo(this.pid)
          ids = info.trackIds || []
          if (!this._dead) this.trackIds = ids
        }
        const q = await playlistQueue(ids, PLAYLIST_QUEUE_HEAD)
        this.busy = ''
        this.hideToast()
        if (this._dead) return
        if (!q.songs.length) {
          this.showToast('没有可播放的曲目')
          return
        }
        player.playList(q.songs, 0)
        if (q.fill) q.fill() // 后台补齐：不 await，不挡页面
        log('plinfo', '播放全部 ' + q.songs.length + ' 首' + (q.fill ? '（其余后台补齐）' : ''))
        go('player', {})
      } catch (e) {
        this.busy = ''
        this.hideToast()
        if (this._dead) return
        this.showToast('载入曲目失败：' + ((e && e.message) || e))
        log('plinfo', '播放全部载入失败 ' + ((e && e.message) || e))
      }
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

/* 内容区 = 100vh − 顶栏 15vh = 85vh；横向两栏：左封面 60vh 见方 + 右信息列。
   父级 .pi-body 高度确定，所以下面介绍区的 flex:1 才有高度可用（平台坑：flex:1 只在父容器高度确定时成立） */
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
