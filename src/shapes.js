// Формы платформ и физика столкновений. Без зависимостей от three.js,
// поэтому всё это можно тестировать отдельно от графики.
//
// Платформа в уровне: [x, y, z, ширина, глубина, форма, поворот°, наклон°, толщина]
//   y        — высота верхней поверхности в центре платформы
//   форма    — индекс в SHAPES (0 = прямоугольник)
//   поворот  — вокруг вертикальной оси, в градусах
//   наклон   — подъём в сторону -Z (до поворота), в градусах: получается пандус
//   толщина  — вертикальная толщина (по умолчанию 1)
// Старые платформы из пяти чисел [x, y, z, w, d] остаются рабочими.

export const PHYS = { HW: 0.35, H: 1.6, STEP: 0.3, SNAP: 0.3 };
// Параметры движения игрока (нужны и игре, и генератору уровней, чтобы прыжки были проходимыми)
export const MOVE = { SPEED: 7, JUMP: 11, GRAV: 30 };
export const DEG = Math.PI / 180;

// ---------- Формы: набор непересекающихся выпуклых многоугольников на квадрате -0.5..0.5 ----------
const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const ngon = (n, rx, rz) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return [Math.cos(a) * rx, Math.sin(a) * rz];
});
// Кусочки кольца (каждый — выпуклая трапеция)
const ring = (n, a0, a1, r0, r1) => Array.from({ length: n }, (_, i) => {
  const s = a0 + ((a1 - a0) * i) / n, e = a0 + ((a1 - a0) * (i + 1)) / n;
  return { poly: [[Math.cos(s) * r1, Math.sin(s) * r1], [Math.cos(e) * r1, Math.sin(e) * r1],
    [Math.cos(e) * r0, Math.sin(e) * r0], [Math.cos(s) * r0, Math.sin(s) * r0]], dy: 0 };
});
const one = (poly) => [{ poly, dy: 0 }];

function star() {
  const tips = [], inner = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    tips.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5]);
    inner.push([Math.cos(a + Math.PI / 5) * 0.21, Math.sin(a + Math.PI / 5) * 0.21]);
  }
  const parts = [{ poly: inner, dy: 0 }];
  for (let i = 0; i < 5; i++) parts.push({ poly: [inner[(i + 4) % 5], tips[i], inner[i]], dy: 0 });
  return parts;
}

function halfDisc() {
  const pts = [];
  for (let i = 0; i <= 10; i++) { const a = (Math.PI * i) / 10; pts.push([Math.cos(a) * 0.5, 0.5 - Math.sin(a)]); }
  return one(pts);
}

function stairs() {
  // 4 ступени по 0.5 вверх; высокая сторона — в сторону -Z
  return [0, 1, 2, 3].map((i) => ({ poly: rect(-0.5, -0.5 + i * 0.25, 0.5, -0.25 + i * 0.25), dy: (3 - i) * 0.5 }));
}

export const SHAPES = [
  { name: 'Прямоугольник', icon: '▬', parts: () => one(rect(-0.5, -0.5, 0.5, 0.5)) },
  { name: 'Круг', icon: '⬤', parts: () => one(ngon(16, 0.5, 0.5)) },
  { name: 'Шестиугольник', icon: '⬢', parts: () => one(ngon(6, 0.5, 0.5)) },
  { name: 'Ромб', icon: '◆', parts: () => one(ngon(4, 0.5, 0.5)) },
  { name: 'Треугольник', icon: '▲', parts: () => one([[0, -0.5], [0.5, 0.5], [-0.5, 0.5]]) },
  { name: 'Полукруг', icon: '◗', parts: halfDisc },
  { name: 'Крест', icon: '✚', parts: () => [
    { poly: rect(-0.5, -0.17, 0.5, 0.17), dy: 0 },
    { poly: rect(-0.17, -0.5, 0.17, -0.17), dy: 0 },
    { poly: rect(-0.17, 0.17, 0.17, 0.5), dy: 0 }] },
  { name: 'Г-образная', icon: 'L', parts: () => [
    { poly: rect(-0.5, -0.5, -0.17, 0.5), dy: 0 },
    { poly: rect(-0.17, 0.17, 0.5, 0.5), dy: 0 }] },
  { name: 'Т-образная', icon: 'T', parts: () => [
    { poly: rect(-0.5, -0.5, 0.5, -0.17), dy: 0 },
    { poly: rect(-0.17, -0.17, 0.17, 0.5), dy: 0 }] },
  { name: 'Зигзаг', icon: 'Z', parts: () => [
    { poly: rect(-0.5, -0.5, 0.17, 0), dy: 0 },
    { poly: rect(-0.17, 0, 0.5, 0.5), dy: 0 }] },
  { name: 'Звезда', icon: '★', parts: star },
  { name: 'Кольцо', icon: '◎', parts: () => ring(14, 0, Math.PI * 2, 0.26, 0.5) },
  { name: 'Подкова', icon: '∩', parts: () => ring(10, -Math.PI / 2 + 0.55, (3 * Math.PI) / 2 - 0.55, 0.26, 0.5) },
  { name: 'Ступени', icon: '▤', parts: stairs },
];

