// Генератор уровней. Не зависит от three.js.
//
// Уровень собирается из «глав» — готовых паттернов, знакомых по популярным платформерам и паркур-играм:
//   острова (Mario 64), столбы, серпантин и лестницы (башни из Tower of Hell), спираль вокруг башни,
//   узкие балки, горки-пандусы, ритм-прыжки и зигзаг. Между главами стоят большие площадки-хабы,
//   от которых иногда отходят боковые площадки с монетами.
// Дальность каждого прыжка считается из физики игрока (MOVE), поэтому уровень всегда проходим.
// Один и тот же сид + стиль + сложность + длина всегда дают один и тот же уровень.
//
// Сложность (DIFFS): 1 лёгкий, 2 средний, 3 сложный, 4 ХАРДКОР.
//   Хардкор: зазоры на пределе физики (98–120% дальности чистого прыжка; проходимо только с койот-временем
//   и приземлением на самый край), платформы по 1–2 м, балки по 0,5 м, редкие и маленькие хабы
//   и глава «Лифт-мост»: пропасть, посреди которой ездит крошечный лифт, не достающий до краёв.
//   Лифты кладутся в lv.objs (формат объектов см. objects.js). В бесконечном режиме лифтов нет.
//
// Длина уровня (LENS):
//   std  — стандартная (как раньше: 26 / 36 / 46 / 60 платформ в зависимости от сложности);
//   long — длинная (в 2.5 раза больше платформ, финальная звезда в конце);
//   inf  — бесконечная: звезды нет, уровень растёт по мере продвижения игрока. Возвращённый уровень
//          содержит функцию more(n), которая достраивает ещё n платформ в конец (новые платформы
//          добавляются в lv.plats). Монет в бесконечном уровне нет. Один и тот же сид всегда даёт одну и ту же бесконечную трассу.

import { DEG, MOVE, normPlat, worldParts, closest, partsBounds } from './shapes.js';

// ---------- Случайные числа ----------
export function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; };
}
export function rngFrom(seed) { const n = xmur3(String(seed)); return () => n() / 4294967296; }

export const STYLES = {
  mix: 'Микс глав', islands: 'Острова', tower: 'Башня', serpent: 'Серпантин',
  beams: 'Балки', ramps: 'Горки', hopper: 'Тренажёр прыжков',
};
export const DIFFS = { 1: 'Лёгкий', 2: 'Средний', 3: 'Сложный', 4: 'Хардкор' };
export const LENS = { std: 'Стандартная', long: 'Длинная', inf: 'Бесконечная' };

// gapF — доля максимальной дальности прыжка; gapMax — потолок зазора, м (по умолчанию 6);
// size — размеры платформ; up — максимальный подъём между платформами; beam/beamMin — ширина балок;
// pmin — минимальная ширина столбов (по умолчанию 2.2)
const DIFF = {
  1: { gapF: [0.22, 0.5], size: [3.6, 5.4], up: 1.0, beam: 2.6, total: 26 },
  2: { gapF: [0.4, 0.66], size: [2.8, 4.6], up: 1.3, beam: 1.8, total: 36 },
  3: { gapF: [0.58, 0.86], size: [2.0, 3.6], up: 1.55, beam: 1.2, total: 46 },
  // Хардкор: у края прыжка (с учётом ~1.4 м допуска на край и койот-время это ≈97% от теоретического максимума)
  4: { gapF: [0.98, 1.2], gapMax: 8, size: [1.2, 2.0], up: 1.75, beam: 0.5, beamMin: 0.5, pmin: 1.2, total: 60 },
};

// Какой по длине прыжок (между краями платформ) можно сделать, если приземляться выше на dy.
export function reach(dy) {
  const { SPEED, JUMP, GRAV } = MOVE, disc = JUMP * JUMP - 2 * GRAV * dy;
  return disc <= 0 ? 0 : (SPEED * (JUMP + Math.sqrt(disc))) / GRAV;
}

