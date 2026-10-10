// apply-changes.mjs — убирает чекпоинты (логика, 3D-флажки, инструмент редактора, тексты)
// и делает «Авто (по времени и погоде)» музыкой по умолчанию.
//
// Запуск из корня репозитория:   node apply-changes.mjs
// Каждая замена должна сработать ровно один раз, иначе скрипт ничего не запишет и скажет, где промах.

import fs from 'node:fs';

const EDITS = {
  'src/main.js': [
    // ── музыка по умолчанию: Авто ──
    ['const AUDIO_VER = 2; // 2: громкость эффектов по умолчанию снижена с 80 % до 50 %',
     'const AUDIO_VER = 2; // 2: громкость эффектов по умолчанию снижена с 80 % до 50 %\nconst MUSIC_AUTO = 11, MUSIC_VER = 2; // 11 — «Авто (по времени и погоде)»; версия 2: Авто стало мелодией по умолчанию'],
    ['musicPreset:1, audio:null, audioVer:AUDIO_VER,', 'musicPreset:MUSIC_AUTO, musicVer:MUSIC_VER, audio:null, audioVer:AUDIO_VER,'],
    ['let musicPreset = 1;', 'let musicPreset = MUSIC_AUTO;'],
    ['{ musicPreset=Number(s.musicPreset); save.musicPreset=musicPreset; }',
     '{ musicPreset=Number(s.musicPreset); save.musicPreset=musicPreset; }\n  // старые сохранения хранили прежний трек по умолчанию (1): один раз переводим на «Авто»\n  if ((s.musicVer|0)<MUSIC_VER && musicPreset===1) { musicPreset=MUSIC_AUTO; save.musicPreset=musicPreset; }'],

    // ── 3D-флажки ──
    ['const flagGeo=new THREE.CylinderGeometry(0.2,0.2,2.4,6), clothGeo=new THREE.BoxGeometry(0.9,0.55,0.06);\nconst flagMat=new THREE.MeshLambertMaterial({color:0x3ddc68,emissive:0x0a4a1a});\n', ''],
    ['coins=[], flags=[], goal, goalOpen=true', 'coins=[], goal, goalOpen=true'],
    ['coins=[]; flags=[]; outlines=[];', 'coins=[]; outlines=[];'],
    [`  // Флаги — только декоративные (зелёные, всегда активны визуально)
  (lv.cps||[]).forEach(([x,y,z],i)=>{
    const f=new THREE.Mesh(flagGeo,flagMat); f.position.set(x,y+1.2,z); f.userData={k:'f',i};
    const cloth=new THREE.Mesh(clothGeo,flagMat); cloth.position.set(0.55,0.85,0);
    f.add(cloth); levelGroup.add(f); flags.push(f);
  });
`, ''],
    ['  // Флаги — декоративно вращаются\n  flags.forEach(f=>{f.rotation.y+=dt*0.6;});\n\n', ''],

    // ── данные уровня ──
    ['cps:[], shapes:[], req:false, theme:0, goal:[10,9.1,-50]', 'shapes:[], req:false, theme:0, goal:[10,9.1,-50]'],
    [', f=Array.isArray(j.f)?j.f.slice(0,20):[];', ';'],
    ['||!f.every((a)=>ok(a,3,-300,300))', ''],
    ['coins:c, cps:f, goal:j.g, start:j.s,', 'coins:c, goal:j.g, start:j.s,'],
    ['...(lv.cps&&lv.cps.length?{f:lv.cps}:{}), ', ''],
    ['if (lv.req||(lv.shapes&&lv.shapes.length)||(lv.cps&&lv.cps.length)||lv.theme) a.push([!!lv.req,lv.shapes||[],lv.cps||[],lv.theme|0]);',
     'if (lv.req||(lv.shapes&&lv.shapes.length)||lv.theme) a.push([!!lv.req,lv.shapes||[],[],lv.theme|0]); // пустой массив сохраняет прежний формат, чтобы не менялись id уровней и рекорды'],
    ['lv.shapes=lv.shapes||[];lv.cps=lv.cps||[];lv.theme', 'lv.shapes=lv.shapes||[];lv.theme'],
    ['plats:[[0,0,0,6,6]],coins:[],cps:[],shapes:[]', 'plats:[[0,0,0,6,6]],coins:[],shapes:[]'],
    ['coins:L.coins,cps:L.cps,shapes:L.shapes', 'coins:L.coins,shapes:L.shapes'],
    ['// ── Сброс: всегда полный (без чекпоинтов) ─────────────────────', '// ── Сброс: всегда полный ──────────────────────────────────────'],
    ['// ── Пропасть: ПОЛНЫЙ сброс (без чекпоинтов) ──────────────────', '// ── Пропасть: ПОЛНЫЙ сброс ───────────────────────────────────'],

    // ── редактор ──
    ["'Digit6','Digit7'].indexOf(e.code)", "'Digit6'].indexOf(e.code)"],
    ["['erase','Стереть'],['cp','Чекпоинт'],['draw','Своя форма']]", "['erase','Стереть'],['draw','Своя форма']]"],
    [",start:'putStart',cp:'putFlag'};", ",start:'putStart'};"],
    [",start:[0.8,1.2,0.8,0.6],cp:[0.6,2.4,0.6,1.2]};", ",start:[0.8,1.2,0.8,0.6]};"],
    ["||hit.object.userData.k==='f'", ''],
    ['...L.coins,...(L.cps||[]),L.goal,L.start', '...L.coins,L.goal,L.start'],
    ["else if(u.k==='f'){pushHist();L.cps.splice(u.i,1);}", ''],
    ["if(t==='cp'&&L.cps.length>=20)return warn('Максимум 20 чекпоинтов');", ''],
    ["else if(t==='cp')L.cps.push([x,y,z]);", ''],
    ["erase:'✖',cp:'⚑',draw:'✎'}", "erase:'✖',draw:'✎'}"],
  ],

  'src/audio.js': [
    ["  putFlag: { dur: 0.3, gain: 0.4, bus: 'ui', make: () => notesFn([[659, 0, 0.06], [880, 0.06, 0.06], [1047, 0.12, 0.15]], { duty: 0.25, decay: 12 }) },\n", ''],
  ],

  // Генератор больше не знает про чекпоинты; «хабы» (большие площадки) отдаются под именем hubs — их использует gulls.js
  'src/gen.js': [
    ['площадки-хабы\n//   (они же чекпоинты), от которых иногда', 'площадки-хабы,\n//   от которых иногда'],
    ['rise, lat, coin, cp', 'rise, lat, coin'],
    ['gapIn: o.gap, cp: !!o.cp, from: curIdx', 'gapIn: o.gap, hub: !!o.hub, from: curIdx'],
    ['// Большая площадка-хаб (и чекпоинт) с боковыми', '// Большая площадка-хаб с боковыми'],
    ["coin: 'none', cp: true }", "coin: 'none', hub: true }"],
    ['// ---------- Монеты и чекпоинты ----------', '// ---------- Монеты ----------'],
    ['const coins = [], cps = [];', 'const coins = [], hubs = [];'],
    ['if (info.cp && cps.length < 20) cps.push([a[0], a[1], a[2]]);', 'if (info.hub) hubs.push([a[0], a[1], a[2]]);'],
    ['plats, coins, cps, goal:', 'plats, coins, hubs, goal:'],
  ],

  'src/gulls.js': [
    ['const cps = lv.cps || [];', 'const hubs = lv.hubs || [];'],
    ['cps.some((c) =>', 'hubs.some((c) =>'],
  ],

  'README.md': [
    ['- **Чекпоинты.** Флажки на больших площадках: после падения возвращаетесь к последнему. Клавиша R начинает уровень заново.',
     '- **Падение.** Сорвались в пропасть: уровень начинается заново. Клавиша R делает то же самое.'],
    ['Между главами стоят хабы с чекпоинтами и боковыми площадками за монетами.', 'Между главами стоят большие площадки-хабы с боковыми площадками за монетами.'],
    ['Ещё в редакторе есть чекпоинты, выбор темы и обязательных монет.', 'Ещё в редакторе есть выбор темы и обязательных монет.'],
    ['клавиши 1–7 (платформа, монета, звезда, старт, стереть, чекпоинт, своя форма)', 'клавиши 1–6 (платформа, монета, звезда, старт, стереть, своя форма)'],
    ['свои формы, чекпоинты, тему и флаг', 'свои формы, тему и флаг'],
    ['Режим **«Авто (по времени и погоде)»** сам подбирает трек', 'Режим **«Авто (по времени и погоде)»** (включён по умолчанию) сам подбирает трек'],
  ],
};

