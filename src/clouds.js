// src/clouds.js — объёмные облака (рэймарчинг по облачным слоям), в духе Volumetric Cloud из Unreal Engine 5.
//
// Как это устроено и почему это быстро:
//   • Свой холст. Игра рисуется в 240 строк (стиль N64), облака рисуются отдельным холстом поверх неё в своём
//     разрешении и сглаживаются браузером. Платформы закрывают облака через карту глубины (в разрешении игры):
//     луч облака останавливается на платформе.
//   • Параметры облаков считает процессор, а не видеокарта. Мир разбит на ячейки, в каждой живёт одно облако.
//     Раз в 0.1 с процессор пересчитывает облака вокруг камеры (16x16 ячеек на слой) и кладёт в три маленькие
//     текстуры. Видеокарта на каждом шаге луча только читает 4 ячейки из текстуры, без хешей и тригонометрии.
//   • Разрешение облаков привязано к разрешению игры (настройка «Разрешение»): холст в 1.5 раза чётче кадра игры,
//     от 360 до 540 строк (выше нельзя: цена растёт вместе с числом пикселей). Старая автоподстройка по FPS (холст сам уменьшался до 144 строк, из-за чего облака
//     становились очень пиксельными) включается только адресом ?clouds=auto.
//   • Дешёвый свет. Три-четыре пробы к солнцу, фаза рассеяния считается один раз на луч, вдали мелкая лепка и свет
//     для почти прозрачных точек пропускаются, шаги луча растут с расстоянием.
//   • В меню облака обновляются в четверть частоты кадров (под полупрозрачным меню этого не видно).
//
// Интерфейс для main.js:
//   createClouds(scene, opts) -> { objects, setLook, setBands, setWeather, setResolution, setOccHeight, update, render }
//   opts: count/high — качество; height — потолок разрешения облаков (строк); occHeight — строк у игры (RES_H);
//         maxDist — дальность, м; auto:false — без автоподстройки; parent — куда добавить холст (по умолчанию #game).
//   setOccHeight(строк) — сообщить облакам, сколько строк у основного кадра игры (меняется в настройках «Разрешение»):
//         карта глубины облаков должна быть ровно такого же размера, как кадр игры.
//   markOccluder(obj) — пометить объект как «закрывающий облака» (необязательно: непрозрачные меши находятся сами).
//
// Адрес игры с параметрами: ?clouds=info (панель состояния), ?clouds=debug (розовый экран), ?clouds=depth (карта глубины),
// ?clouds=nodepth (без учёта платформ), ?clouds=auto (старая автоподстройка разрешения облаков по FPS).

import * as THREE from 'three';

export const OCC_LAYER = 1;
export function markOccluder(obj) { obj.traverse((o) => { if (o.isMesh) o.layers.enable(OCC_LAYER); }); }

const TOON_LEVELS = 0;               // 0 — плавный тон; 4…6 — ступенчатый «мультяшный»
const WIND_A = Math.atan2(1.2, 3.4); // базовое направление ветра (рад, в плоскости XZ)
const WIND_V = 3.6;                  // базовая скорость ветра, м/с
const FOCUS_DIST = 8.7;              // расстояние камера → игрок в третьем лице
const NC = 16;                       // ячеек по каждой оси в таблице вокруг камеры (степень двойки)

