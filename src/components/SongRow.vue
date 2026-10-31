<template>
  <div class="srow" :style="rowStyle" @click="onClick" @longpress="onHold">
    <div class="srow-cv">
      <image v-if="shownCover" class="srow-cvi" :src="shownCover" resize="cover" />
      <!-- 无封面（缓存没记封面 url / 封面没下过）时给灰音符占位，行高不塌 -->
      <image v-else class="srow-cvi-note" :src="ICON.note" />
      <!-- 多选态的勾选标记：叠在封面上（圈的大小等于圈本身的 vh，两态走内联 style）。
           「进出多选态零位移」靠它 —— 不新增 flex 子节点，行高列宽全不变 -->
      <div class="srow-mask" v-if="selectable">
        <div class="srow-mark" :style="markStyle">
          <!-- 勾选圈底是实心主题色 → 图标走 fgIcon（亮色预设自动换深色版，否则白图标看不见） -->
          <image v-if="sel" class="srow-chk" :src="fgIcon('check')" />
        </div>
      </div>
    </div>
    <!-- 歌名 + 灰色别名(括号) + VIP 并排一个容器：VIP 紧跟歌名、共享同一块最大宽度。
         不用嵌套 <text> 富文本——实测该结构会导致渲染器崩溃（打开列表即崩） -->
    <div class="srow-main">
      <text class="srow-nm" :style="titleStyle">{{ song.name || ('歌曲 ' + song.id) }}</text>
      <text class="srow-alias" :style="toneStyle" v-if="aliasText">{{ aliasText }}</text>
      <text class="srow-vip" v-if="isVip"> VIP</text>
    </div>
    <text :class="showQuality ? 'srow-ar-q' : 'srow-ar'" :style="toneStyle">{{ song.artist || '未知歌手' }}</text>
    <!-- 档位 · 体积列（本地下载页专用） -->
    <text class="srow-q" :style="toneStyle" v-if="showQuality">{{ qualityText }}</text>
    <text class="srow-du" :style="toneStyle">{{ dur }}</text>
    <!-- 远端差异标记（本地歌单曲目列表）：绿色 A = 远端有、本地没下，红色 D = 本地有、远端已移除。
         标记列**始终占位**（flagCol 打开时），A/D 行进出不会把左侧各列挤左；
         标记只在有值时渲染，空列保持 8vh 宽 -->
    <div class="srow-flag" v-if="flag || flagCol">
      <text class="srow-flag-t" v-if="flag" :style="flagStyle">{{ flag }}</text>
    </div>
  </div>
</template>

<script>
import { fmtDur, fmtSize } from '../utils/format.js'
import { ensureCover } from '../utils/cover.js'
import { ICON } from '../assets/icons.js'
import { accentMixin } from '../utils/theme.js'
import { TOK } from '../utils/ui/tokens.js'

/**
 * 歌曲行：封面（含无封面占位）/ 歌名(+别名+VIP) / 歌手 / [档位·体积] / 时长
 *   `showQuality` 打开时多一列「档位 · 体积」，本地下载页用它。
 *   queue 页的行仍是自绘：它是「序号列 + 当前播放高亮 + 点击跳播」的另一种行形态，
 *   行度量与本组件对齐（勾选圈 9vh、选中底 a12）。
 *
 * 封面由行组件自己在 mounted 时按需取（cover.js 异步队列）——回调里给组件
 * 自己的 localCover 赋值（普通属性 = 必然响应式），绕开页面级动态 key 的问题；
 * cover url 可能后补（下载页补元数据时）→ watch 兜底，`_coverSrc` 判重。
 *
 * selectable/sel：曲目列表页「多选」模式的多选（点整行 = 勾选/取消，由页面在 @select
 * 里分派）。props 名与社区应用 PenMusic 的同名行组件一致；album/artist 页不传 → 默认
 * false，行为与外观零变化。
 *
 * 事件：@select（点整行）、@hold（长按整行）。
 *   - @hold = **原生 `@longpress`（按住 500ms 派发）+ $emit('hold')**。事件名避开
 *     `tap`/`longpress`/`swipe` 这类手势名：预编译器（falcon-vue-precompiler 的
 *     bindEvents）会给绑了手势事件的节点无条件写 `data-evt-<名>` 属性，自定义组件上就多出
 *     一条「原生手势 + 组件 $emit」双通道，可能一次触发两次（见 PageTopbar.vue 注释）。
 *   - ：**长按整行 → 歌曲详情页（songinfo）**，与播放页点歌名等效。这改掉了
 *     「按住一会儿再松手仍会起播」的旧行为 —— greenui 的长按触发后不再走 click；
 *     list/album/artist/downloads 四处语义一致（下载页 起对齐）。
 *   - `HOLD_SWALLOW_MS`：设备端 native 长按实现未必逐字节同 web 版渲染器，真发了 click
 *     就会「打开详情页」+「顺手起播/勾选」双动作 —— 长按后这段窗口内的 click 一律吞掉
 *     （同播放页 toggleLike 的防御写法）。正常情况（互斥）这段永不生效。
 */
