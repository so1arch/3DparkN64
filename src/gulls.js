import * as THREE from 'three';

// Чайки с фонарями для ночных уровней.
// Парят над уровнем, покачиваются вверх-вниз, отлетают от игрока и продолжают светить.
// Реальных источников света всего GULL.POOL штук: они переходят к ближайшим к игроку чайкам.

// ---------- Настройки (можно крутить) ----------
export const GULL = {
  HOVER: 6,        // на какой высоте над платформой парит чайка, м
  COVER: 17,       // платформа считается освещённой, если до чайки не дальше (3D), м
  MAX: 14,         // максимум чаек на уровень
  NEAR: 8,         // игрок ближе (по горизонтали): чайка отлетает
  STAND: 10,       // на каком расстоянии она держится от игрока
  MIN_ABOVE: 4.5,  // минимум над головой игрока
  LEASH: 24,       // максимум увода от своей точки по горизонтали
  SIZE: 0.85,      // общий масштаб чайки
  POOL: 4,         // сколько настоящих источников света (дорого для GPU)
  ACTIVE: 3,       // сколько ближайших чаек светят
  LIGHT_RANGE: 75, // дальше этого чайка не светит
  // тёплый уютный свет: низкое затухание и большой радиус = мягкое рассеянное освещение
  LIGHT: { color: 0xffb561, intensity: 26, distance: 32, decay: 1.2 },
};

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function wingGeo(pts) {
  const s = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y)));
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2); // y формы -> назад (-Z)
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createGulls(scene) {
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);

  // Общие геометрии и материалы
  const G = {
    ball: new THREE.SphereGeometry(1, 7, 5),
    box: new THREE.BoxGeometry(1, 1, 1),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 5),
    beak: new THREE.ConeGeometry(0.07, 0.34, 5).rotateX(Math.PI / 2), // вершина смотрит в +Z
    inner: wingGeo([[0, -0.3], [0.8, -0.22], [0.8, 0.18], [0, 0.36]]),
    outer: wingGeo([[0, -0.22], [0.95, 0.3], [0, 0.18]]),
  };
  const M = {
    body: new THREE.MeshLambertMaterial({ color: 0xf2f0ea, emissive: 0x1d1a14, flatShading: true }),
    wing: new THREE.MeshLambertMaterial({ color: 0xe9ebf0, emissive: 0x15171c, flatShading: true, side: THREE.DoubleSide }),
    tip: new THREE.MeshLambertMaterial({ color: 0x353b4b, flatShading: true, side: THREE.DoubleSide }),
    orange: new THREE.MeshLambertMaterial({ color: 0xffa726, emissive: 0x2e1800, flatShading: true }),
    dark: new THREE.MeshBasicMaterial({ color: 0x111111 }),
    frame: new THREE.MeshLambertMaterial({ color: 0x4a3524, flatShading: true }),
    glass: new THREE.MeshBasicMaterial({ color: 0xffd490, fog: false }), // не тонет в тумане: лампы видно издалека
  };
  const glowTex = glowTexture();

  // Пул настоящих источников света
  const L = GULL.LIGHT;
  const pool = Array.from({ length: GULL.POOL }, () => {
    const l = new THREE.PointLight(L.color, 0, L.distance, L.decay);
    root.add(l);
    return l;
  });

  let list = [];

  function makeGull() {
    const g = new THREE.Group(), body = new THREE.Group();
    g.add(body); // g — позиция и курс, body — крен и тангаж
    const add = (parent, geo, mat, x, y, z, sx, sy, sz) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.scale.set(sx, sy, sz); parent.add(m); return m;
    };
    add(body, G.ball, M.body, 0, 0, 0, 0.3, 0.26, 0.72);         // тело
    add(body, G.ball, M.body, 0, 0.14, 0.7, 0.2, 0.2, 0.2);      // голова
    add(body, G.beak, M.orange, 0, 0.1, 1.0, 1, 1, 1);           // клюв
    for (const sd of [-1, 1]) add(body, G.box, M.dark, sd * 0.13, 0.2, 0.78, 0.04, 0.04, 0.04); // глаза
    add(body, G.box, M.body, 0, 0.03, -0.85, 0.34, 0.04, 0.45);  // хвост

    // Крылья: плечо + кончик (кончик тёмный, как у настоящих чаек)
    const wings = [];
    for (const side of [1, -1]) {
      const inner = new THREE.Group();
      inner.position.set(side * 0.25, 0.12, 0.15); inner.scale.x = side;
      inner.add(new THREE.Mesh(G.inner, M.wing));
      const outer = new THREE.Group();
      outer.position.x = 0.8;
      outer.add(new THREE.Mesh(G.outer, M.tip));
      inner.add(outer); body.add(inner);
      wings.push({ inner, outer, side });
    }

    // Лапки и фонарь на верёвке
    for (const sd of [-1, 1]) add(body, G.cyl, M.orange, sd * 0.09, -0.36, 0.12, 0.022, 0.34, 0.022);
    const swing = new THREE.Group();
    swing.position.set(0, -0.54, 0.12);
    body.add(swing);
    add(swing, G.cyl, M.frame, 0, -0.25, 0, 0.012, 0.5, 0.012);   // верёвка
    add(swing, G.box, M.frame, 0, -0.52, 0, 0.22, 0.05, 0.22);    // крышка
    add(swing, G.box, M.glass, 0, -0.67, 0, 0.16, 0.24, 0.16);    // «пламя» за стеклом
    add(swing, G.box, M.frame, 0, -0.81, 0, 0.22, 0.04, 0.22);    // дно
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(swing, G.box, M.frame, sx * 0.09, -0.67, sz * 0.09, 0.025, 0.26, 0.025);
    const anchor = new THREE.Object3D();
    anchor.position.set(0, -0.67, 0);
    swing.add(anchor);
    const glowMat = new THREE.SpriteMaterial({
      map: glowTex, color: 0xffb561, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, fog: false, opacity: 0.6,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.position.set(0, -0.67, 0); glow.scale.setScalar(3.2);
    swing.add(glow);
    return { g, body, wings, swing, anchor, glowMat };
  }

  function clear() {
    for (const s of list) { root.remove(s.g); s.glowMat.dispose(); }
    list = [];
  }

  // plats — массив платформ уровня, goal и start — [x,y,z]
  function build(plats, goal, start, seedStr) {
    clear();
    const R = rng(hashStr(String(seedStr)));
    const homes = [];
    const covered = (x, y, z) => homes.some((h) => Math.hypot(h[0] - x, h[1] - y, h[2] - z) < GULL.COVER);
    const addHome = (x, y, z) => homes.push([x, y + GULL.HOVER + R() * 1.5, z]);

    for (let i = 0; i < plats.length && homes.length < GULL.MAX; i++) {
      const a = plats[i];
      if (covered(a[0], a[1], a[2])) continue;
      // смещаем чайку вперёд по пути, к следующей платформе, чтобы освещать дорогу
      const nx = plats[i + 1];
      let ox = 0, oz = 0;
      if (nx) {
        const dx = nx[0] - a[0], dz = nx[2] - a[2], len = Math.hypot(dx, dz) || 1;
        let off = clamp(len * 0.6, 4, 7);
        if (i === 0) off = Math.max(off, GULL.NEAR + 2); // на старте не отлетает сразу
        ox = (dx / len) * off; oz = (dz / len) * off;
      }
      addHome(a[0] + ox, a[1], a[2] + oz);
    }
    if (goal && homes.length < GULL.MAX && !covered(goal[0], goal[1] - 1.6, goal[2])) addHome(goal[0], goal[1] - 1.6, goal[2]);

    for (const [hx, hy, hz] of homes) {
      const m = makeGull();
      const s = {
        ...m,
        home: new THREE.Vector3(hx, hy, hz), pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        ph: R() * 6.28, orbitR: 2.5 + R() * 1.5, orbitA: R() * 6.28, orbitW: (R() < 0.5 ? 1 : -1) * (0.45 + R() * 0.2),
        yaw: R() * 6.28, yawRate: 0, roll: 0, pitch: 0, swX: 0, swZ: 0,
        flee: false, fleeA: R() * 6.28, flapAmt: 0, fp: R() * 6.28, burst: false, flapT: 1 + R() * 4,
        lit: 0, dist: 0, fl: 1,
      };
      s.pos.set(hx + Math.cos(s.orbitA) * s.orbitR, hy, hz + Math.sin(s.orbitA) * s.orbitR);
      s.g.position.copy(s.pos);
      root.add(s.g);
      list.push(s);
    }
  }

  function update(dt, t, pl, cam) {
    if (!root.visible || !list.length) return;
    dt = Math.min(dt, 0.05);
    const NEAR = GULL.NEAR, STAND = GULL.STAND;

    for (const s of list) {
      const gx = s.pos.x - pl.x, gz = s.pos.z - pl.z, gd = Math.hypot(gx, gz);
      const homeD = Math.hypot(s.home.x - pl.x, s.home.z - pl.z);
      // гистерезис: убегаем, когда игрок близко; возвращаемся, когда «дом» свободен
      if (!s.flee && gd < NEAR) s.flee = true;
      else if (s.flee && homeD > NEAR + s.orbitR + 1.5) s.flee = false;

      const bob = Math.sin(t * 0.9 + s.ph) * 0.35 + Math.sin(t * 0.37 + s.ph * 2) * 0.25; // лёгкое покачивание вверх-вниз
      let tx, ty, tz, maxSp;
      if (s.flee) {
        let dx = gx, dz = gz, l = gd;
        if (l < 0.5) { dx = Math.cos(s.fleeA); dz = Math.sin(s.fleeA); l = 1; }
        dx /= l; dz /= l;
        if (gd < STAND) { tx = pl.x + dx * STAND; tz = pl.z + dz * STAND; } else { tx = s.pos.x; tz = s.pos.z; }
        const lx = tx - s.home.x, lz = tz - s.home.z, ll = Math.hypot(lx, lz);
        if (ll > GULL.LEASH) { tx = s.home.x + (lx / ll) * GULL.LEASH; tz = s.home.z + (lz / ll) * GULL.LEASH; }
        ty = clamp(pl.y + GULL.MIN_ABOVE + 1, s.home.y, s.home.y + 16) + bob;
        maxSp = gd < STAND - 1 ? 11 : 5;
      } else {
        s.orbitA += s.orbitW * dt; // парение кругами над своей точкой
        tx = s.home.x + Math.cos(s.orbitA) * s.orbitR;
        tz = s.home.z + Math.sin(s.orbitA) * s.orbitR;
        ty = s.home.y + bob; maxSp = 5;
      }

      // Скорость: плавно тянемся к цели
      let vx = (tx - s.pos.x) * 2, vy = (ty - s.pos.y) * 2, vz = (tz - s.pos.z) * 2;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > maxSp) { const f = maxSp / sp; vx *= f; vy *= f; vz *= f; }
      const a = 1 - Math.exp(-2.5 * dt);
      s.vel.x += (vx - s.vel.x) * a; s.vel.y += (vy - s.vel.y) * a; s.vel.z += (vz - s.vel.z) * a;
      s.pos.addScaledVector(s.vel, dt);

      // Курс, крен, тангаж
      const sh = Math.hypot(s.vel.x, s.vel.z);
      if (sh > 0.6) {
        const d = wrap(Math.atan2(s.vel.x, s.vel.z) - s.yaw);
        s.yawRate += (d * 3 - s.yawRate) * (1 - Math.exp(-6 * dt));
        s.yaw = wrap(s.yaw + s.yawRate * dt);
      } else s.yawRate *= Math.exp(-4 * dt);
      const kr = 1 - Math.exp(-4 * dt);
      s.roll += (-clamp(s.yawRate * 0.4, -0.5, 0.5) - s.roll) * kr;
      s.pitch += (clamp(-s.vel.y * 0.08, -0.35, 0.35) - s.pitch) * kr;

      // Крылья: то планируют, то машут сериями; при бегстве машут всё время
      s.flapT -= dt;
      if (!s.flee && s.flapT <= 0) { s.burst = !s.burst; s.flapT = s.burst ? 1 + Math.random() * 1.2 : 3 + Math.random() * 4; }
      const target = s.flee ? (sh > 2 ? 1 : 0.55) : (s.burst ? 1 : 0);
      s.flapAmt += (target - s.flapAmt) * (1 - Math.exp(-5 * dt));
      s.fp += dt * Math.PI * 2 * (s.flee ? (sh > 2 ? 3.4 : 2.6) : 2.3);
      const gl = 0.12 + 0.04 * Math.sin(t * 1.3 + s.ph), go = -0.12 + 0.05 * Math.sin(t * 1.1 + s.ph * 1.5); // планирование: «M»-образный профиль
      const fi = 0.12 + 0.75 * Math.sin(s.fp), fo = -0.08 + 0.6 * Math.sin(s.fp - 0.9);                       // взмах
      const ai = gl + (fi - gl) * s.flapAmt, ao = go + (fo - go) * s.flapAmt;
      for (const w of s.wings) { w.inner.rotation.z = w.side * ai; w.outer.rotation.z = ao; }
      const flapBob = Math.sin(s.fp - 0.4) * s.flapAmt;
      s.body.position.y = flapBob * 0.07;
      s.body.rotation.set(s.pitch + flapBob * 0.05, 0, s.roll);

      // Фонарь раскачивается: отстаёт от движения и слегка качается сам
      const sy = Math.sin(s.yaw), cy = Math.cos(s.yaw);
      const vlz = s.vel.x * sy + s.vel.z * cy, vlx = s.vel.x * cy - s.vel.z * sy;
      const tX = clamp(vlz * 0.045, -0.45, 0.45) + Math.sin(t * 1.6 + s.ph) * 0.05;
      const tZ = clamp(-vlx * 0.045, -0.45, 0.45) + Math.sin(t * 1.3 + s.ph * 1.7) * 0.04;
      const ks = 1 - Math.exp(-5 * dt);
      s.swX += (tX - s.swX) * ks; s.swZ += (tZ - s.swZ) * ks;
      s.swing.rotation.set(s.swX - s.body.rotation.x, 0, s.swZ - s.body.rotation.z); // фонарь всегда висит вниз

      s.g.position.copy(s.pos);
      s.g.rotation.y = s.yaw;

      // Мерцание огонька
      s.fl = 1 + 0.05 * Math.sin(t * 7.3 + s.ph) + 0.03 * Math.sin(t * 12.7 + s.ph * 2.3);
      s.glowMat.opacity = 0.55 * s.fl;

      // Рядом с камерой чайка растворяется, чтобы не закрывать обзор
      const f = sstep(1.5, 5, s.pos.distanceTo(cam));
      s.g.visible = f > 0.02;
      s.g.scale.setScalar(GULL.SIZE * Math.max(f, 0.02));
      s.dist = Math.hypot(s.pos.x - pl.x, s.pos.y - pl.y, s.pos.z - pl.z);
    }

    // Светят только ближайшие чайки, остальные плавно гаснут (настоящих ламп всего POOL)
    const order = [...list].sort((p, q) => p.dist - q.dist);
    order.forEach((s, i) => {
      const want = i < GULL.ACTIVE && s.dist < GULL.LIGHT_RANGE ? 1 : 0;
      s.lit += (want - s.lit) * (1 - Math.exp(-3 * dt));
    });
    const byLit = [...list].sort((p, q) => q.lit - p.lit);
    for (let i = 0; i < pool.length; i++) {
      const l = pool[i], s = byLit[i];
      if (s && s.lit > 0.01) { s.anchor.getWorldPosition(l.position); l.intensity = L.intensity * s.lit * s.fl; }
      else l.intensity = 0;
    }
  }

  return {
    root, build, update,
    setActive(on) { root.visible = !!on; },
  };
}
