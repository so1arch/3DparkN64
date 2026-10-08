// src/music.js  — новый файл
/**
 * Процедурная музыкальная система в стиле Ocarina of Time.
 * Три пресета, генерируются через Web Audio API (внешних файлов не требуется).
 */

const NOTE = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

export class MusicSystem {
  constructor() {
    this._ctx = null;
    this._master = null;
    this._rev = null;
    this._revSend = null;
    this.preset = 0;
    this.volume = 0.46;
    this._tick = 0;
    this._timer = null;
    this._active = false;
  }

  _init() {
    if (this._ctx) return true;
    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._master = this._ctx.createGain();
      this._master.gain.value = 0;
      this._master.connect(this._ctx.destination);

      // Конвольверный реверб
      const rate = this._ctx.sampleRate, len = Math.round(rate * 2.0);
      const buf = this._ctx.createBuffer(2, len, rate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.6);
      }
      this._rev = this._ctx.createConvolver();
      this._rev.buffer = buf;
      this._revSend = this._ctx.createGain();
      this._revSend.gain.value = 0.20;
      this._rev.connect(this._revSend);
      this._revSend.connect(this._ctx.destination);
      return true;
    } catch (e) {
      console.warn('Web Audio недоступен:', e);
      return false;
    }
  }

  _tone(freq, type, vol, t0, dur, rev = false) {
    const ctx = this._ctx;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    const att = Math.min(0.04, dur * 0.12);
    const rel = Math.min(0.14, dur * 0.35);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(vol, t0 + att);
    env.gain.setValueAtTime(vol, t0 + dur - rel);
    env.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(env);
    env.connect(this._master);
    if (rev && this._rev) env.connect(this._rev);
    osc.start(t0);
    osc.stop(t0 + dur + 0.06);
  }

  _kick(t) {
    const ctx = this._ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.11);
    g.gain.setValueAtTime(0.52, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.connect(g); g.connect(this._master);
    o.start(t); o.stop(t + 0.30);
  }

  _snare(t, vol = 0.26) {
    const ctx = this._ctx, rate = ctx.sampleRate;
    const frames = Math.round(rate * 0.15);
    const buf = ctx.createBuffer(1, frames, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, 1.7);
    const src = ctx.createBufferSource(), env = ctx.createGain();
    const bpf = ctx.createBiquadFilter();
    src.buffer = buf; bpf.type = 'bandpass'; bpf.frequency.value = 2500; bpf.Q.value = 0.5;
    env.gain.setValueAtTime(vol, t); env.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    src.connect(bpf); bpf.connect(env); env.connect(this._master);
    src.start(t);
  }

  _hat(t, vol = 0.10, dur = 0.04) {
    const ctx = this._ctx, rate = ctx.sampleRate;
    const frames = Math.round(rate * Math.max(dur, 0.02));
    const buf = ctx.createBuffer(1, frames, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, dur > 0.1 ? 1.2 : 3.5);
    const src = ctx.createBufferSource(), env = ctx.createGain(), hpf = ctx.createBiquadFilter();
    src.buffer = buf; hpf.type = 'highpass'; hpf.frequency.value = 8800;
    env.gain.setValueAtTime(vol, t); env.gain.exponentialRampToValueAtTime(0.001, t + frames / rate);
    src.connect(hpf); hpf.connect(env); env.connect(this._master);
    src.start(t);
  }

  // ─── УПРАВЛЕНИЕ ──────────────────────────────────────────────────

  play(preset) {
    if (!this._init()) return;
    if (this._ctx.state === 'suspended') this._ctx.resume();
    this.stop();
    this.preset = preset;
    if (!preset) return;
    this._active = true;
    this._tick = 0;
    this._master.gain.cancelScheduledValues(this._ctx.currentTime);
    this._master.gain.setValueAtTime(0, this._ctx.currentTime);
    this._master.gain.linearRampToValueAtTime(this.volume, this._ctx.currentTime + 1.4);
    this._schedule();
  }

  stop() {
    this._active = false;
    clearTimeout(this._timer);
    this._timer = null;
    if (this._master && this._ctx) {
      this._master.gain.setTargetAtTime(0, this._ctx.currentTime, 0.5);
    }
  }

  setVolume(v) {
    this.volume = v;
    if (this._master && this._ctx && this._active) {
      this._master.gain.setTargetAtTime(v, this._ctx.currentTime, 0.08);
    }
  }

  _schedule() {
    if (!this._active) return;
    const now = this._ctx.currentTime;
    let dur = 4;
    switch (this.preset) {
      case 1: dur = this._relaxing(now); break;
      case 2: dur = this._impulsive(now); break;
      case 3: dur = this._melodic(now); break;
      default: return;
    }
    this._tick++;
    this._timer = setTimeout(() => this._schedule(), Math.max(100, (dur - 0.10) * 1000));
  }

  // ─── ПРЕСЕТ 1: Мягкая расслабляющая ─────────────────────────────
  // Вдохновение: Kokiri Forest / Kakariko Village (OoT)
  _relaxing(now) {
    const bpm = 66, b = 60 / bpm;
    const beats = 16;

    const chords = [
      [48, 52, 55, 60], // C maj
      [45, 48, 52, 57], // A min
      [41, 45, 48, 53], // F maj
      [43, 47, 50, 55], // G maj
    ];
    const ch = chords[this._tick % chords.length];
    const dur = beats * b;

    // Долгие пэды с реверб
    ch.forEach((m, i) => this._tone(NOTE(m), 'sine', 0.052, now + i * 0.025, dur * 0.92, true));

    // Восходящее арпеджио
    const arp = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 12, ch[1] + 12];
    arp.forEach((m, i) => this._tone(NOTE(m), 'sine', 0.034, now + i * b * 1.4, b * 1.1, true));

    // Мелодия (C-пентатоника)
    const mel = [64, 67, 69, 72, 71, 69, 67, 64];
    const off = (this._tick % 2) * 4;
    for (let i = 0; i < 8; i++) {
      this._tone(NOTE(mel[(i + off) % mel.length]), 'sine', 0.026, now + b * 0.5 + i * b, b * 0.9, true);
    }

    // Колокольчик на сильных долях
    this._tone(NOTE(84), 'sine', 0.020, now, b * 1.8, true);
    this._tone(NOTE(84), 'sine', 0.015, now + b * 8, b * 1.8, true);

    return dur;
  }

  // ─── ПРЕСЕТ 2: Импульсивная / биток ─────────────────────────────
  // Вдохновение: Battle theme (OoT) + pixel beat
  _impulsive(now) {
    const bpm = 136, b = 60 / bpm;
    const bars = 2, beats = bars * 4;
    const dur = beats * b;

    // Барабаны (16-е)
    for (let i = 0; i < beats * 2; i++) {
      const t = now + i * b * 0.5, pos = i % 8;
      if (pos === 0 || pos === 4) this._kick(t);
      if (pos === 2 || pos === 6) this._snare(t);
      this._hat(t, 0.08 + (pos % 2 ? 0 : 0.05), pos === 7 ? 0.14 : 0.04);
    }

    // Бас (пилообразный)
    const bLines = [
      [33, 0, 33, 36, 33, 0, 36, 38],
      [40, 0, 40, 44, 40, 0, 44, 47],
    ];
    bLines[this._tick % bLines.length].forEach((m, i) => {
      if (m) this._tone(NOTE(m), 'sawtooth', 0.10, now + i * b * 0.5, b * 0.40);
    });

    // Лид-синт (квадрат)
    const lLines = [
      [69, 72, 71, 69, 67, 69, 72, 74],
      [74, 72, 71, 69, 71, 72, 74, 76],
    ];
    lLines[this._tick % lLines.length].forEach((m, i) => {
      this._tone(NOTE(m), 'square', 0.062, now + i * b * 0.5, b * 0.36);
    });

    // Аккордовые стабы
    [[57, 60, 64], [55, 59, 62]].forEach((chord, ci) => {
      chord.forEach(m => this._tone(NOTE(m), 'sawtooth', 0.038, now + b * (ci === 0 ? 1 : 3), b * 0.18));
    });

    return dur;
  }

  // ─── ПРЕСЕТ 3: Мелодичный (стиль окарины) ───────────────────────
  // Вдохновение: Saria's Song + Zelda's Lullaby (OoT)
  _melodic(now) {
    const bpm = 92, b = 60 / bpm;

    const pats = [
      // A — Saria's Song
      [[64,1],[67,.5],[64,.5],[60,1],[64,1],[62,1],[60,.75],[59,1.25],
       [64,1],[67,.5],[64,.5],[60,1],[64,1],[62,.5],[60,.5],[57,2]],
      // B — Zelda's Lullaby
      [[71,.75],[67,.25],[69,.5],[71,1.5],[67,.75],[69,.25],[71,.5],[69,1.5],
       [67,.5],[64,.5],[67,.5],[64,.5],[60,2],[64,.5],[65,.5],[67,.5],[69,1.5]],
    ];
    const pat = pats[this._tick % pats.length];
    const totalDur = pat.reduce((s, [, d]) => s + d, 0) * b;

    // Флейтовый тон (сумма синусов = тёплый призвук)
    let t = now;
    for (const [m, d] of pat) {
      const dur = d * b, f = NOTE(m);
      this._tone(f, 'sine', 0.095, t, dur, true);
      this._tone(f * 2, 'sine', 0.016, t, dur, true);
      this._tone(f * 1.498, 'sine', 0.011, t, dur, true);
      t += dur;
    }

    // Мягкий аккомпанемент (триангл)
    const pads = [
      [48,52,55,60], [45,48,52,57], [43,47,50,55], [45,52,55,59],
    ];
    const pad = pads[this._tick % pads.length];
    pad.forEach(m => this._tone(NOTE(m), 'triangle', 0.036, now, totalDur * 0.9, true));

    // Бас-синус
    this._tone(NOTE(pad[0] - 12), 'sine', 0.062, now, b * 4, false);
    this._tone(NOTE(pad[0] - 12), 'sine', 0.050, now + b * 4, b * 4, false);

    return totalDur;
  }
}

export const music = new MusicSystem();
