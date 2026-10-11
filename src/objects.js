// src/objects.js — интерактивные объекты уровня.
//
// Объект в уровне: [тип, x, y, z, поворот°, параметр1, параметр2]
//   y — высота поверхности, на которой стоит объект. Поворот 0: «лицо» объекта смотрит в +Z, вперёд = -Z.
//
//   0 лестница  — п1: высота. Подойдите к ней (идя в её сторону): игрок хватается, W/S — вверх/вниз,
//                 Пробел — спрыгнуть назад. На самом верху W перебрасывает игрока через край.
//                 Ставьте лестницу вплотную к стене лицом к игроку (игрок стоит со стороны +Z до поворота).
//   1 батут     — п1: высота подброса (м). Подбрасывает при касании сверху.
//   2 ускоритель — п1: множитель скорости (1.2–3.5). Стрелки показывают направление. Разгон держится ~1.5 с,
//                 в том числе в прыжке, поэтому через него можно перелетать длинные пропасти.
//   3 шипы      — п1: размер. Касание — уровень заново.
//   4 лифт      — п1: размер платформы, п2: путь туда-обратно (> 0 — вдоль направления, < 0 — вверх-вниз).
//                 Платформа едет, и игрок едет вместе с ней.
//
// Модуль не знает про main.js: main.js вызывает build() при сборке уровня и drive() каждый кадр.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DEG, MOVE, PHYS, normPlat, worldParts, closest, topAt } from './shapes.js';
import { audio } from './audio.js';

export const OBJ_MAX = 120;
export const OBJ_TYPES = ['ladder', 'spring', 'boost', 'spikes', 'mover']; // индекс = тип
export const OBJ_DEFS = {
  ladder: { type: 0, p1: 6, p2: 0, hint: 'Лестница: параметр 1 — высота. Ставьте у стены лицом к игроку (R — повернуть)' },
  spring: { type: 1, p1: 6, p2: 0, hint: 'Батут: параметр 1 — высота подброса' },
  boost: { type: 2, p1: 1.9, p2: 0, hint: 'Ускоритель: параметр 1 — множитель скорости, стрелки — направление (R — повернуть)' },
  spikes: { type: 3, p1: 3, p2: 0, hint: 'Шипы: параметр 1 — размер. Касание — уровень заново' },
  mover: { type: 4, p1: 4, p2: 8, hint: 'Лифт: параметр 1 — размер, параметр 2 — путь (больше 0 — вдоль, меньше 0 — вверх-вниз)' },
};
export const OBJ_TOOL = Object.fromEntries(Object.entries(OBJ_DEFS).map(([k, d]) => [k, d.type]));
export const OBJ_TOOL_LIST = [['ladder', 'Лестница'], ['spring', 'Батут'], ['boost', 'Ускор.'], ['spikes', 'Шипы'], ['mover', 'Лифт']];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const CLIMB = 4.2;   // скорость лазания, м/с
const PERIOD = 6;    // период лифта, с
const BOOST_T = 1.5; // сколько держится разгон, с

// Размер «призрака» объекта в редакторе: [ширина, высота, глубина, смещение центра вверх] или null
export function objGhost(tool, p1, p2) {
  switch (tool) {
    case 'ladder': { const h = clamp(p1, 1, 24); return [1.2, h, 0.6, h / 2]; }
    case 'spring': return [1.6, 0.8, 1.6, 0.4];
    case 'boost': return [1.9, 0.3, 3.5, 0.15];
    case 'spikes': { const s = clamp(p1, 1, 8); return [s, 1, s, 0.5]; }
    case 'mover': { const w = clamp(p1, 2, 8); return [w, 0.6, w, -0.3]; }
    default: return null;
  }
}

