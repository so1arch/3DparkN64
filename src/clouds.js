// src/clouds.js — объёмные облака (рэймарчинг по облачным слоям), как Volumetric Cloud в Unreal Engine 5.
//
// • Плотность: у облака настоящий объём. Крупная форма («цветная капуста» из ячеек Вороного) плюс мелкая лепка, которая
//   выедает тонкие края, поэтому края получаются пушистыми, а не гладкими.
// • Свет: луч к солнцу или луне проходит сквозь само облако и соседние, ослабляется по закону Бера. Сверху три «октавы»
//   многократного рассеяния (тени получаются мягкими, а не чёрными) и серебристая кромка, когда смотришь в сторону светила.
// • Градиент: низ облака холодный и тёмный (свет неба), макушка светлая.
// • Облака сливаются друг с другом (плотности складываются) и отбрасывают тени друг на друга.
// • Жизнь: каждое облако 70–150 с растёт, живёт, распадается кусками и рождается заново в другом месте и другой формы. Ветер порывистый.
// • Рассеивание: рядом с камерой и вдоль линии «камера → игрок» плотность вычитается, края рассыпаются на лепные куски.
// • Слои: море облаков под уровнем, облака вокруг платформ, высокие. В дождь облака крупнее, площе, ниже и быстрее.
// • Пиксельность даёт сама игра: кадр рисуется в ~240 строк. Если хочется ещё и «мультяшных» ступеней тона,
//   поставьте TOON_LEVELS = 5…6 (0 — плавное затенение).
//
// Интерфейс прежний (main.js менять не нужно):
//   createClouds(scene, opts) -> { objects, setLook(color, emissive), setBands({low, high}), setWeather(rain), update(dt, t) }
//   opts.count >= 30 (или opts.high) — качество HIGH, иначе LIGHT (меньше шагов).
// Диагностика: если шейдер не соберётся, текст ошибки появится на экране. Адрес игры с ?clouds=debug рисует розовый экран.
//
// Облако — один полноэкранный «квадрат»: пишет глубину (gl_FragDepth) по первой плотной точке, поэтому платформы ближе
// к камере закрывают облака, а облака ближе платформ рисуются поверх. Под переопределяющим материалом (SSAO, SSR)
// квадрат вырождается в точку (масштаб 0, а наш вершинный шейдер масштаб игнорирует).

import * as THREE from 'three';

const TOON_LEVELS = 0;               // 0 — плавный тон; 4…6 — ступенчатый «мультяшный»
const WIND_A = Math.atan2(1.2, 3.4); // базовое направление ветра (рад, в плоскости XZ)
const WIND_V = 3.6;                  // базовая скорость ветра, м/с
const FOCUS_DIST = 8.7;              // расстояние камера → игрок в третьем лице

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const approach = (x, to, d) => (x < to ? Math.min(to, x + d) : Math.max(to, x - d));

