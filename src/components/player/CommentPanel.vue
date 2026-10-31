<template>
  <div class="cmp">
    <!-- 顶栏 48px（设计稿 TopBar，底边 TOK.line）：
         左「评论」24px 粗体白 + 总数 14px 白（两者顶对齐，见样式注释）；
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

      <!-- 首屏加载 / 加载失败（可点重试）/ 无评论：三态互斥，各自独立单类名 -->
      <div class="cmp-state" v-if="showLoading">
        <text class="cmp-state-t">加载中…</text>
      </div>
      <div class="cmp-state" v-if="showError" @click="retry">
        <text class="cmp-state-t">评论加载失败，点此重试</text>
      </div>
      <div class="cmp-state" v-if="showEmpty">
        <text class="cmp-state-t">暂无评论</text>
      </div>

      <!-- 还有更多时的「加载更多」行；达到平台单次渲染上限后换成不可点的提示 -->
      <div class="cmp-more" v-if="canLoadMore" @click="loadMore">
        <text class="cmp-more-t">{{ moreLabel }}</text>
      </div>
      <div class="cmp-end" v-if="capped">
        <text class="cmp-end-t">{{ capLabel }}</text>
      </div>

      <!-- 底部留白 12px：scroller 本身没有内边距，用零内容块补（最后一张卡的 margin-bottom 不算） -->
      <div class="cmp-pad"></div>
    </scroller>
  </div>
</template>

<script>
/**
 * 播放页「评论」子面板（设计稿 PlayerPage 14:1570 / CommentPanel 14:1754，480×240）
 *
 * 视觉（Figma 证据与几何表见 docs/播放页.md，px 与设备 1:1）：
 *   顶栏 48px：评论 24px 粗体白 + 总数 14px 白（Title 96×29 @(12,9.5)，两者顶对齐）；
 *              右侧 IconButton 120×36 @(348,6)：图标 24 + 文字 20 + padding 6、内容间距 4。
 *   内容区 480×192：上/左右 12；热门行 24 高（左 padding 10）→ 卡片（456 宽、行距 10）；
 *   评论卡 = 456 宽 / padding 8 / 圆角 8 / 行距 6：
 *     用户行 44 高（padding 4/6）：头像 36 圆 + 10 + 昵称 20px 白；
 *     正文 24px 白、行高 29、左右 padding 4（宽 432）；
 *     状态行 28 高（padding 4/8）：日期 16px TOK.text2 + 右侧 点赞数 16px + thumbs-up 20px（间距 4）。
 *   组件**自己不上底色**：父级 .ply-sub 给 TOK.subBg + 左侧圆角（CONTRACT §0）。
 *
 * 数据/接口：utils/ncm/comments.js（读取明文匿名可用；点赞/发评论走 weapi，未登录 301）。
 * 状态机：
 *   loading（首屏）→ 成功：hot + list + total，失败：failed（点整块重试）；
 *   more → 底部「加载更多」按 cursor 追加；发评论成功 → 重载 offset 0 并 toast。
 *   换歌：watch songId 入口自判重（平台 watch 不去重），重载并丢弃上一首的在途结果（_gen）。
 *
 * ⚠ 平台约束（docs/平台约束与自检.md）：
 *   - 一次渲染 ≤50 行 → 评论卡合计最多 RENDER_MAX=50 张，超出后不再追加（换成「已显示前 N 条」提示）；
 *   - 模板裸绑定必须来自 props/computed/data（本组件所有 :x 都是 data/computed/v-for 别名）；
 *   - 样式只写单类名；颜色一律走 LESS 生成段（静态）或 TOK/accent 内联（动态）；
 *   - 页面会挂两遍 → 每个实例各自加载（数据同源，重复请求无害），异步回调都过 _dead/_gen 守卫。
 *   - 子组件不渲染 hint-toast：提示一律 this.$emit('toast', 文案) 交给页面。
 */
import { TOK } from '../../utils/ui/tokens.js'
import { ICON } from '../../assets/icons.js'
import { accentMixin } from '../../utils/theme.js'
import { PAGE_LIMIT, fetchComments, likeComment, postComment } from '../../utils/ncm/comments.js'
import { loggedIn } from '../../utils/ncm/login.js'
import { openTextEdit } from '../../utils/systemKeyboard.js'
import { log } from '../../utils/log.js'

/** 单次渲染的评论卡上限：热门 + 其余合计不超过 50（平台「一次渲染 ≤50 行」的既有口径） */
const RENDER_MAX = 50

