// src/music.js
/**
 * Процедурная музыка в духе старых консолей. Файлов нет: всё играется через Web Audio (см. audio.js).
 * 1-3 — прежние пресеты, 4-9 — новые, 10 — случайный плейлист (меняет мелодию каждые 30-50 секунд).
 */
import { audio, NOTE } from './audio.js';

export const MUSIC_NAMES = [
  'Выкл',
  'Расслабляющая',
  'Импульсивная',
  'Мелодичная',
  'Музыкальная шкатулка',
  'Приключение',
  'Лофи-вечер',
  'Вальс у камина',
  'Звёздное небо',
  'Пиксельный бег',
  'Случайный плейлист',
];
const SHUFFLE = 10;
const FN = [null, '_relaxing', '_impulsive', '_melodic', '_musicbox', '_adventure', '_lofi', '_waltz', '_stars', '_pixel'];
const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class MusicSystem {
  constructor() {
    this.preset = 0;
    this._tick = 0;
    this._timer = null;
    this._active = false;
    this._t = 0;          // время, до которого музыка уже расписана
    this._sess = null;    // «сессия»: у каждого запуска своя громкость, чтобы старые ноты не звучали в новой мелодии
    this._sessRev = null;
    this._cur = 1;
    this._shuf = 0;
  }

  // ─── Обёртки над движком: всё играет в текущую сессию ──────────────
  _tone(f, type, vol, t0, dur, rev = false, o = {}) {
    audio.tone(f, type, vol, t0, dur, { dest: this._sess, rev: rev ? this._sessRev : null, ...o });
  }
  _kick(t, vol) { audio.kick(t, { dest: this._sess, vol }); }
  _snare(t, vol = 0.26) { audio.snare(t, vol, { dest: this._sess }); }
  _hat(t, vol = 0.1, dur = 0.04) { audio.hat(t, vol, dur, { dest: this._sess }); }

  // ─── УПРАВЛЕНИЕ ──────────────────────────────────────────────────
  resume() { audio.resume(); }

  play(preset) {
    if (!audio.unlock()) return;
    this.stop();
    this.preset = preset;
    if (!preset) return;
    const ctx = audio.ctx, now = ctx.currentTime;
    this._sess = ctx.createGain();
    this._sess.gain.setValueAtTime(0, now);
    this._sess.gain.linearRampToValueAtTime(1, now + 1.4);
    this._sess.connect(audio.buses.music);
    this._sessRev = ctx.createGain();
    this._sessRev.connect(audio.revMusic);
    this._active = true;
    this._tick = 0; this._shuf = 0; this._cur = 1;
    this._t = now + 0.1;
    this._pump();
  }

  stop() {
    this._active = false;
    clearTimeout(this._timer);
    this._timer = null;
    const s = this._sess, r = this._sessRev;
    if (s && audio.ctx) {
      const t = audio.ctx.currentTime;
      s.gain.cancelScheduledValues(t); s.gain.setValueAtTime(s.gain.value, t); s.gain.linearRampToValueAtTime(0, t + 0.6);
      r.gain.cancelScheduledValues(t); r.gain.setValueAtTime(0, t);
      setTimeout(() => { try { s.disconnect(); r.disconnect(); } catch { /* уже отключено */ } }, 1500);
    }
    this._sess = this._sessRev = null;
  }

  _pickPreset() {
    if (this.preset !== SHUFFLE) return this.preset;
    if (this._shuf <= 0) {
      let n;
      do n = 1 + Math.floor(Math.random() * (FN.length - 1)); while (n === this._cur);
      this._cur = n; this._shuf = 2 + Math.floor(Math.random() * 2); this._tick = 0;
    }
    this._shuf--;
    return this._cur;
  }

  // Расписываем музыку на несколько секунд вперёд: ритм не плывёт, даже если вкладка тормозит
  _pump() {
    if (!this._active || !audio.ctx) return;
    while (this._t - audio.ctx.currentTime < 2.5) {
      const fn = FN[this._pickPreset()];
      this._t += this[fn](this._t);
      this._tick++;
    }
    this._timer = setTimeout(() => this._pump(), 400);
  }

  // ─── 1: Мягкая расслабляющая ─────────────────────────────────────
  // Вдохновение: Kokiri Forest / Kakariko Village (OoT)
  _relaxing(now) {
    const bpm = 66, b = 60 / bpm, beats = 16;
    const chords = [
      [48, 52, 55, 60], // C maj
      [45, 48, 52, 57], // A min
      [41, 45, 48, 53], // F maj
      [43, 47, 50, 55], // G maj
    ];
    const ch = chords[this._tick % chords.length];
    const dur = beats * b;

    ch.forEach((m, i) => this._tone(NOTE(m), 'sine', 0.052, now + i * 0.025, dur * 0.92, true));

    const arp = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 12, ch[1] + 12];
    arp.forEach((m, i) => this._tone(NOTE(m), 'sine', 0.034, now + i * b * 1.4, b * 1.1, true));

    const mel = [64, 67, 69, 72, 71, 69, 67, 64];
    const off = (this._tick % 2) * 4;
    for (let i = 0; i < 8; i++) {
      this._tone(NOTE(mel[(i + off) % mel.length]), 'sine', 0.026, now + b * 0.5 + i * b, b * 0.9, true);
    }

    this._tone(NOTE(84), 'sine', 0.020, now, b * 1.8, true);
    this._tone(NOTE(84), 'sine', 0.015, now + b * 8, b * 1.8, true);
    return dur;
  }

  // ─── 2: Импульсивная / биток ─────────────────────────────────────
  // Вдохновение: Battle theme (OoT) + pixel beat
  _impulsive(now) {
    const bpm = 136, b = 60 / bpm;
    const beats = 2 * 4;
    const dur = beats * b;

    for (let i = 0; i < beats * 2; i++) {
      const t = now + i * b * 0.5, pos = i % 8;
      if (pos === 0 || pos === 4) this._kick(t);
      if (pos === 2 || pos === 6) this._snare(t);
      this._hat(t, 0.08 + (pos % 2 ? 0 : 0.05), pos === 7 ? 0.14 : 0.04);
    }

    const bLines = [
      [33, 0, 33, 36, 33, 0, 36, 38],
      [40, 0, 40, 44, 40, 0, 44, 47],
    ];
    bLines[this._tick % bLines.length].forEach((m, i) => {
      if (m) this._tone(NOTE(m), 'sawtooth', 0.10, now + i * b * 0.5, b * 0.40);
    });

    const lLines = [
      [69, 72, 71, 69, 67, 69, 72, 74],
      [74, 72, 71, 69, 71, 72, 74, 76],
    ];
    lLines[this._tick % lLines.length].forEach((m, i) => {
      this._tone(NOTE(m), 'square', 0.062, now + i * b * 0.5, b * 0.36);
    });

    [[57, 60, 64], [55, 59, 62]].forEach((chord, ci) => {
      chord.forEach((m) => this._tone(NOTE(m), 'sawtooth', 0.038, now + b * (ci === 0 ? 1 : 3), b * 0.18));
    });
    return dur;
  }

  // ─── 3: Мелодичный (стиль окарины) ───────────────────────────────
  // Вдохновение: Saria's Song + Zelda's Lullaby (OoT)
  _melodic(now) {
    const bpm = 92, b = 60 / bpm;
    const pats = [
      [[64, 1], [67, .5], [64, .5], [60, 1], [64, 1], [62, 1], [60, .75], [59, 1.25],
       [64, 1], [67, .5], [64, .5], [60, 1], [64, 1], [62, .5], [60, .5], [57, 2]],
      [[71, .75], [67, .25], [69, .5], [71, 1.5], [67, .75], [69, .25], [71, .5], [69, 1.5],
       [67, .5], [64, .5], [67, .5], [64, .5], [60, 2], [64, .5], [65, .5], [67, .5], [69, 1.5]],
    ];
    const pat = pats[this._tick % pats.length];
    const totalDur = pat.reduce((s, [, d]) => s + d, 0) * b;

    let t = now;
    for (const [m, d] of pat) {
      const dur = d * b, f = NOTE(m);
      this._tone(f, 'sine', 0.095, t, dur, true);
      this._tone(f * 2, 'sine', 0.016, t, dur, true);
      this._tone(f * 1.498, 'sine', 0.011, t, dur, true);
      t += dur;
    }

    const pads = [[48, 52, 55, 60], [45, 48, 52, 57], [43, 47, 50, 55], [45, 52, 55, 59]];
    const pad = pads[this._tick % pads.length];
    pad.forEach((m) => this._tone(NOTE(m), 'triangle', 0.036, now, totalDur * 0.9, true));

    this._tone(NOTE(pad[0] - 12), 'sine', 0.062, now, b * 4, false);
    this._tone(NOTE(pad[0] - 12), 'sine', 0.050, now + b * 4, b * 4, false);
    return totalDur;
  }

  // ─── 4: Музыкальная шкатулка ─────────────────────────────────────
  // Колыбельная в 3/4: звонкие нотки с быстрым затуханием и мягкий аккомпанемент
  _musicbox(t0) {
    const b = 60 / 84;
    const ACC = { C: [60, 67, 64], Am: [57, 64, 60], F: [53, 60, 57], G: [55, 62, 59], Em: [52, 59, 55] }; // основа, квинта, терция
    const A = {
      ch: ['C', 'Am', 'F', 'G', 'C', 'Am', 'F', 'C'],
      m: [[[76, 1], [79, 1], [84, 1]], [[81, 1.5], [79, .5], [76, 1]], [[77, 1], [81, 1], [84, 1]], [[83, 2], [79, 1]],
        [[76, 1], [79, 1], [84, 1]], [[88, 1.5], [84, .5], [81, 1]], [[74, 1], [77, 1], [81, 1]], [[84, 3]]],
    };
    const B = {
      ch: ['C', 'G', 'Am', 'Em', 'F', 'C', 'G', 'C'],
      m: [[[79, 1.5], [76, .5], [72, 1]], [[74, 1], [79, 1], [83, 1]], [[81, 1.5], [76, .5], [72, 1]], [[71, 1], [76, 1], [79, 1]],
        [[77, 1.5], [72, .5], [69, 1]], [[72, 1], [76, 1], [79, 1]], [[74, 1.5], [71, .5], [74, 1]], [[72, 3]]],
    };
    const S = this._tick % 2 ? B : A;
    for (let k = 0; k < 8; k++) {
      const tb = t0 + k * 3 * b, acc = ACC[S.ch[k]];
      acc.forEach((m, i) => this._tone(NOTE(m), 'triangle', 0.045, tb + i * b, b * 1.4, true, { pluck: true }));
      let t = tb;
      for (const [m, d] of S.m[k]) {
        this._tone(NOTE(m), 'triangle', 0.075, t, Math.min(2.4, d * b + 1.2), true, { pluck: true });
        this._tone(NOTE(m + 12), 'sine', 0.022, t, 0.9, true, { pluck: true });
        t += d * b;
      }
    }
    return 24 * b;
  }

  // ─── 5: Приключение ──────────────────────────────────────────────
  // Бодрый марш: пульсовый лид, «ум-па» в басу и мягкие барабаны
  _adventure(t0) {
    const b = 60 / 118;
    const ROOT = { C: [48, 55], G: [43, 50], Am: [45, 52], F: [41, 48] };
    const bars = [
      ['C', [[72, .5], [76, .5], [79, 1], [76, .5], [79, .5], [84, 1]]],
      ['G', [[83, .5], [79, .5], [74, 1], [79, .5], [83, .5], [86, 1]]],
      ['Am', [[81, .5], [84, .5], [88, 1], [84, .5], [81, .5], [76, 1]]],
      ['F', [[77, .5], [81, .5], [84, 1], [81, .5], [77, .5], [72, 1]]],
      ['C', [[79, 1], [79, .5], [84, .5], [83, 1], [79, 1]]],
      ['G', [[74, 1], [74, .5], [79, .5], [83, 1], [86, 1]]],
      ['F', [[84, 1], [81, .5], [77, .5], [81, 1], [84, 1]]],
      ['C', [[83, .5], [81, .5], [79, 1], [84, 2]]],
    ];
    bars.forEach(([name, mel], k) => {
      const tb = t0 + k * 4 * b, [root, fifth] = ROOT[name];
      let t = tb;
      for (const [m, d] of mel) {
        this._tone(NOTE(m), 'p25', 0.055, t, d * b * 0.9);
        this._tone(NOTE(m - 12), 'triangle', 0.03, t, d * b * 0.9);
        t += d * b;
      }
      for (let i = 0; i < 4; i++) this._tone(NOTE(i % 2 ? fifth : root), 'triangle', 0.11, tb + i * b, b * 0.8);
      this._kick(tb, 0.35); this._kick(tb + 2 * b, 0.35);
      this._snare(tb + b, 0.14); this._snare(tb + 3 * b, 0.14);
      for (let i = 0; i < 8; i++) this._hat(tb + i * b / 2, 0.05, 0.03);
    });
    return 32 * b;
  }

  // ─── 6: Лофи-вечер ───────────────────────────────────────────────
  // Неспешный бит со свингом, мягкие аккорды, редкие нотки и потрескивание пластинки
  _lofi(t0) {
    const b = 60 / 78, sw = 0.16 * b;
    const CH = {
      Cmaj7: [48, 55, 59, 64], Am7: [45, 52, 55, 60], Dm7: [50, 57, 60, 65],
      G7: [43, 53, 59, 62], Fmaj7: [41, 48, 52, 57], Em7: [40, 47, 50, 55],
    };
    const progs = [['Cmaj7', 'Am7', 'Dm7', 'G7'], ['Fmaj7', 'Em7', 'Dm7', 'Cmaj7'], ['Am7', 'Dm7', 'G7', 'Cmaj7']];
    const prog = progs[this._tick % progs.length];
    const pent = [72, 74, 76, 79, 81, 84];
    prog.forEach((name, k) => {
      const tb = t0 + k * 4 * b, ch = CH[name];
      const E = (e) => tb + e * b / 2 + (e % 2 ? sw : 0); // время восьмой с учётом свинга
      for (const [e, len] of [[0, 1.5], [3, 1.1]]) {
        ch.slice(1).forEach((m, i) => {
          this._tone(NOTE(m), 'triangle', 0.05, E(e) + i * 0.018, len * b, true, { pluck: true });
          this._tone(NOTE(m + 12), 'sine', 0.012, E(e) + i * 0.018, len * b * 0.7, true, { pluck: true });
        });
      }
      for (const [e, m, d, v] of [[0, ch[0], 0.9, 0.12], [3, ch[0] + 7, 0.5, 0.08], [6, ch[0], 0.5, 0.09]]) {
        this._tone(NOTE(m), 'sine', v, E(e), d * b);
      }
      this._kick(E(0), 0.4); this._kick(E(5), 0.32);
      this._snare(E(2), 0.11); this._snare(E(6), 0.11);
      for (let e = 0; e < 8; e++) this._hat(E(e), e % 2 ? 0.03 : 0.05, 0.03);
      if (Math.random() < 0.6) {
        const n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0, e = Math.floor(Math.random() * 3); i < n && e < 8; i++, e += 1 + Math.floor(Math.random() * 2)) {
          this._tone(NOTE(rnd(pent)), 'triangle', 0.05, E(e), 0.9 * b, true, { pluck: true });
        }
      }
    });
    for (let i = 0; i < 14; i++) this._hat(t0 + Math.random() * 16 * b, 0.018, 0.012); // потрескивание
    return 16 * b;
  }

  // ─── 7: Вальс у камина ───────────────────────────────────────────
  // «Раз-два-три» в ля миноре: бас на раз, аккорды на два и три, мелодия пульсовой волной
  _waltz(t0) {
    const b = 60 / 112;
    const CH = { Am: [45, [57, 60, 64]], E: [40, [56, 59, 64]], Dm: [38, [53, 57, 62]] };
    const bars = ['Am', 'Am', 'E', 'Am', 'Dm', 'Am', 'E', 'Am'];
    const mel = [[[76, 2], [72, 1]], [[69, 1], [72, 1], [76, 1]], [[80, 2], [76, 1]], [[81, 3]],
      [[77, 2], [74, 1]], [[72, 1], [76, 1], [72, 1]], [[71, 1], [76, 1], [80, 1]], [[81, 3]]];
    const hi = this._tick % 2 === 1; // на втором круге мелодия звенит октавой выше
    bars.forEach((name, k) => {
      const tb = t0 + k * 3 * b, [bass, chord] = CH[name];
      this._tone(NOTE(bass), 'triangle', 0.12, tb, b * 0.9);
      for (const off of [1, 2]) chord.forEach((m) => this._tone(NOTE(m), 'triangle', 0.04, tb + off * b, b * 0.5));
      let t = tb;
      for (const [m, d] of mel[k]) {
        if (hi) this._tone(NOTE(m + 12), 'triangle', 0.07, t, d * b * 0.95, true, { pluck: true });
        else this._tone(NOTE(m), 'p25', 0.05, t, d * b * 0.95, true);
        t += d * b;
      }
    });
    return 24 * b;
  }

  // ─── 8: Звёздное небо ────────────────────────────────────────────
  // Медленные облака аккордов и редкие искорки-колокольчики с эхом
  _stars(t0) {
    const b = 60 / 56;
    const sets = [
      [[53, 57, 60, 64], [48, 55, 59, 64], [45, 52, 55, 60], [50, 55, 59, 64]],
      [[48, 55, 59, 64], [53, 57, 60, 64], [50, 57, 60, 65], [43, 50, 55, 59]],
    ];
    sets[this._tick % 2].forEach((ch, k) => {
      const tb = t0 + k * 4 * b;
      ch.forEach((m, i) => this._tone(NOTE(m), i % 2 ? 'triangle' : 'sine', 0.04, tb + i * 0.12, 4 * b * 1.05, true, { att: 0.9, rel: 1.2 }));
      this._tone(NOTE(36 + (ch[0] % 12)), 'sine', 0.07, tb, 4 * b, false, { att: 0.6, rel: 1 });
      for (let e = 0; e < 8; e++) {
        if (Math.random() > 0.62) continue;
        const m = rnd(ch) + 12 * (Math.random() < 0.4 ? 2 : 1);
        this._tone(NOTE(m), 'sine', 0.03, tb + e * b / 2 + Math.random() * 0.03, b * 2.2, true, { pluck: true });
      }
    });
    return 16 * b;
  }

  // ─── 9: Пиксельный бег ───────────────────────────────────────────
  // Быстрые чиптюн-арпеджио, прыгающий бас и лёгкий бит
  _pixel(t0) {
    const b = 60 / 150, s = b / 4;
    const CH = { Am: [57, 60, 64, 69], F: [53, 57, 60, 65], C: [55, 60, 64, 67], G: [55, 59, 62, 67] };
    const ROOT = { Am: 45, F: 41, C: 48, G: 43 };
    const progs = [['Am', 'F', 'C', 'G'], ['C', 'G', 'Am', 'F']];
    const pat = [0, 1, 2, 3, 2, 1, 2, 3, 0, 1, 2, 3, 2, 1, 2, 1];
    progs[this._tick % 2].forEach((name, k) => {
      const tb = t0 + k * 4 * b, ch = CH[name];
      for (let i = 0; i < 16; i++) this._tone(NOTE(ch[pat[i]] + 12), 'p25', i % 4 ? 0.032 : 0.042, tb + i * s, s * 0.85);
      for (let j = 0; j < 8; j++) this._tone(NOTE(ROOT[name] + (j % 2 ? 12 : 0)), 'triangle', 0.1, tb + j * b / 2, b * 0.45);
      this._kick(tb, 0.38); this._kick(tb + 2 * b, 0.38);
      this._snare(tb + b, 0.12); this._snare(tb + 3 * b, 0.12);
      for (let j = 0; j < 8; j++) this._hat(tb + j * b / 2, 0.04, j === 7 ? 0.1 : 0.03);
    });
    return 16 * b;
  }
}

export const music = new MusicSystem();