// ── 3D-шум (создаётся один раз) ────────────────────────────────
// Бесшовный. R — гладкий, G — крупная кучевая лепка (Вороной 3x3x3), B — средняя (6x6x6), A — мелкая (12x12x12).
function makeNoise3D(N = 32) {
  let s = 20261104;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const sm = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
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

// ── Шейдеры ────────────────────────────────────────────────────
const VERT = `
uniform mat3 uCamRot;
uniform vec2 uTan;
varying vec3 vRay;
void main() {
  vRay = uCamRot * vec3(position.x * uTan.x, position.y * uTan.y, -1.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

function fragSrc(high) {
  const defs = (high
    ? '#define STEPS 40\n#define LSTEPS 4\n#define STEP_MIN 2.0\n#define STEP_K 0.10\n#define STEP_MAX 40.0\n'
    : '#define STEPS 28\n#define LSTEPS 3\n#define STEP_MIN 3.0\n#define STEP_K 0.16\n#define STEP_MAX 50.0\n')
    + '#define TOON_LEVELS ' + TOON_LEVELS + '\n';
  return defs + `
#define SIGMA 0.40

precision highp sampler3D;
uniform sampler3D uNoise;
uniform float uTime, uRain, uMidK, uMaxDist, uTubeOn, uDebug;
uniform vec2 uWind, uFogRange, uNearFar, uHull;
uniform vec3 uCamPos, uCamFwd, uFocus, uLit, uShade, uGlow, uSunDir, uFogColor, uBand0, uBand1, uBand2;
varying vec3 vRay;

// Целочисленный хеш (PCG): облака лежат в ячейках сетки, у каждой ячейки и каждого «цикла жизни» свои случайные числа
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 rnd3(ivec3 c) { return vec3(pcg3d(uvec3(c))) * (1.0 / 4294967295.0); }

// Плотность одного слоя в точке p. В ячейке живёт одно облако; точку задевают облака только из четырёх ближайших ячеек.
// band: x — низ самых нижних оснований, y — верх самых высоких оснований, z — потолок слоя.
// tk — толщина облака в долях радиуса (min, max). full=false — дешёвый вариант без мелкой лепки (для луча света).
// hAcc копит «высоту внутри облака» (для градиента).
float layerDens(vec3 p, float C, vec3 band, float wmul, int L, vec2 szr, float stMax, vec2 tk, float cover, bool full, inout float hAcc) {
  if (p.y < band.x || p.y > band.z) return 0.0;
  vec2 q = p.xz - uWind * wmul;               // сетка едет вместе с ветром
  vec2 g = q / C - 0.5;
  ivec2 c0 = ivec2(floor(g));
  float acc = 0.0;
  for (int n = 0; n < 4; n++) {
    ivec2 c = c0 + ivec2(n & 1, n >> 1);
    vec3 r0 = rnd3(ivec3(c, L));
    float life = mix(70.0, 150.0, r0.x);      // срок жизни облака, с
    float tau = uTime / life + r0.y;
    float cyc = floor(tau);
    float u = tau - cyc;                      // возраст 0..1; на новом цикле облако рождается заново и другим
    int cy = int(cyc) * 3 + L;
    vec3 r1 = rnd3(ivec3(c, cy + 1000));
    float pres = clamp((cover - r1.x) / 0.15, 0.0, 1.0);
    if (pres <= 0.0) continue;
    float env = smoothstep(0.0, 0.18, u) * (1.0 - smoothstep(0.78, 1.0, u)) * pres;
    if (env <= 0.0) continue;
    vec3 r2 = rnd3(ivec3(c, cy + 2000003));
    vec3 r3 = rnd3(ivec3(c, cy + 3000007));
    float k = 0.6 + 0.4 * env;                // растёт и ужимается вместе с жизнью
    float Rh = C * mix(szr.x, szr.y, r1.z) * (1.0 + 0.35 * uRain) * k;
    float Rx = min(Rh * mix(1.0, stMax, r2.y), 0.76 * C);   // вытянуто по ветру
    float Rz = Rh * mix(0.85, 1.15, r2.z);
    float Ht = Rh * mix(tk.x, tk.y, r2.x);
    float yb = mix(band.x, band.y, r1.y);     // высота плоского дна
    vec2 ctr = (vec2(c) + 0.5 + (r3.xy - 0.5) * 0.30
      + 0.05 * vec2(sin(uTime * 0.07 + r0.z * 6.283), cos(uTime * 0.053 + r0.x * 6.283))) * C;
    float ye = (p.y - yb) / Ht;
    if (ye <= 0.0) continue;                  // под дном облака пусто: оно плоскодонное
    vec3 o = vec3((q.x - ctr.x) / Rx, (p.y - (yb + 0.3 * Ht)) / (0.85 * Ht), (q.y - ctr.y) / Rz);
    float rr = dot(o, o);
    if (rr >= 1.0) continue;
    float s = 1.0 - sqrt(rr);
    // Лепка: крупные «шары» у каждого облака со своим смещением шума, шум медленно «кипит» вверх
    vec3 nq = vec3(q.x - ctr.x, p.y - yb, q.y - ctr.y) + r3 * 37.0 + r2.yzx * 11.0;
    nq.y -= uTime * 0.45;
    vec4 n1 = textureLod(uNoise, nq * (1.0 / 30.0), 0.0);
    float lumps = 0.55 * n1.g + 0.45 * n1.b;
    float d = s * 1.55 - 0.50 + (lumps - 0.5) * 1.15;
    if (full) {                               // мелкая лепка выедает тонкие края: пушистый контур
      vec4 n2 = textureLod(uNoise, nq * (1.0 / 11.0) + 0.31, 0.0);
      float det = 0.6 * n2.g + 0.4 * n2.b;
      d -= (1.0 - det) * 0.40 * (1.0 - clamp(d * 1.5, 0.0, 1.0));
    }
    d -= (1.0 - env) * 0.9;                   // рождение и распад идут кусками лепки
    d *= smoothstep(0.0, 0.08, s) * smoothstep(0.0, 0.30, ye);   // ровный край и мягкое дно
    if (d > 0.0) { acc += d; hAcc += min(ye, 1.0) * d; }
  }
  return acc;
}

// Плотность всех слоёв. Складываем: соседние облака сливаются. h01 — высота внутри облака (0 дно, 1 макушка)
float density(vec3 p, bool full, out float h01) {
  float hAcc = 0.0;
  float rk = 1.0 - 0.3 * uRain;
  float covMid = 0.38 + 0.50 * uRain - (1.0 - uMidK) * 1.4;
  float covHigh = 0.38 + 0.50 * uRain;
  float d = layerDens(p, 70.0, uBand0, 0.8, 0, vec2(0.26, 0.40), 1.4, vec2(0.30, 0.55), 0.88, full, hAcc);
  d += layerDens(p, 90.0, uBand1, 1.0, 1, vec2(0.15, 0.28), 1.4, vec2(0.60, 1.15) * rk, covMid, full, hAcc);
  d += layerDens(p, 100.0, uBand2, 1.3, 2, vec2(0.12, 0.22), 1.6, vec2(0.45, 0.85) * rk, covHigh, full, hAcc);
  d = min(d, 1.5);
  h01 = clamp(hAcc / max(d, 1e-3), 0.0, 1.0);
  return d;
}

// Рассеивание около игрока: 0 — вычистить, 1 — не трогать. Шар вокруг камеры и «труба» по линии камера → игрок.
float clearF(vec3 p) {
  float f = smoothstep(5.0, 17.0, distance(p, uCamPos));
  if (uTubeOn > 0.5) {
    vec3 ab = uFocus - uCamPos;
    float u = clamp(dot(p - uCamPos, ab) / max(dot(ab, ab), 1e-3), 0.0, 1.0);
    f = min(f, smoothstep(6.0, 14.0 + 4.0 * (1.0 - u), distance(p, uCamPos + ab * u)));
  }
  return f;
}

float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }
float ign(vec2 fc) { return fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715)))); }

