// Генерирует <world>.json (центр/радиус) из исходного 3DGS PLY — для авто-фрейминга камеры.
// Запуск: node game/tools/world-manifest.mjs <input.ply> <output.json>
import fs from 'node:fs';

const [, , inPath, outPath] = process.argv;
const fd = fs.openSync(inPath, 'r');
const head = Buffer.alloc(4096);
fs.readSync(fd, head, 0, 4096, 0);
const headerText = head.toString('latin1');
const endTag = 'end_header\n';
const headerEnd = headerText.indexOf(endTag);
if (headerEnd < 0) throw new Error('no ply header in first 4KB');
const dataStart = headerEnd + endTag.length;
const header = headerText.slice(0, headerEnd);
const vertexCount = Number(header.match(/element vertex (\d+)/)[1]);
const props = [...header.matchAll(/property (\w+) (\w+)/g)].map((m) => ({ type: m[1], name: m[2] }));
const sizes = { float: 4, uchar: 1, double: 8, int: 4, uint: 4, short: 2, ushort: 2, char: 1 };
let stride = 0; const off = {};
for (const p of props) { off[p.name] = stride; stride += sizes[p.type]; }
if (!('x' in off)) throw new Error('no x prop');

const STEP = Math.max(1, Math.floor(vertexCount / 20000)); // ~20k сэмплов
const xs = [], ys = [], zs = [];
const buf = Buffer.alloc(stride);
for (let i = 0; i < vertexCount; i += STEP) {
  fs.readSync(fd, buf, 0, stride, dataStart + i * stride);
  xs.push(buf.readFloatLE(off.x)); ys.push(buf.readFloatLE(off.y)); zs.push(buf.readFloatLE(off.z));
}
fs.closeSync(fd);
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
// Робастные границы: 5–95 перцентиль (проигнорировать флоатеры)
const lo = [pct(xs, 0.05), pct(ys, 0.05), pct(zs, 0.05)];
const hi = [pct(xs, 0.95), pct(ys, 0.95), pct(zs, 0.95)];
const center = lo.map((v, i) => (v + hi[i]) / 2);
const radius = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
const manifest = { version: 1, samples: xs.length, center, radius: Math.round(radius * 100) / 100 };
fs.writeFileSync(outPath, JSON.stringify(manifest));
console.log(outPath, JSON.stringify(manifest));
