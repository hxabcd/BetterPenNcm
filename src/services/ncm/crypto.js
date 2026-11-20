/**
 * 网易云 weapi 加密（纯 JS，词典笔可用）
 *
 * 为什么必须自己写：旧版明文 /api/ 登录接口已被服务端封禁（扫码头一次实测回
 * code=8821「请切换其他登录方式或升级新版本再试」），扫码/登录必须走 /weapi/ 加密。
 *
 * 算法与 Binaryify/NeteaseCloudMusicApi 完全一致，本文件的移植基准是用户自己
 * MusicVault 项目里的纯 stdlib 实现（src/musicvault/adapters/providers/
 * netease_client.py），并已用固定随机 key 与 Python 版逐字节对拍通过。
 *
 *   text      = JSON.stringify(payload)
 *   key2      = 随机 16 位字母数字串
 *   params    = base64(AES128CBC(base64(AES128CBC(text, key1)), key2))
 *   message   = int(reversed(key2) 的 ASCII 字节的 hex, 16)   // 128 位
 *   encSecKey = hex(pow(message, 65537, N)).padStart(256,'0') // 1024 位 RSA
 *
 * 约束：QuickJS 配的是 bigNum=false —— **没有 BigInt**，所以 RSA 用 16 位 limb 的
 * 手写大数 + 倍加模乘实现（只用到加/减/比较/移位，~17 次模乘，登录只跑一次）。
 */

/* ------------------------------------------------------------------ *
 * AES-128-CBC（移植自 pyaes 的精简版，语义与 Python 版逐行对应）
 * ------------------------------------------------------------------ */

const SBOX = [
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16
]

const RCON = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]

function bytes2matrix(text) {
  const m = []
  for (let i = 0; i < 16; i += 4) m.push([text[i], text[i + 1], text[i + 2], text[i + 3]])
  return m
}

function expandKey(key) {
  // 44 个 4 字节字
  const w = []
  for (let i = 0; i < 4; i++) w.push([key[i * 4], key[i * 4 + 1], key[i * 4 + 2], key[i * 4 + 3]])
  let rci = 1
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1].slice()
    if (i % 4 === 0) {
      t = [t[1], t[2], t[3], t[0]]
      for (let j = 0; j < 4; j++) t[j] = SBOX[t[j]]
      t[0] ^= RCON[rci++]
    }
    const p = w[i - 4]
    w.push([p[0] ^ t[0], p[1] ^ t[1], p[2] ^ t[2], p[3] ^ t[3]])
  }
  // 11 组轮密钥，每组 16 字节（列主序展开，与 Python 版一致）
  const rk = []
  for (let r = 0; r < 11; r++) {
    const bytes = []
    for (let c = 0; c < 4; c++) {
      const word = w[r * 4 + c]
      bytes.push(word[0], word[1], word[2], word[3])
    }
    rk.push(bytes2matrix(bytes))
  }
  return rk
}

function addRoundKey(state, key) {
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) state[i][j] ^= key[i][j]
}

function subBytes(state) {
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) state[i][j] = SBOX[state[i][j]]
}

function shiftRows(s) {
  let t = s[0][1]
  s[0][1] = s[1][1]
  s[1][1] = s[2][1]
  s[2][1] = s[3][1]
  s[3][1] = t
  t = s[0][2]
  s[0][2] = s[2][2]
  s[2][2] = t
  t = s[1][2]
  s[1][2] = s[3][2]
  s[3][2] = t
  t = s[3][3]
  s[3][3] = s[2][3]
  s[2][3] = s[1][3]
  s[1][3] = s[0][3]
  s[0][3] = t
}

function xtime(v) {
  return v & 0x80 ? (((v << 1) ^ 0x1b) & 0xff) : v << 1
}

function mixSingleColumn(c) {
  const total = c[0] ^ c[1] ^ c[2] ^ c[3]
  const head = c[0]
  c[0] ^= total ^ xtime(c[0] ^ c[1])
  c[1] ^= total ^ xtime(c[1] ^ c[2])
  c[2] ^= total ^ xtime(c[2] ^ c[3])
  c[3] ^= total ^ xtime(c[3] ^ head)
}

function mixColumns(state) {
  for (let i = 0; i < 4; i++) mixSingleColumn(state[i])
}

