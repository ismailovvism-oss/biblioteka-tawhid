'use strict';

/*
 * Генератор иконок PWA без внешних зависимостей (только zlib).
 * Рисует иконку «параллельный текст»: акцентный фон, светлая карточка,
 * вертикальный разделитель и строки текста в две колонки.
 * Запуск: node tools/gen-icons.js  → icons/icon-192.png, icon-512.png
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const ACCENT = [176, 122, 44];
const CARD = [253, 252, 248];
const LINE = [196, 188, 173];

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 512; // нормировка координат под 512-сетку
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };
  const fillRound = (x0, y0, x1, y1, rad, col) => {
    for (let y = Math.floor(y0); y < y1; y++) {
      for (let x = Math.floor(x0); x < x1; x++) {
        // скругление углов
        const cx = x < x0 + rad ? x0 + rad : (x > x1 - rad ? x1 - rad : x);
        const cy = y < y0 + rad ? y0 + rad : (y > y1 - rad ? y1 - rad : y);
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= rad * rad) set(x, y, col);
      }
    }
  };

  // фон (акцент) на всю площадь — устойчиво к maskable-обрезке
  for (let i = 0; i < size * size; i++) { px[i * 4] = ACCENT[0]; px[i * 4 + 1] = ACCENT[1]; px[i * 4 + 2] = ACCENT[2]; px[i * 4 + 3] = 255; }

  // карточка (в безопасной зоне ~центральные 80%)
  fillRound(96 * s, 112 * s, 416 * s, 400 * s, 30 * s, CARD);

  // вертикальный разделитель колонок
  fillRound(252 * s, 140 * s, 260 * s, 372 * s, 4 * s, ACCENT);

  // строки текста в две колонки
  const rows = [168, 204, 240, 276, 312, 348];
  for (const ry of rows) {
    fillRound(124 * s, ry * s, 240 * s, (ry + 12) * s, 6 * s, LINE);   // левая
    fillRound(272 * s, ry * s, 388 * s, (ry + 12) * s, 6 * s, LINE);   // правая
  }
  return px;
}

// ---- минимальный PNG-энкодер (RGBA, 8 бит) ----
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
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 бит, RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // фильтр None
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = path.join(outDir, `icon-${size}.png`);
  fs.writeFileSync(file, encodePng(size, render(size)));
  console.log('written', path.relative(path.join(__dirname, '..'), file));
}