// ---------- Свои формы (рисуются в редакторе) ----------
// Своя форма — многоугольник в нормированных координатах (-0.5..0.5 по обеим осям), как и встроенные.
// Он может быть невыпуклым: для физики и графики режем его на выпуклые куски.
const crs = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const polyArea = (P) => {
  let s = 0;
  for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return s / 2;
};
const EPS = 1e-9;

// Отрезки ab и cd пересекаются или касаются
function segCross(a, b, c, d) {
  const o1 = crs(a, b, c), o2 = crs(a, b, d), o3 = crs(c, d, a), o4 = crs(c, d, b);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  const on = (p, q, r) => Math.min(p[0], q[0]) - EPS <= r[0] && r[0] <= Math.max(p[0], q[0]) + EPS
    && Math.min(p[1], q[1]) - EPS <= r[1] && r[1] <= Math.max(p[1], q[1]) + EPS;
  return (Math.abs(o1) <= EPS && on(a, b, c)) || (Math.abs(o2) <= EPS && on(a, b, d))
    || (Math.abs(o3) <= EPS && on(c, d, a)) || (Math.abs(o4) <= EPS && on(c, d, b));
}

// Замкнутый многоугольник без самопересечений и повторных точек
export function isSimplePolygon(P) {
  const n = P.length;
  if (n < 3 || Math.abs(polyArea(P)) < 0.05) return false;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]) < 1e-6) return false;
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    if (segCross(P[i], P[(i + 1) % n], P[j], P[(j + 1) % n])) return false;
  }
  return true;
}

// Можно ли продолжить незамкнутую ломаную отрезком last -> pt
export function chainOk(pts, pt) {
  const n = pts.length;
  if (!n) return true;
  const last = pts[n - 1];
  if (Math.hypot(last[0] - pt[0], last[1] - pt[1]) < 1e-6) return false;
  for (let i = 0; i < n - 1; i++) {
    if (i === n - 2) { // соседний отрезок: нельзя вернуться по нему же
      const back = (pt[0] - last[0]) * (pts[i][0] - last[0]) + (pt[1] - last[1]) * (pts[i][1] - last[1]);
      if (Math.abs(crs(pts[i], last, pt)) < 1e-9 && back > 0) return false;
      continue;
    }
    if (segCross(pts[i], pts[i + 1], last, pt)) return false;
  }
  return true;
}

// Приводит нарисованный контур к нормированному виду: возвращает форму, ширину и глубину ограничивающей рамки и её центр
export function normalizeShape(pts) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return { poly: pts.map(([x, z]) => [r4((x - cx) / w), r4((z - cz) / d)]), w, d, cx, cz };
}

// Разбиение на выпуклые части: триангуляция «отрезанием ушей» + слияние соседних треугольников, пока часть остаётся выпуклой
export function convexPieces(poly) {
  let P = poly.map((p) => [p[0], p[1]]);
  if (polyArea(P) < 0) P.reverse();
  const idx = P.map((_, i) => i), tris = [];
  const inTri = (p, a, b, c) => crs(a, b, p) >= -EPS && crs(b, c, p) >= -EPS && crs(c, a, p) >= -EPS;
  while (idx.length > 3) {
    let clipped = false;
    for (let k = 0; k < idx.length && !clipped; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
      if (crs(P[ia], P[ib], P[ic]) <= EPS) continue; // выпуклая вершина нужна
      if (idx.some((j) => j !== ia && j !== ib && j !== ic && inTri(P[j], P[ia], P[ib], P[ic]))) continue;
      tris.push([ia, ib, ic]); idx.splice(k, 1); clipped = true;
    }
    if (!clipped) { // осталась вырожденность (вершины на одной прямой): выбрасываем самую «плоскую» вершину
      let bk = 0, bv = Infinity;
      for (let k = 0; k < idx.length; k++) {
        const v = Math.abs(crs(P[idx[(k + idx.length - 1) % idx.length]], P[idx[k]], P[idx[(k + 1) % idx.length]]));
        if (v < bv) { bv = v; bk = k; }
      }
      idx.splice(bk, 1);
    }
  }
  if (idx.length === 3 && crs(P[idx[0]], P[idx[1]], P[idx[2]]) > EPS) tris.push(idx.slice());

  const convex = (L) => L.every((_, i) => crs(P[L[i]], P[L[(i + 1) % L.length]], P[L[(i + 2) % L.length]]) >= -1e-7);
  const tryMerge = (A, B) => {
    for (let i = 0; i < A.length; i++) {
      const u = A[i], v = A[(i + 1) % A.length];
      for (let j = 0; j < B.length; j++) {
        if (B[j] !== v || B[(j + 1) % B.length] !== u) continue;
        const out = [];
        for (let k = 1; k <= A.length; k++) out.push(A[(i + k) % A.length]); // v ... u
        for (let k = 2; k < B.length; k++) out.push(B[(j + k) % B.length]);   // остальные точки B
        return convex(out) ? out : null;
      }
    }
    return null;
  };
  const polys = tris;
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < polys.length && !merged; i++) for (let j = i + 1; j < polys.length && !merged; j++) {
      const m = tryMerge(polys[i], polys[j]);
      if (m) { polys[i] = m; polys.splice(j, 1); merged = true; }
    }
  }
  return polys.map((L) => L.map((i) => P[i]));
}