function encryptBlock(plain, rk) {
  const s = bytes2matrix(plain)
  addRoundKey(s, rk[0])
  for (let i = 1; i < 10; i++) {
    subBytes(s)
    shiftRows(s)
    mixColumns(s)
    addRoundKey(s, rk[i])
  }
  subBytes(s)
  shiftRows(s)
  addRoundKey(s, rk[10])
  const out = []
  for (let i = 0; i < 4; i++) out.push(s[i][0], s[i][1], s[i][2], s[i][3])
  return out
}

/** PKCS7 填充 + AES-128-CBC，返回密文字节数组 */
function aesCbcEncrypt(plainBytes, keyBytes, ivBytes) {
  const rk = expandKey(keyBytes)
  const pad = 16 - (plainBytes.length % 16)
  const data = plainBytes.slice()
  for (let i = 0; i < pad; i++) data.push(pad)
  const out = []
  let prev = ivBytes
  for (let off = 0; off < data.length; off += 16) {
    const block = []
    for (let i = 0; i < 16; i++) block.push(data[off + i] ^ prev[i])
    const enc = encryptBlock(block, rk)
    for (let i = 0; i < 16; i++) out.push(enc[i])
    prev = enc
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 工具：UTF-8 / base64
 * ------------------------------------------------------------------ */

/** 字符串 -> UTF-8 字节数组（不用 TextEncoder，自己算，避免运行时差异） */
export function utf8Bytes(str) {
  const out = []
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = str.charCodeAt(++i)
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00)
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64Encode(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : -1
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : -1
    out += B64[b0 >> 2]
    out += B64[((b0 & 3) << 4) | (b1 < 0 ? 0 : b1 >> 4)]
    out += b1 < 0 ? '=' : B64[((b1 & 15) << 2) | (b2 < 0 ? 0 : b2 >> 6)]
    out += b2 < 0 ? '=' : B64[b2 & 63]
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 大数（16 位 limb，低位在前）：只要加/减/比较/移位，够 RSA 用
 * ------------------------------------------------------------------ */

function trim(a) {
  let n = a.length
  while (n > 1 && a[n - 1] === 0) n--
  return n === a.length ? a : a.slice(0, n)
}

function bnFromHex(hex) {
  const a = []
  for (let i = hex.length; i > 0; i -= 4) {
    const s = Math.max(0, i - 4)
    a.push(parseInt(hex.slice(s, i), 16))
  }
  return trim(a)
}

function bnToHex(a) {
  const n = trim(a)
  let out = (n[n.length - 1] || 0).toString(16)
  for (let i = n.length - 2; i >= 0; i--) {
    const h = n[i].toString(16)
    out += h.length === 4 ? h : '0000'.slice(h.length) + h
  }
  return out
}

/* 下面这组是模幂的热路径：全部**原地运算 + 预分配缓冲**，不计长度、不返回新数组。
   QuickJS 是解释器，之前的写法每步都 slice/push 新数组，笔上实测 RSA 要 6 秒；
   改成定长原地后主要开销只剩纯循环。（数值一律 little-endian 16 位 limb） */

/** a += b，返回新的长度；a 必须预分配到 n 长 */
function addInto(a, alen, b, blen, n) {
  const m = alen > blen ? alen : blen
  // 缓冲是复用的：a 超出当前长度的高位可能残留上次的值，先清零
  for (let i = alen; i < m; i++) a[i] = 0
  let carry = 0
  for (let i = 0; i < m; i++) {
    const v = (a[i] || 0) + (b[i] || 0) + carry
    a[i] = v & 0xffff
    carry = v >>> 16
  }
  if (carry && m < n) {
    a[m] = carry
    return m + 1
  }
  return m
}

/** a -= b（要求 a >= b），返回新的长度 */
function subFrom(a, alen, b, blen) {
  let borrow = 0
  for (let i = 0; i < alen; i++) {
    let v = a[i] - (i < blen ? b[i] : 0) - borrow
    if (v < 0) {
      v += 0x10000
      borrow = 1
    } else {
      borrow = 0
    }
    a[i] = v
  }
  let L = alen
  while (L > 1 && a[L - 1] === 0) L--
  return L
}

/** a 与 b（长度 blen）比较 */
function cmpLen(a, alen, b, blen) {
  if (alen !== blen) return alen > blen ? 1 : -1
  for (let i = alen - 1; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1
  }
  return 0
}

/** 位长（a 的有效位数） */
function bitLenOf(a, alen) {
  let bits = (alen - 1) * 16
  let t = a[alen - 1]
  while (t > 0) {
    bits++
    t >>= 1
  }
  return bits
}

/**
 * out = (a * b) mod m —— 倍加（俄罗斯农民乘法），扫 b 的每一位做「翻倍 + 条件加」。
 * 全程只有加/减/比较，无除法；out 必须与 a/b/m 都是不同缓冲。返回 out 的长度。
 */
function mulMod(a, alen, b, blen, m, mlen, n, out) {
  for (let i = 0; i < n; i++) out[i] = 0
  let olen = 1
  const bits = bitLenOf(b, blen)
  for (let i = bits - 1; i >= 0; i--) {
    // out = 2*out mod m
    olen = addInto(out, olen, out, olen, n)
    if (olen > mlen || (olen === mlen && cmpLen(out, olen, m, mlen) >= 0)) {
      olen = subFrom(out, olen, m, mlen)
    }
    // b 的第 i 位为 1 则 out += a
    if ((b[i >> 4] >> (i & 15)) & 1) {
      olen = addInto(out, olen, a, alen, n)
      if (olen > mlen || (olen === mlen && cmpLen(out, olen, m, mlen) >= 0)) {
        olen = subFrom(out, olen, m, mlen)
      }
    }
  }
  return olen
}

/**
 * r = (base^exp) mod m（exp 为普通 JS number）
 * 平方乘 + 倍加模乘，全程无除法、无分配（缓冲复用）。
 * exp=65537 时共 17 次模乘。
 */
function bnModPow(base, exp, m) {
  const mlen = m.length
  const n = mlen + 2 // 缓冲区（加法可能多出一个 limb）
  const z = function (n2) {
    const a = new Array(n2)
    for (let i = 0; i < n2; i++) a[i] = 0
    return a
  }
  const bx = z(n) // 底数
  const rx = z(n) // 结果
  const mx = z(n) // mulMod 输出（必须与输入不同缓冲）

  for (let i = 0; i < n; i++) bx[i] = i < base.length ? base[i] : 0
  let blen = base.length
  // base 可能 >= m（本用例不会，稳妥起见归一化一次）
  if (cmpLen(bx, blen, m, mlen) >= 0) blen = subFrom(bx, blen, m, mlen)

  rx[0] = 1
  let rlen = 1

  const copy = function (dst, src, len) {
    for (let i = 0; i < len; i++) dst[i] = src[i]
    for (let i = len; i < n; i++) dst[i] = 0
  }

  let e = exp
  while (e > 0) {
    if (e & 1) {
      rlen = mulMod(rx, rlen, bx, blen, m, mlen, n, mx)
      copy(rx, mx, rlen)
    }
    e = Math.floor(e / 2)
    if (e > 0) {
      blen = mulMod(bx, blen, bx, blen, m, mlen, n, mx)
      copy(bx, mx, blen)
    }
  }

  const out = []
  for (let i = 0; i < rlen; i++) out.push(rx[i])
  return out
}

/* ------------------------------------------------------------------ *
 * weapi
 * ------------------------------------------------------------------ */

const AES_KEY1 = utf8Bytes('0CoJUm6Qyw8W8jud')
const AES_IV = utf8Bytes('0102030405060708')
const RSA_N_HEX =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5a' +
  'a76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c368' +
  '5b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece04' +
  '62db0a22b8e7'
const RSA_N = bnFromHex(RSA_N_HEX.replace(/^0+/, ''))
const RSA_E = 65537

const RAND_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' // 备生成密钥池用

// 导出底层实现供 PC 对拍测试使用
export { bnFromHex, bnToHex, bnModPow, RSA_N }

/** AES-128-CBC(PKCS7) -> base64 */
export function cbcB64(text, keyStr) {
  return base64Encode(aesCbcEncrypt(utf8Bytes(text), utf8Bytes(keyStr), AES_IV))
}

/**
 * 预计算密钥池（key2, encSecKey）
 *
 * 为什么要这么做：笔上 QuickJS 跑一次 1024 位 RSA 模幂实测要 ~3 秒，而 weapi 每个请求
 * 都需要一个 encSecKey。但 encSecKey **只取决于二级密钥 key2、与 payload 无关**，
 * 所以可以预先在 PC 上算好一批常数对，运行时随机挑一对：
 *   每次请求只剩两级 AES（实测 ~0.2ms），比现算 RSA 快约 1.5 万倍。
 *
 * 重新生成的姿势（PC 上，用本文件自己的实现，保证与设备端一致）：
 *   node -e "... 循环随机 key -> weapiEncryptWithRsa(payload, key) 取 encSecKey ..."
 * 服务端 RSA 公钥（RSA_N / RSA_E）是公开固定值，与 MusicVault / NeteaseCloudMusicApi
 * 用的完全一样；只有它变化时才需要重新生成密钥池。
 */
const KEY_POOL = [
  ['xdQaXoNiz0V1nye1', '5ee3bfeaef9f41cac0eea342752a45dcf7c9ec0f21e0d7ef0c388429d8084affa270920bc5e551f1accb68fe93559c987ceaaed4729e58a253a30241339774ee68a6db4af19b221f8acbae3d2f2eb5824737bd557baa34735dfa9b39893902fe23493b042f9875806f3ee6e8d73caee90368b3102bc3036ebe29aef772191ebe'],
  ['M7B7qt1SVtukbzY6', '9b3c6803ecd085be1ba947288f41c0840c6d8e68aa2a945d6bac884fcbea471186b5e794494ab62e02eec3bab87b44d53dd5acb5b3baec2796c5920eb27bc00144c6f2dad6a1fb9d787d47220bb785c79261124b3450a52032b9f43c205abdd5f45227c2256d6c2d45cd61f4b3402854327a27cd3831ae3d5d526b6c12df7d68'],
  ['jyVw7ZEpj2lqZkIq', 'c129ece98d9d85406f7a7b03665f9f415bfe0b5fffd8e9b9eb27c1322eacc2f1625750dc78868daf44be378f21ff972c9f19b8f5b4a2eb40c2a6854eb263491ac0dfe72d0afa7a47449e4ef43d4a8d621966d8cf8018c0e5d09318937b28a3973a237008fe09d2fdebbdae8fe8523f5ea373abe6612b3238a4192b2f09ebc4e6'],
  ['zQohlLFGELi8r95q', '13c5af3d51866e2a84d1d7ef226ff941d4f17db8482bcbbf9999e9993186bcebb45ed1f6e8716a3c74a5930be3d656cd6d2e5715b80da453fe84b98e067b0d3446ecc89dde44fd020c54d80f718330bb65718d516e8ee8fd8a9725e6bb160470d08bfdde6b99458c371199368021d1f8955999b0bdf9abe6882caba84eaa1b43'],
  ['qo0ll7DYjdWw8DbG', '09dcd93985ce7741a029242b89cb6c5a00aa6c365b62142c4850481f601693fdfad23f2c76b2ea81747fc56bef1e1af929ad676b0f588aa94f9483041e7c8553ee3ae40ebaec1a3b7f067b69621bb5c070897a9e7d96bef6bb31f63a5d5d3e2034b15dffcb576e3345a3c79a7648885b2964d705e6b49dd20bd966bfb5d617e1'],
  ['pnyHZsvt64shfSNp', 'd0e2a2e1b8e9f83f8374bc092464fcd30f97e8efd8fddb140caa3df44b94fc1b5e06a28c14f9b947b894abbb393ec2339e71c5247b8933c789a27f4d6f41571d74212be94b25b97a38a2de89ae0cf655aab160f785d79a26579a119bde39ac80c34bc05a58304ba528585a2fc51edb9aa0a69f0005275fb31292aac71e04ceef'],
  ['cF80Qp8YQhcQHkZM', '89ba84afdd4df2dd39cc41e004837288ca1f5bdbf59ac10a9d8147c45f77274bbfab23d4e95cac2f52a31331b6742509077b429cc952c10be71c6962029765202260e63e8d64869181a3edb843efd4bb275a38ff71fb0ad835718166f10715302398d57f5bdcb66dc471ac5a85e28b53d68bfbb715b35ddec3ac96e4d1dbb936'],
  ['kSHCQY8UQDwYBnxS', '2f1704e70aa0385df59dc4cc5023154c9422af9e11fb37efa85f31b583844304eeacde8cfc3e5f42383972a9494b03679e8ef3e867820e2dcbeca45f95138991dc56190199e2b1fdf56e90b47a8b45ff012a1ef4f2f8c2bd08f30dd8baa31c15c5d505af2dc7e2d5aadf354ddb797ac80cd906b5adad084ca40b3ea2c7a3d19c']
]

/** 走真实 RSA 的那条路（生成密钥池 / 对拍测试用） */
function weapiEncryptWithRsa(text, key2) {
  const params = cbcB64(cbcB64(text, '0CoJUm6Qyw8W8jud'), key2)
  // reversed(key2) 的 ASCII 字节 -> hex -> 大数
  const rev = key2.split('').reverse().join('')
  const hexBytes = []
  for (let i = 0; i < rev.length; i++) {
    const h = rev.charCodeAt(i).toString(16)
    hexBytes.push(h.length === 1 ? '0' + h : h)
  }
  const message = bnFromHex(hexBytes.join(''))
  let enc = bnToHex(bnModPow(message, RSA_E, RSA_N))
  while (enc.length < 256) enc = '0' + enc
  return { params: params, encSecKey: enc, key2: key2 }
}

/**
 * 生成 weapi 表单参数
 * @param {object} payload 业务参数（csrf_token 请自行放进去）
 * @param {string} [fixedKey] 固定二级密钥 -> 走真实 RSA（仅对拍测试用）
 * @returns {{params:string, encSecKey:string, key2:string}}
 */
export function weapiEncrypt(payload, fixedKey) {
  const text = JSON.stringify(payload)
  if (fixedKey) return weapiEncryptWithRsa(text, fixedKey)
  const pair = KEY_POOL[Math.floor(Math.random() * KEY_POOL.length)]
  return {
    params: cbcB64(cbcB64(text, '0CoJUm6Qyw8W8jud'), pair[0]),
    encSecKey: pair[1],
    key2: pair[0]
  }
}

/** weapi 表单 body：params=..&encSecKey=.. */
export function weapiBody(payload, fixedKey) {
  const r = weapiEncrypt(payload, fixedKey)
  return 'params=' + encodeURIComponent(r.params) + '&encSecKey=' + encodeURIComponent(r.encSecKey)
}

/* ------------------------------------------------------------------ *
 * MD5（密码登录用）
 *
 * /api/login/cellphone 的 password 字段要的是 **md5 后的值**（社区通行做法，
 * 与 NeteaseCloudMusicApi 一致）。设备裸模块 str_utils 有 md5Hex，但登录是
 * 关键路径，不依赖未实测的原生模块 —— 自己写一份纯 JS 的（无 BigInt，
 * 与上面的 RSA 同样只用 32 位整数运算）。
 *
 * 已用 md5('') / md5('abc') / md5('中文') 与标准值对拍通过。
 * ------------------------------------------------------------------ */

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
]

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
]

// 名字避开 AES 段已有的 utf8Bytes
function md5Utf8Bytes(s) {
  const out = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return out
}

/** 字符串 → md5 小写 hex（32 位） */
export function md5Hex(str) {
  const bytes = md5Utf8Bytes(String(str === undefined || str === null ? '' : str))
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const lo = bitLen % 4294967296
  const hi = Math.floor(bitLen / 4294967296)
  bytes.push(lo & 0xff, (lo >>> 8) & 0xff, (lo >>> 16) & 0xff, (lo >>> 24) & 0xff)
  bytes.push(hi & 0xff, (hi >>> 8) & 0xff, (hi >>> 16) & 0xff, (hi >>> 24) & 0xff)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476

  for (let off = 0; off < bytes.length; off += 64) {
    const M = []
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4
      M.push((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0)
    }
    let A = a0
    let B = b0
    let C = c0
    let D = d0
    for (let j = 0; j < 64; j++) {
      let F = 0
      let g = 0
      if (j < 16) {
        F = (B & C) | (~B & D)
        g = j
      } else if (j < 32) {
        F = (D & B) | (~D & C)
        g = (5 * j + 1) % 16
      } else if (j < 48) {
        F = B ^ C ^ D
        g = (3 * j + 5) % 16
      } else {
        F = C ^ (B | ~D)
        g = (7 * j) % 16
      }
      const sum = (A + (F >>> 0) + MD5_K[j] + M[g]) >>> 0
      const s = MD5_S[j]
      const rot = ((sum << s) | (sum >>> (32 - s))) >>> 0
      const next = (B + rot) >>> 0
      A = D
      D = C
      C = B
      B = next
    }
    a0 = (a0 + A) >>> 0
    b0 = (b0 + B) >>> 0
    c0 = (c0 + C) >>> 0
    d0 = (d0 + D) >>> 0
  }

  const HEX = '0123456789abcdef'
  const outArr = [a0, b0, c0, d0]
  let out = ''
  for (let i = 0; i < 4; i++) {
    const v = outArr[i]
    for (let k = 0; k < 4; k++) {
      const b = (v >>> (k * 8)) & 0xff
      out += HEX.charAt(b >> 4) + HEX.charAt(b & 0x0f)
    }
  }
  return out
}
