<template>
  <page-shell :rail="rail" @rail="onRail">
    <page-topbar title="个性化" :sub="hint" />
    <scroller class="lk-body">
      <!-- 背景色：预设色块，点了立即生效（内联样式换 chrome 底色 + 写配置 + 广播） -->
      <div class="lk-bgrow">
        <text class="lk-nm">背景色</text>
        <div class="lk-sws">
          <div
            class="lk-sw"
            v-for="p in presets"
            :key="p.key"
            :style="swStyle(p)"
            @click="pickBg(p.key)"
          >
            <text class="lk-sw-t" :style="swTextStyle(p)">{{ p.name }}</text>
          </div>
        </div>
      </div>

      <!-- 主题色（accent）：色块底色即该预设色本身；点了立即生效（写配置 + 广播，见 utils/theme.js）。
           影响范围：实心主控键/进度条/选中态/首页四张卡的裸图标与播放页收藏态心形（后者按色换 PNG）。 -->
      <div class="lk-acrow">
        <text class="lk-nm">主题色</text>
        <div class="lk-sws">
          <div
            class="lk-sw"
            v-for="a in accents"
            :key="'a' + a.key"
            :style="acStyle(a)"
            @click="pickAccent(a.key)"
          >
            <text class="lk-sw-t" :style="acTextStyle(a)">{{ a.name }}</text>
          </div>
        </div>
      </div>

      <!-- 卡片流光（config.glowOn，加开关）：首页「正在播放」卡那层柔光渐变的总开关。
           默认开 —— 关 = 卡面退回 @panel 纯色（只影响首页那张卡，播放页的渐变不归它管）。
           这里只写配置，首页在 show 时重读（页面是 navTo/finish 进出、不会重新挂载）。 -->
      <div class="lk-grow">
        <text class="lk-glabel">卡片流光</text>
        <opt-toggle :on="glowOn" @change="pickGlow" />
      </div>
    </scroller>
  </page-shell>
</template>

<script>
/**
 * 个性化页（设置 → 个性化，从设置页拆出的二级页）
 *
 * 只放外观：背景色（预设）、主题色（accent 预设）。两项都是「点色块 → 写配置 + 广播
 * `bpncm:theme`」，所有已挂载页面立即换色（页面是 navTo/finish 进出、不会重新挂载，
 * 不广播就会停在旧色）。
 *
 * 尺寸（放大，同日又微调）：色块高 18vh ≈ 43px（原 14vh）、字 @fs-dim（原 @fs-mute）、
 * 两个色块行高 36vh、开关行 26vh（三行总高超过一屏，开关要下滑才看得到 —— 用户已知并接受）。最宽的一行是主题色 7 个色块（名 3 字）≈ 550px，
 * 远小于 1020 - 28.8（左右各 6vh 内边距），横排放得下、不用换行。
 */
import PageShell from '../../components/PageShell.vue'
import PageTopbar from '../../components/PageTopbar.vue'
import OptToggle from '../../components/OptToggle.vue'
import { PRESETS, currentKey, setBg, ACCENTS, currentAccentKey, setAccent, accentMixin } from '../../utils/theme.js'
import { TOK } from '../../utils/ui/tokens.js'
import config from '../../utils/config.js'
import { log } from '../../utils/log.js'

import { pageFrameMixin } from '../../utils/ui/frame.js'

