/**
 * TaskSchool — tools/generate-icons.js
 * Gera os ícones PNG do manifesto PWA sem dependências externas
 * (codificador PNG próprio usando o módulo `zlib` do Node).
 *
 * Uso: npm run icons
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'public', 'icons');

/* ----------------------------- PNG encoder ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filtro "None"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------ Geometria ----------------------------- */

/** Distância de um ponto ao segmento AB. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Testa se o ponto está dentro de um retângulo com cantos arredondados. */
function insideRoundedRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return Math.hypot(px - cx, py - cy) <= r;
}

/* ------------------------------ Renderização --------------------------- */

const COLOR_FROM = [46, 160, 67]; // #2ea043
const COLOR_TO = [24, 101, 38]; // #186526

function mixColor(t) {
  return [
    Math.round(COLOR_FROM[0] + (COLOR_TO[0] - COLOR_FROM[0]) * t),
    Math.round(COLOR_FROM[1] + (COLOR_TO[1] - COLOR_FROM[1]) * t),
    Math.round(COLOR_FROM[2] + (COLOR_TO[2] - COLOR_FROM[2]) * t),
  ];
}

/**
 * @param {number} size      lado da imagem em pixels
 * @param {boolean} maskable true = fundo sangrando (safe zone do Android)
 */
function renderIcon(size, maskable = false) {
  const rgba = Buffer.alloc(size * size * 4);
  const samples = 4; // supersampling 4x4 (anti-aliasing)

  const pad = maskable ? 0 : size * 0.06;
  const boxSize = size - pad * 2;
  const radius = maskable ? 0 : boxSize * 0.24;

  // Geometria do "check" (escalada conforme o modo)
  const scale = maskable ? 0.62 : 1;
  const cx = size / 2;
  const cy = size / 2;
  const stroke = size * 0.1 * scale;
  const p1 = [cx - size * 0.18 * scale, cy + size * 0.01 * scale];
  const p2 = [cx - size * 0.05 * scale, cy + size * 0.14 * scale];
  const p3 = [cx + size * 0.2 * scale, cy - size * 0.15 * scale];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let bgHits = 0;
      let fgHits = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;

          const inBg = maskable
            ? px >= 0 && px <= size && py >= 0 && py <= size
            : insideRoundedRect(px, py, pad, pad, boxSize, boxSize, radius);

          if (inBg) {
            bgHits += 1;
            const d =
              Math.min(
                distanceToSegment(px, py, p1[0], p1[1], p2[0], p2[1]),
                distanceToSegment(px, py, p2[0], p2[1], p3[0], p3[1])
              );
            if (d <= stroke / 2) fgHits += 1;
          }
        }
      }

      const total = samples * samples;
      const bgAlpha = bgHits / total;
      const fgAlpha = fgHits / total;

      const offset = (y * size + x) * 4;
      const [r, g, b] = mixColor((x + y) / (2 * size));

      // Cor final = fundo com gradiente + check branco (alpha-blend)
      const outR = Math.round(r * (1 - fgAlpha) + 255 * fgAlpha);
      const outG = Math.round(g * (1 - fgAlpha) + 255 * fgAlpha);
      const outB = Math.round(b * (1 - fgAlpha) + 255 * fgAlpha);

      rgba[offset] = outR;
      rgba[offset + 1] = outG;
      rgba[offset + 2] = outB;
      rgba[offset + 3] = Math.round(bgAlpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* --------------------------------- Main -------------------------------- */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const targets = [
    { file: 'icon-192.png', size: 192, maskable: false },
    { file: 'icon-512.png', size: 512, maskable: false },
    { file: 'icon-maskable-512.png', size: 512, maskable: true },
  ];

  targets.forEach(({ file, size, maskable }) => {
    const buffer = renderIcon(size, maskable);
    fs.writeFileSync(path.join(OUT_DIR, file), buffer);
    console.log(`[icons] ${file} (${size}x${size}, ${(buffer.length / 1024).toFixed(1)} KB)`);
  });

  // Favicon vetorial
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#2ea043"/>
      <stop offset="100%" stop-color="#186526"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <path d="M17 33.5 L27 43 L47 22" fill="none" stroke="#ffffff" stroke-width="7"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
  fs.writeFileSync(path.join(OUT_DIR, 'favicon.svg'), svg, 'utf8');
  console.log('[icons] favicon.svg');
}

main();
