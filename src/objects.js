// src/objects.js — интерактивные объекты уровня: лестницы, батуты и лифты.
//
// Объект в уровне: [тип, x, y, z, поворот°, параметр1, параметр2, параметр3?]
//   y — высота поверхности, на которой стоит объект. Поворот 0: «лицо» объекта смотрит в +Z, вперёд = -Z.
//   Номера типов остаются прежними (0, 1, 4), поэтому старые уровни и ссылки продолжают работать.
//   Ускорители (2) и шипы (3) убраны: такие объекты при загрузке уровня просто выбрасываются.
//
//   0 лестница — п1: высота, п2: ширина (0 — как раньше, 1.2 м).
//                Подойдите к ней с ЛЮБОЙ стороны (идя в её сторону): игрок хватается.
//                W/S — вверх/вниз, A/D (или стик) — влево/вправо вдоль лестницы, Пробел — спрыгнуть от неё.
//                На самом верху W перебрасывает игрока через край.
//   1 батут    — п1: высота подброса (м). Подбрасывает при касании сверху.
//   4 лифт     — п1: размер платформы, п2: длина пути (м), п3: наклон пути в градусах
//                (0 — горизонтально, 90 — вверх, -90 — вниз, любое число между — по диагонали).
//                Направление по горизонтали задаётся поворотом объекта (любой угол).
//                Старый формат из 7 чисел: п2 < 0 означало «вверх-вниз», п2 > 0 — «вдоль».
//                Платформа едет, и игрок едет вместе с ней.
//
// Модуль не знает про main.js: main.js вызывает build() при сборке уровня и drive() каждый кадр.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DEG, MOVE, normPlat, worldParts, closest, topAt } from './shapes.js';
import { audio } from './audio.js';

export const OBJ_MAX = 120;
export const OBJ_TYPES = ['ladder', 'spring', null, null, 'mover']; // индекс = тип (2 и 3 — бывшие ускоритель и шипы)
export const OBJ_ALLOWED = [0, 1, 4];                               // какие типы ещё существуют
export const OBJ_DEFS = {
  ladder: { type: 0, p1: 6, p2: 2.4, p3: 0, hint: 'Лестница: «Высота» и «Ширина». Ставьте у стены (R — повернуть). Забираться можно с любой стороны, по ней можно ходить влево-вправо' },
  spring: { type: 1, p1: 6, p2: 0, p3: 0, hint: 'Батут: «Высота подброса» — на сколько метров он подбросит' },
  mover: { type: 4, p1: 4, p2: 8, p3: 0, hint: 'Лифт: «Направление» — любой угол (R или поле «Поворот»), «Длина пути», «Наклон пути»: 0° вбок, 90° вверх, -90° вниз. Голубая линия — его путь' },
};
export const OBJ_TOOL = Object.fromEntries(Object.entries(OBJ_DEFS).map(([k, d]) => [k, d.type]));
export const OBJ_TOOL_LIST = [['ladder', 'Лестница'], ['spring', 'Батут'], ['mover', 'Лифт']];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const CLIMB = 4.2;   // скорость лазания вверх-вниз, м/с
const SIDE = 3.2;    // скорость лазания влево-вправо, м/с
const PERIOD = 6;    // период лифта, с

const ladderW = (q) => (q > 0 ? clamp(q, 1, 12) : 1.2);

// Единичный вектор пути лифта: rot — поворот вокруг вертикали (любой), pitch — наклон вверх (-90..90)
export function liftDir(rot, pitch) {
  const th = rot * DEG, pt = clamp(pitch, -90, 90) * DEG, c = Math.cos(pt);
  return [-Math.sin(th) * c, Math.sin(pt), -Math.cos(th) * c];
}
// Длина и наклон пути лифта; поддерживает старый формат из 7 чисел
function liftCfg(a) {
  const q2 = a[6], q3 = a[7];
  return { trav: clamp(Math.abs(q2), 1, 40), pitch: q3 === undefined ? (q2 < 0 ? 90 : 0) : clamp(q3, -90, 90) };
}

