// Генерация маски проходимости арены Фазы B/C (пока нет GLB-коллайдера реального мира):
// круг R=100 м, внешние стены + 4 внутренних стены-препятствия. Формат см. server/mask.js.
// Запуск: node game/tools/make-mask.mjs game/static/worlds/arena-mask-v1.bin
import fs from 'node:fs';

const out = process.argv[2] || 'game/static/worlds/arena-mask-v1.bin';
const CELL = 0.5, R = 100, PAD = 4;
const w = Math.ceil((2 * (R + PAD)) / CELL), h = w;
const originX = -(R + PAD), originZ = -(R + PAD);
const bits = new Uint8Array(Math.ceil((w * h) / 8));
const set = (cx, cz, v) => { const i = cz * w + cx; if (v) bits[i >> 3] |= 1 << (i & 7); else bits[i >> 3] &= ~(1 << (i & 7)); };

// Внутренние стены: [x1,z1,x2,z2,толщина]
const walls = [
  [-60, -20, -20, -20, 1.5],
  [20, 20, 60, 20, 1.5],
  [0, -60, 0, -30, 1.5],
  [-30, 40, -30, 70, 1.5],
];
function nearWall(x, z) {
  for (const [x1, z1, x2, z2, t] of walls) {
    const dx = x2 - x1, dz = z2 - z1, len2 = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / len2));
    const px = x1 + u * dx, pz = z1 + u * dz;
    if ((x - px) ** 2 + (z - pz) ** 2 <= t * t) return true;
  }
  return false;
}
for (let cz = 0; cz < h; cz++) {
  for (let cx = 0; cx < w; cx++) {
    const x = originX + (cx + 0.5) * CELL, z = originZ + (cz + 0.5) * CELL;
    set(cx, cz, x * x + z * z <= R * R && !nearWall(x, z) ? 1 : 0);
  }
}
const head = Buffer.alloc(20);
head.writeInt32LE(w, 0); head.writeInt32LE(h, 4);
head.writeFloatLE(originX, 8); head.writeFloatLE(originZ, 12); head.writeFloatLE(CELL, 16);
fs.writeFileSync(out, Buffer.concat([head, Buffer.from(bits)]));
fs.writeFileSync(out.replace(/\.bin$/, '.json'), JSON.stringify({ w, h, originX, originZ, cell: CELL, r: R, walls }));
console.log(out, w + 'x' + h, (20 + bits.length) + ' bytes');
