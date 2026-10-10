// src/trail.js — «нить ветра»: одна светящаяся полоска, повторяющая путь прошлого прохождения уровня.
//
// Как это работает:
//   • Пока игрок бежит, раз в 0.1 с запоминается позиция (begin / record).
//   • Когда игрок доходит до звезды, путь сохраняется для этого уровня (finish) — в localStorage,
//     хранятся последние 10 уровней. Сорвался вниз — попытка не записывается.
//   • Путь сглаживается кривой Catmull-Rom и рисуется одной линией (1 пиксель низкого разрешения игры, в духе N64).
//   • По нити медленно ползут штрихи, а вдоль неё плывёт яркая «комета». Комета неторопливая (BASE),
//     но догнать её нельзя: игра следит, где игрок на нити, и если он подбирается ближе LEAD метров,
//     комета ускоряется и остаётся впереди. Так же нить при появлении разматывается не медленнее, чем бежит игрок.

import * as THREE from 'three';

const DT = 0.1;        // как часто записываем позицию, с
const Q = 20;          // точность хранения: 20 единиц на метр (5 см)
const MAX_PTS = 3000;  // максимум точек в записи (5 минут)
const SUB = 6;         // сколько точек сглаженной кривой на одну записанную
const KEEP = 10;       // сколько уровней помним
const KEY = 'n64parkour.trails.v1';
const BODY = 0.8;      // высота нити над ногами игрока

const BASE = 7.6;      // скорость кометы, м/с: чуть быстрее бега игрока (7), поэтому догнать её нельзя
const LEAD = 9;        // на сколько метров по нити комета всегда впереди игрока
const ALPHA = 0.38;    // общая прозрачность нити (1 — непрозрачная)
const FLOW = 0.35;     // скорость бегущих по нити штрихов (штрихов в секунду; при плотности 0.35 это ~1 м/с)

// ---------- Шейдер ----------
const VERT = `
attribute float aS;
attribute float aW;
varying float vS;
varying float vW;
void main() {
  vS = aS; vW = aW;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
uniform float uTime, uLen, uFront, uComet, uAlpha;
uniform vec3 uA, uB;
varying float vS;
varying float vW;
void main() {
  float rv = 1.0 - smoothstep(uFront - 2.5, uFront, vS);
  if (rv <= 0.01) discard;
  float f = fract(vS * ${0.35} - uTime * ${FLOW});
  float dash = smoothstep(0.0, 0.12, f) * (1.0 - smoothstep(0.5, 0.7, f));
  float d = uComet - vS;
  float pulse = d > 0.0 ? exp(-d / 4.0) : 0.0;
  vec3 col = mix(uA, uB, clamp(vS / uLen, 0.0, 1.0));
  col = mix(col, vec3(1.0), pulse * 0.8);
  float a = uAlpha * rv * mix(0.35, 1.0, dash) * (0.6 + 0.4 * vW) + pulse * uAlpha * 0.45 * rv;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  #include <colorspace_fragment>
}`;

// ---------- Хранилище ----------
let store = null;
function load() {
  if (store) return store;
  store = { order: [], d: {} };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && Array.isArray(s.order) && s.d && typeof s.d === 'object') store = s;
  } catch { /* пусто */ }
  return store;
}
function persist() {
  for (let tries = 0; tries < 3; tries++) {
    try { localStorage.setItem(KEY, JSON.stringify(store)); return; }
    catch { // не хватило места: забываем самый старый уровень
      const old = store.order.shift();
      if (!old) return;
      delete store.d[old];
    }
  }
}
function put(id, flat) {
  const s = load();
  s.order = s.order.filter((x) => x !== id);
  s.order.push(id);
  s.d[id] = flat;
  while (s.order.length > KEEP) delete s.d[s.order.shift()];
  persist();
}
function get(id) {
  const a = load().d[id];
  return Array.isArray(a) && a.length >= 12 && a.length % 3 === 0 && a.every(Number.isFinite) ? a : null;
}

