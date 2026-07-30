// 홈 화면 아이콘(PNG) 생성기. 의존성을 안 쓰는 프로젝트라 PNG를 직접 인코딩한다.
//   node tools/make-icons.mjs
// 안드로이드 WebAPK는 런처 아이콘으로 PNG를 요구한다(SVG는 안 먹는다).

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../public/', import.meta.url));

// ── PNG 인코딩 ────────────────────────────────────────────────────────
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 그리기 ────────────────────────────────────────────────────────────
/** 점과 선분 사이 거리 — 두께 있는 선을 안티에일리어싱해서 그리려고 쓴다. */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

const BG = [0x16, 0x18, 0x1d];
const LINE = [0xe4, 0x44, 0x2f]; // 상승 빨강
const DIM = [0x3a, 0x3f, 0x48];

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);

  // 마스크(원형으로 잘림)에 대비해 내용은 가운데 60%에만 둔다.
  const pad = size * 0.22;
  const w = size - pad * 2;
  const h = size - pad * 2;

  // 오르는 꺾은선. y는 0(위)~1(아래) 정규화.
  const pts = [
    [0.00, 0.78], [0.16, 0.62], [0.30, 0.70],
    [0.46, 0.42], [0.60, 0.52], [0.78, 0.20], [1.00, 0.30],
  ].map(([x, y]) => [pad + x * w, pad + y * h]);

  const thick = size * 0.055;
  const baseY = pad + h * 0.92;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let color = BG;
      let alpha = 1;

      // 바닥 기준선
      const dBase = Math.abs(y + 0.5 - baseY);
      const baseHalf = size * 0.012;
      if (x + 0.5 >= pad && x + 0.5 <= pad + w && dBase < baseHalf + 1) {
        const a = Math.max(0, Math.min(1, baseHalf + 0.5 - dBase));
        color = DIM.map((c, k) => Math.round(c * a + BG[k] * (1 - a)));
      }

      // 꺾은선
      let dLine = Infinity;
      for (let s = 0; s < pts.length - 1; s++) {
        dLine = Math.min(
          dLine,
          distToSegment(x + 0.5, y + 0.5, pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1])
        );
      }
      const half = thick / 2;
      if (dLine < half + 1) {
        const a = Math.max(0, Math.min(1, half + 0.5 - dLine));
        color = LINE.map((c, k) => Math.round(c * a + color[k] * (1 - a)));
      }

      buf[i] = color[0];
      buf[i + 1] = color[1];
      buf[i + 2] = color[2];
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return buf;
}

mkdirSync(dirname(OUT + 'x'), { recursive: true });
for (const size of [192, 512]) {
  const file = `${OUT}icon-${size}.png`;
  writeFileSync(file, encodePNG(size, draw(size)));
  console.log(`  ${file}`);
}
