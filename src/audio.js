// src/audio.js — звуковой движок «как на старой консоли». Внешних файлов нет, всё рождается в коде.
//
// Как получается «некачественный, но уютный» звук:
//   • эффекты рисуются заранее на низкой частоте дискретизации (11 кГц) и огрубляются до 6 бит —
//     получается лёгкий хрип и «ступеньки», как у картриджей 90-х;
//   • голоса — прямоугольные волны с разной скважностью (12 %, 25 %, 50 %), треугольник и шум;
//   • всё идёт через мягкий фильтр «глухости» (ползунок «Старая консоль») и ограничитель громкости.
//
// Шины (у каждой свой ползунок в настройках): music, sfx (прыжок, бег, монеты), amb (окружение), ui (меню и редактор).
// Работает без three.js. Звук включается после первого действия игрока (правило браузеров): см. unlock().

const SR = 11025; // частота «консольных» эффектов
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
export const NOTE = (m) => 440 * Math.pow(2, (m - 69) / 12);

const DEFAULTS = { master: 0.85, music: 0.7, sfx: 0.8, amb: 0.55, ui: 0.7, lofi: 0.45 };
// Запас громкости шин: при ползунке 100 % звук действительно громкий (ограничитель страхует от перегруза)
const BUS_GAIN = { music: 2.2, sfx: 1.4, amb: 1.6, ui: 1.4 };
const taper = (v) => Math.pow(clamp(v), 1.7); // ползунок -> громкость (на слух ровнее, чем линейно)

// ---------- Рисование эффектов (чистые функции, без Web Audio) ----------
const sqW = (duty = 0.5) => { let ph = 0; return (f) => { ph += f / SR; ph -= Math.floor(ph); return ph < duty ? 1 : -1; }; };
const triW = () => { let ph = 0; return (f) => { ph += f / SR; ph -= Math.floor(ph); return 4 * Math.abs(ph - 0.5) - 1; }; };
// Шум, который меняется не каждый отсчёт, а раз в `hold` отсчётов: звучит «зернистее»
const noiseW = (seed = 1, hold = 1) => {
  let s = (seed * 2654435761) >>> 0, v = 0, c = 0;
  return () => { if (c++ % hold === 0) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v = s / 2147483648 - 1; } return v; };
};

// Набор нот: [частота, старт, длина, громкость?]. duty — скважность, tri — доля треугольника, decay — как быстро затухает
export function notesFn(notes, { duty = 0.5, decay = 8, tri = 0 } = {}) {
  const ph = new Float32Array(notes.length);
  return (t) => {
    let s = 0;
    for (let i = 0; i < notes.length; i++) {
      const [f, st, len, g = 1] = notes[i];
      if (t < st || t >= st + len) continue;
      ph[i] += f / SR; ph[i] -= Math.floor(ph[i]);
      const lt = t - st, e = Math.exp(-lt * decay) * Math.min(1, lt / 0.004) * Math.min(1, (st + len - t) / 0.01);
      const w = ph[i] < duty ? 1 : -1, tw = 4 * Math.abs(ph[i] - 0.5) - 1;
      s += (w * (1 - tri) + tw * tri) * e * g;
    }
    return s;
  };
}

// Свисты (птицы): [частота начала, частота конца, старт, длина], синус с колоколом громкости
function sweepFn(segs) {
  let ph = 0;
  return (t) => {
    for (const [f0, f1, st, len] of segs) {
      if (t < st || t >= st + len) continue;
      const u = (t - st) / len;
      ph += (f0 + (f1 - f0) * u) / SR; ph -= Math.floor(ph);
      return Math.sin(ph * 6.2832) * Math.pow(Math.sin(Math.PI * u), 0.6);
    }
    return 0;
  };
}