export default {
  name: 'CommentPanel',
  mixins: [accentMixin],
  props: {
    /** 当前歌曲 id（页面给 st.cur.id；0 = 未在播放） */
    songId: { type: [Number, String], default: 0 }
  },
  data() {
    return {
      ICON: ICON,
      loading: false, // 首屏请求中
      loadingMore: false, // 追加请求中
      failed: false, // 首屏请求失败（显示可点重试）
      hasLoaded: false, // 至少成功加载过一次
      hot: [], // 热门评论（只有 offset=0 的回包才有）
      list: [], // 正片评论（原始累积，可能含重复 id，由 restList 去重）
      total: 0, // 服务端给的总评论数（顶部计数用）
      cursor: 0, // 下一次请求的 offset（按**原始**条数走，不能用去重后的显示条数）
      more: false, // 服务端还有更多
      capped: false, // 已达到渲染上限（还有更多但不再追加）
      posting: false // 输入法/发评论进行中：防重复触发
    }
  },
  computed: {
    /** 热门卡列表（不参与去重，按服务端顺序） */
    hotList() {
      return this.hot
    },
    /**
     * 正片卡列表：去掉与热门重复的（实测会重复），并去掉翻页错位造成的同 id 重复。
     * 去重在这里做（渲染层），comments.js 保留服务端原样 —— 顶部热门区与正片区不会出现同一张卡。
     */
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
    /** 顶栏评论总数：首屏回来前不显示（避免先闪一个 0） */
    totalText() {
      return this.hasLoaded ? String(this.total) : ''
    },
    /** 加载更多行的文案（请求中给「加载中…」，避免连点） */
    moreLabel() {
      return this.loadingMore ? '加载中…' : '加载更多'
    },
    /** 达到渲染上限后的提示（还有更多、但平台一次渲染装不下） */
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
    /**
     * 换歌：重载评论。平台 watch 不去重（同值会被反复回调），入口用 _songKey 自判重；
     * 回调里 loadFirst 会持有 _gen 快照，慢回包不会覆盖新歌的数据。
     */
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
    this._likeBusy = {} // commentId → true：同一张卡的点赞请求在途时吞掉连点
  },
  mounted() {
    this.loadFirst()
  },
  beforeDestroy() {
    this._dead = true
    this._likeBusy = {}
  },
  methods: {
    /** 提示统一抛给页面（子组件不渲染 hint-toast） */
    showToast(text) {
      this.$emit('toast', text)
    },
    /** 首屏 / 换歌 / 发评论后重载：清空旧数据 → 取 offset=0（热门 + 第一页正片）。
     *  sid 只在 watcher 里显式传入（不依赖 prop 更新与 watcher 的先后顺序）。 */
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
        if (this._dead || gen !== this._gen) return // 期间换歌 / 面板已销毁：丢弃本次回包
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
    /** 加载失败后点整块重试 */
    retry() {
      if (this.loading) return
      this.loadFirst()
    },
    /** 底部「加载更多」：按 cursor 取下一页，追加到正片列表 */
    async loadMore() {
      if (this.loadingMore || this.capped || !this.more) return
      const songId = this.songId
      if (!songId) return
      const gen = this._gen
      // 剩余渲染预算（≤50 行）。room 用**显示条数**算：去重后的卡才是实际渲染的行数
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
    /** 点赞态的数字颜色：已赞用主题色浅色（暗底上更醒目），否则次要文字色 */
    likeTextStyle(c) {
      return { color: c && c.liked ? this.accent.light : TOK.text2 }
    },
    /**
     * 点赞 / 取消（乐观更新，失败整体回滚）：
     * 未登录先本地拦（toast 未登录），避免白打一次 301；同一条卡在途时吞掉连点。
     * 注意服务端是**切换**接口（见 comments.js 文件头），所以请求期间不允许再点同一条。
     */
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
    /**
     * 发布评论：未登录/无在播曲先拦 → 系统输入法（openTextEdit）→ weapi 发评论
     * → 成功 toast「评论已发布」并重载第一页（新评论在最新里）。
     * 取消输入 / 输入法不可用时 openTextEdit 回 null，直接静默返回。
     */
    async onPost() {
      if (this.posting) return
      // songId 在开输入法**之前**锁定：输入法期间自动切歌的话，评论仍然发到用户点按钮时那首
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
        if (raw === null) return // 取消输入 / 输入法不可用
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
          // 期间没换歌才重载（换歌时新歌列表已经在 loadFirst 里了）
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

/* 根：480×240 满格、**不上底色**（父级 .ply-sub 给 TOK.subBg 和左侧圆角） */
.cmp {
  width: 480px; /* 200vh：>100vh 的宽度必须写 px，否则被平台截到 240px */
  height: 100vh;
  flex-direction: column;
  overflow: hidden;
}
/* ---- 顶栏 48px ---- */
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
/* 标题组：96×29 @(12,9.5)。「评论」24px 的天然行盒就是这个高度；
   顶对齐（设计稿 Count 框与 Title 框同顶），不要再写 line-height 去挪基线 ——
   平台对 <text> 的 line-height 支持未验证（全项目只 ControlPanel 用过一次） */
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
/* 发布评论：120×36（icon 24 + 间距 4 + 文字 20，padding 6） */
.cmp-post {
  flex-direction: row;
  align-items: center;
  padding: 6px;
}
.cmp-pen {
  width: 10vh; /* 24px */
  height: 10vh;
}
.cmp-post-t {
  font-size: 8.33vh; /* 20px */
  color: @text;
  margin-left: 1.67vh; /* 4px */
}
/* ---- 内容区 ---- */
/* 视口 = 240-48 = 192px；父高确定（根 100vh）→ flex:1 才有高度 */
.cmp-sc {
  flex: 1;
}
/* 热门评论行：24 高、左 padding 10，上边距 12 = 设计稿 Title1 @(12,60) */
.cmp-sect {
  width: 456px;
  height: 24px;
  flex: none;
  flex-direction: row;
  align-items: center;
  margin-left: 12px;
  margin-top: 12px;
  padding-left: 10px;
}
.cmp-sect-t {
  font-size: 8.33vh; /* 20px */
  font-weight: bold;
  color: @text;
}
/* 评论卡：456 宽、行距 10（卡与卡之间 / 标题与首卡之间），底 TOK.cardBg、圆角 8、padding 8 */
.cmp-card {
  width: 456px;
  flex: none;
  flex-direction: column;
  margin-left: 12px;
  margin-top: 10px;
  padding: 8px;
  border-radius: 8px;
  background-color: @card-bg;
}
/* 用户行：44 高（上下 padding 4 + 头像 36），左右 padding 6 */
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
/* 昵称 20px 白：flex:1 占据剩余宽度（定宽行里才能 lines:1 省略号） */
.cmp-nick {
  flex: 1;
  font-size: 8.33vh; /* 20px */
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
  margin-left: 10px;
}
/* 正文：24px 白、行高 29px（设计稿 Text 框 440×29/行），可折行 → 不写 lines。
   卡片内三段的行距 6：UserInfo → Text → Status（设计稿 y8/58/93，各差 6） */
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
/* 状态行：28 高（上下 padding 4 + 内容 20），左右 padding 8，日期与点赞分列两端 */
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
  font-size: 6.67vh; /* 16px */
  color: @text-2;
}
/* 点赞区：数字 16px + 图标 20px、间距 4；高 28 让点击区顶到状态行上下边（视觉不变） */
.cmp-like {
  height: 28px;
  flex-direction: row;
  align-items: center;
}
.cmp-lc {
  font-size: 6.67vh; /* 16px */
  color: @text-2;
  text-align: right;
  margin-right: 1.67vh; /* 4px */
}
.cmp-thumb {
  width: 8.33vh; /* 20px */
  height: 8.33vh;
}
/* ---- 三态（加载/失败/空）：占满内容区 192px 居中 ---- */
.cmp-state {
  width: 480px;
  height: 192px;
  flex: none;
  align-items: center;
  justify-content: center;
}
.cmp-state-t {
  font-size: 8.33vh; /* 20px */
  color: @text-3;
}
/* 「加载更多」行：可点，高 36（与 20px 文字留出触摸余量），行内居中 */
.cmp-more {
  width: 456px;
  height: 36px;
  flex: none;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  margin-left: 12px;
  margin-top: 10px;
}
.cmp-more-t {
  font-size: 8.33vh; /* 20px */
  color: @text-3;
}
/* 达到渲染上限的提示行：不可点，样式同加载更多 */
.cmp-end {
  width: 456px;
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
/* scroller 没有内边距 → 末尾补 12px 视觉留白 */
.cmp-pad {
  width: 100%;
  height: 12px;
  flex: none;
}
</style>
