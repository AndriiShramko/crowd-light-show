// Модель хоровода: ОДНА полилиния пути головы (ring-buffer + RDP-прореживание без телепорта)
// + members[seatIndex]; сегмент-лидеры каждые SEG звеньев. Спека: spec-arch §Модель цепочки.
export const SPACING = 1.2;      // м между звеньями по дуге
export const SEG = 25;           // сегмент-лидер каждые 25 звеньев
export const JOIN_RADIUS = 4;    // м до хвоста для attach
export const MAX_POINTS = 4096;  // ring-buffer полилинии
const MIN_STEP = 0.25;           // м — минимальный аппенд пути

export class Chain {
  constructor(id, colorId, headPlayer) {
    this.id = id; this.colorId = colorId;
    this.members = [headPlayer.id];            // seatIndex = позиция в массиве
    this.path = [{ x: headPlayer.x, z: headPlayer.z }]; // [0]=старая…[n-1]=голова
    this.cum = [0];                            // кумулятивная длина
  }
  get headId() { return this.members[0]; }
  get length() { return this.members.length; }
  totalLen() { return this.cum[this.cum.length - 1]; }

  appendHead(x, z) {
    const last = this.path[this.path.length - 1];
    const d = Math.hypot(x - last.x, z - last.z);
    if (d < MIN_STEP) return;
    this.path.push({ x, z });
    this.cum.push(this.totalLen() + d);
    if (this.path.length > MAX_POINTS) this.decimate();
  }

  // RDP-подобное прореживание СТАРОЙ половины (каждая 2-я точка при малой кривизне) — без телепорта хвоста.
  decimate() {
    const half = Math.floor(this.path.length / 2);
    const keep = [this.path[0]];
    for (let i = 1; i < half - 1; i++) {
      const a = keep[keep.length - 1], b = this.path[i], c = this.path[i + 1];
      const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
      if (cross > 0.05 || Math.hypot(c.x - a.x, c.z - a.z) > 4) keep.push(b);
    }
    this.path = keep.concat(this.path.slice(half - 1));
    this.cum = [0];
    for (let i = 1; i < this.path.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(this.path[i].x - this.path[i - 1].x, this.path[i].z - this.path[i - 1].z));
    }
  }

  // Точка на дуговой дистанции d ПОЗАДИ головы.
  pointBehind(d) {
    const target = this.totalLen() - d;
    if (target <= 0) return { ...this.path[0] };
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.cum[mid] < target) lo = mid + 1; else hi = mid; }
    const i = Math.max(1, lo);
    const t = (target - this.cum[i - 1]) / Math.max(1e-6, this.cum[i] - this.cum[i - 1]);
    return {
      x: this.path[i - 1].x + t * (this.path[i].x - this.path[i - 1].x),
      z: this.path[i - 1].z + t * (this.path[i].z - this.path[i - 1].z),
    };
  }

  tailPos() { return this.pointBehind((this.length - 1) * SPACING + SPACING); }
  // seatOf с lazy-кешем (broadcast зовёт его per-client — линейный indexOf дал бы O(n²))
  seatOf(playerId) {
    if (!this._seatMap || this._seatDirty) {
      this._seatMap = new Map();
      for (let i = 0; i < this.members.length; i++) this._seatMap.set(this.members[i], i);
      this._seatDirty = false;
    }
    return this._seatMap.has(playerId) ? this._seatMap.get(playerId) : -1;
  }
  isLeaderSeat(seat) { return seat % SEG === 0; }

  attach(playerId) { this.members.push(playerId); this._seatDirty = true; return this.members.length - 1; }

  // Detach любого места: хвост «переклеивается» автоматически (позиции = f(seatIndex) по той же полилинии).
  detach(playerId) {
    const i = this.members.indexOf(playerId);
    if (i < 0) return null;
    this.members.splice(i, 1);
    this._seatDirty = true;
    return i;
  }

  // Передача лидерства: голова уходит, следующий становится головой; полилиния ПРОДОЛЖАЕТСЯ (без разрыва).
  transferHead() {
    const old = this.members.shift();
    this._seatDirty = true;
    // Обрезаем путь до позиции новой головы (она стояла на SPACING позади) — непрерывность сохраняется:
    const p = this.pointBehind(SPACING);
    this.appendHead(p.x, p.z);
    return old;
  }

  maxGap() {
    let m = 0;
    for (let i = 1; i < this.path.length; i++) {
      m = Math.max(m, Math.hypot(this.path[i].x - this.path[i - 1].x, this.path[i].z - this.path[i - 1].z));
    }
    return m;
  }
}
