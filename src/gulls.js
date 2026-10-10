// src/gulls.js — чайки с фонариками: ночью парят над частью платформ и освещают их тёплым светом.
//
// • Места выбираются из платформ уровня детерминированно (один уровень — одни и те же места):
//   всегда у старта и у звезды, дальше выборочно, с минимальным расстоянием друг от друга;
//   если участок без света получается слишком длинным, чайка ставится принудительно.
// • Игрок подошёл ближе FLEE — чайка плавно отлетает (и чуть поднимается), но остаётся
//   в радиусе света платформы. Ушёл — возвращается на своё место.
// • Парение: покачивание вверх-вниз, лёгкий дрейф, медленные взмахи крыльев, качающийся фонарь.
// • Свет: тёплый ненаправленный PointLight. Живых источников фиксированное число (K): они
//   переходят к ближайшим к игроку чайкам с плавным угасанием/зажиганием, поэтому шейдеры
//   не перекомпилируются. У остальных чаек светится только спрайт-ореол.
// Всё рисуется кодом, внешних файлов нет.

import * as THREE from 'three';
import { rngFrom } from './gen.js';

// ── Настройки ──────────────────────────────────────────────────
const MAX_GULLS = 12;
const HOVER = 6.2;        // высота парения над платформой
const MIN_GAP = 13;       // минимальное расстояние между чайками
const FILL_GAP = 21;      // если ближайшая чайка дальше, ставим принудительно
const FLEE = 7;           // игрок ближе — чайка отлетает
const DRIFT = 6.5;        // максимум смещения в сторону от своей точки
const LIFT = 2.6;         // максимум подъёма при испуге
const CAM_R = 5.5;        // чайка держится дальше этого от линии «камера → игрок» (чтобы не закрывать обзор)
const CAM_NEAR = 9;       // у самой камеры радиус больше
const CAM_PUSH = 9;       // максимум смещения из-за камеры
const MAX_OFF = 11;       // дальше этого от своей точки чайка не уходит (чтобы всё ещё светить платформе)
const LIGHT_COLOR = 0xffb866;
const LIGHT_INT = 100;    // сила света (кандела), подбирайте по вкусу
const LIGHT_DIST = 24;    // радиус действия света
const SCALE = 1.4;        // общий размер чайки
const LAMP_Y = -0.84;     // центр фонаря относительно тела (до масштаба)

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (x, to, d) => (x < to ? Math.min(to, x + d) : Math.max(to, x - d));

