/**
 * 歌词排版：固定基础行高 + 长行换行 + 逐字行的视觉行预排。
 *
 * 为什么自己排，而不是把 text 交给平台自动换行：
 *   歌词轨道的位移数学必须知道每行高度（行盒要参与前缀和）。平台没有可用的文字测量 API，
 *   自动换行后的真实高度拿不到；这里用保守的字宽估算把原文/译文/逐字段预排成视觉行，
 *   行盒高度由「视觉行数 × 行高」直接算出。估算宁可多折一行，也不能让文字溢出行盒。
 *
 * 行高规则（活动/非活动行同一行盒，字号差异在行盒内过渡）：
 *   - 基础行高 60px（单行原文、或「单行原文 + 单行译文」都按 60 起算）；
 *   - 长行按活动态字号估算视觉行数，行高 = max(60, 原文行高合计 + 译文行高合计 + 2px 间距)；
 *   - 行间 margin/gap = 0；行内容在行盒内垂直居中，文本左对齐。
 */
export const LYRIC_GEO = {
  PANEL_W: 480,
  PAD_X: 10, // 面板左右 padding（根节点 inset）
  ROW_PAD_X: 4, // 行盒左右 padding
  TEXT_PAD_X: 6, // 文本列左右 padding
  MARK_SPACE: 7, // 左侧指示条 + 间距（指示条绝对定位，不参与排版宽）
  ROW_H: 60,
  MAIN_FS: 26,
  MAIN_LH: 31.2,
  TRANS_FS: 20,
  TRANS_LH: 24,
  TRANS_GAP: 2
}

/** 文本列可用宽（px）：480 − 面板 20 − 行 8 − 文本列 12 − 指示条空间 7 */
export const LYRIC_TEXT_W =
  LYRIC_GEO.PANEL_W - LYRIC_GEO.PAD_X * 2 - LYRIC_GEO.ROW_PAD_X * 2 -
  LYRIC_GEO.TEXT_PAD_X * 2 - LYRIC_GEO.MARK_SPACE

/** 单个字符的保守宽度倍率（乘字号）。CJK 按 1em；拉丁/数字按 0.62em 防止实测更宽时溢出 */
function charRate(code) {
  if (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  ) return 1
  if (code === 0x20 || code === 0x09) return 0.32
  if (code >= 0x30 && code <= 0x39) return 0.62
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return 0.62
  return 0.5
}

function textWidth(text, fontSize) {
  let w = 0
  for (let i = 0; i < text.length; i++) {
    w += charRate(text.charCodeAt(i)) * fontSize
  }
  return w * 1.04 // 粗体略加余量
}

/** 把文本切成「CJK 单字 / 拉丁词 / 空白 / 其他符号」四种 token */
function tokenize(text) {
  const out = []
  let buf = ''
  let kind = ''
  const flush = function () {
    if (buf) out.push({ t: buf, k: kind })
    buf = ''
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i)
    const code = text.charCodeAt(i)
    let k
    if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) || c === "'" || c === '’') {
      k = 'latin'
    } else if (c === ' ' || c === '\t') {
      k = 'space'
    } else if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      k = 'cjk'
    } else {
      k = 'sym'
    }
    if (kind && k !== kind) {
      // 拉丁词后跟标点时标点并入词（don't、AMLL's 这类别被拆开）
      if (kind === 'latin' && k === 'sym' && c !== ' ') {
        buf += c
        continue
      }
      flush()
    }
    kind = k
    buf += c
  }
  flush()
  return out
}

function pushLine(lines, value) {
  if (value) lines.push(value)
}

