<template>
  <div class="cmp">

    <!-- 顶栏 48px（设计稿 TopBar，底边 TOK.line）：左「评论」24px 粗体白 + 总数 14px 白（两者顶对齐）；
         右「发布评论」（pen-line 24px + 20px 白，padding 6px，距右 12px） -->
    <div class="cmp-bar">
      <div class="cmp-ttl">
        <text class="cmp-tt">评论</text>
        <text class="cmp-cnt">{{ totalText }}</text>
      </div>
      <div class="cmp-post" @click="onPost">
        <image class="cmp-pen" :src="ICON.penline" />
        <text class="cmp-post-t">发布评论</text>
      </div>
    </div>

    <!-- 内容区 scroller（视口 480×192）：上/左右 12px 由各块自己的 margin 拼出 -->
    <scroller class="cmp-sc">

      <!-- 「热门评论」行：高 24、左 padding 10 → 文字左缘 = 12+10=22，与设计稿 Title1 一致；
           没有热门评论的歌（新歌/零评论）不显示这一行，直接进正片 -->
      <div class="cmp-sect" v-if="hotList.length">
        <text class="cmp-sect-t">热门评论</text>
      </div>

      <!-- 热门评论卡（设计稿 CommentCard 8:88：456 宽、TOK.cardBg、圆角 8、padding 8、行距 6） -->
      <div class="cmp-card" v-for="c in hotList" :key="'h' + c.id">
        <div class="cmp-user">
          <div class="cmp-avbox">
            <image class="cmp-av" v-if="c.avatar" :src="c.avatar" />
          </div>
          <text class="cmp-nick">{{ c.user }}</text>
        </div>
        <div class="cmp-tw">
          <text class="cmp-tx">{{ c.content }}</text>
        </div>
        <div class="cmp-st">
          <text class="cmp-date">{{ c.timeStr }}</text>
          <div class="cmp-like" @click="onLike(c)">
            <text class="cmp-lc" :style="likeTextStyle(c)">{{ c.likedCount }}</text>
            <image class="cmp-thumb" :src="ICON.thumbsup" />
          </div>
        </div>
      </div>

      <!-- 正片评论卡（已按 id 去掉与热门重复的；见 restList 注释） -->
      <div class="cmp-card" v-for="c in restList" :key="'r' + c.id">
        <div class="cmp-user">
          <div class="cmp-avbox">
            <image class="cmp-av" v-if="c.avatar" :src="c.avatar" />
          </div>
          <text class="cmp-nick">{{ c.user }}</text>
        </div>
        <div class="cmp-tw">
          <text class="cmp-tx">{{ c.content }}</text>
        </div>
        <div class="cmp-st">
          <text class="cmp-date">{{ c.timeStr }}</text>
          <div class="cmp-like" @click="onLike(c)">
            <text class="cmp-lc" :style="likeTextStyle(c)">{{ c.likedCount }}</text>
            <image class="cmp-thumb" :src="ICON.thumbsup" />
          </div>
        </div>
      </div>

      <div class="cmp-state" v-if="showLoading">
        <text class="cmp-state-t">加载中…</text>
      </div>
      <div class="cmp-state" v-if="showError" @click="retry">
        <text class="cmp-state-t">评论加载失败，点此重试</text>
      </div>
      <div class="cmp-state" v-if="showEmpty">
        <text class="cmp-state-t">暂无评论</text>
      </div>

      <div class="cmp-more" v-if="canLoadMore" @click="loadMore">
        <text class="cmp-more-t">{{ moreLabel }}</text>
      </div>
      <div class="cmp-end" v-if="capped">
        <text class="cmp-end-t">{{ capLabel }}</text>
      </div>

      <div class="cmp-pad"></div>
    </scroller>
  </div>
</template>

<script>

// 评论接口：读评论匿名可用；点赞/发评论走 weapi，未登录返回 301
// 平台约束：页面会挂两遍 → 异步回调都过 _dead/_gen 守卫；子组件不渲染 hint-toast，提示一律 $emit('toast') 交给页面