const HOLD_SWALLOW_MS = 3000 // 长按后吞掉 click 的窗口（防御性，见上方注释）
export default {
  name: 'SongRow',
  mixins: [accentMixin],
  props: {
    song: { type: Object, required: true },
    index: { type: Number, default: 0 },
    selectable: { type: Boolean, default: false }, // 多选模式：显示勾选标记
    sel: { type: Boolean, default: false }, // 当前行是否已勾选
    showQuality: { type: Boolean, default: false }, // 本地下载页：多一列「档位 · 体积」
    /** 远端差异标记：'' | 'A'（远端有、本地没下）| 'D'（本地有、远端已移除） */
    flag: { type: String, default: '' },
    /** 始终保留 A/D 标记列的宽度（本地歌单曲目列表用）；避免标记出现/消失让整行左右挪动 */
    flagCol: { type: Boolean, default: false },
    /** 行文字色调：''（正常）| 'a'（灰色）| 'd'（仅歌名白色 + 删除线） */
    tone: { type: String, default: '' }
  },
  data() {
    return { localCover: '', ICON: ICON }
  },
  computed: {
    shownCover() {
      return this.localCover
    },
    /** 封面 url（下载页补元数据时可能顺带补上 → 下面 watch 兜底） */
    coverProp() {
      return this.song.cover || ''
    },
    /** 已勾选的行给一层浅色底（主题色 12%；内联 style —— 平台不支持 .a.b 复合选择器） */
    rowStyle() {
      return this.selectable && this.sel ? { backgroundColor: this.accent.a12 } : {}
    },
    /**
     * 歌名（标题）列的色调：A = 灰（远端有、本地还没下载），
     * D = 白色 + 删除线（远端已移除、文件仍在）。**删除线只打在标题上**，
     * 其余列交给 toneStyle 保持原样式。
     * tone 显式传入时优先（留给以后别的列表用）；否则由 flag 推导。
     */
    titleStyle() {
      const t = this.tone || this.flag
      if (t === 'a' || t === 'A') return { color: TOK.text3 }
      if (t === 'd' || t === 'D') return { color: TOK.text, textDecoration: 'line-through' }
      return {}
    },
    /**
     * 非标题列（别名 / 歌手 / 档位 / 时长）的色调：A 行整体压灰；
     * D 行不加任何覆盖，保留各列原本的次要色，避免整行一起变删除线。
     */
    toneStyle() {
      const t = this.tone || this.flag
      if (t === 'a' || t === 'A') return { color: TOK.text3 }
      return {}
    },
    /** 最右侧 A/D 标记：A 绿、D 浅红（文字色；不额外铺底，避免抢过歌名） */
    flagStyle() {
      return { color: this.flag === 'D' ? TOK.dangerSoft : TOK.ok }
    },
    /** 圈的两态：未选 = 透明底 + 白描边；已选 = 主题色实心底 + 白边（勾用 check 图标，不用 ✓ 字形，见坑 14） */
    markStyle() {
      return this.sel
        ? { backgroundColor: this.accent.c, borderColor: TOK.text }
        : { backgroundColor: TOK.none, borderColor: TOK.markBorder }
    },
    /** 时长缺失（老缓存没记 d）：显示 --:--，补齐后自动变 */
    dur() {
      return this.song.durationMs ? fmtDur(this.song.durationMs) : '--:--'
    },
    /** 「FLAC · 24.1 MB」/「320k · 8.2 MB」；码率缺失的老缓存退回扩展名 */
    qualityText() {
      const s = this.song
      const q = s.ext === 'flac' ? 'FLAC' : (s.br ? Math.round(s.br / 1000) + 'k' : 'MP3')
      return q + ' · ' + fmtSize(s.size)
    },
    isVip() {
      return this.song.fee === 1 || this.song.fee === 4
    },
    /** 别名显示为灰色括号，多个用 / 连接（格式对齐 MusicVault：tns+alia 拆分去重后的列表） */
    aliasText() {
      const a = this.song.aliases
      if (!a || !a.length) return ''
      return ' (' + a.join('/') + ')'
    }
  },
  watch: {
    /**
     * 封面 url 后补（下载页补时长时可能顺带补上封面）：来值时补取一次。
     * watch 不去重（平台坑 17：同值会被反复回调），入口自己用 `_coverSrc` 判重。
     */
    coverProp(c) {
      if (!c || c === this._coverSrc) return
      this.tryCover()
    }
  },
  mounted() {
    this.tryCover()
  },
  methods: {
    /** 取封面（cover.js 异步队列）：已就绪 → 同步回调；未下载 → 入队（并发/去重/磁盘缓存见 cover.js） */
    tryCover() {
      const self = this
      const c = this.song.cover
      if (!c || c === this._coverSrc) return
      this._coverSrc = c
      ensureCover({ id: this.song.id, cover: c }, function (id, path) {
        if (path) self.localCover = path
      })
    },
    /** 点整行：抛 select（页面决定是起播还是勾选）。长按余波（见 HOLD_SWALLOW_MS）吞掉 */
    onClick() {
      const gap = Date.now() - (this._holdAt || 0)
      if (this._holdAt && gap >= 0 && gap < HOLD_SWALLOW_MS) return
      this.$emit('select')
    },
    /** 长按整行：打时间戳（供 onClick 判余波）后抛 hold，页面据此进歌曲详情页 */
    onHold() {
      this._holdAt = Date.now()
      this.$emit('hold')
    }
  }
}
</script>

