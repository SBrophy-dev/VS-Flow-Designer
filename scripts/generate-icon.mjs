// Generates images/icon.png (256×256) without image dependencies: a rasterizer with 4×4
// supersampling draws three flow blocks joined by curves on a navy rounded square.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZE = 256;
const SS = 4;
const px = new Float32Array(SIZE * SIZE * 4);

function roundedRect(x, y, w, h, r) {
  return (px_, py_) => {
    const cx = Math.max(x + r, Math.min(px_, x + w - r));
    const cy = Math.max(y + r, Math.min(py_, y + h - r));
    return (px_ - cx) ** 2 + (py_ - cy) ** 2 <= r * r;
  };
}

function bezierStroke(p0, p1, p2, p3, width) {
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    const u = 1 - t;
    pts.push([
      u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
      u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
    ]);
  }
  return (x, y) => pts.some(([qx, qy]) => (x - qx) ** 2 + (y - qy) ** 2 <= (width / 2) ** 2);
}

function circle(cx, cy, r) {
  return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Painter's order: later shapes cover earlier ones.
const shapes = [
  [roundedRect(8, 8, 240, 240, 48), hex('#16233a')],
  [bezierStroke([96, 78], [140, 78], [124, 128], [160, 128], 7), hex('#89d185')],
  [bezierStroke([96, 78], [150, 78], [110, 186], [160, 186], 7), hex('#f0a531')],
  [roundedRect(28, 52, 80, 52, 10), hex('#2e7dd7')],
  [roundedRect(28, 52, 80, 14, 7), hex('#5aa2f0')],
  [roundedRect(156, 104, 76, 48, 10), hex('#1f9e8a')],
  [roundedRect(156, 104, 76, 13, 7), hex('#45c4ae')],
  [roundedRect(156, 162, 76, 48, 10), hex('#d0455b')],
  [roundedRect(156, 162, 76, 13, 7), hex('#ec6f82')],
  [circle(108, 78, 8), hex('#ffffff')],
  [roundedRect(40, 76, 52, 6, 3), hex('#cfe2fb')],
  [roundedRect(40, 88, 36, 6, 3), hex('#cfe2fb')],
];

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS;
        const fy = y + (sy + 0.5) / SS;
        let color;
        for (const [test, c] of shapes) {
          if (test(fx, fy)) {
            color = c;
          }
        }
        if (color) {
          acc[0] += color[0];
          acc[1] += color[1];
          acc[2] += color[2];
          acc[3] += 255;
        }
      }
    }
    const n = SS * SS;
    const i = (y * SIZE + x) * 4;
    const coverage = acc[3] / 255;
    px[i] = coverage ? acc[0] / coverage : 0;
    px[i + 1] = coverage ? acc[1] / coverage : 0;
    px[i + 2] = coverage ? acc[2] / coverage : 0;
    px[i + 3] = acc[3] / n;
  }
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE * 4; x++) {
    raw[y * (SIZE * 4 + 1) + 1 + x] = Math.round(px[y * SIZE * 4 + x]);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) {
    c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync('images', { recursive: true });
writeFileSync('images/icon.png', png);
console.log(`Wrote images/icon.png (${png.length} bytes)`);
