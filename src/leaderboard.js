// src/leaderboard.js — клиент таблицы лидеров.
//
// Время заезда считает сервер (Cloudflare Worker), клиент время не отправляет:
//   • reset() в main.js → lb.startRun(): запрос /start, сервер запоминает момент старта и выдаёт токен;
//   • win() в main.js   → lb.finishRun(): запрос /finish с токеном, сервер вычитает старт из своего «сейчас».
// Остальное — экран «Рекорды»: три вкладки, список, клик по строке запускает ту же карту.
// Модуль не знает про three.js; с main.js общается через объект host (см. init).

import { STYLES, DIFFS, LENS } from './gen.js';

// Адрес Worker. После деплоя замените на свой (или задайте VITE_LB_API при сборке).
const API = (import.meta.env && import.meta.env.VITE_LB_API) || 'https://n64-leaderboard.fareakuhar6.workers.dev';

const K_NICK = 'n64parkour.lb.nick', K_PID = 'n64parkour.lb.pid';
const $ = (id) => document.getElementById(id);

// ── Формат времени: миллисекунды → ММ:СС.ммм ───────────────────
export function fmtTime(ms) {
  ms = Math.max(0, Math.round(Number(ms) || 0));
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), r = ms % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

// ── Локальные данные: ник и случайный id игрока ────────────────
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* нет места или запрещено: не страшно */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
function playerId() {
  let id = store.get(K_PID);
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { id = uuid(); store.set(K_PID, id); }
  return id;
}
const cleanNick = (s) => [...String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim()].slice(0, 16).join('');

// ── Запросы. Ошибки не бросаем, а возвращаем { error } ─────────
// POST шлём как text/plain: это «простой» запрос, браузер не делает лишний предзапрос CORS
async function api(path, body) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(API + path, body === undefined
      ? { signal: ctl.signal }
      : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    return res.ok ? data : { error: data.error || 'http_' + res.status };
  } catch { return { error: 'network' }; } finally { clearTimeout(t); }
}

// ── Какая это карта (для /start) ───────────────────────────────
// null — в таблицу не попадает (бесконечный режим: у него нет финиша)
function mapInfo(L) {
  if (!L || L.len === 'inf') return null;
  if (L.id === 'classic' || L.id === 'objects') return { mode: 'classic', id: L.id };
  if (L.seed) {
    return {
      mode: 'generated', seed: String(L.seed), style: L.style || 'mix', diff: +L.diff || 2, len: L.len || 'std',
      d: Math.hypot(L.goal[0] - L.start[0], L.goal[2] - L.start[2]),
    };
  }
  return { mode: 'custom' }; // код уровня уйдёт на /finish: по нему сервер сам определит карту
}