let CUSTOM = [], customKey = '';
export const shapeCount = () => SHAPES.length + CUSTOM.length;
export const shapeDef = (i) => (i < SHAPES.length ? SHAPES[i] : CUSTOM[i - SHAPES.length]);
// Задаёт набор своих форм текущего уровня (индексы форм: SHAPES.length + номер)
export function setCustomShapes(list) {
  const key = JSON.stringify(list || []);
  if (key === customKey) return;
  customKey = key;
  CUSTOM = (list || []).map((poly, n) => {
    const pieces = convexPieces(poly);
    return { name: 'Своя форма ' + (n + 1), icon: '✎' + (n + 1), parts: () => pieces.map((p) => ({ poly: p, dy: 0 })) };
  });
}

// ---------- Платформа из массива ----------
export function normPlat(a) {
  return {
    x: a[0], y: a[1], z: a[2], w: a[3], d: a[4],
    s: a[5] >= 0 && a[5] < shapeCount() ? a[5] : 0,
    r: a[6] || 0,
    t: a[7] || 0,
    k: a[8] > 0 ? a[8] : 1,
  };
}

// Части платформы в её собственных координатах (до поворота), с учётом ширины и глубины
export function localParts(pl) {
  return shapeDef(pl.s).parts().map(({ poly, dy }) => ({
    poly: poly.map(([u, v]) => [u * pl.w, v * pl.d]),
    dy,
    T: pl.k + dy, // от верхней грани части до общего «дна» платформы
  }));
}

// Части в мировых координатах, готовые для столкновений
export function worldParts(pl) {
  const th = pl.r * DEG, c = Math.cos(th), s = Math.sin(th), g = Math.tan(pl.t * DEG);
  const gx = -g * s, gz = -g * c; // градиент высоты верха по X и Z
  return localParts(pl).map((q) => {
    let pts = q.poly.map(([xl, zl]) => [pl.x + c * xl + s * zl, pl.z - s * xl + c * zl]);
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (area < 0) pts = pts.reverse(); // обход против часовой: наружные нормали = (dz, -dx)
    const n = pts.length;
    const part = {
      n, px: new Float64Array(n), pz: new Float64Array(n),
      nx: new Float64Array(n), nz: new Float64Array(n), nd: new Float64Array(n),
      minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity,
      y0: pl.y + q.dy, gx, gz, cx: pl.x, cz: pl.z, T: q.T, lo: Infinity, hi: -Infinity,
    };
    for (let i = 0; i < n; i++) {
      part.px[i] = pts[i][0]; part.pz[i] = pts[i][1];
      part.minX = Math.min(part.minX, pts[i][0]); part.maxX = Math.max(part.maxX, pts[i][0]);
      part.minZ = Math.min(part.minZ, pts[i][1]); part.maxZ = Math.max(part.maxZ, pts[i][1]);
      const top = part.y0 + gx * (pts[i][0] - pl.x) + gz * (pts[i][1] - pl.z);
      part.hi = Math.max(part.hi, top); part.lo = Math.min(part.lo, top - q.T);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = part.px[j] - part.px[i], dz = part.pz[j] - part.pz[i], len = Math.hypot(dx, dz) || 1;
      part.nx[i] = dz / len; part.nz[i] = -dx / len;
      part.nd[i] = part.nx[i] * part.px[i] + part.nz[i] * part.pz[i];
    }
    return part;
  });
}

export const topAt = (q, x, z) => q.y0 + q.gx * (x - q.cx) + q.gz * (z - q.cz);

