// netlify/functions/lib/spots-badge.js
//
// Dependency-free PNG generator for the live "spots left" email badge.
//
// Emails can't run JS, so a number can only *update after send* if it's an
// <img> served live by a function. Gmail blocks SVG images, so this must be a
// raster PNG — but rather than add a native rasterizer (sharp/resvg) to the
// Netlify build, we hand-compose an RGBA buffer and encode it with Node's
// built-in zlib. No new dependencies, no build config, renders as a real PNG
// everywhere. Digits are drawn with a tiny 5x7 LED font (scoreboard vibe).
//
// Brand: dark card, lime spots number (#b8ff2c), teal cap (#17d7b0), teal→lime
// fill bar. Public API: renderSpotsPng({ left, cap }) → Buffer (image/png).

import zlib from 'node:zlib';

// ── brand palette (RGBA) ──
const C = {
  card:   [0x16, 0x16, 0x16, 255],
  border: [0x2a, 0x2a, 0x2a, 255],
  lime:   [0xb8, 0xff, 0x2c, 255],
  teal:   [0x17, 0xd7, 0xb0, 255],
  track:  [0x27, 0x2a, 0x2e, 255],
  muted:  [0x8a, 0x8f, 0x98, 255],
};

// ── 5x7 LED font: digits 0-9 and "/" (only glyphs the badge needs) ──
const GLYPHS = {
  '0': ['01110','10001','10011','10101','11001','10001','01110'],
  '1': ['00100','01100','00100','00100','00100','00100','01110'],
  '2': ['01110','10001','00001','00010','00100','01000','11111'],
  '3': ['11111','00010','00100','00010','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '6': ['00110','01000','10000','11110','10001','10001','01110'],
  '7': ['11111','00001','00010','00100','01000','01000','01000'],
  '8': ['01110','10001','10001','01110','10001','10001','01110'],
  '9': ['01110','10001','10001','01111','00001','00010','01100'],
  '/': ['00001','00001','00010','00100','01000','10000','10000'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
};
const GLYPH_W = 5, GLYPH_H = 7;

function makeBuf(w, h, rgba = [0, 0, 0, 0]) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) buf.set(rgba, i * 4);
  return buf;
}

function px(buf, w, h, x, y, rgba) {
  x = x | 0; y = y | 0;
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  buf.set(rgba, (y * w + x) * 4);
}

function rect(buf, w, h, x, y, rw, rh, rgba) {
  for (let yy = y; yy < y + rh; yy++)
    for (let xx = x; xx < x + rw; xx++) px(buf, w, h, xx, yy, rgba);
}

// Rounded-corner card: fill, then knock out the four corners for a soft edge.
function roundedCard(buf, w, h, x, y, rw, rh, r, fill, border) {
  rect(buf, w, h, x, y, rw, rh, fill);
  // 1px border
  rect(buf, w, h, x, y, rw, 1, border);
  rect(buf, w, h, x, y + rh - 1, rw, 1, border);
  rect(buf, w, h, x, y, 1, rh, border);
  rect(buf, w, h, x + rw - 1, y, 1, rh, border);
  // corner mask → transparent outside the radius
  const clear = [0, 0, 0, 0];
  for (let dy = 0; dy < r; dy++) {
    for (let dx = 0; dx < r; dx++) {
      const inside = (dx + 0.5 - r) ** 2 + (dy + 0.5 - r) ** 2 <= r * r;
      if (!inside) {
        px(buf, w, h, x + dx, y + dy, clear);                       // TL
        px(buf, w, h, x + rw - 1 - dx, y + dy, clear);              // TR
        px(buf, w, h, x + dx, y + rh - 1 - dy, clear);             // BL
        px(buf, w, h, x + rw - 1 - dx, y + rh - 1 - dy, clear);    // BR
      }
    }
  }
}

function glyph(buf, w, h, ch, x, y, scale, rgba) {
  const g = GLYPHS[ch] || GLYPHS[' '];
  for (let row = 0; row < GLYPH_H; row++)
    for (let col = 0; col < GLYPH_W; col++)
      if (g[row][col] === '1')
        rect(buf, w, h, x + col * scale, y + row * scale, scale, scale, rgba);
  return GLYPH_W * scale;
}