export default {
  name: 'setlook',
  mixins: [accentMixin, pageFrameMixin],
  components: { 'page-shell': PageShell, 'page-topbar': PageTopbar, 'opt-toggle': OptToggle },
  data() {
    return {
      hint: '',
      presets: PRESETS,
      bgKey: currentKey(),
      accents: ACCENTS,
      accentKey: currentAccentKey(),
      glowOn: true // 卡片流光开关（真值来自 config，mounted 里读）
    }
  },
  computed: {
  },
  async mounted() {
    await config.load()
    // ⚠ `!== false` 而不是 `!!`：DEFAULTS 里 glowOn 默认 true，老配置里没有这个 key（undefined）也要算开
    this.glowOn = config.get('glowOn') !== false
    log('setlook', '个性化挂载 背景=' + this.bgKey + ' 主题=' + this.accentKey + ' 流光=' + this.glowOn)
  },
  methods: {
    /* ---- 背景色 ---- */
    /** 色块：底色=预设色，边框/文字高亮当前选中（平台不支持 .a.b 复合选择器，状态走内联） */
    swStyle(p) {
      const on = p.key === this.bgKey
      return {
        backgroundColor: p.bg,
        borderColor: on ? this.accent.c : TOK.surface3
      }
    },
    swTextStyle(p) {
      return { color: p.key === this.bgKey ? this.accent.light : TOK.text2 }
    },
    pickBg(key) {
      if (key === this.bgKey) return
      setBg(key) // 写配置 + 广播：所有已挂载页面的 chrome 立即换色
      this.bgKey = key
      this.hint = '背景色 ' + nameOf(this.presets, key)
      log('setlook', '背景色 -> ' + key)
    },
    /* ---- 主题色 ---- */
    /**
     * 色块底色 = 该预设色本身，所以**选中态不能用主题色描边**（会与底色同色看不清），
     * 也不能写死白字 —— Vocaloid 七色里 6 个是亮色（黄/绿/青/蓝/紫/粉），白字压上去
     * 对比度只有 ~1.5:1，等于没有。
     * 统一用 `a.on`：theme.js 按 WCAG 相对亮度自动挑的**该色上的前景色**
     * （重音红→白，其余六个亮色→深色 #14151a）。选中描边也用它，两种底色上都看得见。
     */
    acStyle(a) {
      const on = a.key === this.accentKey
      return {
        backgroundColor: a.c,
        borderColor: on ? a.on : TOK.surface3
      }
    },
    acTextStyle(a) {
      return { color: a.on }
    },
    pickAccent(key) {
      if (key === this.accentKey) return
      setAccent(key)
      this.accentKey = key
      this.hint = '主题色 ' + nameOf(this.accents, key)
      log('setlook', '主题色 -> ' + key)
    },
    /* ---- 卡片流光（加）----
       chip 的视觉与设置族其它开关一致（选中 = accent 半透明底 + 同色描边）。
       只写配置不做别的：首页在 show 时重读，改完返回首页即生效。 */
    async pickGlow(on) {
      if (on === this.glowOn) return
      this.glowOn = on
      await config.set('glowOn', on)
      this.hint = on ? '卡片流光已开启' : '卡片流光已关闭'
      log('setlook', '卡片流光 -> ' + (on ? '开' : '关'))
    },
  }
}

/** 预设表里按 key 取名字（顶栏副题用） */
function nameOf(list, key) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].key === key) return list[i].name
  }
  return key
}
</script>

<style lang="less" scoped>
@import '../../styles/common.less';

.lk-body {
  flex: 1;
  padding: 3vh 6vh;
}
/* 背景色行：标题 + 色块两行（高 36vh ≈ 86px，色块 18vh ≈ 43px）。
   ⚠ 竖向预算（加「卡片流光」开关时算过）：
     顶栏 36 + body 上 padding 7.2 + 本行 86.4 + 主题色行 86.4 = 216 —— 屏高只有 240，
     所以**开关行整行在首屏外，要下滑约 60px 才看得到**（下滑就行）。
     别为了让它进首屏去压这两个色块行的高度：色块行的留白是刻意放大的，
     压回去会把整页挤紧。真要让开关进首屏，唯一的办法是把开关挪到背景色行之前。 */
.lk-bgrow {
  height: 36vh;
  flex-direction: column;
  justify-content: center;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
/* 主题色行：几何与 .lk-bgrow 完全相同（36vh），但**必须是独立的单类名**
   —— 同节点不要复用类名（同名属性谁生效按加载顺序定，不靠谱） */
.lk-acrow {
  height: 36vh;
  flex-direction: column;
  justify-content: center;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.lk-nm {
  font-size: @fs-dim;
  color: @text-2;
  lines: 1;
}
.lk-sws {
  flex-direction: row;
  align-items: center;
}
/* 色块：底色由内联 style 给（预设色），边框高亮选中项 */
.lk-sw {
  height: 18vh;
  align-items: center;
  justify-content: center;
  padding-left: 4.5vh;
  padding-right: 4.5vh;
  border-radius: 9vh;
  border-width: 1px;
  border-style: solid;
  margin-right: 3vh;
  margin-top: 2.6vh;
}
.lk-sw-t {
  font-size: @fs-dim;
}
/* 卡片流光开关行：行高 26vh ≈ 62px。
   标签 4 字 × 7vh = 28vh，宽给 50vh 留余量 */
.lk-grow {
  height: 26vh;
  flex-direction: row;
  align-items: center;
  border-bottom-width: 1px;
  border-bottom-style: solid;
  border-bottom-color: @line;
}
.lk-glabel {
  width: 50vh;
  flex: none;
  font-size: @fs-dim;
  color: @text-2;
}
/* 开/关 chip：底色与描边由内联 style 给（跟随主题色）；
   border-width 恒为 1px（未选中透明）→ 选中态切换时盒宽不变，整排不抖 */
.lk-note {
  font-size: @fs-mute;
  color: @text-3;
  padding-left: 6vh;
  padding-right: 6vh;
  margin-top: 2.4vh;
}
</style>