// Готовый уровень, где есть всё: разгон -> лестница -> батут -> шипы -> лифт -> звезда
export function demoLevel() {
  return {
    id: 'objects', name: 'Полигон объектов',
    plats: [[0, 0, 0, 8, 8], [0, 0, -15, 6, 6], [0, 6, -21, 6, 6, 0, 0, 0, 6], [0, 9, -31, 5, 5], [0, 9, -41, 5, 10], [0, 9, -62, 6, 6]],
    coins: [[0, 2, -8], [0, 7.3, -21], [0, 10.3, -31], [0, 10.3, -52], [0, 10.3, -62]],
    objs: [
      [2, 0, 0, -2.5, 0, 1.9, 0],  // ускоритель на старте: без него через пропасть не перепрыгнуть
      [0, 0, 0, -18, 0, 6, 0],     // лестница на башню
      [1, 0, 6, -22.5, 0, 6, 0],   // батут на верхней площадке
      [3, 0, 9, -41, 0, 3, 0],     // шипы посреди платформы
      [4, 0, 9, -52, 0, 4, 8],     // лифт, едет вперёд-назад
    ],
    shapes: [], req: false, theme: 0, goal: [0, 10.6, -62], start: [0, 0, 0],
  };
}

// ---------- Общие материалы и геометрии (создаются один раз) ----------
let R = null;
function res() {
  if (R) return R;
  const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  // Стрелки ускорителя: шевроны, острие смотрит вверх картинки = вперёд (-Z)
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#1b2230'; g.fillRect(0, 0, 64, 128);
  g.strokeStyle = '#ffd23f'; g.lineWidth = 9;
  for (const y of [30, 94]) { g.beginPath(); g.moveTo(10, y + 24); g.lineTo(32, y); g.lineTo(54, y + 24); g.stroke(); }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.magFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
  R = {
    tex,
    hit: new THREE.MeshBasicMaterial({ visible: false }), // невидимая «коробка» для выбора мышью (ластик, подсветка)
    wood: lam(0xb07a3c, { emissive: 0x1e1206 }),
    springBase: lam(0x444a55), springCoil: lam(0xcfd6dd), springTop: lam(0xe8453c, { emissive: 0x3a0a08 }),
    padBase: lam(0x20242e), padTop: new THREE.MeshBasicMaterial({ map: tex }),
    spikeBase: lam(0x30343d), spikeTip: lam(0xd5dbe3, { emissive: 0x3a0a0a }),
    moverBody: lam(0x4a6fa5), moverTop: lam(0x9fd0ff, { emissive: 0x1a3350 }),
    guide: new THREE.LineBasicMaterial({ color: 0xffee55 }),
    gSpringBase: new THREE.CylinderGeometry(0.8, 0.9, 0.2, 8).translate(0, 0.1, 0),
    gCoil: new THREE.CylinderGeometry(0.28, 0.28, 0.4, 6),
    gTop: new THREE.CylinderGeometry(0.8, 0.8, 0.12, 8),
    gSpringHit: new THREE.BoxGeometry(1.6, 0.8, 1.6).translate(0, 0.4, 0),
    gPadBase: new THREE.BoxGeometry(1.9, 0.1, 3.5).translate(0, 0.05, 0),
    gPadTop: new THREE.PlaneGeometry(1.6, 3.1).rotateX(-Math.PI / 2),
    gPadHit: new THREE.BoxGeometry(1.9, 0.3, 3.5).translate(0, 0.15, 0),
  };
  return R;
}

const add = (parent, geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
const merged = (list) => { const g = mergeGeometries(list); list.forEach((q) => q.dispose()); return g; };

// ---------- Сборка моделей ----------
function buildLadder(h, owned) {
  const list = [];
  for (const sx of [-0.45, 0.45]) list.push(new THREE.BoxGeometry(0.09, h, 0.09).translate(sx, h / 2, 0.07));
  for (let y = 0.3; y < h - 0.05; y += 0.4) list.push(new THREE.BoxGeometry(0.9, 0.06, 0.06).translate(0, y, 0.07));
  const vis = merged(list), hit = new THREE.BoxGeometry(1.2, h, 0.6).translate(0, h / 2, 0.3);
  owned.push(vis, hit);
  const root = new THREE.Mesh(hit, R.hit);
  add(root, vis, R.wood);
  return { root };
}
function buildSpring() {
  const root = new THREE.Mesh(R.gSpringHit, R.hit);
  add(root, R.gSpringBase, R.springBase);
  const coil = add(root, R.gCoil, R.springCoil, 0, 0.4, 0);
  const top = add(root, R.gTop, R.springTop, 0, 0.66, 0);
  return { root, coil, top };
}
function buildBoost() {
  const root = new THREE.Mesh(R.gPadHit, R.hit);
  add(root, R.gPadBase, R.padBase);
  add(root, R.gPadTop, R.padTop, 0, 0.115, 0);
  return { root };
}
function buildSpikes(s, owned) {
  const n = Math.max(2, Math.round(s / 0.85)), step = s / n, list = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    list.push(new THREE.ConeGeometry(Math.min(0.32, step * 0.38), 0.85, 4).translate((i + 0.5) * step - s / 2, 0.575, (j + 0.5) * step - s / 2));
  }
  const vis = merged(list), base = new THREE.BoxGeometry(s, 0.15, s).translate(0, 0.075, 0), hit = new THREE.BoxGeometry(s, 1, s).translate(0, 0.5, 0);
  owned.push(vis, base, hit);
  const root = new THREE.Mesh(hit, R.hit);
  add(root, base, R.spikeBase); add(root, vis, R.spikeTip);
  return { root };
}
function buildMover(w, owned) {
  const body = new THREE.BoxGeometry(w, 0.6, w).translate(0, -0.3, 0), top = new THREE.BoxGeometry(w - 0.5, 0.03, w - 0.5);
  owned.push(body, top);
  const root = new THREE.Mesh(body, R.moverBody);
  add(root, top, R.moverTop);
  return { root };
}