// Рисует звук: fn(t, u) -> сэмпл. Сглаживает, нормирует и огрубляет до `bits` бит
export function render(dur, fn, { bits = 6, soft = 0.3 } = {}) {
  const n = Math.max(16, Math.floor(dur * SR)), d = new Float32Array(n);
  let peak = 1e-6, prev = 0;
  for (let i = 0; i < n; i++) {
    prev = prev * soft + fn(i / SR, i / n) * (1 - soft);
    d[i] = prev; peak = Math.max(peak, Math.abs(prev));
  }
  const k = 0.95 / peak, q = Math.pow(2, bits - 1), fade = Math.floor(SR * 0.004);
  for (let i = 0; i < n; i++) {
    let v = Math.round(d[i] * k * q) / q;
    if (i > n - fade) v *= (n - i) / fade;
    d[i] = v;
  }
  return d;
}

const BIRDS = [
  [[2300, 3300, 0, 0.07], [2500, 3500, 0.1, 0.07]],
  [[2800, 3200, 0, 0.04], [3300, 2900, 0.06, 0.04], [2800, 3300, 0.12, 0.04], [3300, 2900, 0.18, 0.04]],
  [[3700, 2500, 0, 0.28]],
];

// Таблица эффектов. gain — базовая громкость, bus — шина, cool — минимальная пауза между повторами, variants — сколько вариантов
export const SFX = {
  // --- игра ---
  jump: { dur: 0.22, gain: 0.5, bus: 'sfx', make: () => { const a = sqW(0.25), b = triW(); return (t, u) => (a(250 + 560 * Math.pow(u, 0.75)) * 0.55 + b(125 + 280 * Math.pow(u, 0.75)) * 0.6) * Math.pow(1 - u, 1.3); } },
  step: { dur: 0.1, gain: 0.5, bus: 'sfx', cool: 0.07, variants: 3, make: (i) => { const o = triW(), n = noiseW(i + 3, 2), f0 = 130 + i * 22; return (t) => o(f0 - 600 * t) * Math.exp(-t * 45) + n() * 0.55 * Math.exp(-t * 80); } },
  land: { dur: 0.22, gain: 0.7, bus: 'sfx', make: () => { const o = triW(), n = noiseW(9, 3); return (t) => o(115 - 300 * t) * Math.exp(-t * 18) + n() * 0.5 * Math.exp(-t * 38); } },
  coin: { dur: 0.32, gain: 0.42, bus: 'sfx', cool: 0.02, make: () => notesFn([[988, 0, 0.07], [1319, 0.07, 0.25]], { duty: 0.5, decay: 9, tri: 0.15 }) },
  allcoins: { dur: 0.75, gain: 0.45, bus: 'sfx', make: () => notesFn([[1047, 0, 0.09], [1319, 0.09, 0.09], [1568, 0.18, 0.09], [2093, 0.27, 0.45]], { duty: 0.5, decay: 6, tri: 0.25 }) },
  win: { dur: 1.7, gain: 0.6, bus: 'sfx', make: () => {
    const a = notesFn([[392, 0, 0.13], [523, 0.13, 0.13], [659, 0.26, 0.13], [784, 0.39, 0.13], [1047, 0.52, 1.05]], { duty: 0.25, decay: 2.2 });
    const b = notesFn([[262, 0.52, 1.05, 0.9], [330, 0.52, 1.05, 0.7]], { tri: 1, decay: 1.6 });
    return (t) => a(t) * 0.7 + b(t) * 0.8; } },
  fall: { dur: 0.6, gain: 0.5, bus: 'sfx', make: () => { const a = sqW(0.5), b = triW(); return (t, u) => (a(720 * Math.pow(0.12, u)) * 0.5 + b(360 * Math.pow(0.12, u)) * 0.6) * Math.pow(1 - u, 0.6); } },
  restart: { dur: 0.26, gain: 0.45, bus: 'sfx', make: () => notesFn([[523, 0, 0.07], [784, 0.07, 0.14]], { duty: 0.25, decay: 10 }) },
  locked: { dur: 0.32, gain: 0.5, bus: 'sfx', make: () => notesFn([[196, 0, 0.11], [147, 0.12, 0.18]], { duty: 0.5, decay: 5, tri: 0.3 }) },
  // --- меню ---
  ui: { dur: 0.055, gain: 0.35, bus: 'ui', cool: 0.03, make: () => notesFn([[880, 0, 0.05]], { duty: 0.25, decay: 30 }) },
  back: { dur: 0.1, gain: 0.35, bus: 'ui', cool: 0.03, make: () => notesFn([[660, 0, 0.035], [440, 0.04, 0.05]], { duty: 0.25, decay: 25 }) },
  move: { dur: 0.035, gain: 0.28, bus: 'ui', cool: 0.02, make: () => notesFn([[1175, 0, 0.03]], { duty: 0.5, decay: 40, tri: 0.4 }) },
  // --- редактор ---
  tick: { dur: 0.04, gain: 0.3, bus: 'ui', cool: 0.03, make: () => notesFn([[1568, 0, 0.035]], { duty: 0.25, decay: 40 }) },
  tool: { dur: 0.09, gain: 0.35, bus: 'ui', cool: 0.03, make: () => notesFn([[988, 0, 0.03], [1319, 0.03, 0.05]], { duty: 0.5, decay: 25, tri: 0.3 }) },
  place: { dur: 0.22, gain: 0.5, bus: 'ui', make: () => { const o = triW(), a = notesFn([[523, 0.02, 0.07], [784, 0.07, 0.12]], { duty: 0.25, decay: 14 }); return (t) => o(170 - 500 * t) * Math.exp(-t * 28) * 0.9 + a(t) * 0.55; } },
  putCoin: { dur: 0.2, gain: 0.4, bus: 'ui', make: () => notesFn([[1319, 0, 0.05], [1760, 0.05, 0.13]], { duty: 0.5, decay: 14 }) },
  putGoal: { dur: 0.45, gain: 0.45, bus: 'ui', make: () => notesFn([[784, 0, 0.07], [988, 0.07, 0.07], [1319, 0.14, 0.07], [1568, 0.21, 0.2]], { duty: 0.5, decay: 10 }) },
  putStart: { dur: 0.26, gain: 0.45, bus: 'ui', make: () => notesFn([[392, 0, 0.08], [523, 0.08, 0.16]], { duty: 0.5, decay: 9, tri: 0.5 }) },
  putFlag: { dur: 0.3, gain: 0.4, bus: 'ui', make: () => notesFn([[659, 0, 0.06], [880, 0.06, 0.06], [1047, 0.12, 0.15]], { duty: 0.25, decay: 12 }) },
  erase: { dur: 0.2, gain: 0.45, bus: 'ui', make: () => { const n = noiseW(5, 2), o = triW(); return (t, u) => (n() * 0.5 + o(520 - 380 * u) * 0.6) * Math.pow(1 - u, 1.8); } },
  undo: { dur: 0.24, gain: 0.4, bus: 'ui', make: () => notesFn([[740, 0, 0.05], [554, 0.06, 0.05], [415, 0.12, 0.1]], { duty: 0.25, decay: 14 }) },
  error: { dur: 0.26, gain: 0.5, bus: 'ui', make: () => notesFn([[147, 0, 0.09], [123, 0.1, 0.14]], { duty: 0.5, decay: 3, tri: 0.2 }) },
  point: { dur: 0.045, gain: 0.3, bus: 'ui', cool: 0.02, make: () => notesFn([[1047, 0, 0.04]], { duty: 0.5, decay: 30 }) },
  done: { dur: 0.55, gain: 0.45, bus: 'ui', make: () => notesFn([[523, 0, 0.07], [659, 0.07, 0.07], [784, 0.14, 0.07], [1047, 0.21, 0.3]], { duty: 0.5, decay: 8, tri: 0.2 }) },
  editOn: { dur: 0.32, gain: 0.45, bus: 'ui', make: () => notesFn([[392, 0, 0.06], [523, 0.06, 0.06], [659, 0.12, 0.16]], { duty: 0.25, decay: 9 }) },
  editOff: { dur: 0.32, gain: 0.45, bus: 'ui', make: () => notesFn([[659, 0, 0.06], [523, 0.06, 0.06], [392, 0.12, 0.16]], { duty: 0.25, decay: 9 }) },
  // --- окружение ---
  bird: { dur: 0.3, gain: 0.4, bus: 'amb', variants: 3, bits: 7, make: (i) => sweepFn(BIRDS[i % BIRDS.length]) },
};

