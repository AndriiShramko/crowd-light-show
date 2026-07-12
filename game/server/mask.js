// Битовая маска проходимости: 1 бит/клетку CELL м. Формат .bin: [i32 w][i32 h][f32 originX][f32 originZ][f32 cell][биты row-major].
import fs from 'node:fs';

export function loadMask(path) {
  const buf = fs.readFileSync(path);
  const w = buf.readInt32LE(0), h = buf.readInt32LE(4);
  const originX = buf.readFloatLE(8), originZ = buf.readFloatLE(12), cell = buf.readFloatLE(16);
  const bits = buf.subarray(20);
  function walkable(x, z) {
    const cx = Math.floor((x - originX) / cell), cz = Math.floor((z - originZ) / cell);
    if (cx < 0 || cz < 0 || cx >= w || cz >= h) return false;
    const i = cz * w + cx;
    return (bits[i >> 3] >> (i & 7)) & 1;
  }
  return { w, h, originX, originZ, cell, walkable };
}