// ---------- Геометрия ----------
// Ближайшая точка многоугольника к (x, z). Возвращает расстояние:
// > 0 — точка снаружи, <= 0 — внутри (по модулю — глубина до ближайшей стороны).
export function closest(q, x, z, out) {
  const n = q.n;
  let best = -Infinity, bi = 0;
  for (let i = 0; i < n; i++) {
    const sd = q.nx[i] * x + q.nz[i] * z - q.nd[i];
    if (sd > best) { best = sd; bi = i; }
  }
  if (best <= 0) { out.x = x; out.z = z; out.ei = bi; return best; }
  let bd = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = q.px[i], az = q.pz[i];
    const ex = q.px[j] - ax, ez = q.pz[j] - az;
    let t = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + ex * t, cz = az + ez * t, d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
    if (d < bd) { bd = d; out.x = cx; out.z = cz; }
  }
  return Math.sqrt(bd);
}

export function partsBounds(parts) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, lo: Infinity, hi: -Infinity };
  for (const q of parts) {
    b.minX = Math.min(b.minX, q.minX); b.maxX = Math.max(b.maxX, q.maxX);
    b.minZ = Math.min(b.minZ, q.minZ); b.maxZ = Math.max(b.maxZ, q.maxZ);
    b.lo = Math.min(b.lo, q.lo); b.hi = Math.max(b.hi, q.hi);
  }
  return b;
}

// Высота опоры под точкой (для тени): самая высокая поверхность не выше maxY
const tmpS = { x: 0, z: 0, ei: 0 };
export function supportY(parts, x, z, maxY) {
  let gy = -Infinity;
  for (const q of parts) {
    if (x + 0.2 < q.minX || x - 0.2 > q.maxX || z + 0.2 < q.minZ || z - 0.2 > q.maxZ) continue;
    if (closest(q, x, z, tmpS) > 0.2) continue;
    const ys = topAt(q, tmpS.x, tmpS.z);
    if (ys <= maxY && ys > gy) gy = ys;
  }
  return gy;
}

// ---------- Движение игрока ----------
// Игрок — вертикальный цилиндр: радиус HW, высота H. p — позиция ног, v — скорость.
// st: { onGround, landed, landVy }. Вызывать с маленьким dt (<= 0.01), вызывающий делает подшаги.
const tmpC = { x: 0, z: 0, ei: 0 };
export function stepBody(parts, p, v, dt, st) {
  const { HW, H, STEP, SNAP } = PHYS;
  const wasGround = st.onGround;
  st.landed = false;

  // 1. Горизонталь: упираемся в стены (всё, что выше ног больше чем на STEP)
  p.x += v.x * dt; p.z += v.z * dt;
  for (let it = 0; it < 2; it++) {
    for (const q of parts) {
      if (p.x + HW < q.minX || p.x - HW > q.maxX || p.z + HW < q.minZ || p.z - HW > q.maxZ) continue;
      const sd = closest(q, p.x, p.z, tmpC);
      if (sd >= HW) continue;
      const ys = topAt(q, tmpC.x, tmpC.z);
      if (p.y >= ys - STEP) continue;    // мы выше или можем шагнуть наверх
      if (p.y + H <= ys - q.T) continue; // платформа целиком над головой
      if (sd <= 0) {                     // центр внутри: выталкиваем через ближайшую сторону
        const d = HW - sd;
        p.x += q.nx[tmpC.ei] * d; p.z += q.nz[tmpC.ei] * d;
      } else {                           // центр снаружи, но тело задевает
        const d = HW - sd;
        p.x += ((p.x - tmpC.x) / sd) * d; p.z += ((p.z - tmpC.z) / sd) * d;
      }
    }
  }

  // 2. Вертикаль: приземление и удар головой
  const py = p.y;
  p.y += v.y * dt;
  st.onGround = false;
  for (const q of parts) {
    if (p.x + HW < q.minX || p.x - HW > q.maxX || p.z + HW < q.minZ || p.z - HW > q.maxZ) continue;
    const sd = closest(q, p.x, p.z, tmpC);
    if (sd >= HW) continue;
    const ys = topAt(q, tmpC.x, tmpC.z), yb = ys - q.T;
    if (p.y < ys && p.y + H > yb) {
      if (v.y <= 0 && py >= ys - STEP) {
        if (!wasGround) { st.landed = true; st.landVy = v.y; }
        p.y = ys; v.y = 0; st.onGround = true;
      } else if (v.y > 0 && py + H <= yb + 0.05) {
        p.y = yb - H; v.y = 0;
      }
    }
  }

  // 3. «Прилипание» к земле на спусках и ступеньках вниз
  if (!st.onGround && wasGround && v.y <= 0) {
    let best = -Infinity;
    for (const q of parts) {
      if (p.x + HW < q.minX || p.x - HW > q.maxX || p.z + HW < q.minZ || p.z - HW > q.maxZ) continue;
      const sd = closest(q, p.x, p.z, tmpC);
      if (sd >= HW) continue;
      const ys = topAt(q, tmpC.x, tmpC.z);
      if (ys <= p.y + 0.001 && p.y - ys <= SNAP && ys > best) best = ys;
    }
    if (best > -Infinity) { p.y = best; v.y = 0; st.onGround = true; }
  }
}