// ── Выбор мест ─────────────────────────────────────────────────
function pickSpots(lv) {
  const plats = lv.plats || [];
  if (!plats.length) return [];
  const R = rngFrom(`gulls|${lv.seed ?? lv.name ?? ''}|${plats.length}`);
  const cps = lv.cps || [];
  const isHub = (a) => cps.some((c) => Math.abs(c[0] - a[0]) < 0.01 && Math.abs(c[2] - a[2]) < 0.01);
  const nearest = (x, z) => {
    let bi = 0, bd = Infinity;
    plats.forEach((a, i) => { const d = Math.hypot(a[0] - x, a[2] - z); if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  const dist = (i, j) => Math.hypot(plats[i][0] - plats[j][0], plats[i][2] - plats[j][2], (plats[i][1] - plats[j][1]) * 0.5);
  const nearOf = (i, list) => list.reduce((m, j) => Math.min(m, dist(i, j)), Infinity);

  const chosen = [];
  chosen.push(nearest(lv.start[0], lv.start[2]));
  const gi = nearest(lv.goal[0], lv.goal[2]);
  if (!chosen.includes(gi) && nearOf(gi, chosen) >= MIN_GAP * 0.6) chosen.push(gi);

  for (let i = 0; i < plats.length && chosen.length < MAX_GULLS; i++) {
    const a = plats[i], roll = R(); // R() вызываем всегда: результат не зависит от ветвлений
    if (chosen.includes(i)) continue;
    const near = nearOf(i, chosen);
    if (near < MIN_GAP) continue;
    const p = clamp(0.22 + 0.05 * (Math.min(a[3], a[4]) - 3) + (isHub(a) ? 0.25 : 0), 0.12, 0.7);
    if (roll < p || near >= FILL_GAP) chosen.push(i);
  }

  return chosen.map((i) => {
    const a = plats[i], ang = R() * Math.PI * 2, r = 0.8 + R() * 1.2;
    return {
      x: a[0] + Math.cos(ang) * r, z: a[2] + Math.sin(ang) * r,
      y: a[1] + HOVER + (R() - 0.5) * 0.8, ph: R() * Math.PI * 2, yaw: R() * Math.PI * 2,
    };
  });
}

// ── Модель ─────────────────────────────────────────────────────
export function createGulls(scene, { high = true } = {}) {
  const K = high ? 3 : 2; // сколько чаек светят по-настоящему

  const lam = (color, emissive) => new THREE.MeshLambertMaterial({ color, emissive, flatShading: true });
  const M = {
    white: lam(0xf2f2ee, 0x2b3046),
    tip: lam(0x7b8190, 0x1a1d2a),
    beak: lam(0xffb21e, 0x3a2600),
    leg: lam(0xe8873a, 0x2a1400),
    metal: lam(0x3b2c1e, 0x120c06),
    eye: new THREE.MeshBasicMaterial({ color: 0x111111 }),
    core: new THREE.MeshBasicMaterial({ color: 0xffd592 }),
  };
  const G = {
    body: new THREE.SphereGeometry(0.28, 7, 5).scale(0.78, 0.66, 1.5),
    head: new THREE.SphereGeometry(0.16, 6, 5),
    beak: new THREE.ConeGeometry(0.055, 0.24, 5).rotateX(Math.PI / 2),
    eye: new THREE.BoxGeometry(0.03, 0.03, 0.03),
    tail: new THREE.BoxGeometry(0.22, 0.03, 0.3),
    wingL: new THREE.BoxGeometry(0.56, 0.04, 0.36).translate(-0.28, 0, 0),
    wingR: new THREE.BoxGeometry(0.56, 0.04, 0.36).translate(0.28, 0, 0),
    tipL: new THREE.BoxGeometry(0.5, 0.03, 0.26).translate(-0.25, 0, 0),
    tipR: new THREE.BoxGeometry(0.5, 0.03, 0.26).translate(0.25, 0, 0),
    leg: new THREE.BoxGeometry(0.025, 0.34, 0.025).translate(0, -0.17, 0),
    handle: new THREE.BoxGeometry(0.02, 0.14, 0.02),
    cap: new THREE.BoxGeometry(0.2, 0.04, 0.2),
    post: new THREE.BoxGeometry(0.018, 0.22, 0.018),
    glass: new THREE.BoxGeometry(0.13, 0.2, 0.13),
  };

  // Ореол вокруг фонаря
  const gc = document.createElement('canvas'); gc.width = gc.height = 64;
  const gg = gc.getContext('2d'), grd = gg.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,236,190,1)'); grd.addColorStop(0.18, 'rgba(255,200,120,0.75)');
  grd.addColorStop(0.5, 'rgba(255,160,70,0.18)'); grd.addColorStop(1, 'rgba(255,140,60,0)');
  gg.fillStyle = grd; gg.fillRect(0, 0, 64, 64);
  const glowTex = new THREE.CanvasTexture(gc); glowTex.colorSpace = THREE.SRGBColorSpace;
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false, opacity: 0 });

  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const objects = []; // спрайты: их прячем при расчёте SSAO

  const mesh = (geo, mat, parent, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m;
  };
  const pivot = (parent, x, y, z) => { const p = new THREE.Group(); p.position.set(x, y, z); parent.add(p); return p; };

  function buildRig() {
    const rig = new THREE.Group(); group.add(rig);
    const body = pivot(rig, 0, 0, 0); // сюда идут крен и тангаж
    mesh(G.body, M.white, body);
    mesh(G.head, M.white, body, 0, 0.15, 0.4);
    mesh(G.beak, M.beak, body, 0, 0.12, 0.62);
    mesh(G.eye, M.eye, body, -0.1, 0.2, 0.5); mesh(G.eye, M.eye, body, 0.1, 0.2, 0.5);
    const tail = mesh(G.tail, M.white, body, 0, 0.02, -0.5); tail.rotation.x = -0.12;

    const wl = pivot(body, -0.2, 0.1, 0.05), wr = pivot(body, 0.2, 0.1, 0.05);
    mesh(G.wingL, M.white, wl); mesh(G.wingR, M.white, wr);
    const wlo = pivot(wl, -0.56, 0, 0), wro = pivot(wr, 0.56, 0, 0);
    mesh(G.tipL, M.tip, wlo); mesh(G.tipR, M.tip, wro);

    for (const sx of [-1, 1]) { const l = mesh(G.leg, M.leg, body, sx * 0.07, -0.2, 0.05); l.rotation.x = -0.25; }

    // Фонарь на лапках
    const lamp = pivot(body, 0, -0.55, 0.13);
    mesh(G.handle, M.metal, lamp, 0, -0.07, 0);
    mesh(G.cap, M.metal, lamp, 0, -0.16, 0);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) mesh(G.post, M.metal, lamp, sx * 0.085, -0.29, sz * 0.085);
    mesh(G.glass, M.core, lamp, 0, -0.29, 0);
    mesh(G.cap, M.metal, lamp, 0, -0.42, 0);
    const sprite = new THREE.Sprite(glowMat);
    sprite.position.set(0, -0.29, 0); sprite.scale.setScalar(2.2); sprite.renderOrder = 7;
    lamp.add(sprite); objects.push(sprite);

    rig.visible = false;
    return { rig, body, wl, wr, wlo, wro, lamp, sprite };
  }

  const rigs = Array.from({ length: MAX_GULLS }, () => ({
    ...buildRig(), active: false, pos: new THREE.Vector3(), anchor: new THREE.Vector3(),
    lp: new THREE.Vector3(), ph: 0, yaw: 0, fp: 0, bank: 0, d: Infinity,
  }));

  // Живые источники света
  const slots = Array.from({ length: K }, () => {
    const l = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DIST, 2);
    scene.add(l);
    return { l, g: null, f: 0 };
  });

  const T = new THREE.Vector3();
  let shown = false;

  function snap() { rigs.forEach((g) => g.pos.copy(g.anchor)); }

  return {
    objects,

    // Расставить чаек под уровень (дёшево, можно вызывать при каждой перестройке)
    setLevel(lv) {
      const spots = pickSpots(lv);
      rigs.forEach((g, i) => {
        const s = spots[i];
        g.active = !!s;
        g.rig.visible = false;
        if (!s) return;
        g.anchor.set(s.x, s.y, s.z); g.pos.copy(g.anchor);
        g.ph = s.ph; g.yaw = s.yaw; g.bank = 0; g.d = Infinity;
      });
      slots.forEach((s) => { s.g = null; s.f = 0; s.l.intensity = 0; });
    },

    // Игрок телепортировался (рестарт): чайки возвращаются на места сразу
    reset: snap,

    // player — позиция ног игрока, night — 0..1 (env.ns), 0 — чаек нет вообще, cam — позиция камеры (чайки её облетают)
    update(dt, t, player, night, cam) {
      if (night <= 0.01) {
        if (shown) { shown = false; group.visible = false; slots.forEach((s) => { s.l.intensity = 0; s.g = null; s.f = 0; }); }
        return;
      }
      shown = true; group.visible = true;
      dt = Math.max(dt, 1e-4);
      glowMat.opacity = 0.9 * night;
      const k = Math.min(1, night * 4);
      const px = player.x, py = player.y + 1, pz = player.z;
      const abx = cam ? px - cam.x : 0, aby = cam ? py - cam.y : 0, abz = cam ? pz - cam.z : 0;
      const ab2 = abx * abx + aby * aby + abz * abz || 1;

      for (const g of rigs) {
        if (!g.active) continue;

        // Куда хочет лететь: на свою точку, но прочь от камеры (и от линии камера → игрок) и от игрока
        T.copy(g.anchor);
        let camHit = false;
        for (let it = 0; it < 2; it++) {
          if (cam) {
            const u = clamp(((T.x - cam.x) * abx + (T.y - cam.y) * aby + (T.z - cam.z) * abz) / ab2, 0, 1);
            const ex = T.x - (cam.x + abx * u), ey = T.y - (cam.y + aby * u), ez = T.z - (cam.z + abz * u);
            const e = Math.hypot(ex, ey, ez), R = CAM_R + (CAM_NEAR - CAM_R) * (1 - u);
            if (e < R) {
              const push = Math.min(CAM_PUSH, (R - e) * 1.3);
              if (e > 0.05) { T.x += (ex / e) * push; T.y += (ey / e) * push; T.z += (ez / e) * push; }
              else { T.x += Math.cos(g.ph) * push; T.y += push * 0.5; T.z += Math.sin(g.ph) * push; }
              camHit = true;
            }
          }
          const dx = T.x - px, dy = T.y - py, dz = T.z - pz, d = Math.hypot(dx, dy, dz);
          if (d < FLEE) {
            const s2 = FLEE - d, hd = Math.hypot(dx, dz);
            const nx = hd > 0.05 ? dx / hd : Math.cos(g.ph), nz = hd > 0.05 ? dz / hd : Math.sin(g.ph);
            const push = Math.min(DRIFT, s2 * 1.1);
            T.x += nx * push; T.z += nz * push; T.y += Math.min(LIFT, s2 * 0.6);
          }
        }
        // не улетаем так далеко, чтобы перестать светить своей платформе
        const ox2 = T.x - g.anchor.x, oz2 = T.z - g.anchor.z, ho = Math.hypot(ox2, oz2);
        if (ho > MAX_OFF) { T.x = g.anchor.x + (ox2 / ho) * MAX_OFF; T.z = g.anchor.z + (oz2 / ho) * MAX_OFF; }
        T.y = Math.min(T.y, g.anchor.y + LIFT + 7);
        const follow = 1 - Math.exp(-(camHit ? 4.5 : 2.4) * dt); // от камеры уходим бодрее
        const ox = g.pos.x, oy = g.pos.y, oz = g.pos.z;
        g.pos.x += (T.x - g.pos.x) * follow; g.pos.y += (T.y - g.pos.y) * follow; g.pos.z += (T.z - g.pos.z) * follow;
        const vx = (g.pos.x - ox) / dt, vy = (g.pos.y - oy) / dt, vz = (g.pos.z - oz) / dt;
        const sp = Math.hypot(vx, vz);

        // Парение: покачивание и лёгкий дрейф
        const rig = g.rig;
        rig.position.set(
          g.pos.x + Math.sin(t * 0.7 + g.ph * 1.3) * 0.45,
          g.pos.y + Math.sin(t * 1.6 + g.ph) * 0.35,
          g.pos.z + Math.cos(t * 0.55 + g.ph) * 0.45,
        );
        g.d = Math.hypot(rig.position.x - px, rig.position.y - py, rig.position.z - pz);
        // если всё же оказалась рядом с камерой — плавно уменьшается и исчезает, а не закрывает экран
        const fade = cam ? sstep(1.8, 5, Math.hypot(rig.position.x - cam.x, rig.position.y - cam.y, rig.position.z - cam.z)) : 1;
        rig.visible = g.d < 120 && fade > 0.02;
        g.fade = fade;
        if (!rig.visible) continue;
        rig.scale.setScalar(SCALE * k * fade);

        // Поворот: в полёте по ходу движения, в покое лениво поглядывает на игрока
        const flying = sp > 0.5;
        const target = flying ? Math.atan2(vx, vz) : Math.atan2(px - rig.position.x, pz - rig.position.z);
        const diff = wrap(target - g.yaw);
        g.yaw += diff * (1 - Math.exp(-(flying ? 5 : 1.2) * dt));
        g.bank += (clamp(-diff * 0.5, -0.35, 0.35) - g.bank) * Math.min(1, 4 * dt);
        rig.rotation.y = g.yaw;
        g.body.rotation.z = g.bank;
        g.body.rotation.x = clamp(-vy * 0.06, -0.3, 0.3);

        // Крылья: в покое медленно, при отлёте чаще и шире
        const fl = clamp(sp / 4, 0, 1);
        g.fp += dt * (2.4 + 7 * fl);
        const amp = 0.22 + 0.3 * fl, flap = 0.12 + Math.sin(g.fp) * amp, lag = Math.sin(g.fp - 0.8) * amp * 0.7;
        g.wl.rotation.z = -flap; g.wr.rotation.z = flap;
        g.wlo.rotation.z = -lag; g.wro.rotation.z = lag;

        // Фонарь качается и мерцает
        const flick = 1 + 0.05 * Math.sin(t * 8.3 + g.ph) + 0.03 * Math.sin(t * 21 + g.ph * 2);
        g.lamp.rotation.z = Math.sin(t * 1.3 + g.ph) * 0.07 - g.bank * 0.4;
        g.sprite.scale.setScalar(2.2 * flick);
        g.flick = flick;
        g.lp.set(rig.position.x, rig.position.y + LAMP_Y * SCALE * k, rig.position.z);
      }

      // Настоящий свет — только ближайшим к игроку; передача плавная
      const want = rigs.filter((g) => g.active && g.rig.visible && g.d < LIGHT_DIST + 30).sort((a, b) => a.d - b.d).slice(0, K);
      for (const s of slots) {
        const keep = s.g && want.includes(s.g);
        s.f = approach(s.f, keep ? 1 : 0, dt * 2.5);
        if (!keep && s.f <= 0.01) s.g = null;
      }
      for (const g of want) {
        if (slots.some((s) => s.g === g)) continue;
        const free = slots.find((s) => !s.g);
        if (free) { free.g = g; free.f = 0; }
      }
      for (const s of slots) {
        if (!s.g) { s.l.intensity = 0; continue; }
        s.l.position.copy(s.g.lp);
        s.l.intensity = LIGHT_INT * night * s.f * (s.g.flick || 1);
      }
    },
  };
}