// Draw a string of LED glyphs left→right. `colorFor(i,ch)` picks each glyph's color.
function text(buf, w, h, str, x, y, scale, colorFor) {
  const gap = scale; // one cell of space between glyphs
  let cx = x;
  for (let i = 0; i < str.length; i++) {
    const adv = glyph(buf, w, h, str[i], cx, y, scale, colorFor(i, str[i]));
    cx += adv + gap;
  }
  return cx - gap - x; // total drawn width
}

function measure(str, scale) {
  const gap = scale;
  return str.length * (GLYPH_W * scale + gap) - gap;
}

// ── PNG encoding (pure JS via zlib) ──
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(rgba, w, h) {
  // filter byte (0 = none) prepended to each scanline
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Render the live spots badge as a PNG buffer.
 * Rendered at 2x (display width ~320px). Shows "left/cap" in LED digits plus a
 * teal→lime fill bar whose length reflects how full the ladder is.
 * @param {{left:number, cap:number}} opts
 * @returns {Buffer} PNG bytes
 */
export function renderSpotsPng({ left, cap }) {
  const L = Math.max(0, Math.floor(Number(left) || 0));
  const CAP = Math.max(0, Math.floor(Number(cap) || 0));
  const W = 640, H = 150;
  const buf = makeBuf(W, H, [0, 0, 0, 0]);

  // card
  roundedCard(buf, W, H, 0, 0, W, H, 26, C.card, C.border);

  const padX = 34;

  // Big spots-left number (lime), then "/cap" (teal), vertically centered above the bar.
  const bigScale = 11;                 // digit cell size for the main number
  const capScale = 6;
  const numStr = String(L);
  const capStr = '/' + String(CAP);
  const numW = measure(numStr, bigScale);
  const numY = 30;
  text(buf, W, H, numStr, padX, numY, bigScale, () => C.lime);
  // "/cap" baseline-aligned to the bottom of the big number
  const capY = numY + GLYPH_H * bigScale - GLYPH_H * capScale;
  text(buf, W, H, capStr, padX + numW + bigScale + 4, capY, capScale, () => C.teal);

  // Fill bar along the bottom: teal→lime gradient, width = filled fraction.
  const barX = padX, barY = H - 34, barW = W - padX * 2, barH = 16;
  // track
  roundedCard(buf, W, H, barX, barY, barW, barH, barH / 2, C.track, C.track);
  const filled = CAP > 0 ? Math.min(1, Math.max(0, (CAP - L) / CAP)) : 0;
  const fw = Math.round(barW * filled);
  if (fw > 2) {
    // per-column interpolation teal→lime
    for (let i = 0; i < fw; i++) {
      const t = fw > 1 ? i / (fw - 1) : 1;
      const col = [
        Math.round(C.teal[0] + (C.lime[0] - C.teal[0]) * t),
        Math.round(C.teal[1] + (C.lime[1] - C.teal[1]) * t),
        Math.round(C.teal[2] + (C.lime[2] - C.teal[2]) * t),
        255,
      ];
      rect(buf, W, H, barX + i, barY, 1, barH, col);
    }
    // round the bar's left/right caps by masking corners of the filled span
    const r = barH / 2, clear = [0, 0, 0, 0];
    for (let dy = 0; dy < r; dy++) for (let dx = 0; dx < r; dx++) {
      const inside = (dx + 0.5 - r) ** 2 + (dy + 0.5 - r) ** 2 <= r * r;
      if (!inside) {
        px(buf, W, H, barX + dx, barY + dy, clear);
        px(buf, W, H, barX + dx, barY + barH - 1 - dy, clear);
      }
    }
  }

  return encodePng(buf, W, H);
}

/** A 1x1 transparent PNG — returned when a badge can't be rendered so a broken
 *  <img> never shows in the email (the baked HTML number is the real fallback). */
export function transparentPng() {
  return encodePng(makeBuf(1, 1, [0, 0, 0, 0]), 1, 1);
}
