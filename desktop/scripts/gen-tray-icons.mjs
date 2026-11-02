// Generates the tray icons and the app icon (design D5) into assets/: tray/tray-0…9, tray-9plus, tray-offline,
// tray-signedout (.ico 16/20/24/32 px) and app.ico (16…256 px). No dependencies: app.ico is the PWA icon
// (web/public/icons/icon-512.png, decoded here and downscaled by area averaging), tray shapes are rasterised with 4×4
// supersampling and glyphs come from a 5×7 pixel font; tray-0 (no sessions waiting) is the same PWA icon. The .ico holds
// 32-bit BMP entries (readable by Windows, Electron and NSIS). Run: npm run icons -w desktop. The output is committed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../assets/', import.meta.url));

const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
};

const WHITE = [255, 255, 255];
const COLORS = {
  count: [217, 48, 37], // red — sessions wait for Ivan
  offline: [120, 120, 120],
  signedout: [199, 119, 0],
};

/** Coverage of a rounded square of `size` px with a radius of 22%. */
function inRoundedRect(x, y, size) {
  const r = size * 0.22;
  const cx = Math.min(Math.max(x, r), size - r);
  const cy = Math.min(Math.max(y, r), size - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function glyphMask(text, size) {
  const glyphs = [...text].map(c => FONT[c]);
  const units = glyphs.length * 5 + (glyphs.length - 1);
  const scale = Math.min((size * 0.62) / 7, (size * 0.8) / units);
  const w = units * scale;
  const h = 7 * scale;
  const ox = (size - w) / 2;
  const oy = (size - h) / 2;
  return (x, y) => {
    const u = (x - ox) / scale;
    const v = (y - oy) / scale;
    if (u < 0 || v < 0 || v >= 7) return false;
    const gi = Math.floor(u / 6);
    const gu = Math.floor(u - gi * 6);
    if (gi >= glyphs.length || gu >= 5) return false;
    return glyphs[gi][Math.floor(v)][gu] === '1';
  };
}

/** RGBA pixels (top-down) of one icon size. */
function render(size, text, color, textColor = WHITE) {
  const px = Buffer.alloc(size * size * 4);
  const glyph = glyphMask(text, size);
  const S = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const fx = x + (sx + 0.5) / S;
          const fy = y + (sy + 0.5) / S;
          if (inRoundedRect(fx, fy, size)) {
            bg++;
            if (glyph(fx, fy)) fg++;
          }
        }
      }
      const a = bg / (S * S);
      const t = bg ? fg / bg : 0;
      const i = (y * size + x) * 4;
      px[i] = Math.round(color[0] * (1 - t) + textColor[0] * t);
      px[i + 1] = Math.round(color[1] * (1 - t) + textColor[1] * t);
      px[i + 2] = Math.round(color[2] * (1 - t) + textColor[2] * t);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

/** One ICO image entry: BITMAPINFOHEADER + BGRA bottom-up + empty AND mask. */
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((size - 1 - y) * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  return Buffer.concat([header, pixels, mask]);
}

/** RGBA pixels of an 8-bit RGBA non-interlaced PNG. */
function decodePng(buf) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) throw new Error('expected 8-bit RGBA non-interlaced PNG');
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  return { width, px };
}

/** Area-average downscale of a square RGBA image (alpha-weighted colour). */
function downscale(src, size) {
  const k = src.width / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = Math.floor(y * k); sy < Math.floor((y + 1) * k); sy++) {
        for (let sx = Math.floor(x * k); sx < Math.floor((x + 1) * k); sx++) {
          const i = (sy * src.width + sx) * 4;
          const al = src.px[i + 3];
          r += src.px[i] * al;
          g += src.px[i + 1] * al;
          b += src.px[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * size + x) * 4;
      if (a) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function icoFromImages(sizes, images) {
  const entries = sizes.map((s, i) => bmpEntry(s, images[i]));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(s >= 256 ? 0 : s, o);
    head.writeUInt8(s >= 256 ? 0 : s, o + 1);
    head.writeUInt8(0, o + 2);
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(entries[i].length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += entries[i].length;
  });
  return Buffer.concat([head, ...entries]);
}

function ico(sizes, text, color, textColor) {
  return icoFromImages(
    sizes,
    sizes.map(s => render(s, text, color, textColor)),
  );
}

const TRAY = [16, 20, 24, 32];
mkdirSync(`${out}tray`, { recursive: true });
for (let n = 1; n <= 9; n++) writeFileSync(`${out}tray/tray-${n}.ico`, ico(TRAY, String(n), COLORS.count));
writeFileSync(`${out}tray/tray-9plus.ico`, ico(TRAY, '9+', COLORS.count));
writeFileSync(`${out}tray/tray-offline.ico`, ico(TRAY, '!', COLORS.offline));
writeFileSync(`${out}tray/tray-signedout.ico`, ico(TRAY, '?', COLORS.signedout));
const pwa = decodePng(readFileSync(fileURLToPath(new URL('../../web/public/icons/icon-512.png', import.meta.url))));
const APP = [16, 24, 32, 48, 64, 128, 256];
writeFileSync(
  `${out}tray/tray-0.ico`,
  icoFromImages(
    TRAY,
    TRAY.map(s => downscale(pwa, s)),
  ),
);
writeFileSync(
  `${out}app.ico`,
  icoFromImages(
    APP,
    APP.map(s => downscale(pwa, s)),
  ),
);
console.log(`icons written to ${out}`);
