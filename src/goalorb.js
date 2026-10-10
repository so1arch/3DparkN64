// src/goalorb.js — финишный шар: жёлтое светящееся ядро с тёмным ореолом, лучами и «созвездием» искр внутри.
//
// • Ядро — низкополигональная сфера с шейдером: светлая середина, янтарный край, лёгкая «лепка» формы, крапинки.
// • Вокруг: тёмно-янтарный ореол (чтобы шар был виден и на светлом небе), мягкое жёлтое сияние, лучи, которые
//   медленно вращаются, и несколько ярких точек, соединённых тонкими линиями.
// • Настоящий свет: один жёлтый PointLight (создаётся один раз, число источников света не меняется,
//   поэтому шейдеры не перекомпилируются).
// • Пока звезда закрыта (нужны все монеты), шар превращается в серую проволочную сферу без свечения.
// Всё рисуется кодом, внешних файлов нет.

import * as THREE from 'three';

// ── Настройки ──────────────────────────────────────────────────
const R = 0.55;               // радиус ядра
const LIGHT_COLOR = 0xffc040; // цвет света на платформах
const LIGHT_INT = 35;         // сила света (кандела), подбирайте по вкусу
const LIGHT_DIST = 22;        // радиус действия света
const HALO_SIZE = 8, GLOW_SIZE = 4.2, RAYS_SIZE = 10;

// ── Текстуры ───────────────────────────────────────────────────
function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function radial(g, s, stops) {
  const h = s / 2, gr = g.createRadialGradient(h, h, 0, h, h, h);
  stops.forEach(([o, c]) => gr.addColorStop(o, c));
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
}

const glowTex = canvasTex(64, (g, s) => radial(g, s, [
  [0, 'rgba(255,248,205,1)'], [0.16, 'rgba(255,222,100,0.85)'], [0.45, 'rgba(255,180,40,0.24)'], [1, 'rgba(255,150,20,0)'],
]));
// тёмное «дымчатое» кольцо вокруг шара, как на референсе
const haloTex = canvasTex(64, (g, s) => radial(g, s, [
  [0, 'rgba(110,64,0,0)'], [0.3, 'rgba(110,64,0,0.10)'], [0.55, 'rgba(110,64,0,0.30)'], [1, 'rgba(110,64,0,0)'],
]));
const dotTex = canvasTex(32, (g, s) => radial(g, s, [
  [0, 'rgba(255,255,235,1)'], [0.3, 'rgba(255,235,150,0.9)'], [1, 'rgba(255,200,60,0)'],
]));
// тонкие лучи, расходящиеся из центра (в обе стороны, разной длины)
const raysTex = canvasTex(256, (g, s) => {
  const h = s / 2;
  g.translate(h, h); g.globalCompositeOperation = 'lighter';
  const rays = [[0.30, 0.95, 2.6], [1.05, 0.70, 1.8], [1.90, 1.00, 2.2], [2.70, 0.60, 1.6], [3.50, 0.90, 2.4], [4.20, 0.65, 1.7], [5.00, 1.00, 2.2], [5.70, 0.75, 1.8]];
  for (const back of [0, Math.PI]) for (const [a, len, w] of rays) {
    g.save(); g.rotate(a + back);
    const L = h * len * (back ? 0.7 : 1), gr = g.createLinearGradient(0, 0, L, 0);
    gr.addColorStop(0, 'rgba(255,244,180,0.9)'); gr.addColorStop(0.35, 'rgba(255,205,80,0.35)'); gr.addColorStop(1, 'rgba(255,170,40,0)');
    g.fillStyle = gr; g.fillRect(0, -w / 2, L, w);
    g.restore();
  }
});

// ── Ядро ───────────────────────────────────────────────────────
const coreMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 } },
  transparent: true, depthWrite: false,
  vertexShader: `
    uniform float uTime;
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      vec3 p = position * (1.0 + 0.07 * sin(position.x * 9.0 + uTime * 1.3) * sin(position.y * 8.0 - uTime) * sin(position.z * 10.0 + uTime * 0.7));
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      vN = normalize(normalMatrix * normal); vV = -mv.xyz; vP = position;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform float uTime;
    varying vec3 vN; varying vec3 vV; varying vec3 vP;
    void main() {
      float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
      vec3 col = mix(vec3(1.0, 0.97, 0.78), vec3(1.0, 0.66, 0.08), smoothstep(0.0, 0.95, f));
      float sp = sin(vP.x * 38.0 + uTime) * sin(vP.y * 41.0 - uTime * 1.3) * sin(vP.z * 35.0 + uTime * 0.6);
      col += vec3(1.0, 0.9, 0.5) * smoothstep(0.55, 0.9, sp) * 0.5;
      gl_FragColor = vec4(col, mix(0.95, 0.55, smoothstep(0.3, 1.0, f)));
      #include <colorspace_fragment>
    }`,
});