// Размер «призрака» объекта в редакторе: [ширина, высота, глубина, смещение центра вверх] или null
export function objGhost(tool, p1, p2) {
  switch (tool) {
    case 'ladder': { const h = clamp(p1, 1, 24); return [ladderW(p2) + 0.3, h, 0.9, h / 2]; }
    case 'spring': return [1.6, 0.8, 1.6, 0.4];
    case 'mover': { const w = clamp(p1, 2, 8); return [w, 0.6, w, -0.3]; }
    default: return null;
  }
}

// Готовый уровень, где есть всё: лестница -> батут -> лифт -> звезда
export function demoLevel() {
  return {
    id: 'objects', name: 'Полигон объектов',
    plats: [[0, 0, 0, 8, 8], [0, 0, -13, 6, 10], [0, 6, -21, 6, 6, 0, 0, 0, 6], [0, 9, -31, 5, 5], [0, 9, -41, 5, 10], [0, 9, -62, 6, 6]],
    coins: [[0, 2, -8], [0, 7.3, -21], [0, 10.3, -31], [0, 10.3, -52], [0, 10.3, -62]],
    objs: [
      [0, 0, 0, -18, 0, 6, 2.4],     // широкая лестница на башню (можно ходить влево-вправо)
      [1, 0, 6, -22.5, 0, 6, 0],     // батут на верхней площадке
      [4, 0, 9, -52, 0, 4, 8, 0],    // лифт, едет вперёд-назад
    ],
    shapes: [], req: false, theme: 0, goal: [0, 10.6, -62], start: [0, 0, 0],
  };
}

// ---------- Общие материалы и геометрии (создаются один раз) ----------
let R = null;
function res() {
  if (R) return R;
  const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  R = {
    hit: new THREE.MeshBasicMaterial({ visible: false }), // невидимая «коробка» для выбора мышью (ластик, подсветка)
    wood: lam(0xb07a3c, { emissive: 0x1e1206, side: THREE.DoubleSide }),
    springBase: lam(0x444a55), springCoil: lam(0xcfd6dd), springTop: lam(0xe8453c, { emissive: 0x3a0a08 }),
    moverBody: lam(0x4a6fa5), moverTop: lam(0x9fd0ff, { emissive: 0x1a3350 }),
    guide: new THREE.LineBasicMaterial({ color: 0x66ccff }),
    gSpringBase: new THREE.CylinderGeometry(0.8, 0.9, 0.2, 8).translate(0, 0.1, 0),
    gCoil: new THREE.CylinderGeometry(0.28, 0.28, 0.4, 6),
    gTop: new THREE.CylinderGeometry(0.8, 0.8, 0.12, 8),
    gSpringHit: new THREE.BoxGeometry(1.6, 0.8, 1.6).translate(0, 0.4, 0),
  };
  return R;
}