import { TOK } from '../../ui/tokens.js'
import { ICON } from '../../assets/icons.js'
import { accentMixin } from '../../ui/mixins/accent.js'
import { PAGE_LIMIT, fetchComments, likeComment, postComment } from '../../services/ncm/comments.js'
import { loggedIn } from '../../services/ncm/login.js'
import { openTextEdit } from '../../core/platform/systemKeyboard.js'
import { log } from '../../core/infra/log.js'

// 单次渲染的评论卡上限：热门 + 其余合计 ≤50（平台「一次渲染 ≤50 行」的既有口径）
const RENDER_MAX = 50

export default {
  name: 'CommentPanel',
  mixins: [accentMixin],
  props: {

    // 当前歌曲 id（页面给 st.cur.id；0 = 未在播放）
    songId: { type: [Number, String], default: 0 }
  },
  data() {
    return {
      ICON: ICON,
      loading: false, 
      loadingMore: false, 
      failed: false, 
      hasLoaded: false, 
      // 热门评论（只有 offset=0 的回包才有）
      hot: [], 
      list: [], 
      total: 0, 
      // 下一次请求的 offset：按原始条数走，不能用去重后的显示条数
      cursor: 0, 
      more: false, 
      capped: false, 
      posting: false 
    }
  },
  computed: {

    hotList() {
      return this.hot
    },

    // 正片卡：去掉与热门重复的（实测会重复）与翻页错位造成的同 id 重复；
    // 去重放渲染层，comments.js 保留服务端原样
    restList() {
      const seen = {}
      const h = this.hot
      for (let i = 0; i < h.length; i++) seen[h[i].id] = 1
      const out = []
      const a = this.list
      for (let i = 0; i < a.length; i++) {
        const c = a[i]
        if (seen[c.id]) continue
        seen[c.id] = 1
        out.push(c)
      }
      return out
    },

    totalText() {
      return this.hasLoaded ? String(this.total) : ''
    },

    moreLabel() {
      return this.loadingMore ? '加载中…' : '加载更多'
    },

    capLabel() {
      return '已显示前 ' + RENDER_MAX + ' 条评论'
    },
    canLoadMore() {
      return this.more && !this.capped
    },
    showLoading() {
      return this.loading && !this.hasLoaded && !this.failed
    },
    showError() {
      return this.failed
    },
    showEmpty() {
      return this.hasLoaded && !this.loading && !this.failed && !this.hot.length && !this.restList.length
    }
  },
  watch: {

    // 平台 watch 不去重（同值会被反复回调）→ 用 _songKey 自判重；
    // loadFirst 里的 _gen 快照保证慢回包不覆盖新歌的数据
    songId(v) {
      if (String(v || 0) === this._songKey) return
      this._songKey = String(v || 0)
      this.loadFirst(v)
    }
  },
  created() {
    this._dead = false
    this._songKey = ''
    this._gen = 0
    this._likeBusy = {} 
  },
  mounted() {
    this.loadFirst()
  },
  beforeDestroy() {
    this._dead = true
    this._likeBusy = {}
  },
  methods: {

    showToast(text) {
      this.$emit('toast', text)
    },

    // sid 由 watcher 显式传入，不依赖 prop 更新与 watcher 回调的先后顺序
    async loadFirst(sid) {
      const songId = sid === undefined ? this.songId : sid
      const key = String(songId || 0)
      this._songKey = key
      const gen = (this._gen = (this._gen || 0) + 1)
      this.hot = []
      this.list = []
      this.total = 0
      this.cursor = 0
      this.more = false
      this.capped = false
      this.failed = false
      this.loadingMore = false
      if (!songId) {

        // 没有在播曲：不发请求，直接空态（页面在无曲时也会渲染本面板）
        this.loading = false
        this.hasLoaded = true
        return
      }
      this.loading = true
      this.hasLoaded = false
      try {
        const r = await fetchComments(songId, 0, PAGE_LIMIT)
        if (this._dead || gen !== this._gen) return 
        this.hot = r.hot
        this.list = r.list
        this.total = r.total
        this.cursor = r.list.length
        this.more = r.more
        this.hasLoaded = true
        this.loading = false
        log('comment', '评论就绪 id=' + songId + ' 热门=' + r.hot.length + ' 本页=' + r.list.length + ' 总数=' + r.total)
      } catch (e) {
        if (this._dead || gen !== this._gen) return
        this.loading = false
        this.failed = true
        log('comment', '评论加载失败 id=' + songId + ' ' + ((e && e.message) || ''))
      }
    },

    retry() {
      if (this.loading) return
      this.loadFirst()
    },

    async loadMore() {
      if (this.loadingMore || this.capped || !this.more) return
      const songId = this.songId
      if (!songId) return
      const gen = this._gen

      // room 用显示条数算：去重后的卡才是实际渲染的行数
      const room = RENDER_MAX - this.hot.length - this.restList.length
      if (room <= 0) {
        this.capped = this.more
        return
      }
      const limit = room < PAGE_LIMIT ? room : PAGE_LIMIT
      this.loadingMore = true
      try {
        const r = await fetchComments(songId, this.cursor, limit)
        if (this._dead || gen !== this._gen) return
        const from = this.cursor
        this.list = this.list.concat(r.list)
        this.cursor += r.list.length

        // 回包为空但仍说 more → 停止，否则「加载更多」会无限空转
        this.more = r.more && r.list.length > 0
        this.loadingMore = false
        const shown = this.hot.length + this.restList.length
        if (shown >= RENDER_MAX) this.capped = this.more
        log('comment', '评论加载更多 offset=' + from + ' 本批=' + r.list.length + ' 共显示=' + shown + ' 还有=' + this.more)
      } catch (e) {
        if (this._dead || gen !== this._gen) return
        this.loadingMore = false
        this.showToast('加载评论失败，请重试')
        log('comment', '评论加载更多失败 ' + ((e && e.message) || ''))
      }
    },

    likeTextStyle(c) {
      return { color: c && c.liked ? this.accent.light : TOK.text2 }
    },

    // 点赞/取消（乐观更新，失败整体回滚）：未登录先本地拦，避免白打一次 301；
    // 服务端是切换接口（见 comments.js），所以请求在途时不允许再点同一条
    async onLike(c) {
      if (!c || !c.id || !this.songId) return
      if (!loggedIn()) {
        this.showToast('未登录')
        return
      }
      const id = c.id
      if (this._likeBusy[id]) return
      this._likeBusy[id] = true
      const want = !c.liked
      const oldCount = c.likedCount
      c.liked = want
      c.likedCount = oldCount + (want ? 1 : -1)
      if (c.likedCount < 0) c.likedCount = 0
      try {
        const r = await likeComment(this.songId, id, want)
        if (this._dead) return
        if (r.ok) return
        c.liked = !want
        c.likedCount = oldCount
        this.showToast(r.needLogin ? '未登录' : '点赞失败，请重试')
        log('comment', '点赞失败 code=' + r.code + ' ' + (r.message || ''))
      } catch (e) {
        c.liked = !want
        c.likedCount = oldCount
        if (!this._dead) this.showToast('点赞失败，请重试')
      } finally {
        this._likeBusy[id] = false
      }
    },

    // 发评论：输入法 → weapi → 成功 toast 并重载第一页（新评论在最新里）
    async onPost() {
      if (this.posting) return

      // songId 在开输入法之前锁定：输入法期间自动切歌的话，评论仍发到用户点按钮时那首
      const songId = this.songId
      if (!songId) {
        this.showToast('未在播放')
        return
      }
      if (!loggedIn()) {
        this.showToast('未登录')
        return
      }
      this.posting = true
      try {
        let raw = null
        try {
          raw = await openTextEdit({ placeholder: '说点什么…', maxlength: 140, inputType: 'ZhCNPreferred' })
        } catch (e) {
          raw = null
        }
        // 取消输入 / 输入法不可用都回 null
        if (raw === null) return 
        const text = String(raw).trim()
        if (!text) {
          this.showToast('评论内容不能为空')
          return
        }
        const r = await postComment(songId, text)
        if (this._dead) return
        if (r.ok) {
          this.showToast('评论已发布')
          log('comment', '评论已发布 id=' + songId + ' 字数=' + text.length)

          if (String(this.songId) === String(songId || 0)) this.loadFirst()
          return
        }
        this.showToast(r.needLogin ? '未登录' : '发布失败，请重试')
        log('comment', '发布失败 code=' + r.code + ' ' + (r.message || ''))
      } finally {
        this.posting = false
      }
    }
  }
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

/* 根：铺满父级、不上底色（父级 .ply-sub / .ply-drawer 给 TOK.subBg 和左侧圆角）；
   宽度用 100% 不写定宽：面板宽度随机型变（S7 480 / 窄屏抽屉更宽） */
.cmp {
  width: 100%;
  height: 100vh;
  flex-direction: column;
  overflow: hidden;
}

.cmp-bar {
  width: 100%;
  height: 48px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-left: 12px;
  padding-right: 12px;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}

/* 顶对齐（设计稿 Count 框与 Title 框同顶），不要再写 line-height 去挪基线 ——
   平台对 text 的 line-height 支持未验证（全项目只 ControlPanel 用过一次） */
.cmp-ttl {
  flex-direction: row;
  align-items: flex-start;
}
.cmp-tt {
  font-size: 24px;
  font-weight: bold;
  color: @text;
}
.cmp-cnt {
  font-size: 14px;
  color: @text;
  margin-left: 2px;
}

.cmp-post {
  flex-direction: row;
  align-items: center;
  padding: 6px;
}
.cmp-pen {
  width: 10vh; 
  height: 10vh;
}
.cmp-post-t {
  font-size: 8.33vh; 
  color: @text;
  margin-left: 1.67vh; 
}

/* 视口 = 240-48 = 192px；父高确定（根 100vh）→ flex:1 才有高度 */
.cmp-sc {
  flex: 1;
}

.cmp-sect {
  width: 95%; 
  height: 24px;
  flex: none;
  flex-direction: row;
  align-items: center;
  margin-left: 12px;
  margin-top: 12px;
  padding-left: 10px;
}
.cmp-sect-t {
  font-size: 8.33vh; 
  font-weight: bold;
  color: @text;
}

.cmp-card {
  width: 95%; 
  flex: none;
  flex-direction: column;
  margin-left: 12px;
  margin-top: 10px;
  padding: 8px;
  border-radius: 8px;
  background-color: @card-bg;
}

.cmp-user {
  width: 100%;
  flex: none;
  flex-direction: row;
  align-items: center;
  padding-left: 6px;
  padding-right: 6px;
  padding-top: 4px;
  padding-bottom: 4px;
}

/* 头像 36 圆形：平台不认 border-radius:50%，写半径 18px；父级 overflow 裁成圆 */
.cmp-avbox {
  width: 36px;
  height: 36px;
  flex: none;
  border-radius: 18px;
  background-color: @btn-bg;
  overflow: hidden;
  align-items: center;
  justify-content: center;
}
.cmp-av {
  width: 36px;
  height: 36px;
}

.cmp-nick {
  flex: 1;
  font-size: 8.33vh; 
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
  margin-left: 10px;
}

.cmp-tw {
  width: 100%;
  flex: none;
  flex-direction: column;
  margin-top: 6px;
  padding-left: 4px;
  padding-right: 4px;
}
.cmp-tx {
  width: 100%;
  font-size: 24px;
  line-height: 29px;
  color: @text;
}

.cmp-st {
  width: 100%;
  height: 28px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  padding-left: 8px;
  padding-right: 8px;
  padding-top: 4px;
  padding-bottom: 4px;
}
.cmp-date {
  font-size: 6.67vh; 
  color: @text-2;
}

.cmp-like {
  height: 28px;
  flex-direction: row;
  align-items: center;
}
.cmp-lc {
  font-size: 6.67vh; 
  color: @text-2;
  text-align: right;
  margin-right: 1.67vh; 
}
.cmp-thumb {
  width: 8.33vh; 
  height: 8.33vh;
}

.cmp-state {
  width: 100%;
  height: 192px;
  flex: none;
  align-items: center;
  justify-content: center;
}
.cmp-state-t {
  font-size: 8.33vh; 
  color: @text-3;
}

.cmp-more {
  width: 95%; 
  height: 36px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  margin-left: 12px;
  margin-top: 10px;
}
.cmp-more-t {
  font-size: 8.33vh; 
  color: @text-3;
}

.cmp-end {
  width: 95%; 
  height: 36px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  margin-left: 12px;
  margin-top: 10px;
}
.cmp-end-t {
  font-size: 14px;
  color: @text-3;
}

.cmp-pad {
  width: 100%;
  height: 12px;
  flex: none;
}
</style>
