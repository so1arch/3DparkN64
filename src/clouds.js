import * as THREE from 'three';

// Динамические облака: пушистые кучки из низкополигональных шаров.
// Дрейфуют по ветру, «дышат», уходят за край поля и возвращаются с другой стороны.
// Три слоя: море облаков под уровнем, редкие облака высоко над ним и облака вокруг.
// Все шары рисуются одним InstancedMesh — это один вызов отрисовки.
const WIND_X = 3.4, WIND_Z = 1.2;

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function createClouds(scene, opts = {}) {
  const COUNT = opts.count ?? 36, PUFFS = opts.puffs ?? 7; // в лёгком режиме облаков меньше и они проще
  const R = rng(2024);
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 7, 5),
    new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x7388b0, flatShading: true }),
    COUNT * PUFFS
  );
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);

  const field = { cx: 0, cz: 0, r: 160, low: -10, high: 10 }; // куда подстраиваемся (уровень)
  const cur = { low: -10, high: 10 };                           // плавно догоняют field
  let first = true;

  const clouds = [];
  for (let i = 0; i < COUNT; i++) {
    const layer = i % 3; // 0: внизу, 1: высоко, 2: вокруг
    const size = layer === 0 ? 4 + R() * 4 : layer === 1 ? 2.5 + R() * 3 : 2 + R() * 3;
    const puffs = [];
    for (let j = 0; j < PUFFS; j++) {
      const a = (j / PUFFS) * Math.PI * 2 + R(), rad = j === 0 ? 0 : 0.6 + R() * 1.1;
      puffs.push({
        ox: Math.cos(a) * rad * 1.5, oz: Math.sin(a) * rad * 0.9,
        oy: (1 - rad / 2) * 0.5 + R() * 0.2, r: j === 0 ? 1.5 : 0.8 + R() * 0.7, ph: R() * 6.28,
      });
    }
    clouds.push({ layer, size, fy: R(), x: (R() - 0.5) * 320, z: (R() - 0.5) * 320, sp: 0.6 + R() * 0.9, puffs });
  }

  const dummy = new THREE.Object3D();

  return {
    // Подстроить поле облаков под уровень: центр, радиус, нижняя и верхняя высоты платформ
    setBands({ cx, cz, r, low, high }) {
      field.cx = cx; field.cz = cz; field.r = Math.max(130, r); field.low = low; field.high = high;
    },
    update(dt, t, cam) {
      const k = first ? 1 : 1 - Math.exp(-2 * dt);
      cur.low += (field.low - cur.low) * k;
      cur.high += (field.high - cur.high) * k;
      first = false;
      const R2 = field.r * 2;
      let idx = 0;
      for (const c of clouds) {
        c.x += WIND_X * c.sp * dt; c.z += WIND_Z * c.sp * dt;
        // возвращаем облако в поле вокруг уровня
        c.x = field.cx + ((((c.x - field.cx + field.r) % R2) + R2) % R2) - field.r;
        c.z = field.cz + ((((c.z - field.cz + field.r) % R2) + R2) % R2) - field.r;
        const y = c.layer === 0 ? cur.low - 8 - c.fy * 18
          : c.layer === 1 ? cur.high + 14 + c.fy * 34
            : cur.low + 2 + c.fy * (cur.high - cur.low + 10);
        // рядом с камерой облако растворяется, чтобы не закрывать обзор
        const d = Math.hypot(c.x - cam.x, y - cam.y, c.z - cam.z);
        const fade = sstep(c.size * 1.5 + 4, c.size * 1.5 + 22, d);
        for (const p of c.puffs) {
          const s = Math.max(1e-4, p.r * c.size * fade * (1 + 0.07 * Math.sin(t * 0.55 + p.ph)));
          dummy.position.set(c.x + p.ox * c.size, y + (p.oy + 0.15 * Math.sin(t * 0.3 + p.ph)) * c.size, c.z + p.oz * c.size);
          dummy.scale.set(s, s * 0.72, s * 0.95);
          dummy.updateMatrix();
          mesh.setMatrixAt(idx++, dummy.matrix);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