// ── Вспомогательные функции интерфейса ─────────────────────────
const span = (cls, text) => { const e = document.createElement('span'); e.className = cls; if (text != null) e.textContent = text; return e; };
const note = (text) => { const e = document.createElement('div'); e.className = 'lb-empty'; e.textContent = text; return e; };
const fmtDate = (s) => { const d = new Date(s); return isNaN(d) ? '' : String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'); };

const EMPTY = {
  classic: 'На этой карте пока нет рекордов. Пройдите её первым!',
  generated: 'Рекордов на генерируемых картах пока нет. Создайте уровень в «Уровни» и дойдите до звезды.',
  custom: 'Рекордов на кастомных картах пока нет. Пройдите уровень из Мастерской или по ссылке.',
};

class Leaderboard {
  constructor() {
    this.run = 0;        // номер текущей попытки: устаревшие ответы отбрасываем
    this.mode = null;    // classic | generated | custom, null — попытка не идёт в таблицу
    this.token = null;
    this.pending = null; // запрос /start, который ещё в пути
    this.host = null;
    this.cat = 'classic';
    this.seq = 0;
  }

  get nick() { return cleanNick(store.get(K_NICK)); }

  // ── Заезд ──────────────────────────────────────────────────
  // Вызывать при каждом старте попытки (начало уровня, R, падение). testRun — тест из редактора: в таблицу не идёт.
  startRun(L, testRun) {
    const run = ++this.run;
    this.token = null; this.pending = null;
    const info = testRun ? null : mapInfo(L);
    this.mode = info ? info.mode : null;
    if (!info) return;
    this.pending = api('/start', info).then((r) => { if (run === this.run && r.token) this.token = r.token; });
  }

  // Вызывать, когда игрок коснулся открытой звезды. Возвращает ответ сервера (с серверным временем) или null.
  async finishRun(L, { testRun } = {}) {
    const run = this.run;
    if (testRun || !this.mode) return null;
    await this.pending;
    if (run !== this.run) return null;
    const token = this.token;
    this.token = null; // токен одноразовый
    if (!token) return { run, error: 'no_token' };
    const body = { token, player_id: playerId(), nick: this.nick || 'Аноним' };
    if (this.mode === 'custom') body.code = this.host.enc(L);
    return { ...(await api('/finish', body)), run };
  }

  // Строка для окна победы
  resultText(r) {
    if (r.error === 'too_fast') return 'Таблица рекордов: время не засчитано';
    if (r.error === 'no_token' || r.error === 'network') return 'Таблица рекордов недоступна, результат не отправлен';
    if (r.error) return 'Таблица рекордов: ошибка (' + r.error + ')';
    const t = fmtTime(r.time_ms);
    let s = r.status === 'record'
      ? `Таблица: ${t}, место #${r.rank}. Новый личный рекорд!`
      : `Таблица: ${t}. Ваш рекорд ${fmtTime(r.best_ms)}, место #${r.rank}`;
    if (!this.nick) s += '. Задайте ник в «Рекорды»';
    return s;
  }

  // ── Экран «Рекорды» ────────────────────────────────────────
  // host: { enc(L) → код уровня, say(text), warn(text), classic(id), generated({seed,style,diff,len}), custom(code) }
  init(host) {
    this.host = host;
    const map = $('lbMap');
    [['classic', 'Классика'], ['objects', 'Полигон объектов']].forEach(([v, n]) => map.add(new Option(n, v)));
    $('lbNick').value = this.nick;
    $('lbNick').onchange = (e) => this.setNick(e.target.value);$('lbTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-cat]');
      if (b) this.setCat(b.dataset.cat);
    });
    map.onchange = () => this.load();
    $('lbSort').onchange = () => this.load();$('lbRefresh').onclick = () => this.load();
    this.setCat('classic', true);
  }

  // Меню открыло экран
  open() {
    $('lbNick').value = this.nick;
    this.load();
  }

  setCat(cat, quiet) {
    this.cat = cat;
    document.querySelectorAll('#lbTabs button').forEach((b) => b.classList.toggle('on', b.dataset.cat === cat));
    $('lbMap').style.display = cat === 'classic' ? '' : 'none';  // у классики — выбор карты
    $('lbSort').style.display = cat === 'classic' ? 'none' : ''; // у остальных — порядок списка
    if (!quiet) this.load();
  }

  async setNick(v) {
    const n = cleanNick(v);
    $('lbNick').value = n;
    if (!n) return;
    store.set(K_NICK, n);
    const r = await api('/rename', { player_id: playerId(), nick: n });
    if (r.error) this.host.warn('Ник сохранён здесь, но на сервере не обновился');
    else { this.host.say('Ник сохранён'); this.load(); }
  }

  async load() {
    const my = ++this.seq, list = $('lbList');
    list.replaceChildren(note('Загрузка…'));
    const q = new URLSearchParams({ category: this.cat, limit: '30' });
    if (this.cat === 'classic') q.set('map', 'K:' + $('lbMap').value); else q.set('sort',$('lbSort').value);
    const r = await api('/get-leaderboard?' + q);
    if (my !== this.seq) return; // пока грузилось, переключили вкладку
    if (r.error || !Array.isArray(r.rows)) { list.replaceChildren(note('Не удалось загрузить таблицу. Проверьте соединение и нажмите ⟳')); return; }
    if (!r.rows.length) { list.replaceChildren(note(EMPTY[this.cat])); return; }
    list.replaceChildren(...r.rows.map((row) => this.rowEl(row)));
  }

  // Подпись под ником: у генерируемых — Seed и параметры, у кастомных — название и ID
  sub(r) {
    if (this.cat === 'generated') return `Seed ${r.seed} · ${STYLES[r.style] || r.style} · ${DIFFS[r.diff] || r.diff}` + (r.len && r.len !== 'std' ? ' · ' + (LENS[r.len] || r.len) : '');
    if (this.cat === 'custom') return `${r.title || 'Без названия'} · ID ${String(r.map_key).slice(2)}`;
    return fmtDate(r.created_at);
  }

  // Строка таблицы — кнопка: клик запускает этот заезд. Тексты ставим через textContent: ники приходят от других игроков
  rowEl(r) {
    const byTime = this.cat === 'classic' || $('lbSort').value === 'fast';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lb-item' + (r.nick === this.nick ? ' me' : '');
    b.title = 'Сыграть этот заезд';
    const mid = span('mid');
    mid.append(span('nk', r.nick), span('sb', this.sub(r)));
    b.append(span('rk', byTime ? '#' + r.place : fmtDate(r.created_at)), mid, span('tm', fmtTime(r.time_ms) + ' ▶'));
    b.onclick = () => this.replay(r);
    return b;
  }

  // «Попробовать побить рекорд»: загрузить ту же карту
  async replay(r) {
    const key = String(r.map_key);
    if (key.startsWith('K:')) return this.host.classic(key.slice(2));
    if (key.startsWith('G:')) return this.host.generated({ seed: r.seed, style: r.style, diff: +r.diff, len: r.len || 'std' });
    // кастомная карта: код уровня не лежит в списке (он большой), поэтому запрашиваем его отдельно
    const res = await api('/get-leaderboard?' + new URLSearchParams({ category: 'custom', map: key, limit: '1', code: '1' }));
    const code = res.rows && res.rows[0] && res.rows[0].level_code;
    if (!code) return this.host.warn('Не удалось получить код карты');
    this.host.custom(code);
  }
}

export const lb = new Leaderboard();