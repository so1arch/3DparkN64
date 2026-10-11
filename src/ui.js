// src/ui.js — оформление интерфейса поверх существующей разметки. Игровую логику не трогает:
// все id (#hCoins, #hTime, #hBest, #hNeed, #lvname…) остаются теми же, main.js продолжает писать в них как раньше.
// Подключать ПОСЛЕ main.js:  <script type="module" src="./src/ui.js"></script>
import './ui.css';
import { audio } from './audio.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

// ── HUD: уровень сверху, под ним три плашки (монеты · время · рекорд) ──
(() => {
  const hud = $('hud'), name = $('lvname'), coins = $('hCoins'), need = $('hNeed'), time = $('hTime'), best = $('hBest');
  if (!hud || !time) return;
  const c = el('div', 'chip hud-c'), t = el('div', 'chip hud-t'), b = el('div', 'chip hud-b'), row = el('div', 'hud-row');
  c.append(el('i', 'ic coin'), coins, need);
  t.append(el('i', 'ic clock'), time, el('small', '', 'с'));
  b.title = 'Рекорд'; b.append(el('i', 'ic star'), best);
  row.append(c, t, b);
  name.removeAttribute('style');
  hud.replaceChildren(name, row);
  // плашка монет «подпрыгивает», когда число изменилось (main.js переписывает текст каждые 0.1 с, поэтому сравниваем)
  let last = coins.textContent;
  new MutationObserver(() => {
    if (coins.textContent === last) return;
    last = coins.textContent;
    c.classList.remove('pulse'); void c.offsetWidth; c.classList.add('pulse');
  }).observe(coins, { childList: true, characterData: true, subtree: true });
})();

// ── Настройки: четыре вкладки вместо одной длинной простыни ──
(() => {
  const sc = document.querySelector('#scr-settings .sscroll');
  if (!sc) return;
  const LABELS = ['Графика', 'Отражения', 'Звук', 'Данные'], pages = [];
  let cur = null;
  for (const k of [...sc.children]) {
    if (k.classList.contains('shead')) { cur = []; pages.push(cur); continue; }
    if (cur) cur.push(k);
  }
  const reset = $('btnReset');
  if (reset) {
    pages.forEach((p) => { const i = p.indexOf(reset); if (i >= 0) p.splice(i, 1); });
    pages.push([el('div', 'snote', 'Рекорды хранятся в браузере. Сброс нельзя отменить.'), reset]);
  }
  const tabs = el('div', 'stabs'), wraps = [];
  const show = (i) => wraps.forEach(([b, w], j) => { b.classList.toggle('on', i === j); w.classList.toggle('on', i === j); });
  pages.forEach((els, i) => {
    const w = el('section', 'spage'), b = el('button', 'tab', LABELS[i] || 'Ещё');
    w.append(...els); sc.append(w);
    b.onclick = () => show(i);
    tabs.append(b); wraps.push([b, w]);
  });
  sc.before(tabs);
  show(0);
})();

// ── Ползунки: золотая заливка до бегунка ──
document.querySelectorAll('input[type=range]').forEach((r) => {
  const f = () => { const mn = +r.min || 0, mx = +r.max || 100; r.style.setProperty('--v', ((r.value - mn) / (mx - mn)) * 100 + '%'); };
  f(); r.addEventListener('input', f);
});

// ── Отклик: вспышка при клике (в том числе от геймпада) и звук при наведении мыши ──
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button');
  if (!b) return;
  b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
}, true);
let lastHover = null;
document.addEventListener('pointerover', (e) => {
  if (e.pointerType !== 'mouse') return;
  const b = e.target.closest && e.target.closest('button,select');
  if (b && b !== lastHover && !b.disabled) audio.sfx('move');
  lastHover = b || null;
});