// ---------- Расстояние между выпуклыми частями ----------
const tmpO = { x: 0, z: 0, ei: 0 };
function axisSep(p, q) {
  let m = -Infinity;
  for (let i = 0; i < p.n; i++) {
    let mn = Infinity;
    for (let j = 0; j < q.n; j++) mn = Math.min(mn, p.nx[i] * q.px[j] + p.nz[i] * q.pz[j] - p.nd[i]);
    if (mn > m) m = mn;
  }
  return m;
}
function gapConvex(p, q) {
  if (Math.max(axisSep(p, q), axisSep(q, p)) <= 0) return 0; // пересекаются
  let best = Infinity;
  for (const [a, b] of [[p, q], [q, p]]) for (let i = 0; i < a.n; i++) best = Math.min(best, closest(b, a.px[i], a.pz[i], tmpO));
  return Math.max(0, best);
}
export function gapParts(P, Q) {
  let best = Infinity;
  for (const p of P) for (const q of Q) {
    if (p.minX - q.maxX > best || q.minX - p.maxX > best || p.minZ - q.maxZ > best || q.minZ - p.maxZ > best) continue;
    best = Math.min(best, gapConvex(p, q));
    if (best === 0) return 0;
  }
  return best;
}

const q4 = (x) => Math.round(x * 4) / 4;
const rS = (x) => Math.round(x * 2) / 2;

