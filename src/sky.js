// Процедурное небо: градиент, солнце (или луна со звёздами), облака наверху и «море облаков» внизу.
// Четыре варианта: день / ночь × ясно / дождь (сплошная облачность, без солнца и звёзд).
// Рисует эквиректангулярную картинку (360° x 180°). Без зависимостей от three.js.

const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
// Направление на солнце совпадает с положением DirectionalLight в main.js: (5, 10, 6)
export const SUN = unit([5, 10, 6]);
// Луна стоит с другой стороны неба; ночью DirectionalLight переезжает на неё
export const MOON = unit([-5, 6.5, -7]);

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
const STOPS_NIGHT = [
  [-1.0, 0.020, 0.030, 0.075],
  [-0.45, 0.030, 0.048, 0.115],
  [-0.08, 0.065, 0.100, 0.225],
  [0.0, 0.095, 0.140, 0.290],
  [0.10, 0.060, 0.095, 0.235],
  [0.35, 0.034, 0.058, 0.165],
  [0.75, 0.020, 0.034, 0.108],
  [1.0, 0.012, 0.022, 0.075],
];
const STOPS_RAIN = [
  [-1.0, 0.46, 0.49, 0.53],
  [-0.45, 0.53, 0.56, 0.60],
  [-0.08, 0.62, 0.65, 0.69],
  [0.0, 0.68, 0.72, 0.77],
  [0.10, 0.58, 0.62, 0.68],
  [0.35, 0.46, 0.50, 0.57],
  [0.75, 0.36, 0.40, 0.47],
  [1.0, 0.30, 0.34, 0.42],
];
const STOPS_NIGHT_RAIN = [
  [-1.0, 0.045, 0.052, 0.072],
  [-0.45, 0.058, 0.068, 0.095],
  [-0.08, 0.095, 0.112, 0.150],
  [0.0, 0.120, 0.138, 0.185],
  [0.10, 0.085, 0.098, 0.135],
  [0.35, 0.062, 0.074, 0.108],
  [0.75, 0.046, 0.056, 0.088],
  [1.0, 0.038, 0.046, 0.076],
];

// Настройки текущего варианта неба. tone — цвет самой светлой части облаков, cov — пороги покрытия (чем меньше, тем плотнее).
const VARIANTS = {
  day: { stops: STOPS, tone: [1, 1, 1], cov: [0.5, 0.78], low: [0.36, 0.6], shadow: [0.72, 0.80, 0.95] },
  night: { stops: STOPS_NIGHT, tone: [0.20, 0.26, 0.44], cov: [0.5, 0.78], low: [0.36, 0.6], shadow: [0.72, 0.80, 0.95] },
  rain: { stops: STOPS_RAIN, tone: [0.68, 0.71, 0.75], cov: [0.0, 0.5], low: [-0.4, 0.15], shadow: [0.80, 0.82, 0.86] },
  nightRain: { stops: STOPS_NIGHT_RAIN, tone: [0.15, 0.17, 0.23], cov: [0.0, 0.5], low: [-0.4, 0.15], shadow: [0.80, 0.82, 0.86] },
};
let cfg = VARIANTS.day, isNight = false, isRain = false;
export const skyKey = (night, rain) => (night ? (rain ? 'nightRain' : 'night') : rain ? 'rain' : 'day');

let cloudCov = 0; // сколько неба закрыто облаками в последней точке (звёзды за облаками гаснут)

function grad(e, out) {
  const STOPS_ = cfg.stops;
  let i = 0;
  while (i < STOPS_.length - 2 && e > STOPS_[i + 1][0]) i++;
  const a = STOPS_[i], b = STOPS_[i + 1], t = Math.min(1, Math.max(0, (e - a[0]) / (b[0] - a[0])));
  out[0] = mix(a[1], b[1], t); out[1] = mix(a[2], b[2], t); out[2] = mix(a[3], b[3], t);
}

const col = [0, 0, 0];

