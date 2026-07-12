// Процедурный low-poly кот (создан кодом — своё, без закупок; стиль референсов U:\...\Game\Cats:
// лохматый чернильно-чёрный, огромные жёлтые глаза). 2 пресета: A «вихрастый», B «с кисточками».
// Один InstancedMesh на всех котов; heading через per-instance matrix; LOD инстанс→билборд→точка.
import * as THREE from 'three';

const INK = 0x111014, EYE = 0xffc21e;

function buildCatGeometry(preset) {
  const parts = [];
  const body = new THREE.SphereGeometry(0.42, 8, 6); body.scale(1, 0.85, 1.15); body.translate(0, 0.42, 0);
  parts.push(body);
  const head = new THREE.SphereGeometry(0.32, 8, 6); head.translate(0, 0.72, 0.34);
  parts.push(head);
  // уши
  for (const s of [-1, 1]) {
    const ear = new THREE.ConeGeometry(0.13, 0.26, 4); ear.translate(s * 0.16, 0.98, 0.32);
    ear.rotateX(-0.2); parts.push(ear);
    if (preset === 'B') { // кисточки на ушах
      const t = new THREE.ConeGeometry(0.05, 0.12, 4); t.translate(s * 0.16, 1.14, 0.30); parts.push(t);
    }
  }
  if (preset === 'A') { // вихры на макушке
    for (const dx of [-0.1, 0, 0.1]) { const w = new THREE.ConeGeometry(0.05, 0.2, 4); w.translate(dx, 1.02, 0.30); w.rotateZ(dx * 2); parts.push(w); }
    const scarf = new THREE.TorusGeometry(0.26, 0.06, 4, 8); scarf.rotateX(Math.PI / 2); scarf.translate(0, 0.5, 0.28); parts.push(scarf);
  }
  // хвост
  const tail = new THREE.CylinderGeometry(0.05, 0.09, 0.6, 5); tail.translate(0, 0.5, -0.5); tail.rotateX(-0.9); parts.push(tail);
  // лапки
  for (const s of [-1, 1]) { const leg = new THREE.CylinderGeometry(0.07, 0.07, 0.24, 5); leg.translate(s * 0.18, 0.12, 0.12); parts.push(leg); }
  return mergeGeometries(parts);
}
function buildEyes() {
  const geos = [];
  for (const s of [-1, 1]) { const e = new THREE.SphereGeometry(0.1, 6, 5); e.scale(1, 1.25, 1); e.translate(s * 0.13, 0.74, 0.6); geos.push(e); }
  return mergeGeometries(geos);
}
// минимальный merge без BufferGeometryUtils (только position/normal)
function mergeGeometries(geos) {
  let vc = 0, ic = 0;
  for (const g of geos) { const gi = g.index; vc += g.attributes.position.count; ic += gi ? gi.count : g.attributes.position.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of geos) {
    g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array, gi = g.index;
    pos.set(p, vo * 3); nor.set(n, vo * 3);
    if (gi) for (let i = 0; i < gi.count; i++) idx[io++] = gi.array[i] + vo;
    else for (let i = 0; i < g.attributes.position.count; i++) idx[io++] = i + vo;
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export function makeCatBillboardTexture(preset) {
  const s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const c = cv.getContext('2d');
  c.fillStyle = '#111014';
  c.beginPath(); c.ellipse(s / 2, s * 0.58, s * 0.32, s * 0.38, 0, 0, 7); c.fill();
  c.beginPath(); c.arc(s / 2, s * 0.34, s * 0.26, 0, 7); c.fill();
  c.fillStyle = '#111014';
  for (const dx of [-0.18, 0.18]) { c.beginPath(); c.moveTo(s / 2 + dx * s, s * 0.18); c.lineTo(s / 2 + dx * s - 6, s * 0.30); c.lineTo(s / 2 + dx * s + 6, s * 0.30); c.fill(); }
  c.fillStyle = '#ffc21e';
  for (const dx of [-0.11, 0.11]) { c.beginPath(); c.ellipse(s / 2 + dx * s, s * 0.34, 5, 7, 0, 0, 7); c.fill(); }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}

// Слой котов: до MAX инстансов, LOD по дистанции камеры.
export class CatLayer {
  constructor(scene, max = 2000) {
    this.max = max;
    this.geoA = buildCatGeometry('A'); this.geoB = buildCatGeometry('B');
    this.eyesA = buildEyes(); this.eyesB = buildEyes();
    const bodyMat = new THREE.MeshLambertMaterial({ color: INK });
    const eyeMat = new THREE.MeshBasicMaterial({ color: EYE });
    this.meshA = new THREE.InstancedMesh(this.geoA, bodyMat, max);
    this.meshB = new THREE.InstancedMesh(this.geoB, bodyMat, max);
    this.eyeMeshA = new THREE.InstancedMesh(this.eyesA, eyeMat, max);
    this.eyeMeshB = new THREE.InstancedMesh(this.eyesB, eyeMat, max);
    for (const m of [this.meshA, this.meshB, this.eyeMeshA, this.eyeMeshB]) { m.frustumCulled = false; m.count = 0; scene.add(m); }
    // билборды (средний LOD) и точки (дальний)
    this.billMat = new THREE.SpriteMaterial({ map: makeCatBillboardTexture('A') });
    this.pointGeo = new THREE.BufferGeometry();
    this.pointGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    this.pointGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    this.points = new THREE.Points(this.pointGeo, new THREE.PointsMaterial({ size: 6, sizeAttenuation: false, vertexColors: true }));
    this.points.frustumCulled = false; scene.add(this.points);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(1, 1, 1);
    this.drawCallsHint = 5;
  }
  // cats: [{x,z,heading,preset,colorId,near}] уже отфильтрованные по AOI; camPos для LOD
  update(cats, camPos) {
    let a = 0, b = 0, pc = 0;
    const posArr = this.pointGeo.attributes.position.array, colArr = this.pointGeo.attributes.color.array;
    for (const c of cats) {
      const d = Math.hypot(c.x - camPos.x, c.z - camPos.z);
      if (d < 25) { // полный инстанс
        this._e.set(0, -c.heading + Math.PI / 2, 0); this._q.setFromEuler(this._e);
        this._p.set(c.x, 0, c.z); this._m.compose(this._p, this._q, this._s);
        if (c.preset === 'B') { this.meshB.setMatrixAt(b, this._m); this.eyeMeshB.setMatrixAt(b, this._m); b++; }
        else { this.meshA.setMatrixAt(a, this._m); this.eyeMeshA.setMatrixAt(a, this._m); a++; }
      } else { // средний/дальний → точка с цветом цепочки
        posArr[pc * 3] = c.x; posArr[pc * 3 + 1] = 0.5; posArr[pc * 3 + 2] = c.z;
        const col = chainColor(c.colorId);
        colArr[pc * 3] = col.r; colArr[pc * 3 + 1] = col.g; colArr[pc * 3 + 2] = col.b; pc++;
      }
    }
    this.meshA.count = a; this.meshB.count = b; this.eyeMeshA.count = a; this.eyeMeshB.count = b;
    this.meshA.instanceMatrix.needsUpdate = this.eyeMeshA.instanceMatrix.needsUpdate = true;
    this.meshB.instanceMatrix.needsUpdate = this.eyeMeshB.instanceMatrix.needsUpdate = true;
    this.pointGeo.setDrawRange(0, pc);
    this.pointGeo.attributes.position.needsUpdate = this.pointGeo.attributes.color.needsUpdate = true;
    this.lastCounts = { instanced: a + b, points: pc };
  }
}

const PALETTE = [0xffffff, 0xff5a6e, 0xffc21e, 0x4ad6a0, 0x5aa0ff, 0xc07bff, 0xff8f3c, 0x7ce0ff];
export function chainColor(id) { return new THREE.Color(PALETTE[(id - 1) % PALETTE.length] || 0xffffff); }
export function chainColorHex(id) { return '#' + (PALETTE[(id - 1) % PALETTE.length] || 0xffffff).toString(16).padStart(6, '0'); }