/** 普通文本 → 视觉行数组（纯字符串）。超宽 token 逐字符硬拆 */
export function wrapText(text, fontSize, width) {
  const out = []
  if (!text) return out
  const toks = tokenize(text)
  let cur = ''
  let w = 0
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i].t
    let tw = textWidth(tk, fontSize)
    if (tw > width) {
      // 单个 token 比一行还宽：逐字符拆（长英文串/长 CJK 标点串）
      if (cur) {
        pushLine(out, cur)
        cur = ''
        w = 0
      }
      for (let k = 0; k < tk.length; k++) {
        const c = tk.charAt(k)
        const cw = textWidth(c, fontSize)
        if (w + cw > width && cur) {
          pushLine(out, cur)
          cur = ''
          w = 0
        }
        cur += c
        w += cw
      }
      continue
    }
    if (w + tw > width && cur) {
      // 行尾空白不带走，避免下一行凭空缩进
      pushLine(out, cur.replace(/\s+$/, ''))
      if (toks[i].k === 'space') {
        cur = ''
        w = 0
        continue
      }
      cur = tk
      w = tw
      continue
    }
    cur += tk
    w += tw
  }
  pushLine(out, cur.replace(/\s+$/, ''))
  return out
}

/**
 * 逐字段 → 视觉行。每行是 { words: [{ text, w, part }] }：
 *   w = 原始 words 下标（同一个逐字段折到两行时两段共用 w，逐字状态照常按 w 判断）；
 *   part = 该字段内的段序，作 v-for key 用。
 */
export function wrapWords(words, fontSize, width) {
  const out = []
  if (!words || !words.length) return out
  let cur = []
  let w = 0
  const newLine = function () {
    if (cur.length) out.push({ words: cur })
    cur = []
    w = 0
  }
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text || ''
    if (!text) continue
    // 逐字段先按字符保守测量；整段能放下就整段放，放不下再逐字拆段
    const tw = textWidth(text, fontSize)
    if (tw <= width && w + tw <= width) {
      cur.push({ text: text, w: i, part: 0 })
      w += tw
      continue
    }
    if (tw <= width) {
      newLine()
      cur.push({ text: text, w: i, part: 0 })
      w = tw
      continue
    }
    // 单段超一行：按字符拆；行尾空白不单独成段
    let part = 0
    let buf = ''
    let bw = 0
    for (let k = 0; k < text.length; k++) {
      const c = text.charAt(k)
      const cw = textWidth(c, fontSize)
      if (bw + cw > width && buf) {
        if (buf.trim()) cur.push({ text: buf, w: i, part: part++ })
        buf = ''
        bw = 0
        newLine()
      }
      buf += c
      bw += cw
    }
    if (buf.trim()) cur.push({ text: buf, w: i, part: part })
    w = bw
  }
  newLine()
  return out
}

/** 歌词数据 → 排版行（含前缀和；只跟歌词/翻译/逐字开关有关，不依赖播放进度） */
export function buildLyricRows(lines, showTrans, wordOn) {
  const out = []
  const n = lines ? lines.length : 0
  let prefix = 0
  for (let i = 0; i < n; i++) {
    const line = lines[i] || {}
    const hasTr = !!(showTrans && line.trans)
    const mainLines = wrapText(line.text || '', LYRIC_GEO.MAIN_FS, LYRIC_TEXT_W)
    const transLines = hasTr
      ? wrapText(line.trans || '', LYRIC_GEO.TRANS_FS, LYRIC_TEXT_W)
      : []
    const wordLines = (wordOn && line.words && line.words.length)
      ? wrapWords(line.words, LYRIC_GEO.MAIN_FS, LYRIC_TEXT_W)
      : null
    const mainCount = wordLines ? wordLines.length : mainLines.length
    let h = mainCount * LYRIC_GEO.MAIN_LH
    if (transLines.length) h += LYRIC_GEO.TRANS_GAP + transLines.length * LYRIC_GEO.TRANS_LH
    if (h < LYRIC_GEO.ROW_H) h = LYRIC_GEO.ROW_H
    h = Math.round(h * 10) / 10
    out.push({
      i: i,
      text: line.text || '',
      trans: line.trans || '',
      hasTr: hasTr,
      h: h,
      prefix: prefix,
      mainLines: mainLines,
      transLines: transLines,
      wordLines: wordLines,
      words: line.words || null
    })
    prefix += h
  }
  return out
}
