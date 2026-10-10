// src/weather.js — дождь: падающие капли, всплески на платформах.
//
// Капли живут в коробке вокруг игрока и падают вертикально. Когда капля рождается (вверху коробки),
// сразу считаем, куда она упадёт: supportY() возвращает высоту самой верхней платформы под ней.
// Капля летит до этой высоты и там превращается во всплеск (кольцо + пара брызг). Если платформы
// под каплей нет, она просто падает до низа коробки. Поэтому под навесом сухо, а на платформах «шумно».
// Чтобы это было дёшево, высота ищется один раз за жизнь капли, а не каждый кадр.
//
// Ночью дождь «тише»: капель меньше, они короче и прозрачнее, у каждой хвост плавно тает (получается тонкий штрих,
// а не яркая палка), цвет приглушён под ночное небо, кольца и брызги тусклее и мельче. Капли рядом с камерой
// растворяются, чтобы не мельтешить перед глазами. Днём вид прежний, только капли и всплески стали чуть мельче.
import * as THREE from 'three';
import { supportY } from './shapes.js';

const HALF = 22;      // половина стороны коробки с дождём
const ABOVE = 20;     // на сколько выше игрока рождаются капли
const BELOW = 24;     // на сколько ниже игрока они пропадают
const RING_LIFE = 0.38, SPRAY_LIFE = 0.32, GRAV = 11;

// Ночные поправки (night = 0..1)
const NIGHT_COUNT = 0.45;  // на сколько меньше капель ночью (доля)
const NIGHT_LEN = 0.38;    // на сколько короче штрихи ночью (доля)
const ALPHA_DAY = 0.5, ALPHA_NIGHT = 0.2;
const COL_DAY = 0xcfe0f5, COL_NIGHT = 0x8fa4cf;

const VERT = `
attribute float aT;
varying float vT;
varying float vD;
#include <fog_pars_vertex>
void main() {
  vT = aT;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vD = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = `
uniform vec3 uColor;
uniform float uAlpha, uNight;
varying float vT;
varying float vD;
#include <fog_pars_fragment>
void main() {
  float tail = mix(1.0, vT * vT, uNight);                          // ночью хвост капли плавно тает
  float near = mix(1.0, smoothstep(1.5, 6.0, vD), 0.35 + 0.65 * uNight); // рядом с камерой капли бледнеют
  gl_FragColor = vec4(uColor, uAlpha * tail * near);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export function createRain(scene, { high = true } = {}) {
  const N = high ? 1500 : 700;
  const RINGS = high ? 140 : 70, SPRAYS = high ? 280 : 140;

  // ── Капли: одна линия на каплю ────────────────────────────────
  const pos = new Float32Array(N * 6);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  const aT = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) { aT[i * 2] = 1; aT[i * 2 + 1] = 0; } // нижний конец (голова) — 1, верхний (хвост) — 0
  geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
  const colDay = new THREE.Color(COL_DAY), colNight = new THREE.Color(COL_NIGHT);
  const streakMat = new THREE.ShaderMaterial({
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, fog: true,
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uColor: { value: new THREE.Color(COL_DAY) }, uAlpha: { value: ALPHA_DAY }, uNight: { value: 0 },
    }]),
  });
  const streaks = new THREE.LineSegments(geo, streakMat);
  streaks.frustumCulled = false; streaks.renderOrder = 5; streaks.visible = false;
  scene.add(streaks);

  const dx = new Float32Array(N), dy = new Float32Array(N), dz = new Float32Array(N);
  const land = new Float32Array(N), speed = new Float32Array(N), len = new Float32Array(N);
  const onSurface = new Uint8Array(N);

  // Выбираем место и высоту падения
  function drop(i, parts, cx, cy, cz, y) {
    const x = cx + (Math.random() * 2 - 1) * HALF, z = cz + (Math.random() * 2 - 1) * HALF;
    place(i, parts, x, z, y, cy);
  }
  function place(i, parts, x, z, y, cy) {
    dx[i] = x; dz[i] = z; dy[i] = y;
    const g = supportY(parts, x, z, y);
    onSurface[i] = g > cy - BELOW ? 1 : 0;
    land[i] = onSurface[i] ? g : cy - BELOW;
  }

  // ── Всплески ──────────────────────────────────────────────────
  const dummy = new THREE.Object3D();
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const rings = new THREE.InstancedMesh(new THREE.RingGeometry(0.62, 1, 8).rotateX(-Math.PI / 2), ringMat, RINGS);
  rings.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(RINGS * 3), 3);
  rings.frustumCulled = false; rings.renderOrder = 6; rings.visible = false;
  const sprayMat = new THREE.MeshBasicMaterial({ color: 0xe6f0ff, transparent: true, opacity: 0.85, depthWrite: false });
  const spray = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), sprayMat, SPRAYS);
  spray.frustumCulled = false; spray.renderOrder = 6; spray.visible = false;
  scene.add(rings, spray);
  const sprayDay = new THREE.Color(0xe6f0ff), sprayNight = new THREE.Color(0x8a9cc4);

  const rp = Array.from({ length: RINGS }, () => ({ x: 0, y: 0, z: 0, age: 9, size: 1 }));
  const sp = Array.from({ length: SPRAYS }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 9, size: 0.05 }));
  let ringNext = 0, sprayNext = 0;
  function splash(x, y, z, night) {
    const r = rp[ringNext]; ringNext = (ringNext + 1) % RINGS;
    r.x = x; r.y = y + 0.035; r.z = z; r.age = 0; r.size = (0.17 + Math.random() * 0.12) * (1 - 0.2 * night);
    for (let k = 0, n = night > 0.5 ? 1 : 2; k < n; k++) { // ночью брызг вдвое меньше
      const s = sp[sprayNext]; sprayNext = (sprayNext + 1) % SPRAYS;
      const a = Math.random() * Math.PI * 2, v = 0.3 + Math.random() * 0.6;
      s.x = x; s.y = y + 0.05; s.z = z; s.vx = Math.cos(a) * v; s.vz = Math.sin(a) * v; s.vy = 1.5 + Math.random() * 1.4;
      s.age = 0; s.size = 0.026 + Math.random() * 0.022;
    }
  }
  function updateSplashes(dt, night) {
    const bright = 1 - 0.72 * night; // ночью кольца не «горят» на тёмных платформах
    for (let i = 0; i < RINGS; i++) {
      const r = rp[i];
      if (r.age >= RING_LIFE) { dummy.scale.setScalar(1e-4); dummy.position.set(0, -999, 0); rings.setColorAt(i, tint.setScalar(0)); }
      else {
        r.age += dt;
        const t = Math.min(1, r.age / RING_LIFE), f = 1 - t;
        dummy.position.set(r.x, r.y, r.z);
        dummy.scale.setScalar(r.size * (0.25 + 0.75 * Math.sqrt(t)));
        rings.setColorAt(i, tint.setScalar(f * f * 0.9 * bright));
      }
      dummy.updateMatrix(); rings.setMatrixAt(i, dummy.matrix);
    }
    rings.instanceMatrix.needsUpdate = true; rings.instanceColor.needsUpdate = true;
    for (let i = 0; i < SPRAYS; i++) {
      const s = sp[i];
      if (s.age >= SPRAY_LIFE) { dummy.scale.setScalar(1e-4); dummy.position.set(0, -999, 0); }
      else {
        s.age += dt; s.vy -= GRAV * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
        dummy.position.set(s.x, s.y, s.z);
        dummy.scale.setScalar(s.size * (1 - 0.6 * s.age / SPRAY_LIFE));
      }
      dummy.updateMatrix(); spray.setMatrixAt(i, dummy.matrix);
    }
    spray.instanceMatrix.needsUpdate = true;
  }
  const tint = new THREE.Color();
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage); spray.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  let started = false, lastParts = null;
  function init(parts, c) {
    for (let i = 0; i < N; i++) {
      speed[i] = 22 + Math.random() * 8; len[i] = 0.55 + Math.random() * 0.45; // капли короче прежних (было 0.8-1.4)
      drop(i, parts, c.x, c.y, c.z, c.y - BELOW + Math.random() * (ABOVE + BELOW));
    }
    started = true;
  }

  return {
    // Всё, что нужно спрятать при расчёте SSAO (полупрозрачные штуки ломают карту глубины)
    objects: [streaks, rings, spray],
    // center — игрок, parts — геометрия уровня, amount — 0..1 сила дождя, night — 0..1 насколько ночь
    update(dt, center, parts, amount, night = 0) {
      const on = amount > 0.01, alive = anyAlive();
      streaks.visible = rings.visible = spray.visible = on || alive;
      if (!on && !alive) return;
      if (parts !== lastParts) { lastParts = parts; started = false; clearSplashes(); } // сменился уровень: пересчитать места падения
      if (!started) init(parts, center);

      // ночной вид: приглушённый цвет, меньше прозрачность, короче штрихи, меньше капель
      const u = streakMat.uniforms;
      u.uNight.value = night; u.uAlpha.value = ALPHA_DAY + (ALPHA_NIGHT - ALPHA_DAY) * night;
      u.uColor.value.lerpColors(colDay, colNight, night);
      sprayMat.color.lerpColors(sprayDay, sprayNight, night); sprayMat.opacity = 0.85 - 0.4 * night;
      const lk = 1 - NIGHT_LEN * night;

      const active = Math.min(N, Math.round(N * amount * (1 - NIGHT_COUNT * night))), cx = center.x, cy = center.y, cz = center.z;
      for (let i = 0; i < active; i++) {
        let y = dy[i] - speed[i] * dt;
        // вылетели за коробку (игрок убежал): переносим на другую сторону
        if (dx[i] - cx > HALF) { place(i, parts, dx[i] - 2 * HALF, dz[i], y, cy); y = dy[i]; }
        else if (dx[i] - cx < -HALF) { place(i, parts, dx[i] + 2 * HALF, dz[i], y, cy); y = dy[i]; }
        if (dz[i] - cz > HALF) { place(i, parts, dx[i], dz[i] - 2 * HALF, y, cy); y = dy[i]; }
        else if (dz[i] - cz < -HALF) { place(i, parts, dx[i], dz[i] + 2 * HALF, y, cy); y = dy[i]; }
        if (y <= land[i]) {
          if (onSurface[i]) splash(dx[i], land[i], dz[i], night);
          drop(i, parts, cx, cy, cz, cy + ABOVE);
          y = dy[i];
        } else dy[i] = y;
        const o = i * 6, yy = dy[i];
        pos[o] = dx[i]; pos[o + 1] = yy; pos[o + 2] = dz[i];
        pos[o + 3] = dx[i]; pos[o + 4] = yy + len[i] * lk; pos[o + 5] = dz[i];
      }
      geo.setDrawRange(0, active * 2);
      geo.attributes.position.needsUpdate = true;
      updateSplashes(dt, night);
    },
    // Телепорт игрока (рестарт): капли заново рассыпать вокруг него
    reset() { started = false; clearSplashes(); },
  };

  function anyAlive() { return rp.some((r) => r.age < RING_LIFE); }
  function clearSplashes() { rp.forEach((r) => (r.age = 9)); sp.forEach((s) => (s.age = 9)); }
}