const add = (parent, geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
const merged = (list) => { const g = mergeGeometries(list); list.forEach((q) => q.dispose()); return g; };

// ---------- Сборка моделей ----------
function buildLadder(h, w, owned) {
  const list = [], mid = Math.max(0, Math.ceil(w / 2.4) - 1), rails = [-w / 2, w / 2];
  for (let i = 1; i <= mid; i++) rails.push(-w / 2 + (w * i) / (mid + 1)); // у широкой лестницы есть промежуточные стойки
  for (const sx of rails) list.push(new THREE.BoxGeometry(0.09, h, 0.09).translate(sx, h / 2, 0.07));
  for (let y = 0.3; y < h - 0.05; y += 0.4) list.push(new THREE.BoxGeometry(w, 0.06, 0.06).translate(0, y, 0.07));
  // «коробка» для выбора мышью симметрична: лестница одинаково цепляется с обеих сторон
  const vis = merged(list), hit = new THREE.BoxGeometry(w + 0.3, h, 0.9).translate(0, h / 2, 0.07);
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
    this.time = 0; this.ladder = null; this.lside = 1; this.climbing = false; this.lcool = 0;
    this.mantleT = 0; this.mantleD = [0, 0]; this.kickT = 0; this.kickD = [0, 0];
    this.sprT = 0; this.rung = 0;
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
      if (type === 0) { o.h = clamp(q1, 1, 24); o.w = ladderW(q2); b = buildLadder(o.h, o.w, this.owned); }
      else if (type === 1) { o.h = clamp(q1, 1, 15); o.v = Math.sqrt(2 * MOVE.GRAV * o.h); b = buildSpring(); o.top = b.top; o.coil = b.coil; }
      else {
        const cfg = liftCfg(a);
        o.w = clamp(q1, 2, 8); o.trav = cfg.trav; o.dir = liftDir(rot, cfg.pitch);
        b = buildMover(o.w, this.owned);
        o.parts = worldParts(normPlat([x, y, z, o.w, o.w, 0, rot, 0, 0.6]));
        o.base = o.parts.map(snapshotPart);
        this.parts.push(...o.parts);
        // Линия пути лифта (видна только в редакторе)
        const A = o.trav / 2, d = o.dir;
        const geo = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(x - d[0] * A, y - d[1] * A + 0.05, z - d[2] * A),
          new THREE.Vector3(x + d[0] * A, y + d[1] * A + 0.05, z + d[2] * A),
        ]);
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

  // Отпустить лестницу. kick — оттолкнуться от неё (прыжок): в сторону, с которой игрок на ней висит
  release(cool = 0.3, kick = false) {
    const o = this.ladder;
    if (!o) return;
    const s = this.lside;
    this.ladder = null; this.climbing = false; this.lcool = cool;
    if (kick) { this.kickT = 0.25; this.kickD[0] = o.nx * s; this.kickD[1] = o.nz * s; }
  }

  _mover(o, p, st) {
    const s = Math.sin((this.time * Math.PI * 2) / PERIOD) * (o.trav / 2);
    const nx = o.dir[0] * s, ny = o.dir[1] * s, nz = o.dir[2] * s, q = o.parts[0];
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
      } else if (o.type === 0 && !this.ladder && this.lcool <= 0 && c.len > 0.2) {
        // Лестница: хватаемся с любой стороны, если идём к ней. s = +1 — игрок со стороны «лица», -1 — с обратной
        const depth = dx * o.nx + dz * o.nz, lat = dx * o.ux + dz * o.uz, s = depth >= 0 ? 1 : -1;
        if (Math.abs(depth) < 1.15 && Math.abs(lat) < o.w / 2 + 0.3 && p.y > o.y - 0.2 && p.y < o.y + o.h - 0.3
          && -s * (c.dx * o.nx + c.dz * o.nz) > 0.3) {
          this.ladder = o; this.lside = s; this.climbing = true; v.y = 0; this.rung = p.y;
          audio.sfx('rung');
        }
      }
    }

    // Лазание
    if (this.ladder) {
      const o = this.ladder, s = this.lside, rx = p.x - o.x, rz = p.z - o.z;
      const depth = rx * o.nx + rz * o.nz, lat = rx * o.ux + rz * o.uz, k = Math.min(1, dt * 14);
      const lim = Math.max(0.1, o.w / 2 - 0.1);
      // ввод влево-вправо: движение по камере, спроецированное на лестницу
      const side = clamp((c.dx * o.ux + c.dz * o.uz) * c.mag, -1, 1);
      const nd = depth + (0.5 * s - depth) * k, want = lat + side * SIDE * dt, nl = want + (clamp(want, -lim, lim) - want) * k;
      p.x = o.x + o.nx * nd + o.ux * nl; p.z = o.z + o.nz * nd + o.uz * nl;
      v.x = 0; v.z = 0;
      const f = clamp(c.f, -1, 1);
      v.y = f * CLIMB;
      out.face = Math.atan2(-o.nx * s, -o.nz * s);
      if (Math.abs(p.y - this.rung) > 0.4) { this.rung = p.y; audio.sfx('rung'); }
      if (p.y >= o.y + o.h - 0.05 && f > 0.1) { // наверху: перебрасываем игрока через край
        this.ladder = null; this.climbing = false; this.lcool = 0.5;
        this.mantleT = 0.3; this.mantleD[0] = -o.nx * s; this.mantleD[1] = -o.nz * s; v.y = 7.5;
      } else if (p.y <= o.y + 0.02 && f < -0.1) this.release(0.25, false); // внизу: слезаем
    }
    if (this.kickT > 0) { this.kickT -= dt; v.x = this.kickD[0] * 4.5; v.z = this.kickD[1] * 4.5; }
    if (this.mantleT > 0) { this.mantleT -= dt; v.x = this.mantleD[0] * 3.5; v.z = this.mantleD[1] * 3.5; }
    return out;
  }
}

export const createObjects = () => new Ents();