// Три слоя. C — размер ячейки сетки, м (в каждой ячейке живёт одно облако); szr — радиус облака в долях C;
// st — максимальная вытянутость по ветру; tk — толщина в долях радиуса; wind — во сколько раз слой быстрее базового ветра.
// Ограничения (чтобы облако не вылезало за соседние ячейки): szr[1] * 1.35 <= 0.66.
const LAYERS = [
  { C: 280, szr: [0.30, 0.46], st: 1.5, tk: [0.10, 0.20], wind: 0.8 }, // море облаков под уровнем
  { C: 260, szr: [0.28, 0.46], st: 1.4, tk: [0.30, 0.60], wind: 1.0 }, // облака вокруг платформ
  { C: 330, szr: [0.24, 0.40], st: 1.7, tk: [0.22, 0.42], wind: 1.3 }, // высокие облака
];
// Максимальная высота облака над основанием (с запасом): по ней считается потолок слоя
const HMAX = LAYERS.map((L, i) => 1.2 * L.C * L.szr[1] * L.tk[1] * (i === 0 ? 1.35 : 1));

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const approach = (x, to, d) => (x < to ? Math.min(to, x + d) : Math.max(to, x - d));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ── Хеш для ячеек (на процессоре) ──────────────────────────────
function pcg(x, y, z, out) {
  x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
  y = (Math.imul(y, 1664525) + 1013904223) >>> 0;
  z = (Math.imul(z, 1664525) + 1013904223) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0; y = (y + Math.imul(z, x)) >>> 0; z = (z + Math.imul(x, y)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0; y = (y ^ (y >>> 16)) >>> 0; z = (z ^ (z >>> 16)) >>> 0;
  x = (x + Math.imul(y, z)) >>> 0; y = (y + Math.imul(z, x)) >>> 0; z = (z + Math.imul(x, y)) >>> 0;
  out[0] = x / 4294967296; out[1] = y / 4294967296; out[2] = z / 4294967296;
}

// ── 3D-шум (создаётся один раз) ────────────────────────────────
// Бесшовный. R — гладкий, G — крупная кучевая лепка (Вороной 3x3x3), B — средняя (6x6x6), A — мелкая (12x12x12).
function makeNoise3D(N = 32) {
  let s = 20261104;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const sm = (t) => t * t * (3 - 2 * t);
  const lattice = (P) => Float32Array.from({ length: P * P * P }, rnd);
  const vnoise = (A, P, u, v, w) => {
    const x = u * P, y = v * P, z = w * P;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = sm(x - xi), fy = sm(y - yi), fz = sm(z - zi);
    const x1 = (xi + 1) % P, y1 = (yi + 1) % P, z1 = (zi + 1) % P;
    const at = (a, b, c) => A[(c * P + b) * P + a];
    const f = (c) => lerp(lerp(at(xi, yi, c), at(x1, yi, c), fx), lerp(at(xi, y1, c), at(x1, y1, c), fx), fy);
    return lerp(f(zi), f(z1), fz);
  };
  const worleyPts = (K) => Float32Array.from({ length: K * K * K * 3 }, rnd);
  const worley = (pts, K, u, v, w) => {
    const x = u * K, y = v * K, z = w * K;
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const o = ((((cz + dz + K) % K) * K + ((cy + dy + K) % K)) * K + ((cx + dx + K) % K)) * 3;
      const ex = cx + dx + pts[o] - x, ey = cy + dy + pts[o + 1] - y, ez = cz + dz + pts[o + 2] - z;
      best = Math.min(best, ex * ex + ey * ey + ez * ez);
    }
    return Math.sqrt(best);
  };
  const A4 = lattice(4), A8 = lattice(8), A16 = lattice(16);
  const W3 = worleyPts(3), W6 = worleyPts(6), W12 = worleyPts(12);
  const q = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  const data = new Uint8Array(N * N * N * 4);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = (x + 0.5) / N, v = (y + 0.5) / N, w = (z + 0.5) / N, o = ((z * N + y) * N + x) * 4;
    data[o] = q(vnoise(A4, 4, u, v, w) * 0.5 + vnoise(A8, 8, u, v, w) * 0.3 + vnoise(A16, 16, u, v, w) * 0.2);
    data[o + 1] = q(1 - worley(W3, 3, u, v, w));
    data[o + 2] = q(1 - worley(W6, 6, u, v, w));
    data[o + 3] = q(1 - worley(W12, 12, u, v, w));
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1; tex.needsUpdate = true;
  return tex;
}