// Цвет неба в направлении (x, y, z) — единичный вектор. Результат в `col` (0..1, sRGB).
function skyAt(x, y, z) {
  grad(y, col);
  cloudCov = 0;
  const L = isNight ? MOON : SUN;
  const sd = x * L[0] + y * L[1] + z * L[2];
  const [tr, tg, tb] = cfg.tone;
  const [c0, c1] = cfg.cov;
  const warmK = isNight || isRain ? 0 : 1; // тёплая подсветка облаков у солнца — только в ясный день

  // облака в вышине
  if (y > 0.01) {
    const k = 1 / (y + 0.22);
    const n = fbm(x * k * 1.7 + 5.3, z * k * 1.7 - 2.1);
    const cov = sstep(c0, c1, n);
    const fade = sstep(0.01, 0.22, y) * (1 - 0.85 * sstep(0.7, 1, y));
    // у солнца облака тоньше; в дождь они сплошные, так что просвета нет
    const a = cov * fade * (isRain ? 0.97 : 0.92) * (1 - (isRain ? 0 : 0.8) * sstep(0.985, 0.999, sd));
    const shade = 1 - (isRain ? 0.30 : 0.26) * sstep(0.62, 0.95, n); // плотные части темнее
    const warm = Math.pow(Math.max(0, sd), 6) * 0.35 * warmK;
    const moonLit = isNight && !isRain ? Math.pow(Math.max(0, sd), 8) * 0.22 : 0; // облака рядом с луной подсвечены
    col[0] = mix(col[0], Math.min(1, tr * shade + warm + moonLit * 0.8), a);
    col[1] = mix(col[1], Math.min(1, tg * shade + warm * 0.8 + moonLit * 0.9), a);
    col[2] = mix(col[2], Math.min(1, tb * shade * 0.99 + 0.02 * (tb > 0.9 ? 1 : 0) + warm * 0.5 + moonLit), a);
    cloudCov = a;
  }
  // море облаков внизу
  else if (y < -0.005) {
    const k = 1 / (-y + 0.14);
    const n = fbm(x * k * 1.3 + 11.7, z * k * 1.3 + 3.9);
    const cov = sstep(cfg.low[0], cfg.low[1], n) * sstep(0, 0.16, -y);
    const lit = sstep(0.4, 0.85, n);
    const [sr, sg, sb] = cfg.shadow;
    const r = tr * mix(sr, 1.0, lit), g = tg * mix(sg, 1.0, lit), b = tb * mix(sb, 1.0, lit);
    const warm = Math.pow(Math.max(0, sd), 3) * 0.25 * warmK;
    const moonLit = isNight && !isRain ? Math.pow(Math.max(0, sd), 3) * 0.10 : 0;
    col[0] = mix(col[0], Math.min(1, r + warm + moonLit * 0.8), cov);
    col[1] = mix(col[1], Math.min(1, g + warm * 0.8 + moonLit * 0.9), cov);
    col[2] = mix(col[2], Math.min(1, b + warm * 0.4 + moonLit), cov);
  }

  if (isNight) {
    // луна: мягкое сияние, диск с «морями»
    if (sd > 0 && !isRain) {
      const glow = Math.pow(sd, 8) * 0.07 + Math.pow(sd, 60) * 0.12 + Math.pow(sd, 500) * 0.18;
      col[0] = Math.min(1, col[0] + glow * 0.72);
      col[1] = Math.min(1, col[1] + glow * 0.82);
      col[2] = Math.min(1, col[2] + glow * 1.0);
      const disc = sstep(0.9987, 0.9991, sd) * (1 - 0.65 * cloudCov);
      const sea = 0.82 + 0.18 * fbm(x * 55 + 3.1, y * 55 + z * 55 - 1.7);
      col[0] = mix(col[0], 0.86 * sea, disc); col[1] = mix(col[1], 0.90 * sea, disc); col[2] = mix(col[2], 0.98 * sea, disc);
    } else if (sd > 0 && isRain) {
      const glow = Math.pow(sd, 10) * 0.05 + Math.pow(sd, 120) * 0.05; // луна еле просвечивает сквозь тучи
      col[0] += glow * 0.7; col[1] += glow * 0.8; col[2] += glow;
    }
  } else if (sd > 0) {
    if (isRain) {
      // солнце за тучами: просто светлое пятно
      const glow = Math.pow(sd, 5) * 0.10 + Math.pow(sd, 60) * 0.12;
      col[0] = Math.min(1, col[0] + glow); col[1] = Math.min(1, col[1] + glow); col[2] = Math.min(1, col[2] + glow * 0.95);
    } else {
      // солнце: широкое сияние, ореол, диск
      const glow = Math.pow(sd, 6) * 0.22 + Math.pow(sd, 40) * 0.35 + Math.pow(sd, 400) * 0.6;
      col[0] = Math.min(1, col[0] + glow * 1.0);
      col[1] = Math.min(1, col[1] + glow * 0.84);
      col[2] = Math.min(1, col[2] + glow * 0.52);
      const disc = sstep(0.9982, 0.9989, sd);
      col[0] = mix(col[0], 1.0, disc); col[1] = mix(col[1], 0.97, disc); col[2] = mix(col[2], 0.86, disc);
    }
  }
}

// Дешёвый хеш двух целых -> 0..1 (для звёзд)
const hash2 = (a, b) => {
  let h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// Заполняет RGBA-буфер w*h (строка 0 — верх картинки = зенит).
// opts: { night, rain } — вариант неба (см. VARIANTS)
export function paintSky(data, w, h, opts = {}) {
  isNight = !!opts.night; isRain = !!opts.rain;
  cfg = VARIANTS[skyKey(isNight, isRain)];
  const stars = isNight && !isRain;
  const blk = w >= 1024 ? 2 : 1, dens = blk === 2 ? 0.012 : 0.009; // звезда = блок пикселей, чтобы читалась после уменьшения кадра
  for (let j = 0; j < h; j++) {
    const lat = (0.5 - (j + 0.5) / h) * Math.PI, y = Math.sin(lat), c = Math.cos(lat);
    for (let i = 0; i < w; i++) {
      const phi = ((i + 0.5) / w - 0.5) * Math.PI * 2; // тот же угол, что и atan(z, x) в three.js
      skyAt(c * Math.cos(phi), y, c * Math.sin(phi));
      if (stars && y > 0.02) {
        const bi = (i / blk) | 0, bj = (j / blk) | 0, r = hash2(bi, bj);
        if (r < dens * c) { // у зенита картинка сжата по горизонтали, поэтому там звёзд реже (c = cos широты)
          const br = Math.pow(0.35 + 0.65 * hash2(bi + 17, bj + 5), 2) * sstep(0.02, 0.2, y) * (1 - cloudCov * 1.1);
          if (br > 0) {
            const tint = hash2(bi + 3, bj + 29);
            col[0] = Math.min(1, col[0] + br * (0.9 + 0.1 * tint));
            col[1] = Math.min(1, col[1] + br * (0.92 + 0.05 * tint));
            col[2] = Math.min(1, col[2] + br * (1 - 0.12 * tint));
          }
        }
      }
      const dither = (((i * 73856093) ^ (j * 19349663)) & 255) / 255 - 0.5; // убирает полосы градиента
      const o = (j * w + i) * 4;
      data[o] = col[0] * 255 + dither; data[o + 1] = col[1] * 255 + dither; data[o + 2] = col[2] * 255 + dither; data[o + 3] = 255;
    }
  }
}