// ---------- Геометрия ----------
function blur(a, r) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(a.length - 1, i + r); j++) { s += a[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

// flat — целые числа [x, y, z, ...] в единицах 1/Q метра. Возвращает { pos, S, W, L, n } или null.
// S — длина нити от старта до каждой точки, W — скорость бега в этой точке (0..1): быстрые участки ярче.
function buildData(flat) {
  const n0 = flat.length / 3;
  const raw = [];
  for (let i = 0; i < n0; i++) raw.push(new THREE.Vector3(flat[i * 3] / Q, flat[i * 3 + 1] / Q, flat[i * 3 + 2] / Q));
  const curve = new THREE.CatmullRomCurve3(raw, false, 'centripetal');
  const n = (n0 - 1) * SUB + 1;
  const pos = new Float32Array(n * 3), S = new Float32Array(n), sp = new Float32Array(n);
  let prev = null;
  for (let i = 0; i < n; i++) {
    const p = curve.getPoint(i / (n - 1));
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    if (prev) { const d = p.distanceTo(prev); S[i] = S[i - 1] + d; sp[i] = d / (DT / SUB); }
    prev = p;
  }
  sp[0] = sp[1];
  const L = S[n - 1];
  if (!(L > 1)) return null;
  let W = new Float32Array(n);
  for (let i = 0; i < n; i++) W[i] = Math.min(1, sp[i] / 9);
  W = blur(blur(W, SUB), SUB);
  return { pos, S, W, L, n };
}

export function createTrail(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  const U = { uTime: { value: 0 }, uLen: { value: 1 }, uFront: { value: 0 }, uComet: { value: -100 } };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    uniforms: { ...U, uAlpha: { value: ALPHA }, uA: { value: new THREE.Color(0x3fd0ff) }, uB: { value: new THREE.Color(0xb48cff) } },
  });

  let data = null, has = false, shownId = null;
  let reveal = 1, revealT = 2;           // разматывание нити при появлении
  let comet = 0, chase = false;          // позиция кометы по нити, м; chase — идёт попытка, комета не даёт себя догнать
  let idx = 0, prog = 0;                 // где сейчас игрок на нити: номер точки и расстояние от старта, м
  let buf = [], acc = 0;

  function clear() {
    for (const o of [...group.children]) { group.remove(o); o.geometry.dispose(); }
    has = false; data = null;
  }
  function showFlat(flat) {
    clear();
    if (!flat) return;
    try {
      const d = buildData(flat);
      if (!d) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
      g.setAttribute('aS', new THREE.BufferAttribute(d.S, 1));
      g.setAttribute('aW', new THREE.BufferAttribute(d.W, 1));
      const line = new THREE.Line(g, mat);
      line.frustumCulled = false; line.renderOrder = 4;
      group.add(line);
      data = d; has = true;
      U.uLen.value = d.L; reveal = 0; revealT = Math.min(5, Math.max(1.5, d.L / 40));
      idx = 0; prog = 0; comet = LEAD;
    } catch (e) { console.warn('Не удалось построить нить:', e); clear(); }
  }
  function push(p) {
    if (buf.length >= MAX_PTS * 3) return;
    const x = p.x, y = p.y + BODY, z = p.z, n = buf.length;
    if (n >= 3) { const dx = x - buf[n - 3], dy = y - buf[n - 2], dz = z - buf[n - 1]; if (dx * dx + dy * dy + dz * dz < 0.0016) return; }
    buf.push(x, y, z);
  }

  // Ближайшая к точке (x, y, z) точка нити среди i0..i1; возвращает номер, квадрат расстояния кладёт в bestD
  let bestD = 0;
  function nearest(x, y, z, i0, i1) {
    const a = data.pos;
    let best = -1; bestD = Infinity;
    for (let i = i0; i <= i1; i++) {
      const dx = a[i * 3] - x, dy = a[i * 3 + 1] - y, dz = a[i * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  // Где игрок на нити: ищем рядом с прошлым положением, а если потерялись (другой маршрут) — по всей нити
  function track(pos) {
    const x = pos.x, y = pos.y + BODY, z = pos.z;
    let b = nearest(x, y, z, Math.max(0, idx - 60), Math.min(data.n - 1, idx + 400));
    if (bestD > 36) { const g = nearest(x, y, z, 0, data.n - 1); if (bestD < 36) b = g; else b = -1; }
    if (b >= 0) { idx = b; prog = data.S[b]; }
  }

  return {
    // Всё, что надо прятать при расчёте SSAO
    objects: [group],

    // Показать нить сохранённого прохождения этого уровня (null — спрятать).
    // Если нить та же, что уже показана, ничего не перестраиваем и анимацию появления не повторяем.
    show(id) {
      if (id === shownId) return;
      shownId = id;
      showFlat(id ? get(id) : null);
    },

    // Начало новой попытки: пишем путь, а комета с этого момента держится впереди игрока
    begin(p) {
      buf = []; acc = 0; push(p);
      chase = true; idx = 0; prog = 0; comet = LEAD;
    },

    // Раз за кадр, пока идёт попытка
    record(dt, p) {
      acc += dt;
      if (acc < DT) return;
      acc = acc > 3 * DT ? 0 : acc - DT;
      push(p);
    },

    // Дошли до звезды: сохраняем путь и сразу показываем его. Возвращает true, если нить у уровня появилась впервые.
    finish(id) {
      if (buf.length < 12) return false;
      const first = !get(id), flat = buf.map((v) => Math.round(v * Q));
      put(id, flat);
      shownId = id;
      showFlat(flat);
      chase = false; comet = 0; // на экране победы комета просто бегает по нити по кругу
      return first;
    },

    // dt = 0 замораживает анимацию (например, в меню); visible — показывать ли нить; pos — позиция игрока (ноги)
    update(dt, t, visible, pos) {
      group.visible = has && visible;
      if (!group.visible) return;
      const L = data.L;
      U.uTime.value = t;
      if (chase && pos) track(pos);

      comet += BASE * dt;
      if (chase) {
        const target = prog + LEAD;
        if (comet < target) comet += (target - comet) * Math.min(1, dt * 6); // игрок подобрался — комета уходит вперёд
        if (comet > L + 20) comet = target < L ? target : L + 20;            // долетела до конца: появляется снова впереди игрока
      } else if (comet > L + 20) comet = 0;
      U.uComet.value = comet;

      if (reveal < 1) reveal = Math.min(1, reveal + dt / revealT);
      let front = reveal * (L + 3);
      if (chase) front = Math.max(front, prog + LEAD + 15); // нить не должна «не успевать» за игроком
      U.uFront.value = front;
    },
  };
}