// Таблица ячеек: три текстуры NC x (NC*3) (по NC строк на слой). Облако ячейки c лежит в тексле (c.x mod NC, c.z mod NC + слой*NC).
//   A: центр x, центр z, радиус по x, радиус по z   (радиус 0 — облака в ячейке нет)
//   B: толщина, высота дна, «сила жизни» (0..1)
//   C: смещение шума (xyz)
function makeCellTex() {
  const d = new Float32Array(NC * NC * 3 * 4);
  const t = new THREE.DataTexture(d, NC, NC * 3, THREE.RGBAFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return { d, t };
}

// ── Шейдеры ────────────────────────────────────────────────────
const VERT = `
uniform mat3 uCamRot;
uniform vec2 uTan;
varying vec3 vRay;
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vRay = uCamRot * vec3(position.x * uTan.x, position.y * uTan.y, -1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const f1 = (x) => x.toFixed(1), f2 = (x) => x.toFixed(2), f3 = (x) => x.toFixed(3);
const call = (i) => `layerDens(p, ${f1(LAYERS[i].C)}, uBand${i}, ${f2(LAYERS[i].wind)}, ${i}, full, hAcc)`;

function fragSrc(high) {
  const S = high
    ? { steps: 44, ls: 4, lb: 7.0, lg: 2.1, smin: 5.0, sk: 0.10, smax: 55.0, full: 24.0 }
    : { steps: 30, ls: 3, lb: 9.0, lg: 2.3, smin: 7.0, sk: 0.14, smax: 70.0, full: 20.0 };
  const defs = `#define STEPS ${S.steps}\n#define LSTEPS ${S.ls}\n#define LBASE ${f1(S.lb)}\n#define LGROW ${f2(S.lg)}\n`
    + `#define STEP_MIN ${f1(S.smin)}\n#define STEP_K ${f3(S.sk)}\n#define STEP_MAX ${f1(S.smax)}\n#define FULL_SL ${f1(S.full)}\n`
    + `#define NC ${NC}\n#define TOON_LEVELS ${TOON_LEVELS}\n`;
  return defs + `
#define SIGMA 0.30

precision highp sampler2D;
precision highp sampler3D;
uniform sampler3D uNoise;
uniform sampler2D uDepth, uCellA, uCellB, uCellC;
uniform float uTime, uRain, uMaxDist, uTubeOn, uDebug, uUseDepth;
uniform vec2 uWind, uFogRange, uNearFar, uHull;
uniform vec3 uCamPos, uCamFwd, uFocus, uLit, uShade, uGlow, uSunDir, uFogColor, uBand0, uBand1, uBand2;
varying vec3 vRay;
varying vec2 vUv;

// Плотность одного слоя в точке p. Облака ячеек (их параметры лежат в таблице uCellA..C) считает процессор.
// Точку задевают облака только из четырёх ближайших ячеек. band: x — низ самых нижних оснований, z — потолок слоя.
// full=false — дешёвый вариант без мелкой лепки (для луча света и дальних шагов). hAcc копит «высоту внутри облака».
float layerDens(vec3 p, float C, vec3 band, float wmul, int L, bool full, inout float hAcc) {
  if (p.y < band.x || p.y > band.z) return 0.0;
  vec2 q = p.xz - uWind * wmul;               // сетка едет вместе с ветром
  vec2 g = q / C - 0.5;
  ivec2 c0 = ivec2(floor(g));
  float acc = 0.0;
  for (int n = 0; n < 4; n++) {
    ivec2 c = c0 + ivec2(n & 1, n >> 1);
    ivec2 tc = ivec2(c.x & (NC - 1), (c.y & (NC - 1)) + L * NC);
    vec4 A = texelFetch(uCellA, tc, 0);
    if (A.z <= 0.0) continue;                 // в ячейке нет облака
    vec4 B = texelFetch(uCellB, tc, 0);       // толщина, дно, сила жизни
    float ye = (p.y - B.y) / B.x;
    if (ye <= 0.0) continue;                  // под дном облака пусто: оно плоскодонное
    vec3 o = vec3((q.x - A.x) / A.z, (p.y - (B.y + 0.3 * B.x)) / (0.85 * B.x), (q.y - A.y) / A.w);
    float rr = dot(o, o);
    if (rr >= 1.0) continue;
    float s = 1.0 - sqrt(rr);
    // Лепка: крупные «шары» у каждого облака со своим смещением шума, шум медленно «кипит» вверх
    vec3 nq = vec3(q.x - A.x, p.y - B.y, q.y - A.y) + texelFetch(uCellC, tc, 0).xyz;
    nq.y -= uTime * 0.45;
    vec4 n1 = textureLod(uNoise, nq * (1.0 / 56.0), 0.0);
    float lumps = 0.55 * n1.g + 0.45 * n1.b;
    float d = s * 1.55 - 0.50 + (lumps - 0.5) * 1.15;
    if (full) {                               // мелкая лепка выедает тонкие края: пушистый контур
      vec4 n2 = textureLod(uNoise, nq * (1.0 / 20.0) + 0.31, 0.0);
      float det = 0.6 * n2.g + 0.4 * n2.b;
      d -= (1.0 - det) * 0.40 * (1.0 - clamp(d * 1.5, 0.0, 1.0));
    }
    d -= (1.0 - B.z) * 0.9;                   // рождение и распад идут кусками лепки
    d *= smoothstep(0.0, 0.08, s) * smoothstep(0.0, 0.30, ye);   // ровный край и мягкое дно
    if (d > 0.0) { acc += d; hAcc += min(ye, 1.0) * d; }
  }
  return acc;
}

// Плотность всех слоёв. Складываем: соседние облака сливаются. h01 — высота внутри облака (0 дно, 1 макушка)
float density(vec3 p, bool full, out float h01) {
  float hAcc = 0.0;
  float d = ${call(0)};
  d += ${call(1)};
  d += ${call(2)};
  d = min(d, 1.6);
  h01 = clamp(hAcc / max(d, 1e-3), 0.0, 1.0);
  return d;
}

// Рассеивание около игрока: 0 — вычистить, 1 — не трогать. Шар вокруг камеры и «труба» по линии камера → игрок.
float clearF(vec3 p) {
  float f = smoothstep(8.0, 26.0, distance(p, uCamPos));
  if (uTubeOn > 0.5) {
    vec3 ab = uFocus - uCamPos;
    float u = clamp(dot(p - uCamPos, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
    f = min(f, smoothstep(7.0, 16.0 + 6.0 * (1.0 - u), distance(p, uCamPos + ab * u)));
  }
  return f;
}

float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }
float ign(vec2 fc) { return fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715)))); }

void main() {
  // Глубина платформ (в разрешении игры): расстояние до ближайшей платформы вдоль экранного пикселя
  float dep = texture(uDepth, vUv).r;
  float zn = dep * 2.0 - 1.0;
  float vz = 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - zn * (uNearFar.y - uNearFar.x));
  // Проверка тракта отрисовки: ?clouds=debug — сплошной розовый экран, ?clouds=depth — карта глубины (серое — платформы, зелёное — пусто)
  if (uDebug > 0.5 && uDebug < 1.5) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
  if (uDebug > 1.5) { gl_FragColor = dep < 0.99999 ? vec4(vec3(clamp(vz / 60.0, 0.0, 1.0)), 1.0) : vec4(0.0, 0.35, 0.0, 1.0); return; }

  vec3 rd = normalize(vRay);
  vec3 ro = uCamPos;

  // Луч работает только внутри высотного пояса, где вообще бывают облака
  float t0 = 0.0, t1 = uMaxDist;
  if (abs(rd.y) < 1e-4) {
    if (ro.y < uHull.x || ro.y > uHull.y) discard;
  } else {
    float ta = (uHull.x - ro.y) / rd.y, tb = (uHull.y - ro.y) / rd.y;
    t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  }
  // Платформа (или игрок) на пути луча: дальше неё облако не рисуем
  if (uUseDepth > 0.5 && dep < 0.99999) t1 = min(t1, vz / max(dot(rd, uCamFwd), 1e-3));
  if (t1 <= t0) discard;

  // Фаза рассеяния зависит только от направления луча: считаем один раз на три «октавы»
  float cosT = dot(rd, uSunDir);
  float ph0 = mix(hg(cosT, -0.2), hg(cosT, 0.65), 0.3);
  float ph1 = mix(hg(cosT, -0.12), hg(cosT, 0.39), 0.3);
  float ph2 = mix(hg(cosT, -0.072), hg(cosT, 0.234), 0.3);

  float t = t0 + ign(gl_FragCoord.xy) * clamp(t0 * STEP_K, STEP_MIN, STEP_MAX);
  float T = 1.0, Tacc = 0.0, Aacc = 0.0, tFirst = -1.0;
  vec3 Cacc = vec3(0.0), lastCs = uLit * 0.85;
  for (int i = 0; i < STEPS; i++) {
    if (t > t1 || T < 0.03) break;
    float sl = clamp(t * STEP_K, STEP_MIN, STEP_MAX);   // шаг растёт с расстоянием: вдали пиксель всё равно крупный
    vec3 p = ro + rd * t;
    float h01;
    float d = density(p, sl < FULL_SL, h01);
    if (d > 0.0) d = max(0.0, d - (1.0 - clearF(p)) * 1.1);
    if (d > 0.002) {
      float a = 1.0 - exp(-d * SIGMA * sl);
      float w = a * T;
      if (w > 0.02) { // свет считаем только для заметных точек; у почти прозрачных берём цвет с прошлой точки
        // Сколько света дойдёт до точки: пробы в сторону светила, в том числе сквозь соседние облака
        float tau = 0.0, off = LBASE;
        for (int k = 0; k < LSTEPS; k++) {
          float hh;
          tau += density(p + uSunDir * off, false, hh) * off * 0.35;
          off *= LGROW;
        }
        // Три «октавы» многократного рассеяния: тени мягкие, а свет у светила образует серебристую кромку
        float lightE = (ph0 * exp(-tau * SIGMA) + 0.55 * ph1 * exp(-tau * SIGMA * 0.4) + 0.3025 * ph2 * exp(-tau * SIGMA * 0.16)) * 0.5;
#if TOON_LEVELS > 0
        lightE = floor(lightE * float(TOON_LEVELS) + 0.5) / float(TOON_LEVELS);
#endif
        // Собственный градиент: дно холодное и тёмное (свет только от неба), макушка светлая
        vec3 amb = uShade * mix(0.70, 1.35, h01) + uLit * 0.08 * h01;
        lastCs = mix(amb, uLit, clamp(lightE, 0.0, 1.0)) + uGlow * max(lightE - 1.0, 0.0) * 0.30; // серебристая кромка у светила
      }
      Cacc += lastCs * w; Tacc += t * w; Aacc += w;
      T *= 1.0 - a;
      if (tFirst < 0.0 && Aacc > 0.1) tFirst = t;
    }
    t += sl;
  }
  if (Aacc < 0.01) discard;

  vec3 col = Cacc / Aacc;
  float tHit = tFirst > 0.0 ? tFirst : Tacc / Aacc;
  // Воздушная дымка: начинается там, где у платформ уже густой туман, и растёт до края дальности
  col = mix(col, uFogColor, smoothstep(uFogRange.y * 0.8, uMaxDist, tHit) * 0.65);
  float aOut = clamp(Aacc * 1.05, 0.0, 1.0) * (1.0 - smoothstep(0.82 * uMaxDist, uMaxDist, tHit));
  if (aOut < 0.01) discard;

  gl_FragColor = vec4(col, aOut);
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`;
}