const count = (s, sub) => s.split(sub).length - 1;
const out = {};
let bad = 0;

for (const [file, edits] of Object.entries(EDITS)) {
  if (!fs.existsSync(file)) { console.error(`✗ нет файла ${file} (запускайте из корня репозитория)`); bad++; continue; }
  const raw = fs.readFileSync(file, 'utf8'), crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');
  edits.forEach(([a, b], i) => {
    const n = count(s, a);
    if (n !== 1) { console.error(`✗ ${file}, правка №${i + 1}: найдено ${n} раз(а) вместо 1:\n    ${a.split('\n')[0].slice(0, 110)}`); bad++; return; }
    s = s.replace(a, () => b);
  });
  out[file] = crlf ? s.replace(/\n/g, '\r\n') : s;
}

if (bad) { console.error(`\nОшибок: ${bad}. Ничего не записано.`); process.exit(1); }
for (const [file, s] of Object.entries(out)) { fs.writeFileSync(file, s); console.log('✓', file); }

// Контроль: в коде не должно остаться упоминаний
const left = Object.keys(out).filter((f) => /чекпоинт|checkpoint|\bcps\b|flagGeo|flagMat/i.test(fs.readFileSync(f, 'utf8')));
console.log(left.length ? `\nВнимание, остались упоминания в: ${left.join(', ')}` : '\nУпоминаний чекпоинтов не осталось.');