export function createGoalOrb(lockedMat) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 10, 8), coreMat);
  mesh.userData = { k: 'g' }; mesh.renderOrder = 5;

  const fx = []; // всё, что надо прятать при расчёте SSAO
  const sprite = (map, size, order, extra = {}) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, fog: false, ...extra }));
    s.scale.setScalar(size); s.renderOrder = order; mesh.add(s); fx.push(s); return s;
  };
  sprite(haloTex, HALO_SIZE, 4);
  // Лучи и свечение — это свет в воздухе, а не плоская картинка в мире. Спрайт — плоский квад в плоскости центра шара,
  // и при включённой проверке глубины платформа, которая ближе к камере, отрезала бы его по линии пересечения.
  // Поэтому для аддитивных слоёв проверка глубины выключена: они накладываются поверх сцены, как блик (bloom).
  // Тёмный ореол остаётся с проверкой глубины: поверх близких предметов он выглядел бы пятном.
  const raysA = sprite(raysTex, RAYS_SIZE, 7, { blending: THREE.AdditiveBlending, opacity: 0.8, depthTest: false });
  const raysB = sprite(raysTex, RAYS_SIZE * 0.7, 7, { blending: THREE.AdditiveBlending, opacity: 0.55, depthTest: false });
  const glow = sprite(glowTex, GLOW_SIZE, 8, { blending: THREE.AdditiveBlending, opacity: 0.9, depthTest: false });

  // Искры внутри шара и тонкие линии между ними
  const N = 8, base = [];
  for (let i = 0; i < N; i++) {
    if (i === 0) { base.push([0.02, 0.04, 0.1]); continue; } // «узел», от которого расходятся линии
    const y = 1 - (i / N) * 2 + 0.1, rr = Math.sqrt(Math.max(0, 1 - y * y)), a = i * 2.39996, k = 0.5 + 0.38 * ((i * 0.618) % 1);
    base.push([Math.cos(a) * rr * k, y * k, Math.sin(a) * rr * k]);
  }
  const EDGES = [[0, 1], [0, 2], [0, 3], [0, 5], [2, 4], [3, 6], [5, 7]];
  const pPos = new Float32Array(N * 3), lPos = new Float32Array(EDGES.length * 6);
  const pGeo = new THREE.BufferGeometry(), lGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
  lGeo.setAttribute('position', new THREE.BufferAttribute(lPos, 3).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
    map: dotTex, color: 0xfff2b0, size: 0.3, sizeAttenuation: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  const lines = new THREE.LineSegments(lGeo, new THREE.LineBasicMaterial({
    color: 0xffe9a0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  }));
  for (const o of [points, lines]) { o.frustumCulled = false; o.renderOrder = 6; mesh.add(o); fx.push(o); }

  // Настоящий жёлтый свет на платформах
  const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DIST, 2);
  mesh.add(light);

  let open = true;
  function setOpen(v) {
    open = !!v;
    mesh.material = open ? coreMat : lockedMat;
    fx.forEach((o) => (o.visible = open));
    light.intensity = open ? LIGHT_INT : 0;
  }
  setOpen(true);

  return {
    mesh,
    objects: fx,
    setOpen,
    // t — время игры, с
    update(t) {
      coreMat.uniforms.uTime.value = t;
      if (!open) return;
      for (let i = 0; i < N; i++) {
        const s = 1 + 0.1 * Math.sin(t * 1.7 + i * 1.9);
        pPos[i * 3] = base[i][0] * s; pPos[i * 3 + 1] = base[i][1] * s; pPos[i * 3 + 2] = base[i][2] * s;
      }
      EDGES.forEach(([a, b], i) => {
        lPos.set(pPos.subarray(a * 3, a * 3 + 3), i * 6);
        lPos.set(pPos.subarray(b * 3, b * 3 + 3), i * 6 + 3);
      });
      pGeo.attributes.position.needsUpdate = true; lGeo.attributes.position.needsUpdate = true;
      const flick = 1 + 0.06 * Math.sin(t * 7) + 0.04 * Math.sin(t * 13.7);
      glow.scale.setScalar(GLOW_SIZE * flick);
      raysA.material.rotation = t * 0.25; raysB.material.rotation = 1 - t * 0.17;
      light.intensity = LIGHT_INT * flick;
    },
  };
}
