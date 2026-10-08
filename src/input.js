// src/input.js — ввод с геймпада (PS4/DualShock, Xbox и совместимые), автоопределение устройства
// и тексты подсказок, которые меняются в зависимости от того, чем сейчас играют.
// Без зависимостей от three.js. Клавиатуру и мышь по-прежнему обрабатывает main.js;
// здесь они только отслеживаются, чтобы понимать, какое устройство активно.
//
// Раскладка (стандартный маппинг браузера, "standard gamepad"):
//   игра:     левый стик — бег, A/✕ — прыжок, правый стик или LB/RB — камера, Y/△ — рестарт, Start — меню
//   меню:     D-pad или левый стик — выбор, A/✕ — ОК, B/○ — назад, Start — закрыть меню
//   редактор: см. controlsHTML()

const KIND_NAME = { ps: 'PlayStation', xbox: 'Xbox', generic: '' };
const GLYPH = {
  ps: { A: '✕', B: '○', X: '□', Y: '△', LB: 'L1', RB: 'R1', LT: 'L2', RT: 'R2', START: 'Options', BACK: 'Share' },
  xbox: { A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', LT: 'LT', RT: 'RT', START: 'Menu', BACK: 'View' },
};
GLYPH.generic = GLYPH.xbox;

// Тип геймпада по id. «Xbox Wireless Controller» содержит слова «wireless controller», поэтому Xbox проверяем первым.
export function kindOf(id = '') {
  if (/xbox|xinput|045e|microsoft/i.test(id)) return 'xbox';
  if (/054c|0ce6|dualshock|dualsense|playstation|sony|wireless controller/i.test(id)) return 'ps';
  return 'generic';
}

// Круговая мёртвая зона с плавным стартом: внутри d — ноль, дальше растёт до 1
function dz(x, y, d = 0.2) {
  const m = Math.hypot(x, y);
  if (m < d) return [0, 0];
  const s = Math.min(1, (m - d) / (1 - d)) / m;
  return [x * s, y * s];
}

// Приводит gamepad к простому виду. Оси Y перевёрнуты: вверх = +1.
export function readPad(gp) {
  const ax = gp.axes || [], kind = kindOf(gp.id);
  let rx = ax[2] || 0, ry = ax[3] || 0;
  // Нестандартный маппинг (старые драйверы): правый стик у DualShock бывает на осях 2 и 5
  if (gp.mapping !== 'standard' && kind === 'ps' && ax.length >= 6) ry = ax[5] || 0;
  const [lx, ly] = dz(ax[0] || 0, -(ax[1] || 0));
  const [sx, sy] = dz(rx, -ry);
  const bt = gp.buttons || [];
  const btn = Array.from({ length: 16 }, (_, i) => !!bt[i] && (bt[i].pressed || bt[i].value > 0.5));
  const val = (i) => (bt[i] ? bt[i].value || (bt[i].pressed ? 1 : 0) : 0);
  return { kind, index: gp.index, id: gp.id || '', lx, ly, rx: sx, ry: sy, btn, lt: val(6), rt: val(7) };
}

export const IDLE = Object.freeze({
  moveX: 0, moveY: 0, lookX: 0, lookY: 0, camDir: 0, zoom: 0, nav: null,
  jump: false, restart: false, a: false, b: false, x: false, y: false,
  lb: false, rb: false, start: false, back: false, cancel: false, r3: false, any: false,
});

class Input {
  constructor() {
    this.device = 'kbm';  // 'kbm' | 'pad'
    this.kind = 'generic'; // 'ps' | 'xbox' | 'generic' — какой геймпад сейчас активен
    this.idle = IDLE;
    this._onDevice = []; this._onPad = [];
    this._prevBtn = {}; this._prevStick = {};
    this._active = -1;
    this._cur = null;
    this._navDir = null; this._navT = 0;
    this._mAcc = 0; this._mT = 0;
    if (typeof window === 'undefined') return;
    const kbm = () => this._setDevice('kbm');
    window.addEventListener('keydown', kbm, true);
    window.addEventListener('pointerdown', kbm, true);
    window.addEventListener('wheel', kbm, { capture: true, passive: true });
    // Мышь переключает устройство только при заметном движении, чтобы случайный толчок стола не сбивал геймпад
    window.addEventListener('mousemove', (e) => {
      const now = performance.now();
      if (now - this._mT > 150) this._mAcc = 0;
      this._mT = now;
      this._mAcc += Math.abs(e.movementX || 0) + Math.abs(e.movementY || 0);
      if (this._mAcc >= 8) kbm();
    }, true);
    window.addEventListener('gamepadconnected', (e) => this._onPad.forEach((f) => f(this._nameOf(e.gamepad.id), true)));
    window.addEventListener('gamepaddisconnected', (e) => {
      this._onPad.forEach((f) => f(this._nameOf(e.gamepad.id), false));
      if (e.gamepad.index === this._active) this._active = -1;
    });
  }

  onChange(fn) { this._onDevice.push(fn); }
  onPadEvent(fn) { this._onPad.push(fn); }

  _emit() { this._onDevice.forEach((f) => f(this.device, this.kind)); }
  _setDevice(d, kind = this.kind) {
    const changed = d !== this.device || (d === 'pad' && kind !== this.kind);
    this.device = d; this.kind = kind;
    if (d === 'kbm') this.clearFocus();
    if (changed) this._emit();
  }
  _nameOf(id) { const k = kindOf(id); return 'Геймпад' + (KIND_NAME[k] ? ' ' + KIND_NAME[k] : ''); }

  // Вызывать раз за кадр. opts.menuOpen — открыто меню (тогда геймпад ходит по кнопкам меню).
  poll(dt, opts = {}) {
    const raw = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    const list = [];
    for (const gp of raw) {
      if (!gp || !gp.connected) continue;
      const r = readPad(gp);
      const prev = this._prevBtn[r.index] || [];
      r.press = r.btn.map((d, i) => d && !prev[i]);
      const strong = Math.max(Math.hypot(r.lx, r.ly), Math.hypot(r.rx, r.ry)) > 0.5;
      r.act = r.press.some(Boolean) || (strong && !this._prevStick[r.index]);
      this._prevBtn[r.index] = r.btn; this._prevStick[r.index] = strong;
      list.push(r);
    }
    const c = list.find((r) => r.act) || list.find((r) => r.index === this._active) || list[0];
    if (!c) {
      if (this.device === 'pad') this._setDevice('kbm');
      return IDLE;
    }
    this._active = c.index;
    if (c.act) this._setDevice('pad', c.kind);
    else if (this.device === 'pad' && c.kind !== this.kind) this._setDevice('pad', c.kind);

    const p = c.press, menu = !!opts.menuOpen;
    const S = {
      moveX: c.lx, moveY: c.ly, lookX: c.rx, lookY: c.ry,
      camDir: (c.btn[4] ? 1 : 0) - (c.btn[5] ? 1 : 0), zoom: c.rt - c.lt, nav: null,
      jump: p[0], restart: p[3], a: p[0], b: p[1], x: p[2], y: p[3],
      lb: p[4], rb: p[5], back: p[8], start: p[9], cancel: p[1], r3: p[11], any: p.some(Boolean),
    };

    // Направление выбора: D-pad (в меню ещё и левый стик), с автоповтором при удержании
    let dir = null;
    if (c.btn[12]) dir = 'up'; else if (c.btn[13]) dir = 'down'; else if (c.btn[14]) dir = 'left'; else if (c.btn[15]) dir = 'right';
    else if (menu && Math.max(Math.abs(c.lx), Math.abs(c.ly)) > 0.6) {
      dir = Math.abs(c.lx) > Math.abs(c.ly) ? (c.lx > 0 ? 'right' : 'left') : (c.ly > 0 ? 'up' : 'down');
    }
    if (dir !== this._navDir) { this._navDir = dir; this._navT = 0.38; if (dir) S.nav = dir; }
    else if (dir) { this._navT -= dt; if (this._navT <= 0) { this._navT = 0.12; S.nav = dir; } }

    if (menu) {
      if (S.nav) this._navigate(S.nav);
      if (S.a) this._activate();
      // start и cancel (○/B = «назад») остаются: ими main.js закрывает меню или возвращается на экран выше.
      // Нажатия, которые «съело» меню, не должны сработать в игре в этом же кадре (например, прыжок после «Играть»)
      Object.assign(S, { nav: null, jump: false, restart: false, a: false, b: false, x: false, y: false, lb: false, rb: false, r3: false,
        moveX: 0, moveY: 0, lookX: 0, lookY: 0, camDir: 0, zoom: 0 });
    }
    return S;
  }

  // ─── Навигация по кнопкам меню ───────────────────────────────────
  _items() {
    if (typeof document === 'undefined') return [];
    const root = document.querySelector('.screen.on');
    if (!root) return [];
    return [...root.querySelectorAll('button, select, input[type=range]')].filter((el) => !el.disabled && el.offsetParent !== null);
  }
  _focus(el) {
    if (this._cur && this._cur.classList) this._cur.classList.remove('padfocus');
    this._cur = el;
    if (el) { el.classList.add('padfocus'); if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }
  }
  clearFocus() { this._focus(null); }
  menuFocusFirst() { const l = this._items(); this._focus(l[0] || null); }

  _navigate(dir) {
    const list = this._items();
    if (!list.length) return;
    const cur = this._cur && list.includes(this._cur) ? this._cur : null;
    if (!cur) return this._focus(list[0]);
    const ctr = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const c = ctr(cur), horiz = dir === 'left' || dir === 'right';
    let best = null, bs = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const q = ctr(el), dx = q.x - c.x, dy = q.y - c.y;
      let prim, sec;
      if (dir === 'down') { if (dy <= 4) continue; prim = dy; sec = Math.abs(dx); }
      else if (dir === 'up') { if (dy >= -4) continue; prim = -dy; sec = Math.abs(dx); }
      else if (dir === 'right') { if (dx <= 4 || Math.abs(dy) > 24) continue; prim = dx; sec = Math.abs(dy); }
      else { if (dx >= -4 || Math.abs(dy) > 24) continue; prim = -dx; sec = Math.abs(dy); }
      const s = prim + sec * 2.5;
      if (s < bs) { bs = s; best = el; }
    }
    if (best) return this._focus(best);
    if (horiz) return this._adjust(cur, dir === 'right' ? 1 : -1); // в строке больше некуда идти: меняем значение списка/ползунка
    // сверху/снизу край списка: переходим на другой конец
    const byY = [...list].sort((a, b) => ctr(a).y - ctr(b).y);
    this._focus(dir === 'down' ? byY[0] : byY[byY.length - 1]);
  }
  _adjust(el, delta) {
    if (el.tagName === 'SELECT') {
      const n = el.options.length;
      if (!n) return;
      el.selectedIndex = (el.selectedIndex + delta + n) % n;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.type === 'range') {
      const mn = +el.min || 0, mx = el.max === '' ? 100 : +el.max, st = +el.step || 1;
      const v = Math.min(mx, Math.max(mn, +el.value + delta * Math.max(st, (mx - mn) / 20)));
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  _activate() {
    const el = this._cur;
    if (!el) return this.menuFocusFirst();
    if (el.tagName === 'SELECT') this._adjust(el, 1);
    else if (el.type !== 'range') el.click();
  }

  // ─── Тексты подсказок (зависят от активного устройства) ──────────
  g(name) { return GLYPH[this.kind][name]; }
  deviceName() {
    if (this.device !== 'pad') return 'Клавиатура + мышь';
    return 'Геймпад' + (KIND_NAME[this.kind] ? ' ' + KIND_NAME[this.kind] : '');
  }
  menuButtonText() { return this.device === 'pad' ? `☰ Меню (${this.g('START')})` : '☰ Меню'; }
  restartHint() {
    return this.device === 'pad' ? `${this.g('Y')}: сыграть ещё · ${this.g('START')}: меню` : 'R: сыграть ещё · Esc: меню';
  }
  menuHint() {
    return this.device === 'pad' ? `D-pad / левый стик — выбор · ${this.g('A')} — ОК · ${this.g('B')} — назад · ${this.g('START')} — закрыть` : '';
  }
  helpText(mode) {
    const G = (n) => this.g(n);
    if (mode === 'edit') {
      return `${G('A')} — поставить  •  ${G('X')} — стереть  •  ${G('B')} — отмена  •  ${G('Y')} — повернуть\n`
        + `D-pad ←→ — инструмент  •  ↑↓ — высота  •  ${G('LB')}/${G('RB')} — форма\n`
        + `Стики — камера  •  ${G('LT')}/${G('RT')} — зум  •  R3 — вся карта  •  ${G('BACK')} — тест  •  ${G('START')} — меню`;
    }
    return `Левый стик — бег  •  ${G('A')} — прыжок\nПравый стик / ${G('LB')}·${G('RB')} — камера  •  ${G('Y')} — заново  •  ${G('START')} — меню`;
  }
  controlsHTML() {
    if (this.device !== 'pad') {
      return '<b>WASD</b> — Бег<br><b>Пробел</b> — Прыжок<br><b>Q / E, Мышь</b> — Камера<br>'
        + '<b>R</b> — Рестарт уровня<br><b>Esc / M</b> — Меню';
    }
    const G = (n) => this.g(n);
    return `<b>Левый стик</b> — Бег (скорость зависит от наклона)<br><b>${G('A')}</b> — Прыжок<br>`
      + `<b>Правый стик, ${G('LB')} / ${G('RB')}</b> — Камера<br><b>${G('Y')}</b> — Рестарт уровня<br><b>${G('START')}</b> — Меню<br>`
      + `<b>В меню:</b> D-pad или левый стик — выбор, <b>${G('A')}</b> — ОК, <b>${G('B')}</b> — назад<br>`
      + '<b>Редактор:</b> по центру экрана прицел, им выбирают место<br>'
      + `&nbsp;&nbsp;<b>${G('A')}</b> — поставить, <b>${G('X')}</b> — стереть, <b>${G('B')}</b> — отмена, <b>${G('Y')}</b> — повернуть / замкнуть форму<br>`
      + `&nbsp;&nbsp;<b>D-pad ←→</b> — инструмент, <b>↑↓</b> — высота, <b>${G('LB')} / ${G('RB')}</b> — форма платформы<br>`
      + `&nbsp;&nbsp;<b>Левый стик</b> — двигать камеру, <b>правый</b> — вращать, <b>${G('LT')} / ${G('RT')}</b> — зум<br>`
      + `&nbsp;&nbsp;<b>R3</b> — вся карта, <b>${G('BACK')}</b> — тест уровня`;
  }
}

export const input = new Input();