export function generate(seed, style = 'mix', diff = 2, nThemes = 6, len = 'std') {
  if (!STYLES[style]) style = 'mix';
  if (!LENS[len]) len = 'std';
  diff = DIFF[diff] ? +diff : 2;
  const D = DIFF[diff];
  const hc = diff === 4;                    // хардкор
  const withLifts = hc && len !== 'inf';    // лифты-мосты (в бесконечном уровне объекты добавлять некуда)
  // Стандартная длина использует прежнюю строку сида, поэтому старые уровни и ссылки не меняются
  const R = rngFrom(len === 'std' ? `${seed}|${style}|${diff}` : `${seed}|${style}|${diff}|${len}`);
  const rr = (a, b) => a + R() * (b - a);
  const ri = (a, b) => Math.floor(rr(a, b + 1));
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const sz = (a, b) => rS(rr(a, b));
  // Размер «вспомогательных» платформ глав: в хардкоре примерно вдвое меньше
  const fz = (a, b) => (hc ? sz(a * 0.55, b * 0.6) : sz(a, b));

  const plats = [], infos = [], objs = [];
  let curIdx = 0, ang = rr(-0.5, 0.5), exitY = 0, deadTo = 0;

  function reg(a, extra) {
    const parts = worldParts(normPlat(a)), b = partsBounds(parts);
    plats.push(a); infos.push({ parts, b, coin: 'top', gapIn: 0, ...extra });
  }

  // Старт: большая площадка с цельным центром
  reg([0, 0, 0, 7, 7, pick([0, 1, 2])], { coin: 'none' });

  // Нет ли конфликта с другими платформами (пересечение или нехватка места над головой)
  function free(parts, b) {
    for (let i = 0; i < infos.length; i++) {
      const o = infos[i];
      if (i === curIdx || o.dead) continue; // dead: старые платформы бесконечного уровня, их уже нет в игре
      if (b.minX - o.b.maxX > 0.8 || o.b.minX - b.maxX > 0.8 || b.minZ - o.b.maxZ > 0.8 || o.b.minZ - b.maxZ > 0.8) continue;
      if (gapParts(parts, o.parts) >= 0.8) continue;
      if (b.lo >= o.b.hi + 2.2 || o.b.lo >= b.hi + 2.2) continue; // одна над другой с запасом
      return false;
    }
    return true;
  }

  // Поставить платформу после текущей. o: w, d, s (форма), k, t (наклон), dy, gap, turn, rot, rise, lat, coin
  function put(o) {
    const a = ang + (o.turn || 0), ux = Math.sin(a), uz = -Math.cos(a), px = Math.cos(a), pz = Math.sin(a);
    const g = Math.tan((o.t || 0) * DEG), lat = o.lat || 0;
    const y = q4(exitY + (o.dy || 0) + (g * o.d) / 2);
    if (y > 70 || y < -6) return false;
    const rot = o.rot !== undefined ? o.rot : ((Math.round((-a * 180) / Math.PI) % 360) + 360) % 360;
    const cur = plats[curIdx], cp = infos[curIdx];
    const mk = (d) => [q4(cur[0] + ux * d + px * lat), y, q4(cur[2] + uz * d + pz * lat), o.w, o.d, o.s || 0, rot, o.t || 0, o.k || 1];
    const gapAt = (d) => gapParts(cp.parts, worldParts(normPlat(mk(d))));
    const dMax = Math.hypot(cp.b.maxX - cp.b.minX, cp.b.maxZ - cp.b.minZ) / 2 + Math.hypot(o.w, o.d) / 2 + o.gap + Math.abs(lat) + 1.5;
    if (gapAt(dMax) < o.gap) return false;
    // идём снаружи внутрь: ближайшее к текущей платформе место с нужным зазором
    let hi = dMax, d = dMax;
    while (d > 0.01) { d -= 0.5; if (gapAt(d) < o.gap) break; hi = d; }
    let lo = Math.max(d, 0);
    for (let i = 0; i < 7; i++) { const m = (lo + hi) / 2; if (gapAt(m) >= o.gap) hi = m; else lo = m; }
    const cand = mk(hi);
    if (Math.abs(cand[0]) > 235 || Math.abs(cand[2]) > 235) return false;
    const parts = worldParts(normPlat(cand)), b = partsBounds(parts);
    if (!free(parts, b)) return false;
    const ey = y + (g * o.d) / 2 + (o.rise || 0);
    plats.push(cand); infos.push({ parts, b, coin: o.coin || 'top', gapIn: o.gap, hub: !!o.hub, from: curIdx, ang: a, ey });
    curIdx = plats.length - 1; ang = a; exitY = ey;
    return true;
  }

  // Если ушли далеко от центра, мягко разворачиваемся обратно
  function steer(turn) {
    const c = plats[curIdx], len = Math.hypot(c[0], c[2]);
    if (len < 110) return turn;
    let df = Math.atan2(-c[0], c[2]) - ang;
    df = Math.atan2(Math.sin(df), Math.cos(df));
    return Math.max(-0.9, Math.min(0.9, df)) * (len > 170 ? 1 : 0.6) + turn * 0.3;
  }
  // Несколько попыток с разными поворотами: если место занято, ищем другое направление
  function attempt(mk, base) {
    base = steer(base);
    for (let t = 0; t < 8; t++) {
      const turn = t === 0 ? base : base + (R() < 0.5 ? -1 : 1) * rr(0.2, 0.5) * t;
      if (put(mk(Math.max(-2.6, Math.min(2.6, turn))))) return true;
    }
    return false;
  }

  // Зазор для прыжка: доля от максимальной длины при данной разнице высот
  const jg = (dy, f = rr(D.gapF[0], D.gapF[1])) => Math.max(0.9, Math.min(D.gapMax ?? 6, reach(dy) * f));
  const pickDy = () => {
    const r = R();
    let dy = hc
      ? (r < 0.15 ? 0 : r < 0.7 ? rr(0.5, D.up) : -rr(0.8, 2.6)) // хардкор: чаще подъёмы почти до потолка прыжка
      : (r < 0.3 ? 0 : r < 0.7 ? rr(0.3, D.up) : -rr(0.4, 2.0));
    if (exitY > 50 && dy > 0) dy = -dy;
    if (exitY < 1 && dy < 0) dy = Math.abs(dy) * 0.5;
    return dy;
  };
  const small = D.size[0] < 3.2;
  const SH_SMALL = [0, 0, 1, 1, 2, 3, 4, 5], SH_BIG = [0, 0, 1, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

  // ---------- Лифт-мост (только хардкор) ----------
  // Две платформы на одном уровне и пропасть между ними. Посередине ездит маленький лифт, который в крайних точках
  // не доходит до краёв на 2.8–3.8 м: надо прыгнуть на лифт, прокатиться и спрыгнуть на другой берег.
  function liftBridge() {
    const sv = { cur: curIdx, ang, ey: exitY, n: plats.length };
    const rollback = () => { plats.length = sv.n; infos.length = sv.n; curIdx = sv.cur; ang = sv.ang; exitY = sv.ey; return false; };
    const w = pick([2, 2.5]), g = rr(2.8, 3.8), G0 = w + 2 * g + rr(6, 13);
    const bw = sz(2, 3), bs = pick([0, 1, 2]);
    if (!attempt((turn) => ({ w: bw, d: bw, s: bs, dy: 0, gap: G0, turn, coin: 'top' }), rr(-0.4, 0.4))) return false;

    const B = plats[curIdx], bi = infos[curIdx], A = plats[bi.from], Ap = infos[bi.from].parts;
    let ux = B[0] - A[0], uz = B[2] - A[2];
    const Ld = Math.hypot(ux, uz);
    if (!Ap || Ld < 1) return rollback();
    ux /= Ld; uz /= Ld;
    // Где линия от центра A к центру B выходит из A и входит в B (идём шагами по 5 см)
    const inside = (parts, t) => {
      const x = A[0] + ux * t, z = A[2] + uz * t;
      for (const q of parts) if (closest(q, x, z, tmpO) <= 0) return true;
      return false;
    };
    let tA = null, tB = null;
    for (let t = 30; t >= 0; t -= 0.05) if (inside(Ap, t)) { tA = t; break; }
    for (let t = Ld - 30; t <= Ld; t += 0.05) if (inside(bi.parts, t)) { tB = t; break; }
    if (tA === null || tB === null) return rollback();
    const trav = Math.min(40, tB - tA - w - 2 * g);
    if (trav < 3) return rollback();

    const tm = (tA + tB) / 2, mx = A[0] + ux * tm, mz = A[2] + uz * tm, y = B[1];
    const rot = Math.round(((-Math.atan2(ux, -uz) * 180) / Math.PI) * 100) / 100; // направление пути лифта = направление на B
    // Путь лифта не должен упираться в чужие платформы
    const sweep = worldParts(normPlat([mx, y, mz, w, trav + w, 0, rot, 0, 0.6])), sb = partsBounds(sweep);
    for (let i = 0; i < infos.length - 1; i++) { // последний — сама B
      const o = infos[i];
      if (i === bi.from || o.dead) continue;
      if (sb.minX - o.b.maxX > 0.8 || o.b.minX - sb.maxX > 0.8 || sb.minZ - o.b.maxZ > 0.8 || o.b.minZ - sb.maxZ > 0.8) continue;
      if (gapParts(sweep, o.parts) >= 0.8) continue;
      if (sb.lo >= o.b.hi + 2.2 || o.b.lo >= sb.hi + 2.2) continue;
      return rollback();
    }
    objs.push([4, q4(mx), y, q4(mz), rot, w, Math.round(trav * 10) / 10, 0]);
    return true;
  }

  // ---------- Главы ----------
  const segs = {
    // Парящие острова разной формы, размера и толщины
    islands(n) {
      for (let i = 0; i < n; i++) {
        const dy = pickDy(), s = pick(small ? SH_SMALL : SH_BIG);
        let w = sz(...D.size), d = sz(...D.size);
        if (s === 11) w = d = sz(6.5, 9);
        if (s === 10) w = d = sz(5, 7);
        const k = R() < 0.3 ? sz(1.5, 6) : 1;
        const t = s <= 2 && R() < 0.15 ? pick([-10, -6, 6, 10]) : 0;
        const rot = t === 0 && R() < 0.5 ? ri(0, 359) : undefined;
        const gap = jg(dy);
        if (!attempt((turn) => ({ w, d, s, k, t, rot, dy, gap, turn }), rr(-0.9, 0.9))) return false;
      }
      return true;
    },
    // Узкие столбы, торчащие из бездны
    pillars(n) {
      for (let i = 0; i < n; i++) {
        const dy = (i % 2 ? -1 : 1) * rr(0.2, D.up), w = sz(Math.max(D.pmin ?? 2.2, D.size[0] - 0.4), D.size[0] + 0.6), s = pick([0, 1, 2]);
        const k = sz(6, 14), gap = jg(dy);
        if (!attempt((turn) => ({ w, d: w, s, k, dy, gap, turn }), rr(-0.7, 0.7))) return false;
      }
      return true;
    },
    // Серпантин: пролёты ступенек вверх с площадками-разворотами
    serp(fl) {
      let dir = R() < 0.5 ? 1 : -1, pend = 0;
      for (let f = 0; f < fl; f++) {
        for (let j = 0, m = ri(3, 5); j < m; j++) {
          if (exitY > 55) return true;
          const dy = rr(0.6, D.up), w = fz(3, 4.4), d = fz(3, 4.4), s = pick([0, 2, 1]), gap = jg(dy) * 0.85;
          if (!attempt((turn) => ({ w, d, s, dy, gap, turn }), j === 0 ? pend : rr(-0.15, 0.15))) return false;
        }
        const L = fz(5, 6.5), s = pick([1, 2, 0]), dy = rr(0.3, 0.9), gap = jg(0.6) * 0.8;
        if (!attempt((turn) => ({ w: L, d: L, s, dy, gap, turn, coin: 'none' }), 0)) return false;
        pend = dir * rr(1.35, 1.75); dir = -dir;
      }
      return true;
    },
    // Спираль вокруг воображаемой башни: вверх (или вниз, если забрались высоко)
    spiral(n, down) {
      const dT = (R() < 0.5 ? 1 : -1) * rr(0.5, 0.72);
      for (let i = 0; i < n; i++) {
        if (down ? exitY < 2 : exitY > 58) return true;
        const dy = down ? -rr(0.8, 1.6) : rr(0.8, D.up), w = fz(3, 4.2), s = [2, 1, 0][i % 3], gap = jg(dy) * 0.8;
        if (!attempt((turn) => ({ w, d: w, s, dy, gap, turn }), dT)) return false;
      }
      return true;
    },
    // Узкие балки с площадками на поворотах (и иногда с разрывом посередине)
    beams(n) {
      const bw = Math.max(D.beamMin ?? 1, rS(rr(D.beam, D.beam + 0.5))), sg = R() < 0.5 ? 1 : -1;
      const pad = (gap) => {
        const s = pick([0, 1, 2]);
        const pw = hc ? 2.5 : 4;
        return attempt((turn) => ({ w: pw, d: pw, s, dy: 0, gap, turn, coin: 'none' }), 0);
      };
      if (!pad(jg(0) * 0.8)) return false;
      for (let i = 0; i < n; i++) {
        const len = sz(6, 14), brk = R() < (hc ? 0.6 : 0.3), turn0 = (i % 2 ? -sg : sg) * (Math.PI / 2);
        if (!attempt((turn) => ({ w: bw, d: len, s: 0, dy: 0, gap: 0.05, turn }), turn0)) return false;
        if (brk) {
          const len2 = sz(5, 9), gap = jg(0);
          if (!attempt((turn) => ({ w: bw, d: len2, s: 0, dy: 0, gap, turn }), 0)) return false;
        }
        if (!pad(0.05)) return false;
      }
      return true;
    },
    // Горки: наклонные пандусы вверх и вниз, между ними площадки или прыжки
    ramps(n) {
      for (let i = 0; i < n; i++) {
        const up = exitY > 45 ? false : exitY < 2 ? true : R() < 0.55;
        const t = ri(14, 28), len = sz(6, 10), w = fz(3.2, 4.8), g0 = i === 0 ? jg(0) * 0.7 : 0.05;
        if (!attempt((turn) => ({ w, d: len, s: 0, t: up ? t : -t, dy: 0, gap: g0, turn, coin: 'none' }), rr(-0.5, 0.5))) return false;
        const lw = fz(3.5, 5.2), gl = R() < 0.55 ? 0.05 : jg(0) * 0.9, s = pick([0, 1, 2]);
        if (!attempt((turn) => ({ w: lw, d: lw, s, dy: 0, gap: gl, turn }), 0)) return false;
      }
      return true;
    },
    // Ритм-прыжки: одинаковые плиточки, зазор растёт к концу главы
    hopper(n) {
      const s = pick([1, 2, 0]);
      const w = sz(Math.max(hc ? 1 : 2, D.size[0] * 0.85), Math.max(hc ? 1.5 : 2.5, D.size[0] * 1.15));
      const wave = R() < 0.5, amp = rr(0.5, Math.min(1.2, D.up));
      for (let i = 0; i < n; i++) {
        const f = D.gapF[0] + (D.gapF[1] - D.gapF[0]) * (n > 1 ? i / (n - 1) : 0.5);
        const dy = wave ? (i % 2 ? -amp : amp) : R() < 0.3 ? rr(0.4, D.up * 0.8) : 0, gap = jg(dy, f);
        if (!attempt((turn) => ({ w, d: w, s, dy, gap, turn }), rr(-0.25, 0.25))) return false;
      }
      return true;
    },
    // Зигзаг: платформы то влево, то вправо от общего направления
    zigzag(n) {
      const base = ang;
      let sg = R() < 0.5 ? 1 : -1, ok = true;
      for (let i = 0; i < n && ok; i++) {
        const dy = pickDy() * 0.6, w = sz(...D.size), d = sz(...D.size), s = pick([0, 1, 2, 3]), gap = jg(dy), want = base + sg * rr(0.6, 0.95);
        ok = attempt((turn) => ({ w, d, s, dy, gap, turn }), want - ang);
        sg = -sg;
      }
      ang = base;
      return ok;
    },
    // Лесенка: встроенная форма «Ступени» (ступеньки по 0.5, нужно прыгать)
    stairs(n) {
      for (let i = 0; i < n; i++) {
        if (exitY > 55) return true;
        const w = fz(3, 4), d = fz(4, 6), g0 = i === 0 ? jg(0) * 0.6 : 0.05;
        if (!attempt((turn) => ({ w, d, s: 13, dy: 0, rise: 1.5, gap: g0, turn, coin: 'none' }), i === 0 ? rr(-0.4, 0.4) : 0)) return false;
      }
      const lw = fz(4, 5.5);
      return attempt((turn) => ({ w: lw, d: lw, s: 1, dy: 0, gap: 0.05, turn }), 0);
    },
    // Лифт-мост (только хардкор): прыжок на движущийся лифт и с него на другой берег
    lifts(n) {
      for (let i = 0; i < n; i++) if (!liftBridge()) return i > 0;
      return true;
    },
  };

  // Большая площадка-хаб с боковыми площадками за монетами (в хардкоре — маленькая и редкая)
  function hub() {
    const s = hc ? pick([0, 1, 2]) : pick([1, 2, 10, 6, 0, 1, 2]);
    const w = hc ? sz(3.5, 5) : s === 10 ? sz(8, 10) : sz(7, 10), dy = rr(0.2, 0.9), gap = jg(dy) * 0.75;
    if (!attempt((turn) => ({ w, d: w, s, dy, gap, turn, coin: 'none', hub: true }), rr(-0.4, 0.4))) return false;
    for (const sg of [-1, 1]) {
      if (R() > 0.55) continue;
      const sv = [curIdx, ang, exitY], pw = hc ? sz(1.5, 2.2) : sz(2.4, 3.2), ps = pick([1, 2]), pdy = rr(-0.4, 0.9), pgap = jg(pdy) * 0.8;
      attempt((turn) => ({ w: pw, d: pw, s: ps, dy: pdy, gap: pgap, turn, coin: 'branch' }), sg * (Math.PI / 2) + rr(-0.3, 0.3));
      [curIdx, ang, exitY] = sv; // боковая площадка — тупик, основной путь продолжается от хаба
    }
    return true;
  }

  const PLAN = {
    islands: ['islands', 'pillars', 'islands', 'zigzag', 'islands'],
    tower: ['spiral', 'serp', 'spiral', 'stairs', 'spiral'],
    serpent: ['serp', 'stairs', 'serp', 'serp'],
    beams: ['beams', 'beams', 'hopper', 'beams'],
    ramps: ['ramps', 'islands', 'ramps', 'ramps'],
    hopper: ['hopper', 'zigzag', 'pillars', 'hopper', 'hopper'],
  };
  let ALL = ['islands', 'pillars', 'serp', 'spiral', 'beams', 'ramps', 'hopper', 'zigzag', 'stairs'];
  if (withLifts) {
    ALL = [...ALL, 'lifts', 'lifts'];
    // В хардкоре после каждой второй главы плана добавляется лифт-мост
    for (const k of Object.keys(PLAN)) PLAN[k] = PLAN[k].flatMap((n, i) => (i % 2 ? [n, 'lifts'] : [n]));
  }
  const COUNT = { islands: [5, 9], pillars: [5, 8], serp: [2, 3], spiral: [8, 14], beams: [2, 4], ramps: [2, 4], hopper: [6, 9], zigzag: [5, 8], stairs: [2, 3], lifts: [1, 2] };
  const run = (name) => {
    const n = ri(...COUNT[name]);
    return name === 'spiral' ? segs.spiral(n, exitY > 35) : segs[name](n);
  };

  // Тупик: возвращаемся на несколько платформ назад и продолжаем трассу оттуда (получается развилка)
  function backtrack() {
    const j = Math.max(1, curIdx - ri(1, 10)), o = infos[j];
    if (o && !o.dead && o.ang !== undefined) { curIdx = j; ang = o.ang; exitY = o.ey; }
  }
  // Дописывает главы, пока платформ не станет target (или пока подряд не случится maxFails неудач).
  // retries: сколько раз можно вернуться назад, если трасса зашла в тупик (у стандартной длины их нет)
  let last = '', pi = 0;
  function grow(target, maxFails, retries = 0) {
    let fails = 0;
    for (;;) {
      while (plats.length < target && fails < maxFails) {
        let name;
        if (style === 'mix') { do name = pick(ALL); while (name === last); } else name = PLAN[style][pi++ % PLAN[style].length];
        last = name;
        const before = plats.length;
        if (!run(name) || plats.length === before) fails++;
        if (plats.length < target && R() < (hc ? 0.25 : 0.85)) hub();
      }
      if (plats.length >= target || retries-- <= 0) break;
      backtrack(); fails = 0;
    }
  }

  const longMode = len === 'long', inf = len === 'inf';
  // std: как раньше (D.total ± разброс, не больше 60); long: в 2.5 раза больше (не больше 130); inf: стартовый отрезок
  const target = inf ? 24 : Math.min(longMode ? 130 : 60, Math.round(D.total * (longMode ? 2.5 : 1)) + ri(-4, 6));
  grow(target, longMode ? 6 : inf ? 6 : hc ? 6 : 4, longMode ? 12 : inf ? 6 : hc ? 4 : 0);
  if (plats.length < 8) segs.islands(10);

  // Финал: большая площадка со звездой (в бесконечном уровне её нет)
  let fin = null;
  if (!inf) {
    const fs = hc ? pick([1, 2, 0]) : pick([1, 10, 2]);
    const fw = hc ? sz(3, 4) : fs === 10 ? sz(8, 9) : sz(6, 8), fdy = rr(0.2, 0.8), fgap = jg(0.5) * 0.75;
    attempt((turn) => ({ w: fw, d: fw, s: fs, dy: fdy, gap: fgap, turn, coin: 'none' }), 0);
    fin = plats[curIdx];
  }

  // ---------- Монеты и хабы ----------
  const coins = [], hubs = [];
  const MAXC = longMode ? 150 : inf ? 0 : 70; // в бесконечном уровне монет нет
  const add = (x, y, z) => { if (coins.length < MAXC) coins.push([q4(x), q4(y), q4(z)]); };
  // Монеты для платформ с номерами from..to-1 (для обычного уровня — сразу для всех)
  function coinPass(from, to) {
    for (let i = from; i < to; i++) {
      const a = plats[i], info = infos[i];
      if (info.hub) hubs.push([a[0], a[1], a[2]]);
      if (i === 0 || a === fin) continue;
      if (info.coin === 'top' && R() < 0.6) add(a[0], a[1] + 1.3, a[2]);
      if (info.coin === 'branch') { add(a[0] - 0.9, a[1] + 1.3, a[2]); add(a[0], a[1] + 1.6, a[2]); add(a[0] + 0.9, a[1] + 1.3, a[2]); }
    }
    // дуги из монет над длинными прыжками (по порядку постановки платформ)
    for (let i = Math.max(1, from); i < to; i++) {
      const A = plats[infos[i].from], B = plats[i];
      if (infos[i].gapIn >= 2.8 && infos[i].coin !== 'branch' && R() < 0.5) add((A[0] + B[0]) / 2, Math.max(A[1], B[1]) + 2.2, (A[2] + B[2]) / 2);
    }
  }
  coinPass(0, plats.length);

  const end = inf ? plats[curIdx] : fin;
  const level = {
    name: `${STYLES[style]}: ${seed}${longMode ? ' · длинный' : inf ? ' · ∞' : ''}`, seed: String(seed), style, diff, len,
    plats, coins, hubs, objs, goal: [end[0], end[1] + 1.6, end[2]], start: [0, 0, 0],
    shapes: [], req: false, theme: Math.floor(R() * nThemes),
  };

  // Бесконечный уровень: достроить ещё n платформ. Возвращает, сколько добавлено (0 — место закончилось).
  // Старые платформы (дальше 60 назад) забываются, поэтому трасса может снова пройти по тем же местам.
  if (inf) {
    level.more = (n = 10) => {
      const from = plats.length;
      grow(from + n, 8, 12);
      if (plats.length === from) return 0; // совсем тупик: вызывающий может попробовать позже
      while (deadTo < curIdx - 60) { const o = infos[deadTo++]; o.dead = true; o.parts = null; }
      coinPass(from, plats.length);
      const e = plats[curIdx];
      level.goal = [e[0], e[1] + 1.6, e[2]];
      return plats.length - from;
    };
  }
  return level;
}
