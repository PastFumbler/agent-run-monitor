// Draws the app icon from code (no third-party art): a soft rounded square with a white
// "running" ring and a play mark. Writes build/icon.png (512x512) and build/icon.ico.
// Run: node build/make-icons.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = dirname(fileURLToPath(import.meta.url));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a + (b - a) * t;
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const TOP = hex('#9fd3bd'); // soft sage
const BOTTOM = hex('#5f97b4'); // soft harbour blue

/** Coverage-weighted samples of the shape at pixel (px, py) for an icon of `s` pixels. */
function shade(s, px, py) {
  const m = s * 0.055; // margin around the tile
  const r = s * 0.23; // corner radius
  const c = s / 2;
  const R = s * 0.255; // ring radius
  const W = s * 0.072; // ring width
  const gapFrom = -Math.PI / 2 + 0.05; // gap at the top right, like a spinner mid-turn
  const gapTo = -Math.PI / 2 + Math.PI / 2.4;
  const ends = [gapFrom, gapTo].map((a) => [c + R * Math.cos(a), c + R * Math.sin(a)]);
  // play mark, nudged right for optical balance
  const tri = [
    [c - s * 0.075, c - s * 0.11],
    [c - s * 0.075, c + s * 0.11],
    [c + s * 0.115, c],
  ];
  const edge = (a, b, x, y) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);

  const N = 4;
  let tile = 0;
  let glyph = 0;
  let gy = 0;
  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const x = px + (sx + 0.5) / N;
      const y = py + (sy + 0.5) / N;
      // rounded square
      const qx = Math.max(Math.abs(x - c) - (c - m - r), 0);
      const qy = Math.max(Math.abs(y - c) - (c - m - r), 0);
      if (Math.hypot(qx, qy) > r) continue;
      tile++;
      gy += y;
      // ring with round caps
      const d = Math.hypot(x - c, y - c);
      const a = Math.atan2(y - c, x - c);
      const inGap = a > gapFrom && a < gapTo;
      let on = !inGap && Math.abs(d - R) <= W / 2;
      if (!on) on = ends.some(([ex, ey]) => Math.hypot(x - ex, y - ey) <= W / 2);
      // play triangle
      if (!on) {
        const e1 = edge(tri[0], tri[1], x, y);
        const e2 = edge(tri[1], tri[2], x, y);
        const e3 = edge(tri[2], tri[0], x, y);
        on = (e1 <= 0 && e2 <= 0 && e3 <= 0) || (e1 >= 0 && e2 >= 0 && e3 >= 0);
      }
      if (on) glyph++;
    }
  }
  const total = N * N;
  if (!tile) return [0, 0, 0, 0];
  const t = gy / tile / s;
  const bg = TOP.map((v, i) => mix(v, BOTTOM[i], t));
  const g = glyph / tile;
  const col = bg.map((v) => mix(v, 255, g * 0.96));
  return [...col.map(Math.round), Math.round((tile / total) * 255)];
}

function render(s) {
  const buf = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const [r, g, b, a] = shade(s, x, y);
      const o = (y * s + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = a;
    }
  return png(s, buf);
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.data)]);
}

writeFileSync(join(OUT, 'icon.png'), render(512));
writeFileSync(join(OUT, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: render(size) }))));
console.log(`wrote ${join(OUT, 'icon.png')} and icon.ico`);