void main() {
  // Проверка тракта отрисовки (адрес игры с ?clouds=debug): сплошной розовый экран поверх неба, но под платформами
  if (uDebug > 0.5) { gl_FragDepth = 0.999999; gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
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
  if (t1 <= t0) discard;

  float cosT = dot(rd, uSunDir);
  float t = t0 + ign(gl_FragCoord.xy) * clamp(t0 * STEP_K, STEP_MIN, STEP_MAX);
  float T = 1.0, Tacc = 0.0, Aacc = 0.0, tFirst = -1.0;
  vec3 Cacc = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    if (t > t1 || T < 0.03) break;
    float sl = clamp(t * STEP_K, STEP_MIN, STEP_MAX);   // шаг растёт с расстоянием: вдали пиксель всё равно крупный
    vec3 p = ro + rd * t;
    float h01;
    float d = density(p, true, h01);
    if (d > 0.0) d = max(0.0, d - (1.0 - clearF(p)) * 1.1);
    if (d > 0.002) {
      // Сколько света дойдёт до точки: пробы в сторону светила, в том числе сквозь соседние облака
      float tau = 0.0;
      for (int k = 0; k < LSTEPS; k++) {
        float off = 2.5 * pow(2.0, float(k)), hh;
        tau += density(p + uSunDir * off, false, hh) * off * 0.8;
      }
      // Три «октавы» многократного рассеяния: тени мягкие, а свет у светила образует серебристую кромку
      float lightE = 0.0, aa = 1.0, bb = 1.0, cc = 1.0;
      for (int o = 0; o < 3; o++) {
        float ph = mix(hg(cosT, -0.2 * cc), hg(cosT, 0.6 * cc), 0.35);
        lightE += bb * ph * exp(-tau * SIGMA * aa);
        aa *= 0.45; bb *= 0.55; cc *= 0.6;
      }
      lightE *= 0.5;
#if TOON_LEVELS > 0
      lightE = floor(lightE * float(TOON_LEVELS) + 0.5) / float(TOON_LEVELS);
#endif
      vec3 amb = uShade * mix(0.75, 1.2, h01);           // собственный градиент: дно холодное и тёмное, макушка светлая
      vec3 cs = mix(amb, uLit, clamp(lightE, 0.0, 1.0));
      cs += uGlow * max(lightE - 1.0, 0.0) * 0.25;       // серебристая кромка
      float a = 1.0 - exp(-d * SIGMA * sl);
      float w = a * T;
      Cacc += cs * w; Tacc += t * w; Aacc += w;
      T *= 1.0 - a;
      if (tFirst < 0.0 && Aacc > 0.1) tFirst = t;
    }
    t += sl;
  }
  if (Aacc < 0.01) discard;

  vec3 col = Cacc / Aacc;
  float tHit = tFirst > 0.0 ? tFirst : Tacc / Aacc;
  // Дымка с расстоянием: только вдали, чтобы ближние облака оставались белыми
  col = mix(col, uFogColor, smoothstep(uFogRange.x * 1.5, uFogRange.y, tHit) * 0.7);
  float aOut = clamp(Aacc * 1.05, 0.0, 1.0) * (1.0 - smoothstep(0.8 * uMaxDist, uMaxDist, tHit));
  if (aOut < 0.01) discard;

  // Глубина по первой плотной точке: платформы ближе к камере закрывают облако, облако ближе платформ рисуется поверх
  float dFwd = max(tHit * dot(rd, uCamFwd), 1e-3);
  float ndc = (uNearFar.y + uNearFar.x) / (uNearFar.y - uNearFar.x) - 2.0 * uNearFar.x * uNearFar.y / ((uNearFar.y - uNearFar.x) * dFwd);
  gl_FragDepth = clamp(ndc * 0.5 + 0.5, 0.0, 0.999999);

  gl_FragColor = vec4(col, aOut);
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`;
}

export function createClouds(scene, opts = {}) {
  const high = opts.high ?? (opts.count == null ? true : opts.count >= 30);
  const debug = typeof location !== 'undefined' && /[?&]clouds=debug/.test(location.search);
  let light = opts.light || null; // направленный свет (солнце/луна); если не передан, берём первый DirectionalLight сцены

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: fragSrc(high),
    uniforms: {
      uNoise: { value: makeNoise3D(32) },
      uTime: { value: 0 }, uDebug: { value: debug ? 1 : 0 }, uRain: { value: 0 }, uMidK: { value: 1 }, uMaxDist: { value: 200 }, uTubeOn: { value: 0 },
      uWind: { value: new THREE.Vector2() }, uFogRange: { value: new THREE.Vector2(24, 150) },
      uNearFar: { value: new THREE.Vector2(0.1, 250) }, uHull: { value: new THREE.Vector2(-30, 80) },
      uTan: { value: new THREE.Vector2(1, 1) }, uCamRot: { value: new THREE.Matrix3() },
      uCamPos: { value: new THREE.Vector3() }, uCamFwd: { value: new THREE.Vector3(0, 0, -1) }, uFocus: { value: new THREE.Vector3() },
      uLit: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.6, 0.66, 0.8) },
      uGlow: { value: new THREE.Color(1, 0.95, 0.85) }, uSunDir: { value: new THREE.Vector3(5, 10, 6).normalize() },
      uFogColor: { value: new THREE.Color(0xb0d8ff) },
      uBand0: { value: new THREE.Vector3() }, uBand1: { value: new THREE.Vector3() }, uBand2: { value: new THREE.Vector3() },
    },
    transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: true, fog: false,
  });
  const u = mat.uniforms;

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.scale.set(0, 0, 0); // наш шейдер масштаб не использует; у проходов с чужим материалом (нормали SSAO и SSR) квадрат вырождается
  mesh.renderOrder = 1;    // раньше дождя, нити и чаек: они рисуются поверх облаков
  scene.add(mesh);

  const field = { low: -10, high: 10 };  // высоты уровня, под которые подстраиваемся (setBands)
  const cur = { low: -10, high: 10 };    // плавно догоняют field
  let first = true, rainT = 0, rainS = 0, midK = 1, windX = 0, windZ = 0, editing = false, hooked = false;
  const lit = new THREE.Color(1, 1, 1), shade = new THREE.Color(0.6, 0.66, 0.8), tmp = new THREE.Color();
  const sunTint = new THREE.Color(1, 1, 1), WARM = new THREE.Color(1, 0.93, 0.8);

  // Параметры камеры и тумана берём в момент отрисовки: сцену рисуют несколько проходов, камера одна, но дальность и туман меняются
  mesh.onBeforeRender = (renderer, scn, camera) => {
    if (!hooked) { // если шейдер не соберётся, текст ошибки появится на экране (и в консоли), а не пропадёт молча
      hooked = true;
      if (!renderer.debug.onShaderError) renderer.debug.onShaderError = (gl, program, vs, fs) => {
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
    const f = scn.fog, cap = high ? 280 : 220;
    if (f) { u.uFogColor.value.copy(f.color); u.uFogRange.value.set(f.near, f.far); u.uMaxDist.value = Math.min(camera.far * 0.96, f.far * 1.2, cap); }
    else u.uMaxDist.value = Math.min(camera.far * 0.96, cap);
    // «Труба» рассеивания: от камеры до игрока. В третьем лице игрок ровно там, куда смотрит камера (FOCUS_DIST).
    // В первом лице (угол обзора шире) и в редакторе трубы нет: работает только шар вокруг камеры.
    const tube = !editing && camera.fov < 68;
    u.uTubeOn.value = tube ? 1 : 0;
    u.uFocus.value.copy(u.uCamPos.value).addScaledVector(u.uCamFwd.value, FOCUS_DIST);
    mat.uniformsNeedUpdate = true;
  };

  return {
    objects: [mesh],

    // Цвет облаков: освещённая часть (color) и «самосвет» (emissive), из которого получается цвет теней.
    // Ночью и в дождь main.js передаёт более тёмные цвета.
    setLook(color, emissive) {
      lit.copy(color);
      shade.copy(emissive).multiplyScalar(1.6).lerp(tmp.copy(color).multiplyScalar(0.55), 0.5);
    },

    // Высоты уровня. Остальные поля (cx, cz, r) не нужны: облака заполняют весь мир, сетка бесконечная
    setBands({ low, high: hi }) { field.low = low; field.high = hi; },

    // Дождь 0..1: облака сходятся, становятся крупнее, площе, ниже и быстрее
    setWeather(rain) { rainT = clamp(rain, 0, 1); },

    // t — время игры, с (нужно шейдеру для жизни облаков)
    update(dt, t) {
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
      u.uTime.value = t; u.uRain.value = rainS; u.uMidK.value = midK;

      // Высотные пояса: море облаков под уровнем, облака вокруг платформ, высокие над ними (в дождь ниже)
      const lo = cur.low, hi = cur.high, r = rainS;
      u.uBand0.value.set(lo - 26, lo - 8, lo - 8 + 22);
      u.uBand1.value.set(lo + 2, hi + 12, hi + 12 + 40);
      u.uBand2.value.set(hi + 14 - 10 * r, hi + 48 - 10 * r, hi + 48 - 10 * r + 30);
      u.uHull.value.set(lo - 26, hi + 48 - 10 * r + 30);

      // Свет: направление и цвет берём у солнца/луны сцены (main.js плавно переводит его днём и ночью)
      if (!light) light = scene.children.find((o) => o.isDirectionalLight) || null;
      if (light) {
        u.uSunDir.value.copy(light.position).normalize();
        sunTint.copy(light.color).multiplyScalar(0.55 + 0.45 * clamp(light.intensity / 1.3, 0, 1));
        u.uGlow.value.copy(light.color).multiply(WARM).multiplyScalar(1.1);
      }
      u.uLit.value.copy(lit).multiply(sunTint);
      u.uShade.value.copy(shade);
    },
  };
}