const NOOP = () => {};
const STUB = { objects: [], setLook: NOOP, setBands: NOOP, setWeather: NOOP, setResolution: NOOP, setOccHeight: NOOP, update: NOOP, render: NOOP };
const LEVELS = [144, 180, 216, 270, 360, 480, 720, 1080]; // ступени разрешения холста облаков (строк)
const levelOf = (lines) => { let k = 0; LEVELS.forEach((v, i) => { if (v <= lines) k = i; }); return k; };

export function createClouds(scene, opts = {}) {
  const high = opts.high ?? (opts.count == null ? true : opts.count >= 30);
  const qmode = (typeof location !== 'undefined' && /[?&]clouds=(\w+)/.exec(location.search) || [])[1] || '';
  const debug = qmode === 'debug' ? 1 : qmode === 'depth' ? 2 : 0;
  const SHOW_INFO = qmode === 'info';
  let occH = opts.occHeight || 240;                   // строк у основного кадра игры (RES_H в main.js); меняется через setOccHeight()
  const maxDist = opts.maxDist || (high ? 800 : 550); // дальность облаков, м
  // По умолчанию разрешение облаков привязано к разрешению игры (см. linkedH) и не меняется само.
  // Старая автоподстройка по FPS включается адресом ?clouds=auto
  const auto = opts.auto !== false && qmode === 'auto';
  let capLvl = levelOf(opts.height || (high ? 480 : 360));  // потолок разрешения (только для автоподстройки)
  let lvl = auto ? Math.min(capLvl, 3) : capLvl;            // автоподстройка стартует с 270 строк
  // Привязка к игре: облака рисуются в 1.5 раза чётче кадра игры, но не меньше 360 и не больше 540 строк
  // (240p -> 360, 360p и выше -> 540). Потолок нужен из-за цены: рэймарчинг идёт на каждый пиксель холста, и на 1080 строках
  // облака в 4 раза дороже, чем на 540, а лишней чёткости они не дают (облака мягкие, браузер сглаживает холст).
  const linkedH = () => clamp(Math.round(occH * 1.5), 360, 540);
  let cloudH = auto ? LEVELS[lvl] : linkedH();
  let light = opts.light || null;                     // направленный свет (солнце/луна); если не передан, берём первый DirectionalLight сцены

  // Своё полотно и свой рендерер: у облаков разрешение выше, чем у игры
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    console.warn('Облака отключены: не удалось создать второй WebGL-контекст', e);
    return STUB;
  }
  const cv = renderer.domElement;
  cv.id = 'cloudCanvas';
  Object.assign(cv.style, { position: 'absolute', left: '0', top: '0', zIndex: '1', pointerEvents: 'none', imageRendering: 'auto' });
  (opts.parent || document.getElementById('game') || document.body).appendChild(cv);
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);

  const CA = makeCellTex(), CB = makeCellTex(), CC = makeCellTex();
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: fragSrc(high),
    uniforms: {
      uNoise: { value: makeNoise3D(32) }, uDepth: { value: null }, uCellA: { value: CA.t }, uCellB: { value: CB.t }, uCellC: { value: CC.t },
      uTime: { value: 0 }, uDebug: { value: debug }, uUseDepth: { value: qmode === 'nodepth' ? 0 : 1 }, uRain: { value: 0 }, uMaxDist: { value: maxDist }, uTubeOn: { value: 0 },
      uWind: { value: new THREE.Vector2() }, uFogRange: { value: new THREE.Vector2(24, 150) },
      uNearFar: { value: new THREE.Vector2(0.1, 250) }, uHull: { value: new THREE.Vector2(-30, 80) },
      uTan: { value: new THREE.Vector2(1, 1) }, uCamRot: { value: new THREE.Matrix3() },
      uCamPos: { value: new THREE.Vector3() }, uCamFwd: { value: new THREE.Vector3(0, 0, -1) }, uFocus: { value: new THREE.Vector3() },
      uLit: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.25, 0.3, 0.45) },
      uGlow: { value: new THREE.Color(1, 0.95, 0.85) }, uSunDir: { value: new THREE.Vector3(5, 10, 6).normalize() },
      uFogColor: { value: new THREE.Color(0xb0d8ff) },
      uBand0: { value: new THREE.Vector3() }, uBand1: { value: new THREE.Vector3() }, uBand2: { value: new THREE.Vector3() },
    },
    transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: false, fog: false,
  });
  const u = mat.uniforms;

  const cloudScene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  cloudScene.add(mesh);

  // ── Размеры: холст облаков (меняется автоподстройкой) и карта глубины (размер как у кадра игры) ──
  let rt = null;
  const resizeCanvas = () => renderer.setSize(Math.max(2, Math.round((cloudH * innerWidth) / innerHeight)), cloudH, false);
  function resizeDepth() {
    const ow = Math.max(2, Math.round((occH * innerWidth) / innerHeight)); // ровно столько же, сколько у основного кадра игры
    if (rt) rt.dispose();
    const dt = new THREE.DepthTexture(ow, occH, THREE.UnsignedIntType);
    rt = new THREE.WebGLRenderTarget(ow, occH, { depthTexture: dt, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    u.uDepth.value = dt;
  }
  addEventListener('resize', () => { resizeCanvas(); resizeDepth(); });
  resizeCanvas(); resizeDepth();
  const occMat = new THREE.MeshBasicMaterial({ colorWrite: false, fog: false }); // платформы только в буфер глубины

  const field = { low: -10, high: 10 };  // высоты уровня, под которые подстраиваемся (setBands)
  const cur = { low: -10, high: 10 };    // плавно догоняют field
  let first = true, rainT = 0, rainS = 0, midK = 1, windX = 0, windZ = 0, editing = false, hooked = false;
  const lit = new THREE.Color(1, 1, 1), shade = new THREE.Color(0.25, 0.3, 0.45), tmp = new THREE.Color();
  const sunTint = new THREE.Color(1, 1, 1), WARM = new THREE.Color(1, 0.93, 0.8);
  let cam = null;

  // ── Таблица облаков на процессоре ─────────────────────────────
  const R0 = [0, 0, 0], R1 = [0, 0, 0], R2 = [0, 0, 0], R3 = [0, 0, 0];
  const wrap = (i) => ((i % NC) + NC) % NC;
  function fillLayer(L, t, rain, band, camx, camz) {
    const D = LAYERS[L], C = D.C;
    const cover = L === 0 ? 0.90 + 0.10 * rain : L === 1 ? 0.60 + 0.40 * rain - (1 - midK) * 1.4 : 0.52 + 0.48 * rain;
    const rk = L === 0 ? 1 : 1 - 0.3 * rain;
    const cx0 = Math.floor((camx - windX * D.wind) / C), cz0 = Math.floor((camz - windZ * D.wind) / C);
    for (let j = -NC / 2; j < NC / 2; j++) for (let i = -NC / 2; i < NC / 2; i++) {
      const cx = cx0 + i, cz = cz0 + j;
      const o = ((wrap(cz) + L * NC) * NC + wrap(cx)) * 4;
      pcg(cx, cz, L, R0);
      const life = lerp(100, 200, R0[0]), tau = t / life + R0[1], cyc = Math.floor(tau), age = tau - cyc; // возраст 0..1; на новом цикле облако рождается заново и другим
      const cy = cyc * 3 + L;
      pcg(cx, cz, cy + 1000, R1);
      const pres = clamp((cover - R1[0]) / 0.15, 0, 1);
      const env = pres > 0 ? sstep(0, 0.18, age) * (1 - sstep(0.78, 1, age)) * pres : 0;
      if (env <= 0) { CA.d[o] = CA.d[o + 1] = CA.d[o + 2] = CA.d[o + 3] = 0; continue; }
      pcg(cx, cz, cy + 2000003, R2); pcg(cx, cz, cy + 3000007, R3);
      const k = 0.6 + 0.4 * env;                                                   // растёт и ужимается вместе с жизнью
      const Rh = C * lerp(D.szr[0], D.szr[1], R1[2]) * (1 + 0.35 * rain) * k;
      const Rx = Math.min(Rh * lerp(1, D.st, R2[1]), 0.76 * C);                    // вытянуто по ветру
      const Rz = Rh * lerp(0.85, 1.15, R2[2]);
      const Ht = Rh * lerp(D.tk[0], D.tk[1], R2[0]) * rk;
      CA.d[o] = (cx + 0.5 + (R3[0] - 0.5) * 0.30 + 0.05 * Math.sin(t * 0.07 + R0[2] * 6.283)) * C;
      CA.d[o + 1] = (cz + 0.5 + (R3[1] - 0.5) * 0.30 + 0.05 * Math.cos(t * 0.053 + R0[0] * 6.283)) * C;
      CA.d[o + 2] = Rx; CA.d[o + 3] = Rz;
      CB.d[o] = Ht; CB.d[o + 1] = lerp(band[0], band[1], R1[1]); CB.d[o + 2] = env; CB.d[o + 3] = 0;
      CC.d[o] = R3[0] * 37 + R2[1] * 11; CC.d[o + 1] = R3[1] * 37 + R2[2] * 11; CC.d[o + 2] = R3[2] * 37 + R2[0] * 11; CC.d[o + 3] = 0;
    }
  }
  let cellT = -1;
  function refreshCells(t) {
    if (!cam || (cellT >= 0 && t - cellT < 0.1 && t >= cellT)) return;
    cellT = t;
    const lo = cur.low, hi = cur.high, r = rainS;
    const bands = [[lo - 44, lo - 16], [lo + 6, hi + 10], [hi + 34 - 10 * r, hi + 76 - 10 * r]];
    for (let L = 0; L < 3; L++) fillLayer(L, t, r, bands[L], cam.position.x, cam.position.z);
    CA.t.needsUpdate = CB.t.needsUpdate = CC.t.needsUpdate = true;
  }

  // ── Автоподстройка разрешения ────────────────────────────────
  let ema = 0.016, evalT = 0, warm = 0, upStreak = 0, lastUp = -99, ban = 99, banUntil = 0, banLen = 120, clock = 0, minEma = Infinity;
  function autoScale(dt) {
    clock += dt;
    ema += (dt - ema) * Math.min(1, dt / 0.6);
    if (++warm < 90) return;              // прогрев: компиляция шейдера, первые кадры
    evalT += dt;
    if (evalT < 1) return;
    evalT = 0;
    minEma = Math.min(minEma, ema);
    const maxL = Math.min(capLvl, clock < banUntil ? ban - 1 : 99);
    if (ema > 0.0215 && lvl > 0) {        // медленнее ~46 FPS: уменьшаем холст облаков
      if (clock - lastUp < 8) { ban = lvl; banUntil = clock + banLen; banLen = Math.min(900, banLen * 2); } // апгрейд не удался: не пробуем снова
      lvl--; upStreak = 0; lastUp = -99; cloudH = LEVELS[lvl]; resizeCanvas();
    } else if (ema < 0.0185 && ema < minEma * 1.1 + 0.0005 && lvl < maxL) { // запас есть: аккуратно растём
      if (++upStreak >= 4) { lvl++; upStreak = 0; lastUp = clock; cloudH = LEVELS[lvl]; resizeCanvas(); }
    } else upStreak = 0;
    if (lvl > maxL) { lvl = maxL; cloudH = LEVELS[lvl]; resizeCanvas(); }
  }

  // Параметры камеры и тумана берём в момент отрисовки: камера одна, но дальность и туман меняются
  mesh.onBeforeRender = (rdr, scn, camera) => {
    if (!hooked) { // если шейдер не соберётся, текст ошибки появится на экране (и в консоли), а не пропадёт молча
      hooked = true;
      if (!rdr.debug.onShaderError) rdr.debug.onShaderError = (gl, program, vs, fs) => {
        const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)].filter(Boolean).join('\n').trim();
        console.error('[clouds] ошибка шейдера:\n' + log);
        const el = document.createElement('pre');
        el.style.cssText = 'position:fixed;left:8px;right:8px;top:90px;max-height:50vh;overflow:auto;z-index:99999;background:rgba(120,0,0,.93);color:#fff;font:11px/1.3 monospace;padding:8px;white-space:pre-wrap;pointer-events:none';
        el.textContent = 'Ошибка шейдера (облака):\n' + log.slice(0, 3000);
        document.body.append(el);
      };
    }
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    camera.getWorldDirection(u.uCamFwd.value);
    const th = Math.tan((camera.fov * Math.PI) / 360);
    u.uTan.value.set(th * camera.aspect, th);
    u.uNearFar.value.set(camera.near, camera.far);
    const f = scene.fog;
    if (f) { u.uFogColor.value.copy(f.color); u.uFogRange.value.set(f.near, f.far); }
    // «Труба» рассеивания: от камеры до игрока. В третьем лице игрок ровно там, куда смотрит камера (FOCUS_DIST).
    // В первом лице (угол обзора шире) и в редакторе трубы нет: работает только шар вокруг камеры.
    const tube = !editing && camera.fov < 68;
    u.uTubeOn.value = tube ? 1 : 0;
    u.uFocus.value.copy(u.uCamPos.value).addScaledVector(u.uCamFwd.value, FOCUS_DIST);
    mat.uniformsNeedUpdate = true;
  };

  // ── Отрисовка: сама, из update() ─────────────────────────────
  let frames = 0, tick = 0, menuTick = 0, occN = 0, hits = '—', errText = '', errCount = 0, glErr = 0, info = null;
  const showPanel = () => {
    if (info) return;
    info = document.createElement('pre');
    info.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99998;background:rgba(0,0,0,.78);color:#7dff9a;font:11px/1.35 monospace;padding:6px 8px;pointer-events:none;white-space:pre-wrap;max-width:62vw';
    document.body.append(info);
  };
  if (SHOW_INFO) showPanel();
  // Всё непрозрачное в сцене закрывает облака (платформы, лифты, игрок, монеты). Метки обновляются раз в 10 кадров.
  function syncOccluders() {
    let n = 0;
    scene.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      const m = o.material;
      const solid = m && !Array.isArray(m) && !m.transparent && !m.wireframe && m.visible !== false && !m.isShaderMaterial;
      if (solid) { o.layers.enable(OCC_LAYER); n++; } else if (o.layers.isEnabled(OCC_LAYER)) o.layers.disable(OCC_LAYER);
    });
    occN = n;
  }
  function renderNow() {
    if (!cam || !rt || errCount > 3) return;
    // В меню (оно полупрозрачное) облака обновляем в четверть частоты: холст сохраняет прошлую картинку
    if (document.body.classList.contains('menu') && (menuTick++ & 3)) return;
    try {
      if (tick++ % 10 === 0) syncOccluders();
      cam.updateWorldMatrix(true, false);
      const bg = scene.background, om = scene.overrideMaterial, mask = cam.layers.mask;
      scene.background = null; scene.overrideMaterial = occMat; cam.layers.set(OCC_LAYER);
      try {
        renderer.setRenderTarget(rt);
        renderer.render(scene, cam);
      } finally {
        renderer.setRenderTarget(null);
        scene.background = bg; scene.overrideMaterial = om; cam.layers.mask = mask;
      }
      renderer.render(cloudScene, cam);
      frames++;
      if (info && frames % 20 === 0) { // раз в треть секунды: проверяем, нарисовалось ли что-нибудь на холсте облаков
        const gl = renderer.getContext(), px = new Uint8Array(4), w = cv.width, h = cv.height;
        let hit = 0, tot = 0;
        for (let iy = 1; iy <= 3; iy++) for (let ix = 1; ix <= 5; ix++) {
          gl.readPixels(Math.floor((w * ix) / 6), Math.floor((h * iy) / 4), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          tot++; if (px[3] > 8) hit++;
        }
        hits = hit + '/' + tot; glErr = gl.getError();
      }
    } catch (e) {
      errCount++; errText = String((e && e.stack) || e).slice(0, 700);
      console.error('[clouds] ошибка отрисовки:', e);
      showPanel();
    }
    if (info && (frames % 20 === 0 || errText)) {
      info.style.color = errText ? '#ff8080' : '#7dff9a';
      info.textContent = 'Облака: ' + (errText ? 'ОШИБКА\n' + errText : 'работают')
        + '\nкадров: ' + frames + ' | холст ' + cv.width + '×' + cv.height + ' (' + (auto ? 'авто, потолок ' + LEVELS[capLvl] : 'привязано к игре ' + occH + 'p') + ') | глубина ' + rt.width + '×' + rt.height
        + '\nкадр ' + (ema * 1000).toFixed(1) + ' мс (' + Math.round(1 / ema) + ' FPS)'
        + '\nзакрывающих объектов: ' + occN + ' | шейдеров: ' + (renderer.info.programs ? renderer.info.programs.length : '?') + ' | GL: ' + (glErr || 'ok')
        + '\nточек с облаками на холсте: ' + hits + ' (0 — облаков в кадре нет)'
        + '\n?clouds=depth — карта глубины, ?clouds=debug — розовый экран, ?clouds=nodepth — без глубины, ?clouds=auto — автоподстройка по FPS';
    }
  }

  return {
    objects: [], // облака рисуются отдельным холстом, в сцене игры их нет: прятать при SSAO/SSR не нужно

    // Цвет облаков: освещённая часть (color) и «самосвет» (emissive), из которого получается цвет теней.
    // Ночью и в дождь main.js передаёт тёмные цвета.
    setLook(color, emissive) {
      lit.copy(color);
      shade.copy(emissive).multiplyScalar(0.9).add(tmp.copy(color).multiplyScalar(0.08));
    },

    // Высоты уровня. Остальные поля (cx, cz, r) не нужны: облака заполняют весь мир, сетка бесконечная
    setBands({ low, high: hi }) { field.low = low; field.high = hi; cellT = -1; },

    // Дождь 0..1: облака сходятся в сплошную облачность, становятся крупнее, площе, ниже и быстрее
    setWeather(rain) { rainT = clamp(rain, 0, 1); },

    // Потолок чёткости облаков: сколько строк по вертикали (270 / 360 / 480 / 720 / 1080). Реальное разрешение подбирается само.
    setResolution(lines) {
      if (!auto) return; // разрешение облаков привязано к кадру игры (setOccHeight)
      capLvl = levelOf(Math.round(lines) || 480);
      if (!auto || lvl > capLvl) { lvl = auto ? capLvl : capLvl; cloudH = LEVELS[lvl]; resizeCanvas(); }
      ban = 99; banUntil = 0;
    },

    // Размер кадра игры (строк по вертикали) изменился, например в настройках «Разрешение».
    // Карта глубины, по которой платформы закрывают облака, должна быть ровно такого же размера, как кадр игры.
    setOccHeight(lines) {
      const h = Math.max(2, Math.round(lines) || 240);
      if (h === occH) return;
      occH = h;
      resizeDepth();
      if (!auto) { const c = linkedH(); if (c !== cloudH) { cloudH = c; resizeCanvas(); } } // облака меняют разрешение вместе с игрой
    },

    // t — время игры, с (нужно шейдеру для жизни облаков)
    update(dt, t) {
      if (!cam) cam = opts.camera || scene.children.find((o) => o.isCamera) || null;
      const k = first ? 1 : 1 - Math.exp(-2 * dt);
      cur.low += (field.low - cur.low) * k;
      cur.high += (field.high - cur.high) * k;
      rainS = first ? rainT : approach(rainS, rainT, dt / 6);
      editing = typeof document !== 'undefined' && document.body.classList.contains('editing');
      midK = first ? (editing ? 0 : 1) : approach(midK, editing ? 0 : 1, dt / 1.5);
      first = false;

      // Ветер: порывы меняют скорость и чуть качают направление. Сетка облаков едет вместе с ним
      const wind = WIND_V * (1 + 0.3 * Math.sin(t * 0.11) + 0.15 * Math.sin(t * 0.37 + 1)) * (1 + 0.7 * rainS);
      const wa = WIND_A + 0.18 * Math.sin(t * 0.07);
      windX += Math.cos(wa) * wind * dt; windZ += Math.sin(wa) * wind * dt;
      u.uWind.value.set(windX, windZ);
      u.uTime.value = t; u.uRain.value = rainS;

      // Высотные пояса: море облаков под уровнем, облака вокруг платформ, высокие над ними (в дождь ниже)
      const lo = cur.low, hi = cur.high, r = rainS;
      u.uBand0.value.set(lo - 44, lo - 16, lo - 16 + HMAX[0]);
      u.uBand1.value.set(lo + 6, hi + 10, hi + 10 + HMAX[1]);
      u.uBand2.value.set(hi + 34 - 10 * r, hi + 76 - 10 * r, hi + 76 - 10 * r + HMAX[2]);
      u.uHull.value.set(lo - 44, Math.max(hi + 10 + HMAX[1], hi + 76 - 10 * r + HMAX[2]));

      // Свет: направление и цвет берём у солнца/луны сцены (main.js плавно переводит его днём и ночью)
      if (!light) light = scene.children.find((o) => o.isDirectionalLight) || null;
      if (light) {
        u.uSunDir.value.copy(light.position).normalize();
        sunTint.copy(light.color).multiplyScalar(0.55 + 0.45 * clamp(light.intensity / 1.3, 0, 1));
        u.uGlow.value.copy(light.color).multiply(WARM).multiplyScalar(1.1);
      }
      u.uLit.value.copy(lit).multiply(sunTint).multiplyScalar(1.12);
      u.uShade.value.copy(shade);

      refreshCells(t);
      if (auto) autoScale(dt);
      renderNow();
    },

    // Облака рисуются сами, в конце update(). Метод оставлен для совместимости со старым main.js.
    render() {},
  };
}