// ---------- Движение частей лифта ----------
const snapshotPart = (q) => ({
  px: q.px.slice(), pz: q.pz.slice(), nd: q.nd.slice(),
  minX: q.minX, maxX: q.maxX, minZ: q.minZ, maxZ: q.maxZ, y0: q.y0, lo: q.lo, hi: q.hi, cx: q.cx, cz: q.cz,
});
function shiftPart(q, b, ox, oy, oz) {
  for (let i = 0; i < q.n; i++) {
    q.px[i] = b.px[i] + ox; q.pz[i] = b.pz[i] + oz;
    q.nd[i] = b.nd[i] + q.nx[i] * ox + q.nz[i] * oz;
  }
  q.minX = b.minX + ox; q.maxX = b.maxX + ox; q.minZ = b.minZ + oz; q.maxZ = b.maxZ + oz;
  q.y0 = b.y0 + oy; q.lo = b.lo + oy; q.hi = b.hi + oy; q.cx = b.cx + ox; q.cz = b.cz + oz;
}
function poseSpring(o) {
  const a = o.anim, lift = a > 0.85 ? -0.15 : 0.45 * Math.sin((Math.PI * (1 - a)) / 0.85);
  o.top.position.y = 0.66 + lift; o.coil.scale.y = 1 + lift * 1.5;
}

const TMP = { x: 0, z: 0, ei: 0 };

class Ents {
  constructor() {
    this.list = []; this.parts = []; this.owned = []; this.guides = []; this.guideOn = false;
    this.out = { face: null };
    this._clear();
  }
  _clear() {
    this.time = 0; this.ladder = null; this.climbing = false; this.lcool = 0;
    this.mantleT = 0; this.mantleD = [0, 0]; this.kickT = 0; this.kickD = [0, 0];
    this.bT = 0; this.bM = 1; this.bd = [0, -1]; this.sprT = 0; this.rung = 0; this.zapped = false;
  }
  get noJump() { return this.sprT > 0; } // сразу после батута прыжок не должен «перебивать» подброс