<style lang="less" scoped>
@import '../styles/common.less';

.srow {
  height: @row-h;
  flex-direction: row;
  align-items: center;
  /* 左右留白 4vh(≈9.6px)：内容不贴屏幕边 */
  padding-left: 4vh;
  padding-right: 4vh;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
/* 封面容器：图片未就绪时显示为色块占位。
   position:relative 是多选态勾选叠加层的定位基准（嵌套 relative+absolute 已由
   player.vue 的 .ply-seekline 真机验证）；overflow:hidden 顺带把叠加层裁进圆角 */
.srow-cv {
  width: 17vh;
  height: 17vh;
  border-radius: 1.4vh;
  background-color: @panel-2;
  overflow: hidden;
  margin-right: 2.6vh;
  position: relative;
  /* 无封面音符占位要居中 */
  align-items: center;
  justify-content: center;
}
.srow-cvi {
  width: 17vh;
  height: 17vh;
}
.srow-cvi-note {
  width: 8vh;
  height: 8vh;
}
/* 勾选叠加层：四边给 0 → 尺寸自动跟 .srow-cv（不重复写 17vh，改封面尺寸时不用同步这里） */
.srow-mask {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.42);
  align-items: center;
  justify-content: center;
}
/* 勾选圈：直径 9vh → 圆角写半值 4.5vh（平台不认 50%，AGENTS 坑 10）。
   圈径、圆角、勾图尺寸三个常量成对维护：勾 ≈ 圈的 0.6 */
.srow-mark {
  width: 9vh;
  height: 9vh;
  border-radius: 4.5vh;
  border-width: 0.8vh;
  border-style: solid;
  align-items: center;
  justify-content: center;
}
.srow-chk {
  width: 5.4vh;
  height: 5.4vh;
}
/* 歌名区（flex 吸收原 VIP 列宽），行内三个 text 并排 */
.srow-main {
  flex: 1;
  flex-direction: row;
  align-items: center;
  overflow: hidden;
  padding-right: 2.5vh;
}
.srow-nm {
  font-size: @fs-strong;
  color: @text;
  lines: 1;
  text-overflow: ellipsis;
}
.srow-alias {
  font-size: @fs-dim;
  color: @text-3;
  lines: 1;
}
.srow-vip {
  font-size: @fs-mute;
  color: @warn;
  /* 歌名/别名让位时 VIP 不被压缩（保证溢出时仍可见） */
  flex-shrink: 0;
}
.srow-ar {
  width: 104vh;
  flex: none;
  font-size: @fs-dim;
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
  padding-right: 2.5vh;
}
/* 带「档位 · 体积」列时歌名列让位（84 + 74 ≈ 原 104 + 间距）——两个完整单类名切换，
   不用复合/覆盖写法（平台只认单类名；:class 三元的先例见 login.vue 的 qr-seg） */
.srow-ar-q {
  width: 84vh;
  flex: none;
  font-size: @fs-dim;
  color: @text-2;
  lines: 1;
  text-overflow: ellipsis;
  padding-right: 2.5vh;
}
/* 档位 · 体积（下载页）：FLAC · 24.1 MB */
.srow-q {
  width: 74vh;
  flex: none;
  font-size: @fs-mute;
  color: @text-3;
  lines: 1;
  text-overflow: ellipsis;
  padding-right: 2.5vh;
}
.srow-du {
  width: 26vh;
  flex: none;
  font-size: @fs-mute;
  color: @text-3;
  text-align: right;
}
/* A/D 标记列：列表最右侧的独立固定列；flagCol 打开时无标记也占位，
   保证 A/D 行与普通行的左右边界一致（标记色由内联 style 给） */
.srow-flag {
  width: 8vh;
  flex: none;
  align-items: flex-end;
}
.srow-flag-t {
  font-size: @fs-dim;
  font-weight: bold;
  color: @ok;
}
</style>
