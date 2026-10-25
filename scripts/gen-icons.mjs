// 生成应用图标：build/icon.ico（安装包用）、托盘图标（以 base64 模块内嵌，避免资源路径问题）
// 无第三方依赖：纯手写 PNG 编码 + 像素级绘制
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePNG(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy ? rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride) : null
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 极简画布 ----------
function createCanvas(size) {
  const buf = Buffer.alloc(size * size * 4)
  const put = (x, y, [r, g, b, a]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
  }
  // 在 0..S 设计坐标系下绘制（按比例映射到实际像素）
  const S = 128
  const k = size / S
  return {
    buf,
    roundRect(x, y, w, h, r, color) {
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          const dx = px / k, dy = py / k
          if (dx < x || dy < y || dx > x + w || dy > y + h) continue
          const cx = Math.max(x + r, Math.min(dx, x + w - r))
          const cy = Math.max(y + r, Math.min(dy, y + h - r))
          if ((dx - cx) ** 2 + (dy - cy) ** 2 <= r * r || (dx >= x + r && dx <= x + w - r) || (dy >= y + r && dy <= y + h - r)) {
            if ((dx < x + r || dx > x + w - r) && (dy < y + r || dy > y + h - r) && (dx - cx) ** 2 + (dy - cy) ** 2 > r * r) continue
            put(px, py, color)
          }
        }
      }
    },
    lerpRoundRect(y0, y1, r, c0, c1) {
      for (let py = 0; py < size; py++) {
        const t = Math.min(1, Math.max(0, (py / k - y0) / (y1 - y0)))
        const c = [0, 1, 2].map(i => Math.round(c0[i] + (c1[i] - c0[i]) * t)).concat([255])
        this.rowCache = c
        for (let px = 0; px < size; px++) {
          const dx = px / k, dy = py / k
          const cx = Math.max(0 + r, Math.min(dx, S - r))
          const cy = Math.max(0 + r, Math.min(dy, S - r))
          const inCorner = (dx < r || dx > S - r) && (dy < r || dy > S - r)
          if (!inCorner || (dx - cx) ** 2 + (dy - cy) ** 2 <= r * r) put(px, py, c)
        }
      }
    },
    ring(cx, cy, r, t, color) {
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          const dx = px / k - cx, dy = py / k - cy
          if (Math.abs(Math.hypot(dx, dy) - r) <= t / 2) put(px, py, color)
        }
      }
    },
    line(x1, y1, x2, y2, t, color) {
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          const dx = px / k, dy = py / k
          const vx = x2 - x1, vy = y2 - y1
          const u = Math.max(0, Math.min(1, ((dx - x1) * vx + (dy - y1) * vy) / (vx * vx + vy * vy)))
          const d = Math.hypot(dx - (x1 + u * vx), dy - (y1 + u * vy))
          if (d <= t / 2) put(px, py, color)
        }
      }
    }
  }
}

const WHITE = [255, 255, 255, 255]

// 应用图标：紫蓝渐变圆角方块 + 白色放大镜
function drawIcon(size) {
  const c = createCanvas(size)
  c.lerpRoundRect(0, 128, 28, [99, 102, 241, 255], [139, 92, 246, 255])
  c.ring(56, 54, 24, 11, WHITE)
  c.line(74, 72, 98, 96, 13, WHITE)
  return c.buf
}

// 托盘图标：同款设计（小尺寸加粗）
function drawTray(size) {
  const c = createCanvas(size)
  const s = 128 / size
  c.lerpRoundRect(0, 128, 28, [99, 102, 241, 255], [139, 92, 246, 255])
  c.ring(58, 56, 22, 14 * s / 2, WHITE)
  c.line(74, 72, 96, 94, 16 * s / 2, WHITE)
  return c.buf
}

function buildIco(png) {
  const head = Buffer.alloc(6)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // type: icon
  head.writeUInt16LE(1, 4) // count
  const entry = Buffer.alloc(16)
  entry[0] = 0 // width 256
  entry[1] = 0 // height 256
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(22, 12) // offset
  return Buffer.concat([head, entry, png])
}

// ---------- 输出 ----------
mkdirSync(join(ROOT, 'build'), { recursive: true })
mkdirSync(join(ROOT, 'src/main/assets'), { recursive: true })

const icon256 = encodePNG(256, 256, drawIcon(256))
writeFileSync(join(ROOT, 'build/icon.ico'), buildIco(icon256))
writeFileSync(join(ROOT, 'build/icon.png'), icon256)

const trayPng = encodePNG(32, 32, drawTray(32))
const trayModule = `// 由 scripts/gen-icons.mjs 生成，请勿手改\nexport const TRAY_ICON_DATA_URL = 'data:image/png;base64,${trayPng.toString('base64')}'\n`
writeFileSync(join(ROOT, 'src/main/assets/tray-icon.ts'), trayModule)

console.log('[gen-icons] build/icon.ico, build/icon.png, src/main/assets/tray-icon.ts 已生成')