// Волна с заданной скважностью (для Web Audio PeriodicWave)
function pulseWave(ctx, duty, harmonics = 40) {
  const re = new Float32Array(harmonics + 1), im = new Float32Array(harmonics + 1);
  for (let n = 1; n <= harmonics; n++) {
    re[n] = (2 * Math.sin(2 * Math.PI * n * duty)) / (Math.PI * n);
    im[n] = (2 * (1 - Math.cos(2 * Math.PI * n * duty))) / (Math.PI * n);
  }
  return ctx.createPeriodicWave(re, im);
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.vol = { ...DEFAULTS };
    this.buses = {};
    this.failed = false;
    this._bufs = {};
    this._last = {};
    this._amb = null;
    this._clock = 0;
    this._birdT = 2.5;
    this._chT = 7;
  }

  // ----- настройки -----
  settings() { return { ...this.vol }; }
  load(o) {
    if (!o || typeof o !== 'object') return;
    for (const k in DEFAULTS) if (typeof o[k] === 'number' && Number.isFinite(o[k])) this.vol[k] = clamp(o[k]);
  }
  set(key, v) {
    if (!(key in DEFAULTS)) return;
    this.vol[key] = clamp(+v);
    this._apply(false);
  }
  _apply(immediate) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, v = this.vol;
    const put = (prm, x) => (immediate ? (prm.value = x) : prm.setTargetAtTime(x, t, 0.03));
    put(this.out.gain, taper(v.master));
    for (const k in BUS_GAIN) put(this.buses[k].gain, taper(v[k]) * BUS_GAIN[k]);
    put(this.lp.frequency, 16000 * Math.pow(1800 / 16000, v.lofi)); // 0 — чисто, 1 — совсем глухо
  }

  // ----- запуск -----
  // Вызывать из любого действия игрока. Возвращает true, если звук готов.
  unlock() {
    if (this.failed) return false;
    if (!this.ctx) {
      try { this._build(); } catch (e) { console.warn('Web Audio недоступен:', e); this.ctx = null; this.failed = true; return false; }
    }
    this.resume();
    return true;
  }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC());
    this.out = ctx.createGain();
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.Q.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -9; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.18;
    this.out.connect(this.lp); this.lp.connect(comp); comp.connect(ctx.destination);
    for (const k in BUS_GAIN) { const g = ctx.createGain(); g.connect(this.out); this.buses[k] = g; }
    this.birdLP = ctx.createBiquadFilter(); this.birdLP.type = 'lowpass'; this.birdLP.frequency.value = 2800;
    this.birdLP.connect(this.buses.amb);

    this.waves = { p25: pulseWave(ctx, 0.25), p125: pulseWave(ctx, 0.125), p50: pulseWave(ctx, 0.5) };

    // шум 16 кГц: «зернистый», для барабанов и ветра
    const nb = ctx.createBuffer(1, 32000, 16000), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    this.noise = nb;

    // импульс реверберации: тёмный, быстро затухающий
    const rate = ctx.sampleRate, len = Math.round(rate * 1.8), ir = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c); let lp = 0;
      for (let i = 0; i < len; i++) { lp += (Math.random() * 2 - 1 - lp) * 0.35; d[i] = lp * Math.pow(1 - i / len, 2.2); }
    }
    this._ir = ir;
    this.revMusic = this._mkReverb(this.buses.music, 0.3);
    this.revAmb = this._mkReverb(this.buses.amb, 0.35);

    for (const [name, def] of Object.entries(SFX)) {
      const list = [];
      for (let i = 0; i < (def.variants || 1); i++) {
        const d = render(def.dur, def.make(i), { bits: def.bits ?? 6, soft: def.soft ?? 0.3 });
        const b = ctx.createBuffer(1, d.length, SR); b.getChannelData(0).set(d); list.push(b);
      }
      this._bufs[name] = list;
    }
    this._buildAmbience();
    this._apply(true);
  }

  _mkReverb(dest, level) {
    const c = this.ctx.createConvolver(); c.buffer = this._ir;
    const inp = this.ctx.createGain(), out = this.ctx.createGain();
    out.gain.value = level;
    inp.connect(c); c.connect(out); out.connect(dest);
    return inp;
  }

  // ----- эффекты -----
  // name — из таблицы SFX. o: vol, rate (высота), delay (сек), pan (-1..1), jitter (случайный разброс высоты)
  sfx(name, o = {}) {
    const ctx = this.ctx, def = SFX[name];
    if (!ctx || !def) return;
    const now = ctx.currentTime;
    if (!o.delay && now - (this._last[name] ?? -9) < (def.cool ?? 0.03)) return;
    if (!o.delay) this._last[name] = now;
    const list = this._bufs[name], src = ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = (o.rate || 1) * (1 + (Math.random() - 0.5) * 2 * (o.jitter ?? 0.05));
    const g = ctx.createGain(); g.gain.value = def.gain * (o.vol ?? 1);
    src.connect(g);
    let node = g;
    if (o.pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = o.pan; g.connect(p); node = p; }
    node.connect(def.bus === 'amb' ? this.birdLP : this.buses[def.bus]);
    src.start(now + (o.delay || 0));
  }

  // Нота на осцилляторе. type: sine | triangle | sawtooth | square | p25 | p125 | p50.
  // o: dest (куда играть), rev (вход реверберации), pluck (быстрое затухание), att, rel, to (скольжение высоты)
  tone(freq, type, vol, t0, dur, o = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator(), env = ctx.createGain();
    if (this.waves[type]) osc.setPeriodicWave(this.waves[type]); else osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    if (o.pluck) {
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(vol, t0 + 0.005);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    } else {
      const att = o.att ?? Math.min(0.04, dur * 0.12), rel = o.rel ?? Math.min(0.14, dur * 0.35);
      env.gain.setValueAtTime(0, t0);
      env.gain.linearRampToValueAtTime(vol, t0 + att);
      env.gain.setValueAtTime(vol, Math.max(t0 + att, t0 + dur - rel));
      env.gain.linearRampToValueAtTime(0, t0 + dur);
    }
    osc.connect(env);
    env.connect(o.dest || this.buses.music);
    if (o.rev) env.connect(o.rev);
    osc.start(t0); osc.stop(t0 + dur + 0.08);
  }

  _noiseHit(t, dur, type, freq, q, vol, dest) {
    const ctx = this.ctx, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noise; src.loop = true;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest || this.buses.music);
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }
  kick(t, o = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator(), g = ctx.createGain(), v = o.vol ?? 0.52;
    osc.frequency.setValueAtTime(155, t); osc.frequency.exponentialRampToValueAtTime(38, t + 0.11);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(g); g.connect(o.dest || this.buses.music);
    osc.start(t); osc.stop(t + 0.3);
  }
  snare(t, vol = 0.26, o = {}) {
    if (!this.ctx) return;
    this._noiseHit(t, 0.15, 'bandpass', 2200, 0.6, vol, o.dest);
    this.tone(185, 'triangle', vol * 0.5, t, 0.08, { dest: o.dest, pluck: true });
  }
  hat(t, vol = 0.1, dur = 0.04, o = {}) {
    if (!this.ctx) return;
    this._noiseHit(t, Math.max(dur, 0.02), 'highpass', 3800, 0.7, vol, o.dest);
  }

  // Далёкий колокольчик (пентатоника) с эхом
  chime() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + 0.02, pent = [72, 74, 76, 79, 81, 84, 88], n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const m = pent[Math.floor(Math.random() * pent.length)], tt = t + i * (0.18 + Math.random() * 0.12);
      this.tone(NOTE(m), 'sine', 0.16, tt, 2.6, { dest: this.buses.amb, rev: this.revAmb, pluck: true });
      this.tone(NOTE(m) * 2.001, 'sine', 0.04, tt, 1.2, { dest: this.buses.amb, pluck: true });
    }
  }

  // ----- окружение: ветер, шипение на высоте и в падении, птицы, колокольчики -----
  _buildAmbience() {
    const ctx = this.ctx, WR = 8000, N = WR * 6, F = WR / 2 | 0;
    // розовый шум (фильтр Келли), закольцованный плавным переходом
    const raw = new Float32Array(N); let b0 = 0, b1 = 0, b2 = 0, peak = 1e-6;
    for (let i = 0; i < N; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      raw[i] = b0 + b1 + b2 + w * 0.1848; peak = Math.max(peak, Math.abs(raw[i]));
    }
    const out = ctx.createBuffer(1, N - F, WR), d = out.getChannelData(0);
    for (let i = 0; i < N - F; i++) d[i] = (raw[i] / peak) * 0.9;
    for (let i = 0; i < F; i++) d[i] = d[i] * (i / F) + ((raw[N - F + i] / peak) * 0.9) * (1 - i / F);

    const mk = (rate, freq, type, q, off) => {
      const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      src.buffer = out; src.loop = true; src.playbackRate.value = rate;
      f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.buses.amb); src.start(0, off);
      return { f, g };
    };
    this._amb = { wind: mk(1, 500, 'lowpass', 0.5, 0), hiss: mk(1.7, 1200, 'bandpass', 0.8, 2.3) };
  }

  // Раз в кадр. p: level (0..1 общая «слышимость»), height (высота), speed (бег), fall (скорость падения)
  update(dt, p = {}) {
    const ctx = this.ctx, a = this._amb;
    if (!ctx || !a) return;
    this._clock += dt;
    const t = ctx.currentTime, lvl = p.level ?? 1;
    const h = clamp((p.height ?? 0) / 45), fall = clamp((p.fall ?? 0) / 28), sp = clamp((p.speed ?? 0) / 7);
    const gust = 0.5 + 0.28 * Math.sin(this._clock * 0.21) + 0.22 * Math.sin(this._clock * 0.57 + 1.3);
    const w = clamp(0.3 + 0.35 * h + 0.55 * fall + 0.1 * sp + 0.25 * (gust - 0.5));
    a.wind.g.gain.setTargetAtTime(lvl * (0.06 + 0.4 * w), t, 0.25);
    a.wind.f.frequency.setTargetAtTime(350 + 1100 * w, t, 0.25);
    a.hiss.g.gain.setTargetAtTime(lvl * 0.1 * w * w * (0.5 + fall), t, 0.25);
    a.hiss.f.frequency.setTargetAtTime(900 + 900 * w, t, 0.25);

    this._birdT -= dt; this._chT -= dt;
    if (this.vol.amb > 0.02 && lvl > 0.1 && ctx.state === 'running') {
      if (this._birdT <= 0) {
        this._birdT = 3 + Math.random() * 7;
        if (h < 0.9 && Math.random() < 0.8) this.sfx('bird', { pan: (Math.random() * 2 - 1) * 0.8, vol: (0.4 + Math.random() * 0.6) * lvl, rate: 0.85 + Math.random() * 0.45, jitter: 0 });
      }
      if (this._chT <= 0) { this._chT = 9 + Math.random() * 14; this.chime(); }
    }
  }

  // Пример звука при настройке ползунка
  preview(name) {
    if (!this.ctx) return;
    if (name === 'chime') { this.chime(); this.sfx('bird', { pan: 0.3, delay: 0.5, jitter: 0 }); }
    else this.sfx(name, { delay: 0.001 });
  }
  // Кнопка «Проверить звуки»
  demo() {
    if (!this.unlock()) return;
    for (const [n, d] of [['jump', 0], ['step', 0.35], ['step', 0.55], ['land', 0.8], ['coin', 1.1], ['place', 1.5], ['bird', 1.9]]) this.sfx(n, { delay: d + 0.001 });
    setTimeout(() => this.chime(), 2300);
  }
}

export const audio = new AudioEngine();
