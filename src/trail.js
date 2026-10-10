// src/trail.js — «нить ветра»: след прошлого прохождения уровня в виде светящейся нити с вихрем воздуха.
//
// Как это работает:
//   • Пока игрок бежит, раз в 0.1 с запоминается позиция (begin / record).
//   • Когда игрок доходит до звезды, путь сохраняется для этого уровня (finish) — в localStorage,
//     хранятся последние 10 уровней. Сорвался вниз — попытка не записывается.
//   • Путь сглаживается кривой Catmull-Rom. Вдоль неё строятся три линии: сама нить и две спирали,
//     обвивающие её. Чем быстрее бежал игрок, тем шире вихрь.
//   • По нити бегут штрихи и яркая «комета» со скоростью бега, а при появлении нить разматывается от старта.
// Рисуется линиями в 1 пиксель низкого разрешения игры, так что выглядит «пиксельно» в духе N64.

import * as THREE from 'three';

const DT = 0.1;        // как часто записываем позицию, с
const Q = 20;          // точность хранения: 20 единиц на метр (5 см)
const MAX_PTS = 3000;  // максимум точек в записи (5 минут)
const SUB = 6;         // сколько точек сглаженной кривой на одну записанную
const KEEP = 10;       // сколько уровней помним
const KEY = 'n64parkour.trails.v1';
const PITCH = 2.6;     // длина одного витка вихря, м
const BODY = 0.8;      // высота нити над ногами игрока

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
uniform float uTime, uLen, uReveal, uAlpha, uDash, uDir;
uniform vec3 uA, uB;
varying float vS;
varying float vW;
void main() {
  float front = uReveal * (uLen + 3.0);
  float rv = 1.0 - smoothstep(front - 2.5, front, vS);
  if (rv <= 0.01) discard;
  float f = fract(vS * uDash - uTime * 0.8 * uDir);
  float dash = smoothstep(0.0, 0.12, f) * (1.0 - smoothstep(0.5, 0.7, f));
  float head = mod(uTime * 8.0, uLen + 24.0);
  float d = head - vS;
  float pulse = d > 0.0 ? exp(-d / 4.0) : 0.0;
  vec3 col = mix(uA, uB, clamp(vS / uLen, 0.0, 1.0));
  col = mix(col, vec3(1.0), pulse * 0.8);
  float a = uAlpha * rv * mix(0.35, 1.0, dash) * (0.55 + 0.45 * vW) + pulse * 0.7 * rv;
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

// flat — целые числа [x, y, z, ...] в единицах 1/Q метра. Возвращает { cen, strands: [pos, pos], S, W, L } или null.
function buildData(flat) {
  const n0 = flat.length / 3;
  const raw = [];
  for (let i = 0; i < n0; i++) raw.push(new THREE.Vector3(flat[i * 3] / Q, flat[i * 3 + 1] / Q, flat[i * 3 + 2] / Q));
  const curve = new THREE.CatmullRomCurve3(raw, false, 'centripetal');
  const n = (n0 - 1) * SUB + 1;
  const P = new Array(n), S = new Float32Array(n), sp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    P[i] = curve.getPoint(i / (n - 1));
    if (i) { const d = P[i].distanceTo(P[i - 1]); S[i] = S[i - 1] + d; sp[i] = d / (DT / SUB); }
  }
  sp[0] = sp[1];
  const L = S[n - 1];
  if (!(L > 1)) return null;
  // скорость (0..1) сглаживаем: от неё зависит ширина вихря и яркость
  let W = new Float32Array(n);
  for (let i = 0; i < n; i++) W[i] = Math.min(1, sp[i] / 9);
  W = blur(blur(W, SUB), SUB);

  const up = new THREE.Vector3(0, 1, 0), ex = new THREE.Vector3(1, 0, 0);
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  const cen = new Float32Array(n * 3), s1 = new Float32Array(n * 3), s2 = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    T.subVectors(P[Math.min(n - 1, i + 1)], P[Math.max(0, i - 1)]);
    if (T.lengthSq() < 1e-12) T.set(0, 0, -1); else T.normalize();
    if (i === 0) N.crossVectors(Math.abs(T.y) < 0.9 ? up : ex, T).normalize();
    else {
      N.addScaledVector(T, -N.dot(T)); // перенос рамки вдоль кривой без закручивания
      if (N.lengthSq() < 1e-8) N.crossVectors(up, T);
      N.normalize();
    }
    B.crossVectors(T, N);
    const edge = Math.max(0, Math.min(1, S[i] / 2.5, (L - S[i]) / 2.5));
    const r = (0.12 + 0.34 * W[i]) * (0.85 + 0.15 * Math.sin(S[i] * 0.9)) * (0.25 + 0.75 * edge);
    const ph = (S[i] * Math.PI * 2) / PITCH, c = Math.cos(ph) * r, s = Math.sin(ph) * r;
    const o = i * 3, p = P[i];
    cen[o] = p.x; cen[o + 1] = p.y; cen[o + 2] = p.z;
    s1[o] = p.x + N.x * c + B.x * s; s1[o + 1] = p.y + N.y * c + B.y * s; s1[o + 2] = p.z + N.z * c + B.z * s;
    s2[o] = p.x - N.x * c - B.x * s; s2[o + 1] = p.y - N.y * c - B.y * s; s2[o + 2] = p.z - N.z * c - B.z * s;
  }
  return { cen, strands: [s1, s2], S, W, L };
}