  // Собрать объекты уровня в группу. Части лифтов лежат в this.parts: main.js добавляет их к физике уровня.
  build(list, group) {
    this.owned.forEach((g) => g.dispose());
    this.owned = []; this.list = []; this.parts = []; this.guides = [];
    this._clear();
    if (!list.length) return;
    res();
    list.forEach((a, i) => {
      const [type, x, y, z, rot, q1, q2] = a, th = rot * DEG;
      const o = { type, i, x, y, z, nx: Math.sin(th), nz: Math.cos(th), ux: Math.cos(th), uz: -Math.sin(th), cool: 0, anim: 0, ox: 0, oy: 0, oz: 0 };
      let b;
      if (type === 0) { o.h = clamp(q1, 1, 24); b = buildLadder(o.h, this.owned); }
      else if (type === 1) { o.h = clamp(q1, 1, 15); o.v = Math.sqrt(2 * MOVE.GRAV * o.h); b = buildSpring(); o.top = b.top; o.coil = b.coil; }
      else if (type === 2) { o.m = clamp(q1, 1.2, 3.5); b = buildBoost(); }
      else if (type === 3) { o.s = clamp(q1, 1, 8); b = buildSpikes(o.s, this.owned); }
      else {
        o.w = clamp(q1, 2, 8); o.trav = clamp(Math.abs(q2), 1, 20); o.vert = q2 < 0;
        b = buildMover(o.w, this.owned);
        o.parts = worldParts(normPlat([x, y, z, o.w, o.w, 0, rot, 0, 0.6]));
        o.base = o.parts.map(snapshotPart);
        this.parts.push(...o.parts);
        // Линия пути лифта (видна только в редакторе)
        const A = o.trav / 2, dx = o.vert ? 0 : -o.nx * A, dy = o.vert ? A : 0, dz = o.vert ? 0 : -o.nz * A;
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x - dx, y - dy + 0.05, z - dz), new THREE.Vector3(x + dx, y + dy + 0.05, z + dz)]);
        const line = new THREE.Line(geo, R.guide);
        line.raycast = () => {}; line.visible = this.guideOn; line.frustumCulled = false;
        group.add(line); this.guides.push(line); this.owned.push(geo);
      }
      o.root = b.root;
      o.root.position.set(x, y, z); o.root.rotation.y = th; o.root.userData = { k: 'x', i };
      group.add(o.root);
      this.list.push(o);
      if (type === 1) poseSpring(o);
    });
  }

  setGuides(on) { this.guideOn = !!on; this.guides.forEach((g) => (g.visible = this.guideOn)); }

  // Начать заново: лифты в исходное положение, все состояния обнуляются
  reset() {
    this._clear();
    for (const o of this.list) {
      o.cool = 0; o.anim = 0;
      if (o.type === 4) { o.parts.forEach((q, k) => shiftPart(q, o.base[k], 0, 0, 0)); o.ox = o.oy = o.oz = 0; o.root.position.set(o.x, o.y, o.z); }
      if (o.type === 1) poseSpring(o);
    }
  }

  // Отпустить лестницу. kick — оттолкнуться от неё (прыжок)
  release(cool = 0.3, kick = false) {
    const o = this.ladder;
    if (!o) return;
    this.ladder = null; this.climbing = false; this.lcool = cool;
    if (kick) { this.kickT = 0.25; this.kickD[0] = o.nx; this.kickD[1] = o.nz; }
  }

  _mover(o, p, st) {
    const s = Math.sin((this.time * Math.PI * 2) / PERIOD) * (o.trav / 2);
    const nx = o.vert ? 0 : -o.nx * s, ny = o.vert ? s : 0, nz = o.vert ? 0 : -o.nz * s, q = o.parts[0];
    // Если игрок стоит на лифте, он едет вместе с ним
    if (st.onGround && closest(q, p.x, p.z, TMP) < 0.3 && Math.abs(p.y - topAt(q, p.x, p.z)) < 0.15) {
      p.x += nx - o.ox; p.y += ny - o.oy; p.z += nz - o.oz;
    }
    o.parts.forEach((part, k) => shiftPart(part, o.base[k], nx, ny, nz));
    o.ox = nx; o.oy = ny; o.oz = nz;
    o.root.position.set(o.x + nx, o.y + ny, o.z + nz);
  }

  // Раз в кадр, после того как main.js выставил скорость по вводу, но до физики.
  // c: { f — ввод вперёд/назад, dx, dz — направление бега (единичный вектор), len — сила ввода, mag }.
  // Меняет p и v, возвращает { face } — куда повернуть игрока (или null).
  drive(dt, p, v, st, c) {
    const out = this.out; out.face = null;
    const list = this.list;
    if (!list.length) return out;
    this.time += dt;
    if (this.lcool > 0) this.lcool -= dt;
    if (this.sprT > 0) this.sprT -= dt;
    R.tex.offset.y = (R.tex.offset.y - dt * 0.9) % 1;

    for (const o of list) {
      if (o.type === 4) this._mover(o, p, st);
      else if (o.type === 1 && o.anim > 0) { o.anim = Math.max(0, o.anim - dt * 2.5); poseSpring(o); }
    }

    for (const o of list) {
      const dx = p.x - o.x, dz = p.z - o.z;
      if (o.type === 1) { // батут
        if (o.cool > 0) o.cool -= dt;
        else if (dx * dx + dz * dz < 0.85 && p.y > o.y - 0.25 && p.y < o.y + 0.5 && v.y <= 1) {
          v.y = o.v; st.onGround = false; o.cool = 0.4; o.anim = 1; this.sprT = 0.25;
          this.release(0.3, false);
          audio.sfx('spring');
        }
      } else if (o.type === 2) { // ускоритель
        const al = dx * o.nx + dz * o.nz, lat = dx * o.ux + dz * o.uz;
        if (Math.abs(lat) < 0.95 && Math.abs(al) < 1.8 && p.y > o.y - 0.2 && p.y < o.y + 0.6) {
          if (this.bT < 0.3) audio.sfx('boost');
          this.bT = BOOST_T; this.bM = o.m; this.bd[0] = -o.nx; this.bd[1] = -o.nz;
        }
      } else if (o.type === 0 && !this.ladder && this.lcool <= 0 && c.len > 0.2) { // лестница: хватаемся, если идём к ней
        const depth = dx * o.nx + dz * o.nz, lat = dx * o.ux + dz * o.uz;
        if (depth > -0.1 && depth < 1.15 && Math.abs(lat) < 0.75 && p.y > o.y - 0.2 && p.y < o.y + o.h - 0.3 && -(c.dx * o.nx + c.dz * o.nz) > 0.3) {
          this.ladder = o; this.climbing = true; v.y = 0; this.rung = p.y;
          audio.sfx('rung');
        }
      }
    }

    // Разгон: быстрее бег, а если стоим на месте, ускоритель толкает вперёд
    if (this.bT > 0) {
      this.bT -= dt;
      const k = Math.min(1, this.bT / 0.5), m = 1 + (this.bM - 1) * k;
      v.x *= m; v.z *= m;
      if (c.mag < 0.3) { const s = MOVE.SPEED * (this.bM - 1) * 0.7 * k; v.x += this.bd[0] * s; v.z += this.bd[1] * s; }
    }

    // Лазание
    if (this.ladder) {
      const o = this.ladder, rx = p.x - o.x, rz = p.z - o.z;
      const depth = rx * o.nx + rz * o.nz, lat = rx * o.ux + rz * o.uz, k = Math.min(1, dt * 14);
      const nd = depth + (0.5 - depth) * k, nl = lat + (clamp(lat, -0.45, 0.45) - lat) * k;
      p.x = o.x + o.nx * nd + o.ux * nl; p.z = o.z + o.nz * nd + o.uz * nl;
      v.x = 0; v.z = 0;
      const f = clamp(c.f, -1, 1);
      v.y = f * CLIMB;
      out.face = Math.atan2(-o.nx, -o.nz);
      if (Math.abs(p.y - this.rung) > 0.4) { this.rung = p.y; audio.sfx('rung'); }
      if (p.y >= o.y + o.h - 0.05 && f > 0.1) { // наверху: перебрасываем игрока через край
        this.ladder = null; this.climbing = false; this.lcool = 0.5;
        this.mantleT = 0.3; this.mantleD[0] = -o.nx; this.mantleD[1] = -o.nz; v.y = 7.5;
      } else if (p.y <= o.y + 0.02 && f < -0.1) this.release(0.25, false); // внизу: слезаем
    }
    if (this.kickT > 0) { this.kickT -= dt; v.x = this.kickD[0] * 4.5; v.z = this.kickD[1] * 4.5; }
    if (this.mantleT > 0) { this.mantleT -= dt; v.x = this.mantleD[0] * 3.5; v.z = this.mantleD[1] * 3.5; }
    return out;
  }

  // Игрок задел шипы?
  deadly(p) {
    for (const o of this.list) {
      if (o.type !== 3) continue;
      const dx = p.x - o.x, dz = p.z - o.z, u = dx * o.ux + dz * o.uz, w = dx * o.nx + dz * o.nz, hs = o.s / 2 + 0.12;
      if (Math.abs(u) < hs && Math.abs(w) < hs && p.y < o.y + 0.7 && p.y + PHYS.H > o.y) { this.zapped = true; return true; }
    }
    return false;
  }
}

export const createObjects = () => new Ents();
