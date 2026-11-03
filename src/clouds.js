// src/clouds.js — стилизованные облака в духе N64: плоскодонные кучевые из низкополигональных шаров.
//
// • Форма: основные шары стоят на общем плоском «дне», сверху маленькие «шапки». У шаров срезана нижняя часть,
//   тон разный (макушка светлее, края серее), поэтому облако читается как объёмное.
// • Жизнь: облако собирается шар за шаром (сначала центр, потом края), живёт 70–150 с, так же рассыпается и
//   появляется снова в другом месте и другой формы. Ветер порывистый, облака вытянуты по ветру, шары «дышат».
// • Погода: в дождь облака сходятся (больше, площе, ниже, быстрее), в ясную погоду часть слотов пустует.
// • Не мешают игроку: шары по одному растворяются рядом с камерой и рядом с линией «камера → игрок».
//   Рассеивание идёт через масштаб шара (а не через прозрачность), поэтому работает и в проходах SSAO/SSR.
// • Три слоя: море облаков под уровнем (шире и площе), облака вокруг уровня и редкие высоко над ним.
// Все шары рисует один InstancedMesh — один вызов отрисовки.

import * as THREE from 'three';

const WIND_A = Math.atan2(1.2, 3.4); // базовое направление ветра (рад, в плоскости XZ)
const WIND_V = 3.6;                  // базовая скорость ветра, м/с
const FLAT = 0.3;                    // на сколько ниже центра срезан шар (плоское дно)

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const approach = (x, to, d) => (x < to ? Math.min(to, x + d) : Math.max(to, x - d));

// Шар с плоским дном: все вершины ниже -FLAT прижаты к плоскости
function puffGeometry() {
  const g = new THREE.SphereGeometry(1, 8, 5);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) if (pos.getY(i) < -FLAT) pos.setY(i, -FLAT);
  g.computeVertexNormals();
  return g;
}