function mkLine(pos, S, W, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aS', new THREE.BufferAttribute(S, 1));
  g.setAttribute('aW', new THREE.BufferAttribute(W, 1));
  const l = new THREE.Line(g, mat);
  l.frustumCulled = false; l.renderOrder = 4;
  return l;
}

export function createTrail(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  const U = { uTime: { value: 0 }, uLen: { value: 1 }, uReveal: { value: 1 } }; // общие для трёх линий
  const mk = (dash, dir, a, b, alpha) => new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    uniforms: { ...U, uDash: { value: dash }, uDir: { value: dir }, uAlpha: { value: alpha }, uA: { value: new THREE.Color(a) }, uB: { value: new THREE.Color(b) } },
  });
  const matCen = mk(0.35, 1, 0x3fd0ff, 0xb48cff, 0.95);
  const matS1 = mk(0.6, 1, 0x9be8ff, 0xe0c8ff, 0.75);
  const matS2 = mk(0.6, 1.3, 0x9be8ff, 0xe0c8ff, 0.75);

  let has = false, shownId = null, reveal = 1, revealT = 2, buf = [], acc = 0;

  function clear() {
    for (const o of [...group.children]) { group.remove(o); o.geometry.dispose(); }
    has = false;
  }
  function showFlat(flat) {
    clear();
    if (!flat) return;
    try {
      const d = buildData(flat);
      if (!d) return;
      group.add(mkLine(d.cen, d.S, d.W, matCen), mkLine(d.strands[0], d.S, d.W, matS1), mkLine(d.strands[1], d.S, d.W, matS2));
      U.uLen.value = d.L; reveal = 0; revealT = Math.min(5, Math.max(1.5, d.L / 40)); has = true;
    } catch (e) { console.warn('Не удалось построить нить:', e); clear(); }
  }
  function push(p) {
    if (buf.length >= MAX_PTS * 3) return;
    const x = p.x, y = p.y + BODY, z = p.z, n = buf.length;
    if (n >= 3) { const dx = x - buf[n - 3], dy = y - buf[n - 2], dz = z - buf[n - 1]; if (dx * dx + dy * dy + dz * dz < 0.0016) return; }
    buf.push(x, y, z);
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

    // Начало новой попытки
    begin(p) { buf = []; acc = 0; push(p); },

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
      return first;
    },

    // dt = 0 замораживает появление (например, в меню); visible — показывать ли нить сейчас
    update(dt, t, visible) {
      group.visible = has && visible;
      if (!group.visible) return;
      U.uTime.value = t;
      if (reveal < 1) reveal = Math.min(1, reveal + dt / revealT);
      U.uReveal.value = reveal;
    },
  };
}
