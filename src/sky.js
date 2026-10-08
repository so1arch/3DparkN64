// Процедурное небо: градиент, солнце с ореолом, облака наверху и «море облаков» внизу.
// Рисует эквиректангулярную картинку (360° x 180°). Без зависимостей от three.js.

// Направление на солнце совпадает с положением DirectionalLight в main.js: (5, 10, 6)
export const SUN = (() => { const v = [5, 10, 6], l = Math.hypot(...v); return v.map((x) => x / l); })();

// ---------- шум ----------
const perm = new Uint16Array(512), val = new Float32Array(256);
(() => {
  let s = 1337;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const idx = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = idx[i & 255];
  for (let i = 0; i < 256; i++) val[i] = rnd();
})();

function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const X = xi & 255, Y = yi & 255;
  const a = val[perm[perm[X] + Y]], b = val[perm[perm[X + 1] + Y]];
  const c = val[perm[perm[X] + Y + 1]], d = val[perm[perm[X + 1] + Y + 1]];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
  let a = 0.5, s = 0, f = 1;
  for (let o = 0; o < 4; o++) { s += a * noise(x * f + o * 7.7, y * f - o * 3.1); f *= 2.03; a *= 0.5; }
  return s / 0.9375;
}

const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

// Градиент по высоте над горизонтом: [высота, r, g, b] (0..1)
const STOPS = [
  [-1.0, 0.27, 0.40, 0.76],
  [-0.45, 0.40, 0.60, 0.90],
  [-0.08, 0.66, 0.82, 1.0],
  [0.0, 0.76, 0.90, 1.0],
  [0.10, 0.58, 0.80, 1.0],
  [0.35, 0.29, 0.57, 0.95],
  [0.75, 0.13, 0.35, 0.80],
  [1.0, 0.07, 0.25, 0.70],
];
function grad(e, out) {
  let i = 0;
  while (i < STOPS.length - 2 && e > STOPS[i + 1][0]) i++;
  const a = STOPS[i], b = STOPS[i + 1], t = Math.min(1, Math.max(0, (e - a[0]) / (b[0] - a[0])));
  out[0] = mix(a[1], b[1], t); out[1] = mix(a[2], b[2], t); out[2] = mix(a[3], b[3], t);
}

const col = [0, 0, 0];

// Цвет неба в направлении (x, y, z) — единичный вектор. Результат в `col` (0..1, sRGB).
function skyAt(x, y, z) {
  grad(y, col);
  const sd = x * SUN[0] + y * SUN[1] + z * SUN[2];

  // облака в вышине
  if (y > 0.01) {
    const k = 1 / (y + 0.22);
    const n = fbm(x * k * 1.7 + 5.3, z * k * 1.7 - 2.1);
    const cov = sstep(0.5, 0.78, n);
    const fade = sstep(0.01, 0.22, y) * (1 - 0.85 * sstep(0.7, 1, y));
    const a = cov * fade * 0.92 * (1 - 0.8 * sstep(0.985, 0.999, sd)); // у солнца облака тоньше
    const shade = 1 - 0.26 * sstep(0.62, 0.95, n); // плотные части темнее
    const warm = Math.pow(Math.max(0, sd), 6) * 0.35;
    col[0] = mix(col[0], Math.min(1, shade + warm), a);
    col[1] = mix(col[1], Math.min(1, shade + warm * 0.8), a);
    col[2] = mix(col[2], Math.min(1, shade * 0.99 + 0.02 + warm * 0.5), a);
  }
  // море облаков внизу
  else if (y < -0.005) {
    const k = 1 / (-y + 0.14);
    const n = fbm(x * k * 1.3 + 11.7, z * k * 1.3 + 3.9);
    const cov = sstep(0.36, 0.6, n) * sstep(0, 0.16, -y);
    const lit = sstep(0.4, 0.85, n);
    const r = mix(0.72, 1.0, lit), g = mix(0.80, 1.0, lit), b = mix(0.95, 1.0, lit);
    const warm = Math.pow(Math.max(0, sd), 3) * 0.25;
    col[0] = mix(col[0], Math.min(1, r + warm), cov);
    col[1] = mix(col[1], Math.min(1, g + warm * 0.8), cov);
    col[2] = mix(col[2], Math.min(1, b + warm * 0.4), cov);
  }

  // солнце: широкое сияние, ореол, диск
  if (sd > 0) {
    const glow = Math.pow(sd, 6) * 0.22 + Math.pow(sd, 40) * 0.35 + Math.pow(sd, 400) * 0.6;
    col[0] = Math.min(1, col[0] + glow * 1.0);
    col[1] = Math.min(1, col[1] + glow * 0.84);
    col[2] = Math.min(1, col[2] + glow * 0.52);
    const disc = sstep(0.9982, 0.9989, sd);
    col[0] = mix(col[0], 1.0, disc); col[1] = mix(col[1], 0.97, disc); col[2] = mix(col[2], 0.86, disc);
  }
}

// Заполняет RGBA-буфер w*h (строка 0 — верх картинки = зенит)
export function paintSky(data, w, h) {
  for (let j = 0; j < h; j++) {
    const lat = (0.5 - (j + 0.5) / h) * Math.PI, y = Math.sin(lat), c = Math.cos(lat);
    for (let i = 0; i < w; i++) {
      const phi = ((i + 0.5) / w - 0.5) * Math.PI * 2; // тот же угол, что и atan(z, x) в three.js
      skyAt(c * Math.cos(phi), y, c * Math.sin(phi));
      const dither = (((i * 73856093) ^ (j * 19349663)) & 255) / 255 - 0.5; // убирает полосы градиента
      const o = (j * w + i) * 4;
      data[o] = col[0] * 255 + dither; data[o + 1] = col[1] * 255 + dither; data[o + 2] = col[2] * 255 + dither; data[o + 3] = 255;
    }
  }
}