export function createClouds(scene, opts = {}) {
  const COUNT = opts.count ?? 36, PUFFS = Math.max(3, opts.puffs ?? 7); // в лёгком режиме облаков меньше и они проще
  const R0 = rng(2024);
  const mesh = new THREE.InstancedMesh(
    puffGeometry(),
    new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x7388b0, flatShading: true }),
    COUNT * PUFFS
  );
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);

  const field = { cx: 0, cz: 0, r: 160, low: -10, high: 10 }; // куда подстраиваемся (уровень)
  const cur = { low: -10, high: 10 };                           // плавно догоняют field
  let first = true, rainT = 0, rainS = 0;                       // rainT — цель (0..1), rainS — плавное значение

  const tc = new THREE.Color();
  const fs = new Float32Array(COUNT * PUFFS).fill(1); // видимость каждого шара (0 — растворён рядом с камерой/игроком)
  const clouds = [];

  // Придумать облако заново: слой, размер, форма, срок жизни. R — генератор случайных чисел.
  function shape(c, i, R) {
    const layer = i % 3; // 0: внизу, 1: высоко, 2: вокруг
    c.layer = layer;
    c.size = layer === 0 ? 4 + R() * 4 : layer === 1 ? 2.5 + R() * 3 : 2 + R() * 3;
    c.sq = layer === 0 ? 0.5 : layer === 1 ? 0.8 : 0.7;               // насколько шары приплюснуты
    c.sp = (0.6 + R() * 0.9) * (layer === 1 ? 1.3 : layer === 0 ? 0.8 : 1); // скорость относительно ветра
    c.fy = R();
    c.thr = R() * (layer === 0 ? 0.6 : 1); // порог «покрытия неба»: море облаков есть всегда, остальные приходят с дождём
    c.life = 70 + R() * 80; c.ph = R() * 6.28;
    const stretch = layer === 0 ? 1.4 : 1 + R() * 0.3;
    const crowns = PUFFS >= 5 ? 2 : 1, main = PUFFS - crowns, puffs = [];
    for (let j = 0; j < main; j++) {
      const t = main > 1 ? (j / (main - 1)) * 2 - 1 : 0, a = Math.abs(t);
      puffs.push({
        ox: t * 2 * stretch * (0.85 + 0.3 * R()), oz: (R() - 0.5) * 1.6 * (1 - a * 0.3),
        r: (1.55 - 0.7 * a) * (0.85 + 0.3 * R()), lift: 0, g: a * 0.7, tone: 0.9 + 0.08 * (1 - a),
      });
    }
    for (let j = 0; j < crowns; j++) { // шапки сверху
      puffs.push({
        ox: (R() - 0.5) * 1.6 * stretch, oz: (R() - 0.5) * 0.7, r: 0.75 + R() * 0.25,
        lift: 0.8, g: 0.85 + 0.15 * R(), tone: 1,
      });
    }
    puffs.forEach((p) => { p.ph = R() * 6.28; p.yaw = R() * 6.28; p.tone = clamp(p.tone + (R() - 0.5) * 0.05, 0, 1); });
    c.puffs = puffs;
    for (let j = 0; j < PUFFS; j++) mesh.setColorAt(i * PUFFS + j, tc.setScalar(puffs[j].tone));
    mesh.instanceColor.needsUpdate = true;
    for (let j = 0; j < PUFFS; j++) fs[i * PUFFS + j] = 1;
  }
  // Облако «рассеялось»: появляется снова в случайном месте поля, другой формы
  function respawn(c, i) {
    shape(c, i, Math.random);
    c.age = 0;
    c.x = field.cx + (Math.random() * 2 - 1) * field.r * 0.9;
    c.z = field.cz + (Math.random() * 2 - 1) * field.r * 0.9;
  }

  for (let i = 0; i < COUNT; i++) {
    const c = { x: (R0() - 0.5) * 320, z: (R0() - 0.5) * 320, age: 0 };
    shape(c, i, R0);
    c.age = (0.1 + 0.75 * R0()) * c.life; // на старте все в разных фазах жизни, чтобы небо не «мигало» разом
    clouds.push(c);
  }

  const dummy = new THREE.Object3D();

  return {
    // Цвет облаков: основной и «самосвет» (ночью и в дождь облака темнее)
    setLook(color, emissive) { mesh.material.color.copy(color); mesh.material.emissive.copy(emissive); },
    // Подстроить поле облаков под уровень: центр, радиус, нижняя и верхняя высоты платформ
    setBands({ cx, cz, r, low, high }) {
      field.cx = cx; field.cz = cz; field.r = Math.max(130, r); field.low = low; field.high = high;
    },
    // Дождь 0..1: облака сходятся, становятся крупнее, площе, ниже и быстрее
    setWeather(rain) { rainT = clamp(rain, 0, 1); },

    // cam — камера; focus — игрок (ноги), необязательно: шары рядом с линией «камера → игрок» растворяются
    update(dt, t, cam, focus) {
      const k = first ? 1 : 1 - Math.exp(-2 * dt), kf = first ? 1 : 1 - Math.exp(-9 * dt);
      cur.low += (field.low - cur.low) * k;
      cur.high += (field.high - cur.high) * k;
      rainS = first ? rainT : approach(rainS, rainT, dt / 6);
      first = false;

      // ветер: порывы меняют скорость и чуть качают направление
      const wind = WIND_V * (1 + 0.3 * Math.sin(t * 0.11) + 0.15 * Math.sin(t * 0.37 + 1)) * (1 + 0.7 * rainS);
      const wa = WIND_A + 0.18 * Math.sin(t * 0.07), ca = Math.cos(wa), sa = Math.sin(wa);
      const sizeK = 1 + 0.45 * rainS, yK = 1 - 0.3 * rainS, cover = 0.7 + 0.45 * rainS;
      const R2 = field.r * 2;

      let abx = 0, aby = 0, abz = 0, ab2 = 1;
      if (focus) {
        abx = focus.x - cam.x; aby = focus.y + 1 - cam.y; abz = focus.z - cam.z;
        ab2 = abx * abx + aby * aby + abz * abz || 1;
      }

      let idx = 0;
      for (let i = 0; i < COUNT; i++) {
        const c = clouds[i];
        c.age += dt;
        if (c.age >= c.life) respawn(c, i);
        c.x += ca * wind * c.sp * dt; c.z += sa * wind * c.sp * dt;
        // уходим за край поля — возвращаемся с другой стороны (на краю облако уже растворено)
        c.x = field.cx + ((((c.x - field.cx + field.r) % R2) + R2) % R2) - field.r;
        c.z = field.cz + ((((c.z - field.cz + field.r) % R2) + R2) % R2) - field.r;

        // «Жизненная сила» облака: рост и распад, край поля, покрытие неба
        const u = c.age / c.life;
        const env = sstep(0, 0.18, u) * (1 - sstep(0.78, 1, u));
        const edge = 1 - sstep(0.82, 1, Math.max(Math.abs(c.x - field.cx), Math.abs(c.z - field.cz)) / field.r);
        const pres = sstep(0, 1, clamp((cover - c.thr) / 0.15, 0, 1));
        const life = env * edge * pres;

        const S = c.size * sizeK, h = c.sq * yK; // h — приплюснутость шаров
        let by = c.layer === 0 ? cur.low - 8 - c.fy * 18
          : c.layer === 1 ? cur.high + 14 + c.fy * 34 - 10 * rainS
            : cur.low + 2 + c.fy * (cur.high - cur.low + 10);
        by += Math.sin(t * 0.3 + c.ph) * 0.12 * S; // by — высота плоского дна

        for (let j = 0; j < PUFFS; j++, idx++) {
          const p = c.puffs[j];
          // шары вырастают по очереди: центр раньше, края и шапки позже (при распаде — наоборот)
          const pf = sstep(p.g * 0.55, p.g * 0.55 + 0.45, life);
          const lx = p.ox * S, lz = p.oz * S;
          const wx = c.x + lx * ca - lz * sa, wz = c.z + lx * sa + lz * ca;
          const re = p.r * S, bottom = by + p.lift * S * h;
          const wy0 = bottom + FLAT * re * h;

          // Растворение рядом с камерой и рядом с линией «камера → игрок»
          let ft = sstep(re * 0.9 + 2, re * 0.9 + 13, Math.hypot(wx - cam.x, wy0 - cam.y, wz - cam.z));
          if (focus) {
            const w = clamp(((wx - cam.x) * abx + (wy0 - cam.y) * aby + (wz - cam.z) * abz) / ab2, 0, 1);
            const e = Math.hypot(wx - (cam.x + abx * w), wy0 - (cam.y + aby * w), wz - (cam.z + abz * w));
            ft = Math.min(ft, sstep(re * 0.8 + 1.2, re * 0.8 + 6, e));
          }
          fs[idx] += (ft - fs[idx]) * kf;

          const s = Math.max(1e-4, re * pf * (1 + 0.07 * Math.sin(t * 0.55 + p.ph)) * fs[idx]), sy = s * h;
          dummy.position.set(wx, bottom + FLAT * sy, wz); // дно шара остаётся на месте, пока шар растёт и тает
          dummy.rotation.set(0, p.yaw, 0);
          dummy.scale.set(s, sy, s * 0.95);
          dummy.updateMatrix();
          mesh.setMatrixAt(idx, dummy.matrix);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
