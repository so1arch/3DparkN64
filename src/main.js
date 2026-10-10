// src/main.js
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  SHAPES, DEG, MOVE, normPlat, localParts, worldParts, partsBounds, supportY, stepBody,
  shapeCount, shapeDef, setCustomShapes, isSimplePolygon, chainOk, normalizeShape,
} from './shapes.js';
import { paintSky, SUN, MOON, skyKey } from './sky.js';
import { createClouds } from './clouds.js';
import { createRain } from './weather.js';
import { generate, rngFrom, STYLES, DIFFS } from './gen.js';
import { music, MUSIC_NAMES } from './music.js';
import { audio } from './audio.js';
import { input } from './input.js';
import { createGulls } from './gulls.js';

const $ = (id) => document.getElementById(id);

// ── Настройки графики: HIGH + безлимитный FPS по умолчанию ─────
let QUALITY = 'high', FPS_CAP = 0, TIME = 'day', WEATHER = 'clear';
try {
  const q = JSON.parse(localStorage.getItem('n64parkour.v1') || '{}');
  if (q.quality === 'light') QUALITY = 'light';
  if ([0, 30, 60].includes(q.fps)) FPS_CAP = q.fps;
  if (q.time === 'night') TIME = 'night';
  if (q.weather === 'rain') WEATHER = 'rain';
} catch { /* defaults */ }
const HIGH = QUALITY === 'high';

// ── Рендер ─────────────────────────────────────────────────────
const RES_H = 240;
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);
$('game').appendChild(renderer.domElement);

// Небо и карта окружения рисуются в коде (~0.2 с на вариант), поэтому каждый из четырёх вариантов
// (день/ночь × ясно/дождь) строится один раз, при первом показе, и дальше берётся из кэша.
const skyCache = {}, envCache = {};
function skyTex(night, rain) {
  const k = skyKey(night, rain);
  return skyCache[k] || (skyCache[k] = makeSky(night, rain));
}
function envFor(night, rain) {
  const k = skyKey(night, rain);
  return envCache[k] || (envCache[k] = makeEnv(night, rain));
}
function makeSky(night, rain) {
  const W = HIGH ? 1024 : 512, H = W / 2, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d'), img = g.createImageData(W, H);
  paintSky(img.data, W, H, { night, rain });
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  return t;
}

const scene = new THREE.Scene();
scene.background = skyTex(TIME === 'night', WEATHER === 'rain');
scene.fog = new THREE.Fog(0xb0d8ff, 24, 150);
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 250);
camera.rotation.order = 'YXZ';
scene.add(camera);
const ambient = new THREE.AmbientLight(0xffffff, 0.3);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(5, 10, 6);
scene.add(sun);

let composer = null, ssao = null;
if (HIGH) {
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  ssao = new SSAOPass(scene, camera, 320, RES_H);
  ssao.kernelRadius = 2.5;
  composer.addPass(ssao);
  composer.addPass(new OutputPass());
}

function setFar(f) {
  camera.far = f; camera.updateProjectionMatrix();
  if (ssao) { ssao.minDistance = 0.125 / f; ssao.maxDistance = 3 / f; }
}
setFar(250);

let outlines = [];
const helpers = new THREE.Group(); helpers.visible = false; scene.add(helpers);
const marker = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.2, 6), new THREE.MeshBasicMaterial({ color: 0xff2222 }));
marker.visible = false; scene.add(marker);
if (ssao) {
  const ssaoRender = ssao.render.bind(ssao);
  ssao.render = (...args) => {
    const hide = [helpers, marker, dust, ...rain.objects, ...gulls.objects, ...outlines], was = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false)); ssaoRender(...args); hide.forEach((o, i) => (o.visible = was[i]));
  };
}

function resize() {
  const w = Math.round(RES_H * innerWidth / innerHeight);
  renderer.setSize(w, RES_H, false);
  if (composer) composer.setSize(w, RES_H);
  camera.aspect = w / RES_H; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const mat = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
const box = (parent, w, h, d, m, x, y, z) => {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z); parent.add(o); return o;
};
const clouds = createClouds(scene, HIGH ? { count: 36, puffs: 7 } : { count: 20, puffs: 5 });
const rain = createRain(scene, { high: HIGH });
const gulls = createGulls(scene, { high: HIGH });

// ── Материалы платформ ─────────────────────────────────────────
const TILE_M = 2;
const maxAniso = renderer.capabilities.getMaxAnisotropy();
function mapTex(size, fn, srgb) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const o = (y * size + x) * 4, px = fn(x, y);
    img.data[o] = px[0]; img.data[o + 1] = px[1]; img.data[o + 2] = px[2]; img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.anisotropy = Math.min(4, maxAniso);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}
const TS = 64, tileR = rngFrom('tiles');
const flake = new Uint8Array(TS * TS).map(() => (tileR() < 0.05 ? 1 : 0));
const cellOf = (x, y) => ((x >> 5) + (y >> 5)) & 1;
const seam = (x, y) => (x & 31) < 2 || (y & 31) < 2;
const bevel = (x, y) => (x & 31) === 2 || (y & 31) === 2;
const noiseT = (x, y) => ((x * 73856093) ^ (y * 19349663)) & 15;
const albedoTex = mapTex(TS, (x, y) => { const c = Math.max(0, Math.min(255, (seam(x,y)?150:cellOf(x,y)?205:255)+noiseT(x,y)-8)); return [c,c,c]; }, true);
const ormTex = !HIGH ? null : mapTex(TS, (x,y) => { if (seam(x,y)) return [255,255,0]; if (flake[y*TS+x]) return [255,60,255]; return cellOf(x,y)?[255,215,70]:[255,185,120]; }, false);
const bumpTex = !HIGH ? null : mapTex(TS, (x,y) => { const h=seam(x,y)?40:bevel(x,y)?230:150+noiseT(x,y); return [h,h,h]; }, false);

// Яркость «солнца» (или луны) в карте отражений: [широкий блик, узкий блик]. Под тучами бликов почти нет.
const ENV_BOOST = { day: [2, 18], night: [1.4, 10], rain: [0.35, 0], nightRain: [0.12, 0] };
function makeEnv(night, rain) {
  const W=512,H=256,px=new Uint8ClampedArray(W*H*4); paintSky(px,W,H,{night,rain});
  const [b1,b2]=ENV_BOOST[skyKey(night,rain)], LD=night?MOON:SUN;
  const half=new Uint16Array(W*H*4),toH=THREE.DataUtils.toHalfFloat;
  for (let j=0;j<H;j++) { const lat=(0.5-(j+0.5)/H)*Math.PI,y=Math.sin(lat),c=Math.cos(lat),row=H-1-j;
    for (let i=0;i<W;i++) { const phi=((i+0.5)/W-0.5)*Math.PI*2;
      const sd=c*Math.cos(phi)*LD[0]+y*LD[1]+c*Math.sin(phi)*LD[2];
      const boost=sd>0?1+b1*Math.pow(sd,30)+b2*Math.pow(sd,1500):1;
      const o=(j*W+i)*4,d=(row*W+i)*4;
      for (let k=0;k<3;k++) half[d+k]=toH(Math.pow(px[o+k]/255,2.2)*boost); half[d+3]=toH(1); } }
  const t=new THREE.DataTexture(half,W,H,THREE.RGBAFormat,THREE.HalfFloatType);
  t.mapping=THREE.EquirectangularReflectionMapping; t.colorSpace=THREE.LinearSRGBColorSpace;
  t.minFilter=t.magFilter=THREE.LinearFilter; t.generateMipmaps=false; t.needsUpdate=true;
  const pm=new THREE.PMREMGenerator(renderer),rt=pm.fromEquirectangular(t); t.dispose(); pm.dispose(); return rt.texture;
}
let envTex = HIGH ? envFor(TIME === 'night', WEATHER === 'rain') : null;

const THEMES = [
  { name:'Классика', colors:[0x4caf50,0xff9800,0x42a5f5,0xe91e63,0xffeb3b], rough:0.5, metal:0.45, env:1.0 },
  { name:'Лёд', colors:[0x9fd8ff,0xc8ecff,0x7fc4f0,0xe6f7ff,0xa8b8ff], rough:0.22, metal:0.1, env:1.4 },
  { name:'Золото', colors:[0xffd24d,0xffb300,0xe6c36a,0xd9a441,0xfff0a0], rough:0.32, metal:1.0, env:1.3 },
  { name:'Вулкан', colors:[0x8a3b2a,0xb5502f,0x5b3a35,0xd9622b,0x6e4a40], rough:0.75, metal:0.35, env:0.9 },
  { name:'Конфеты', colors:[0xff7eb6,0x7ee8c0,0xffe27e,0xb59cff,0x7fd3ff], rough:0.28, metal:0.15, env:1.2 },
  { name:'Нефрит', colors:[0x2e9b6a,0x3fb58a,0x1f7a5a,0x66d19e,0x8fe3b8], rough:0.3, metal:0.3, env:1.2 },
];
const grey = (k) => new THREE.Color().setScalar(Math.max(0, Math.min(1, k)));
function platMat(color, th) {
  const m = HIGH
    ? new THREE.MeshStandardMaterial({ color, map:albedoTex, roughnessMap:ormTex, metalnessMap:ormTex, bumpMap:bumpTex, bumpScale:0.6, roughness:th.rough, metalness:th.metal, vertexColors:true, envMap:envTex, envMapIntensity:th.env })
    : new THREE.MeshPhongMaterial({ color, map:albedoTex, vertexColors:true, shininess:8+(1-th.rough)*80, specular:grey(0.1+0.3*th.metal+0.3*(1-th.rough)**2) });
  m.userData.base = new THREE.Color(color); m.userData.th = th; // исходные значения: от них считается «мокрый» вид
  return m;
}
// Мокрая платформа: темнее, гладче и сильнее отражает небо и свет. wet: 0 — сухо, 1 — насквозь мокро
const WET_SPEC = new THREE.Color();
function applyWet(m, wet = env.wet) {
  const { base, th } = m.userData;
  m.color.copy(base).multiplyScalar(1 - 0.32 * wet);
  if (HIGH) { m.roughness = th.rough * (1 - 0.72 * wet); m.envMapIntensity = th.env * (1 + 1.2 * wet); }
  else { m.shininess = 8 + (1 - th.rough) * 80 + 90 * wet; m.specular.copy(grey(0.1 + 0.3 * th.metal + 0.3 * (1 - th.rough) ** 2)).lerp(WET_SPEC.setScalar(0.75), 0.6 * wet); }
}
const glossMats = []; // материалы с отражением неба: у них надо менять карту окружения при смене дня/ночи/погоды
function gloss(color, rough, metal, extra={}) {
  if (HIGH) { const m = new THREE.MeshStandardMaterial({ color, roughness:rough, metalness:metal, envMap:envTex, envMapIntensity:1.2, ...extra }); glossMats.push(m); return m; }
  return new THREE.MeshPhongMaterial({ color, shininess:8+(1-rough)*90, specular:grey(0.12+0.35*metal+0.3*(1-rough)**2), ...extra });
}
function setShine(m, rough, metal) {
  if (HIGH) { m.roughness=rough; m.metalness=metal; }
  else { m.shininess=8+(1-rough)*90; m.specular.copy(grey(0.12+0.35*metal+0.3*(1-rough)**2)); }
}

// ── Сохранение ─────────────────────────────────────────────────
const SAVE_KEY = 'n64parkour.v1';
const AUDIO_VER = 2; // 2: громкость эффектов по умолчанию снижена с 80 % до 50 %
let save = { best:{}, skin:null, quality:QUALITY, fps:FPS_CAP, musicPreset:1, audio:null, audioVer:AUDIO_VER, time:TIME, weather:WEATHER };
let musicPreset = 1;
try {
  const s = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
  if (s.best && typeof s.best==='object') save.best=s.best;
  if (s.skin && typeof s.skin==='object') save.skin=s.skin;
  if (Number.isInteger(Number(s.musicPreset)) && Number(s.musicPreset)>=0 && Number(s.musicPreset)<MUSIC_NAMES.length) { musicPreset=Number(s.musicPreset); save.musicPreset=musicPreset; }
  if (s.audio && typeof s.audio==='object') {
    // Старое сохранение хранило прежние 80 % эффектов как «выбор игрока»: если там осталось значение по умолчанию, берём новое
    const a={...s.audio}; if((s.audioVer|0)<AUDIO_VER&&a.sfx===0.8)delete a.sfx;
    audio.load(a);
  }
  else if (typeof s.musicVol==='number') audio.load({ music: s.musicVol }); // старое сохранение: была одна громкость музыки
} catch { /* ignore */ }
function persist() { try { save.audio=audio.settings(); save.audioVer=AUDIO_VER; localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* ignore */ } }

// ── Уровни ─────────────────────────────────────────────────────
function classic() {
  const plats=[[0,0,0,8,8],[0,0.5,-8,4,4],[3,1.2,-13,3,3],[-1,2,-18,3,3],
    [-5,2.5,-23,3,3],[-5,3.5,-28,2.5,2.5],[0,4.2,-30,3,3],[5,5,-32,3,3],
    [10,6,-36,2.5,2.5],[10,6.5,-42,1.5,6],[10,7.5,-50,6,6]];
  return { id:'classic', name:'Классика', plats, coins:plats.slice(1,10).map(([x,y,z])=>[x,y+1.3,z]),
    cps:[], shapes:[], req:false, theme:0, goal:[10,9.1,-50], start:[0,0,0] };
}
const fullP=(a)=>[a[0],a[1],a[2],a[3],a[4],a[5]??0,a[6]??0,a[7]??0,a[8]??1];
const trimP=(a)=>{ const b=fullP(a),dflt=[0,0,0,0,0,0,0,0,1]; while(b.length>5&&b[b.length-1]===dflt[b.length-1])b.pop(); return b; };
function sanitize(j) {
  const num=(v)=>typeof v==='number'&&Number.isFinite(v);
  const ok=(a,n,lo,hi)=>Array.isArray(a)&&a.length===n&&a.every((v)=>num(v)&&v>=lo&&v<=hi);
  if (!j||!Array.isArray(j.p)||!j.p.length||j.p.length>80) return null;
  const shapes=Array.isArray(j.sh)?j.sh:[];
  const okShape=(poly)=>Array.isArray(poly)&&poly.length>=3&&poly.length<=40&&poly.every((pt)=>Array.isArray(pt)&&pt.length===2&&pt.every((v)=>num(v)&&Math.abs(v)<=0.5001))&&isSimplePolygon(poly);
  if (shapes.length>24||!shapes.every(okShape)) return null;
  const nShapes=SHAPES.length+shapes.length;
  const okP=(a)=>Array.isArray(a)&&a.length>=5&&a.length<=9&&a.every(num)&&a.slice(0,3).every((v)=>Math.abs(v)<=300)&&a[3]>=1&&a[3]<=30&&a[4]>=1&&a[4]<=30&&(a[5]===undefined||(Number.isInteger(a[5])&&a[5]>=0&&a[5]<nShapes))&&(a[6]===undefined||Math.abs(a[6])<=720)&&(a[7]===undefined||Math.abs(a[7])<=60)&&(a[8]===undefined||(a[8]>=0.25&&a[8]<=20));
  if (!j.p.every(okP)) return null;
  const c=Array.isArray(j.c)?j.c.slice(0,100):[], f=Array.isArray(j.f)?j.f.slice(0,20):[];
  if (!c.every((a)=>ok(a,3,-300,300))||!f.every((a)=>ok(a,3,-300,300))) return null;
  if (!ok(j.g,3,-300,300)||!ok(j.s,3,-300,300)) return null;
  return { name:String(j.n||'Без названия').slice(0,40), plats:j.p.map(fullP), coins:c, cps:f, goal:j.g, start:j.s,
    shapes, req:!!j.q, theme:Number.isInteger(j.th)&&j.th>=0&&j.th<THEMES.length?j.th:0 };
}
const enc=(lv)=>btoa(unescape(encodeURIComponent(JSON.stringify({ n:lv.name, p:lv.plats.map(trimP), c:lv.coins, g:lv.goal, s:lv.start, ...(lv.cps&&lv.cps.length?{f:lv.cps}:{}), ...(lv.shapes&&lv.shapes.length?{sh:lv.shapes}:{}), ...(lv.req?{q:1}:{}), ...(lv.theme?{th:lv.theme}:{}) })))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function dec(code) { try { return sanitize(JSON.parse(decodeURIComponent(escape(atob(code.replace(/-/g,'+').replace(/_/g,'/')))))); } catch { return null; } }
function lvId(lv) {
  if (lv.id) return lv.id;
  if (lv.seed) return `S:${lv.seed}:${lv.style||'mix'}:${lv.diff||2}`;
  const a=[lv.plats.map(trimP),lv.coins,lv.goal,lv.start];
  if (lv.req||(lv.shapes&&lv.shapes.length)||(lv.cps&&lv.cps.length)||lv.theme) a.push([!!lv.req,lv.shapes||[],lv.cps||[],lv.theme|0]);
  const s=JSON.stringify(a); let h=2166136261;
  for (let i=0;i<s.length;i++) { h^=s.charCodeAt(i); h=Math.imul(h,16777619); }
  return 'H:'+(h>>>0).toString(36);
}

// ── Построение уровня ──────────────────────────────────────────
const coinGeo=new THREE.CylinderGeometry(0.4,0.4,0.1,8).rotateX(Math.PI/2);
const coinMat=gloss(0xffd800,0.28,1,{emissive:0x2a1c00});
const goalGeo=new THREE.IcosahedronGeometry(0.7,0);
const goalMat=gloss(0xfff176,0.22,0.9,{emissive:0x6a4a00});
const goalLockedMat=new THREE.MeshBasicMaterial({color:0x8a94b0,wireframe:true});
const outlineMat=new THREE.LineBasicMaterial({color:0x000000,transparent:true,opacity:0.55});
const flagGeo=new THREE.CylinderGeometry(0.2,0.2,2.4,6), clothGeo=new THREE.BoxGeometry(0.9,0.55,0.06);
const flagMat=new THREE.MeshLambertMaterial({color:0x3ddc68,emissive:0x0a4a1a});
const orbit={cx:0,cz:0,rx:15,rz:15,top:0};
let L, levelGroup=new THREE.Group(), parts=[], platMeshes=[], coins=[], flags=[], goal, goalOpen=true, voidY=-15;
scene.add(levelGroup);

function platGeometry(lparts, g) {
  const pos=[],nor=[],col=[],uv=[];
  const K=1/TILE_M,sec=Math.sqrt(1+g*g);
  let gx=0,gz=0,cnt=0;
  for (const q of lparts) for (const [x,z] of q.poly) { gx+=x; gz+=z; cnt++; }
  gx/=cnt; gz/=cnt;
  let R=0.001;
  for (const q of lparts) for (const [x,z] of q.poly) R=Math.max(R,Math.hypot(x-gx,z-gz));
  const lit=(x,z)=>1-0.3*Math.min(1,Math.hypot(x-gx,z-gz)/R);
  const key=(a,b,dy)=>{ const A=`${Math.round(a[0]*1e4)},${Math.round(a[1]*1e4)}`,B=`${Math.round(b[0]*1e4)},${Math.round(b[1]*1e4)}`; return (A<B?A+'|'+B:B+'|'+A)+'|'+dy; };
  const edgeCount=new Map();
  for (const q of lparts) for (let i=0;i<q.poly.length;i++) { const k=key(q.poly[i],q.poly[(i+1)%q.poly.length],q.dy); edgeCount.set(k,(edgeCount.get(k)||0)+1); }
  const tri=(A,B,C,want)=>{ const e1x=B[0]-A[0],e1y=B[1]-A[1],e1z=B[2]-A[2],e2x=C[0]-A[0],e2y=C[1]-A[1],e2z=C[2]-A[2]; let nx=e1y*e2z-e1z*e2y,ny=e1z*e2x-e1x*e2z,nz=e1x*e2y-e1y*e2x; const len=Math.hypot(nx,ny,nz); if(len<1e-9)return; nx/=len;ny/=len;nz/=len; if(nx*want[0]+ny*want[1]+nz*want[2]<0){[B,C]=[C,B];nx=-nx;ny=-ny;nz=-nz;} for(const V of[A,B,C]){pos.push(V[0],V[1],V[2]);nor.push(nx,ny,nz);col.push(V[3],V[3],V[3]);uv.push(V[4],V[5]);} };
  for (const q of lparts) {
    const P=q.poly,n=P.length; let cx=0,cz=0;
    for (const [x,z] of P){cx+=x;cz+=z;} cx/=n;cz/=n;
    const yt=(z)=>q.dy-g*z,yb=(z)=>yt(z)-q.T;
    const top=(x,z,b)=>[x,yt(z),z,b,x*K,z*K*sec],bot=(x,z)=>[x,yb(z),z,0.3,x*K,z*K];
    for(let i=0;i<n;i++){const a=P[i],b=P[(i+1)%n];tri(top(cx,cz,lit(cx,cz)),top(a[0],a[1],lit(a[0],a[1])),top(b[0],b[1],lit(b[0],b[1])),[0,1,0]);tri(bot(cx,cz),bot(a[0],a[1]),bot(b[0],b[1]),[0,-1,0]);}
    for(let i=0;i<n;i++){const a=P[i],b=P[(i+1)%n];if(edgeCount.get(key(a,b,q.dy))>1)continue;const ex=b[0]-a[0],ez=b[1]-a[1],el=Math.hypot(ex,ez)||1;const want=[(a[0]+b[0])/2-cx,0,(a[1]+b[1])/2-cz];const V=(pt,t)=>{const y=yb(pt[1])+(yt(pt[1])-yb(pt[1]))*t;return[pt[0],y,pt[1],0.35+0.35*t,((pt[0]*ex+pt[1]*ez)/el)*K,y*K];};for(const[t0,t1]of[[0,0.5],[0.5,1]]){tri(V(a,t0),V(b,t0),V(b,t1),want);tri(V(a,t0),V(b,t1),V(a,t1),want);}}
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  geo.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
  geo.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  geo.computeBoundingSphere();
  return geo;
}
function setGoalOpen(open){goalOpen=open;if(goal)goal.material=open?goalMat:goalLockedMat;}
let hoverObj=null;
function buildLevel(lv) {
  scene.remove(levelGroup);
  levelGroup.traverse((o)=>{if(o.userData.own)o.geometry.dispose();if(o.userData.ownMat)o.material.dispose();});
  levelGroup=new THREE.Group(); scene.add(levelGroup);
  parts=[]; platMeshes=[]; coins=[]; flags=[]; outlines=[]; hoverObj=null;
  setCustomShapes(lv.shapes||[]);
  const th=THEMES[lv.theme|0]||THEMES[0];
  lv.plats.forEach((a,i)=>{
    const pl=normPlat(a);
    const geo=platGeometry(localParts(pl),Math.tan(pl.t*DEG));
    const m=new THREE.Mesh(geo,platMat(th.colors[i%th.colors.length],th)); applyWet(m.material);
    m.position.set(pl.x,pl.y,pl.z); m.rotation.y=pl.r*DEG; m.userData={k:'p',i,own:true,ownMat:true};
    const ol=new THREE.LineSegments(new THREE.EdgesGeometry(geo,25),outlineMat);
    ol.userData={k:'o',own:true}; ol.visible=mode==='edit'; m.add(ol); outlines.push(ol);
    levelGroup.add(m); platMeshes.push(m); parts.push(...worldParts(pl));
  });
  lv.coins.forEach(([x,y,z],i)=>{const c=new THREE.Mesh(coinGeo,coinMat);c.position.set(x,y,z);c.userData={k:'c',i};levelGroup.add(c);coins.push(c);});
  // Флаги — только декоративные (зелёные, всегда активны визуально)
  (lv.cps||[]).forEach(([x,y,z],i)=>{
    const f=new THREE.Mesh(flagGeo,flagMat); f.position.set(x,y+1.2,z); f.userData={k:'f',i};
    const cloth=new THREE.Mesh(clothGeo,flagMat); cloth.position.set(0.55,0.85,0);
    f.add(cloth); levelGroup.add(f); flags.push(f);
  });
  goal=new THREE.Mesh(goalGeo,goalMat); goal.position.set(...lv.goal); goal.userData={k:'g'};
  levelGroup.add(goal); setGoalOpen(true);
  marker.position.set(lv.start[0],lv.start[1]+0.6,lv.start[2]);
  const B=partsBounds(parts);
  orbit.cx=(B.minX+B.maxX)/2; orbit.cz=(B.minZ+B.maxZ)/2;
  orbit.rx=Math.max(15,(B.maxX-B.minX)/2); orbit.rz=Math.max(15,(B.maxZ-B.minZ)/2); orbit.top=B.hi;
  voidY=B.lo-12;
  clouds.setBands({cx:orbit.cx,cz:orbit.cz,r:Math.max(orbit.rx,orbit.rz)+100,low:B.lo,high:B.hi});
  refreshShapeButtons();
  gulls.setLevel(lv);
}

// ── Игрок ──────────────────────────────────────────────────────
const SKIN_KEYS=['legs','shirt','head','cap','belt'];
const SKINS=[
  {name:'Серебряный рыцарь',legs:0x8d99a6,shirt:0xc9d3dc,head:0xd5dde4,cap:0xd32f2f,belt:0x5d4037,rough:0.3,metal:0.9},
  {name:'Золотой рыцарь',legs:0xb8860b,shirt:0xffd24d,head:0xffe08a,cap:0x1565c0,belt:0x6d4c00,rough:0.25,metal:1},
  {name:'Чёрный рыцарь',legs:0x23232a,shirt:0x34343c,head:0x2b2b32,cap:0x8e0000,belt:0xb71c1c,rough:0.35,metal:0.85},
  {name:'Красный рыцарь',legs:0x8e1b1b,shirt:0xc62828,head:0xd84a4a,cap:0xf5f5f5,belt:0xffc107,rough:0.3,metal:0.8},
  {name:'Королевский синий',legs:0x1a3a8a,shirt:0x2f5fd0,head:0x5a85e8,cap:0xffd24d,belt:0xffc107,rough:0.28,metal:0.85},
  {name:'Изумрудный',legs:0x1b6b4a,shirt:0x2e9b6a,head:0x4fcf97,cap:0xf5f5f5,belt:0x5d4037,rough:0.3,metal:0.8},
  {name:'Хром',legs:0xb0bec5,shirt:0xe0e6ea,head:0xcfd8dc,cap:0x455a64,belt:0x37474f,rough:0.12,metal:1},
  {name:'Ледяной',legs:0x4aa3e0,shirt:0xbfe8ff,head:0xe3f6ff,cap:0x2f6f9f,belt:0x7fc4f0,rough:0.15,metal:0.3},
  {name:'Вулкан',legs:0x3e2723,shirt:0x8a3b2a,head:0xd9622b,cap:0xffb300,belt:0x212121,rough:0.7,metal:0.4},
  {name:'Призрак',legs:0xdedede,shirt:0xffffff,head:0xf5f5f5,cap:0xcfd8ff,belt:0x9fa8da,rough:0.2,metal:0.1},
  {name:'Радужный (анимация)',legs:0x1565c0,shirt:0xd32f2f,head:0xffcc99,cap:0xd32f2f,belt:0xffffff,rough:0.25,metal:0.6,rainbow:true},
];

const skinMats={};
for (const k of SKIN_KEYS) skinMats[k]=gloss(0xffffff,0.4,0.8,{flatShading:true});
const darkMat=gloss(0x111111,0.4,0,{flatShading:true});
const steelMat=gloss(0xdde3e8,0.18,1,{flatShading:true});

// Материалы для превью персонажа (простые Phong)
const pvMats={};
for (const k of SKIN_KEYS) pvMats[k]=new THREE.MeshPhongMaterial({color:0xffffff,shininess:55,flatShading:true});
const pvDarkMat=new THREE.MeshPhongMaterial({color:0x111111,shininess:10,flatShading:true});
const pvSteelMat=new THREE.MeshPhongMaterial({color:0xdde3e8,shininess:110,flatShading:true});

// Строитель рыцаря: используется и для игрока, и для превью
function buildKnight(parent, mats, dM, sM) {
  const sp=(key,par,w,h,d,x,y,z)=>box(par,w,h,d,mats[key],x,y,z);
  const piv=(x,y,z)=>{const g=new THREE.Group();g.position.set(x,y,z);parent.add(g);return g;};
  const legL=piv(-0.17,0.46,0),legR=piv(0.17,0.46,0);
  const armL=piv(-0.42,1.08,0),armR=piv(0.42,1.08,0);
  sp('legs',legL,0.26,0.46,0.32,0,-0.23,0);
  sp('legs',legR,0.26,0.46,0.32,0,-0.23,0);
  sp('belt',parent,0.7,0.12,0.42,0,0.52,0);
  sp('shirt',parent,0.62,0.52,0.38,0,0.84,0);
  sp('shirt',parent,0.36,0.26,0.05,0,0.88,0.21);
  sp('shirt',armL,0.26,0.18,0.34,0,0.02,0);
  sp('shirt',armR,0.26,0.18,0.34,0,0.02,0);
  sp('legs',armL,0.17,0.42,0.2,0,-0.26,0);
  sp('legs',armR,0.17,0.42,0.2,0,-0.26,0);
  sp('cap',armL,0.08,0.5,0.4,-0.14,-0.28,0.04);
  sp('belt',armL,0.05,0.14,0.14,-0.2,-0.28,0.04);
  // ── Меч: исправленное положение ──────────────────────────────
  // Лезвие выше, рукоять у кисти, гарда между ними; смещён вправо-вперёд чтобы не клипиться
  box(armR,0.06,0.76,0.04,sM,0.06,0.14,0.18);             // лезвие (вверх от гарды)
  sp('belt',armR,0.36,0.06,0.09,0.06,-0.26,0.18);         // гарда
  sp('belt',armR,0.08,0.22,0.08,0.06,-0.40,0.18);         // рукоять
  // ─────────────────────────────────────────────────────────────
  sp('head',parent,0.46,0.46,0.46,0,1.38,0);
  sp('head',parent,0.5,0.1,0.5,0,1.18,0);
  box(parent,0.34,0.07,0.04,dM,0,1.4,0.24);
  box(parent,0.05,0.22,0.04,dM,0,1.3,0.24);
  sp('cap',parent,0.1,0.18,0.5,0,1.69,-0.02);
  sp('cap',parent,0.1,0.3,0.12,0,1.55,-0.3);
  return {legL,legR,armL,armR};
}

const player=new THREE.Group();
const {legL,legR,armL,armR}=buildKnight(player,skinMats,darkMat,steelMat);
scene.add(player);

let skin=SKINS[0], skinId=0;
function applySkin(sk) {
  skin=sk;
  for (const k of SKIN_KEYS) {
    skinMats[k].color.setHex(sk[k]); setShine(skinMats[k],sk.rough??0.55,sk.metal??0.1);
    if (pvMats[k]) pvMats[k].color.setHex(sk[k]);
  }
}
const kn={phase:0,swing:0,air:0};
function knightAnim(dt,moving,grounded) {
  kn.phase+=dt*(moving&&grounded?14:0);
  const k=Math.min(1,14*dt);
  kn.swing+=((moving&&grounded?Math.sin(kn.phase)*0.75:0)-kn.swing)*k;
  kn.air+=((grounded?0:1)-kn.air)*k;
  legL.rotation.x=kn.swing*(1-kn.air*0.6); legR.rotation.x=-kn.swing*(1-kn.air*0.6);
  armL.rotation.x=-kn.swing*0.8-kn.air*0.9; armR.rotation.x=kn.swing*0.8-kn.air*1.6;
  player.position.y=p.y+(grounded&&moving?Math.abs(Math.sin(kn.phase))*0.05:0);
}
function skinAnim(t) {
  if (!skin.rainbow) return;
  SKIN_KEYS.forEach((k,i)=>{if(k!=='belt'){const h=(t*0.15+i*0.2)%1;skinMats[k].color.setHSL(h,0.85,0.55);if(pvMats[k])pvMats[k].color.setHSL(h,0.85,0.55);}});
}
const hexStr=(n)=>'#'+n.toString(16).padStart(6,'0');
function syncSkinUI() {
  $('skinSel').value=String(skinId);
  const ids={legs:'skLegs',shirt:'skShirt',head:'skHead',cap:'skCap',belt:'skBelt'};
  for (const k of SKIN_KEYS) $(ids[k]).value=hexStr(skin[k]);
}
function chooseSkin(id) {
  skinId=id;
  if (id==='custom'){const c=save.skin&&save.skin.colors;applySkin({name:'Свои цвета',...(c||SKINS[0])});}
  else applySkin(SKINS[id]);
  save.skin=id==='custom'?{id,colors:Object.fromEntries(SKIN_KEYS.map((k)=>[k,skin[k]]))}:{id};
  persist(); syncSkinUI();
}
function customSkin(colors){save.skin={id:'custom',colors};chooseSkin('custom');}
const shadow=new THREE.Mesh(new THREE.CircleGeometry(0.5,8).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.4}));
scene.add(shadow);

// ── 3D-превью персонажа ────────────────────────────────────────
let pvRenderer=null,pvScene=null,pvCam=null,pvPlayer=null,pvAngle=0;
function initCharPreview() {
  const container=$('charPreview');
  if (!container||pvRenderer) return;
  container.innerHTML='';
  try {
    const cvs=document.createElement('canvas'); cvs.width=180; cvs.height=240;
    container.appendChild(cvs);
    pvRenderer=new THREE.WebGLRenderer({canvas:cvs,antialias:false});
    pvRenderer.setPixelRatio(1); pvRenderer.setSize(180,240,false);
    pvScene=new THREE.Scene(); pvScene.background=new THREE.Color(0x030810);
    pvScene.add(new THREE.AmbientLight(0xffffff,0.5));
    const pl1=new THREE.DirectionalLight(0xffffff,1.2); pl1.position.set(3,7,4); pvScene.add(pl1);
    const pl2=new THREE.DirectionalLight(0x4466ff,0.4); pl2.position.set(-3,2,-4); pvScene.add(pl2);
    const floor=new THREE.Mesh(new THREE.CircleGeometry(2,8).rotateX(-Math.PI/2),new THREE.MeshLambertMaterial({color:0x0a1228}));
    floor.position.y=-0.01; pvScene.add(floor);
    pvPlayer=new THREE.Group(); buildKnight(pvPlayer,pvMats,pvDarkMat,pvSteelMat); pvScene.add(pvPlayer);
    pvCam=new THREE.PerspectiveCamera(38,180/240,0.1,50);
    for (const k of SKIN_KEYS) if(pvMats[k]) pvMats[k].color.setHex(skin[k]);
  } catch(e) { pvRenderer=null; if(container) container.innerHTML='<div class="pv-ph">Превью недоступно</div>'; }
}
function renderPreview(dt) {
  if (!pvRenderer||!pvScene||!pvCam||!pvPlayer) return;
  pvAngle+=dt*0.7; pvPlayer.rotation.y=pvAngle;
  const camY=1.45+Math.sin(pvAngle*0.4)*0.10;
  pvCam.position.set(0,camY,3.6); pvCam.lookAt(0,0.8,0);
  pvRenderer.render(pvScene,pvCam);
}

// ── Пыль ──────────────────────────────────────────────────────
const DUST_N=90;
const dust=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1,0),new THREE.MeshBasicMaterial({color:0xeeeae2,transparent:true,opacity:0.8,depthWrite:false}),DUST_N);
dust.frustumCulled=false; dust.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(dust);
const dp=Array.from({length:DUST_N},()=>({x:0,y:0,z:0,vx:0,vy:0,vz:0,age:1,life:1,size:0,rot:0}));
let dustNext=0,runPuff=0;
const dummyD=new THREE.Object3D();
function puff(x,y,z,vx,vy,vz,size,life){const d=dp[dustNext];dustNext=(dustNext+1)%DUST_N;d.x=x;d.y=y;d.z=z;d.vx=vx;d.vy=vy;d.vz=vz;d.size=size;d.life=life;d.age=0;d.rot=Math.random()*6.28;}
function dustRing(x,y,z,n,speed,size){for(let i=0;i<n;i++){const a=(i/n)*Math.PI*2+Math.random()*0.5,sp=speed*(0.7+Math.random()*0.6);puff(x+Math.cos(a)*0.25,y+0.08,z+Math.sin(a)*0.25,Math.cos(a)*sp,0.5+Math.random()*0.9,Math.sin(a)*sp,size*(0.8+Math.random()*0.5),0.45+Math.random()*0.3);}}
function updateDust(dt){for(let i=0;i<DUST_N;i++){const d=dp[i];if(d.age>=d.life){dummyD.scale.setScalar(1e-4);dummyD.position.set(0,-999,0);}else{d.age+=dt;const k=Math.exp(-3*dt);d.vx*=k;d.vz*=k;d.vy=d.vy*k+0.6*dt;d.x+=d.vx*dt;d.y+=d.vy*dt;d.z+=d.vz*dt;const t=Math.min(1,d.age/d.life),s=d.size*(0.35+0.65*Math.min(1,t*4))*(1-t*t);dummyD.position.set(d.x,d.y,d.z);dummyD.scale.setScalar(Math.max(1e-4,s));dummyD.rotation.set(d.rot,d.rot*0.7+t,0);}dummyD.updateMatrix();dust.setMatrixAt(i,dummyD.matrix);}dust.instanceMatrix.needsUpdate=true;}
function clearDust(){dp.forEach((d)=>(d.age=d.life));}

// ── Физика ────────────────────────────────────────────────────
const {SPEED,JUMP,GRAV}=MOVE;
const p=new THREE.Vector3(),v=new THREE.Vector3(),tmp=new THREE.Vector3();
const st={onGround:false,landed:false,landVy:0};
let coyote=0,face=0,got=0,time=0,won=false;

const keys={};
let mode='play',jumpBuf=0,camA=0,snapCam=false,clockT=0,testRun=false,levelId='';
let goalToastAt=0,lastHud='',coinCombo=0,coinT=-9,lastStep=0;
let menuOpen=false,menuScreen='main',introDone=false;
const hud=$('hud'),msg=$('msg'),hCoins=$('hCoins'),hNeed=$('hNeed'),hTime=$('hTime'),hBest=$('hBest');
const mouse=new THREE.Vector2();
let pad=input.idle; // состояние геймпада за текущий кадр (см. input.js)
let padFocusEl=null; // выбранная геймпадом кнопка меню (для звука «шагов» по меню)

// ── Подсказки управления (заметные, но ненавязчивые) ──────────
const HELP_PLAY  = 'WASD — движение  •  Пробел — прыжок\nQ/E — камера  •  R — заново  •  Esc — меню';
const HELP_EDIT  = 'ЛКМ — поставить  •  ПКМ — стереть\nКолесо — зум  •  R — поворот  •  Z/X — высота  •  F — вся карта';

// Все подсказки, зависящие от устройства ввода, обновляются здесь (вызывается при смене устройства)
function refreshHints(edit=mode==='edit'){
  const gp=input.device==='pad';
  document.body.classList.toggle('pad',gp);
  $('help').textContent=gp?input.helpText(edit?'edit':'play'):(edit?HELP_EDIT:HELP_PLAY);
  $('ctlList').innerHTML=input.controlsHTML();
  $('ctlDevice').textContent='Сейчас: '+input.deviceName();
  $('padhint').textContent=input.menuHint();
  document.querySelectorAll('.openmenu').forEach((b)=>{b.textContent=input.menuButtonText();});
  document.querySelectorAll('.hint-restart').forEach((el)=>{el.textContent=input.restartHint();});
  if(gp&&menuOpen)input.menuFocusFirst();
}

let toastT;
function toast(t,ms=2200){const el=$('toast');el.textContent=t;el.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove('show'),ms);}

// ── Сброс: всегда полный (без чекпоинтов) ─────────────────────
function reset() {
  clearDust(); rain.reset(); gulls.reset();
  p.set(...L.start); v.set(0,0,0); st.onGround=false;
  got=0; time=0; won=false; jumpBuf=0; coyote=0;
  coins.forEach((c)=>(c.visible=true));
  setGoalOpen(!L.req||coins.length===0);
  levelId=lvId(L);
  msg.style.display='none';
  snapCam=true;
}

addEventListener('keydown',(e)=>{
  if(menuOpen&&e.code==='Escape'){e.preventDefault();showMenu(menuScreen==='main'?null:'main');return;}
  if(/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))return;
  if(menuOpen){if(e.code==='KeyM')showMenu(menuScreen==='main'?null:'main');return;}
  keys[e.code]=true;
  if(e.code==='Space'||e.code.startsWith('Arrow'))e.preventDefault();
  if(e.code==='KeyM'||(e.code==='Escape'&&!(mode==='edit'&&ed.draw.length)))toggleMenu();
  if(mode==='play'){if(e.code==='Space')jumpBuf=0.15;if(e.code==='KeyR'){audio.sfx('restart');reset();}}
  else {
    if(e.code==='KeyZ'&&(e.ctrlKey||e.metaKey)){e.preventDefault();undo();return;}
    if(e.code==='Enter'&&ed.tool==='draw'){e.preventDefault();finishDraw();}
    if(e.code==='Escape')cancelDraw();
    if(e.code==='Backspace'&&ed.tool==='draw'){e.preventDefault();undoDrawPoint();}
    if(e.code==='KeyZ'){ed.h-=0.5;syncUI();audio.sfx('tick',{rate:0.85});}
    if(e.code==='KeyX'){ed.h+=0.5;syncUI();audio.sfx('tick',{rate:1.15});}
    if(e.code==='KeyR'){ed.rot=(ed.rot+(e.shiftKey?-15:15)+360)%360;ed.dirty=true;syncUI();audio.sfx('tick',{rate:1.3});}
    if(e.code==='KeyF')fitView();
    const ti=['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7'].indexOf(e.code);
    if(ti>=0)setTool(TOOLS[ti][0]);
  }
});
addEventListener('keyup',(e)=>{keys[e.code]=false;});
addEventListener('blur',()=>{for(const k in keys)keys[k]=false;});
addEventListener('mousemove',(e)=>{if(mode==='play'&&!menuOpen&&e.buttons)camA-=e.movementX*0.005;});

function win(){
  won=true; audio.sfx('win'); const total=coins.length; let extra='';
  if(testRun)extra='<br>Тест уровня: рекорд не сохраняется';
  else{const prev=save.best[levelId];if(prev==null||time<prev){save.best[levelId]=time;extra+='<br>Новый рекорд!';}else extra+=`<br>Рекорд: ${prev.toFixed(1)} с`;persist();}
  msg.style.display='flex';
  msg.innerHTML=`ЗВЕЗДА!<br>Время: ${time.toFixed(1)} с${total?`, монет: ${got}/${total}`:''}${extra}<br><span class="hint-restart">${input.restartHint()}</span>`;
}

function update(dt){
  if(pad.restart){audio.sfx('restart');reset();}
  // Клавиатура и геймпад работают одновременно: оси геймпада просто добавляются к клавишам
  camA+=((keys.ArrowLeft||keys.KeyQ?1:0)-(keys.ArrowRight||keys.KeyE?1:0)+pad.camDir-pad.lookX*1.4)*2*dt;
  const f=(keys.KeyW?1:0)-(keys.KeyS?1:0)+pad.moveY,r=(keys.KeyD?1:0)-(keys.KeyA?1:0)+pad.moveX;
  let dx=-Math.sin(camA)*f+Math.cos(camA)*r,dz=-Math.cos(camA)*f-Math.sin(camA)*r;
  const len=Math.hypot(dx,dz),mag=Math.min(1,len); // стик наклонён слабее — идём медленнее
  if(len>0){dx/=len;dz/=len;face=Math.atan2(dx,dz);}
  v.x=dx*SPEED*mag;v.z=dz*SPEED*mag;
  coyote=st.onGround?0.1:coyote-dt; jumpBuf-=dt; if(pad.jump)jumpBuf=0.15;
  if(jumpBuf>0&&coyote>0){v.y=JUMP;coyote=0;jumpBuf=0;st.onGround=false;dustRing(p.x,p.y,p.z,7,1.8,0.28);audio.sfx('jump');}
  const n=Math.max(1,Math.ceil(dt/0.01)),h=dt/n; let landVy=0;
  for(let i=0;i<n;i++){v.y=Math.max(-35,v.y-GRAV*h);stepBody(parts,p,v,h,st);if(st.landed)landVy=Math.min(landVy,st.landVy);}
  if(landVy<-5){audio.sfx('land',{vol:0.35+0.65*Math.min(1,-landVy/30)});dustRing(p.x,p.y,p.z,Math.min(14,6+Math.round(-landVy/3)),Math.min(4,1.5-landVy*0.12),0.32+Math.min(0.25,-landVy*0.01));}
  runPuff-=dt;
  if(st.onGround&&len>0&&runPuff<=0){runPuff=0.07;puff(p.x-dx*0.25+(Math.random()-0.5)*0.3,p.y+0.08,p.z-dz*0.25+(Math.random()-0.5)*0.3,-dx*0.8+(Math.random()-0.5)*0.6,0.35+Math.random()*0.4,-dz*0.8+(Math.random()-0.5)*0.6,0.2+Math.random()*0.12,0.4+Math.random()*0.2);}
  updateDust(dt);

  // ── Пропасть: ПОЛНЫЙ сброс (без чекпоинтов) ──────────────────
  if(p.y<voidY) { audio.sfx('fall'); reset(); return; }

  // Флаги — декоративно вращаются
  flags.forEach(f=>{f.rotation.y+=dt*0.6;});

  tmp.set(p.x,p.y+0.8,p.z);
  for(const c of coins){if(!c.visible)continue;c.rotation.y+=dt*4;if(c.position.distanceTo(tmp)<1){c.visible=false;got++;coinCombo=clockT-coinT<1.4?Math.min(coinCombo+1,8):0;coinT=clockT;audio.sfx('coin',{rate:Math.pow(2,coinCombo*2/12),jitter:0});if(got>=coins.length){audio.sfx('allcoins',{delay:0.22});if(L.req){setGoalOpen(true);toast('Все монеты собраны! Беги к звезде');}else toast('Все монеты собраны!');}}}
  goal.rotation.y+=dt*(goalOpen?2:0.8);
  goal.scale.setScalar(goalOpen?1+0.08*Math.sin(clockT*5):1);
  if(!won&&goal.position.distanceTo(tmp)<1.4){if(goalOpen)win();else if(clockT>goalToastAt){audio.sfx('locked');toast(`Нужны все монеты! Осталось: ${coins.length-got}`);goalToastAt=clockT+1.5;}}
  if(!won)time+=dt;
  const best=save.best[levelId],need=L.req&&coins.length&&got<coins.length;
  const hv=`${got}/${coins.length}|${need?1:0}|${time.toFixed(1)}|${best!=null?best.toFixed(1):'--'}`;
  if(hv!==lastHud){lastHud=hv;hCoins.textContent=`×${got}/${coins.length}`;hNeed.textContent=need?'нужны все':'';hTime.textContent=time.toFixed(1);hBest.textContent=best!=null?best.toFixed(1):'--';}
  skinAnim(clockT);
  player.position.copy(p); knightAnim(dt,len>0,st.onGround); player.rotation.y=face;
  // Шаги: звук на каждый «шаг» ног (фаза бега растёт только когда бежим по земле)
  const sIdx=Math.floor(kn.phase/Math.PI);
  if(sIdx!==lastStep){lastStep=sIdx;audio.sfx('step',{vol:0.45+0.55*mag,rate:(sIdx&1)?0.92:1.06});}
  const gy=supportY(parts,p.x,p.z,p.y+0.05);
  shadow.visible=gy>-Infinity; shadow.position.set(p.x,gy+0.02,p.z);
  tmp.set(p.x+Math.sin(camA)*8,p.y+4.5,p.z+Math.cos(camA)*8);
  if(snapCam)camera.position.copy(tmp);else camera.position.lerp(tmp,1-Math.exp(-6*dt));
  camera.lookAt(p.x,p.y+1.2,p.z); snapCam=false;
}

// ── Редактор ───────────────────────────────────────────────────
const TOOLS=[['plat','Платформа'],['coin','Монета'],['goal','Звезда'],['start','Старт'],['erase','Стереть'],['cp','Чекпоинт'],['draw','Своя форма']];
const PLACE_SFX={plat:'place',coin:'putCoin',goal:'putGoal',start:'putStart',cp:'putFlag'};
const ed={tool:'plat',shape:0,w:3,d:3,rot:0,tilt:0,k:1,h:0,step:0.5,snap:true,mx:0,my:0,mz:0,below:null,tx:0,ty:0,tz:0,yaw:0.5,pitch:0.95,dist:22,over:false,dirty:true,draw:[],drawY:0};
const ray=new THREE.Raycaster(),ray2=new THREE.Raycaster(),plane=new THREE.Plane(new THREE.Vector3(0,1,0),0);
const hitP=new THREE.Vector3(),rayO=new THREE.Vector3(),DOWN=new THREE.Vector3(0,-1,0);
const ghostShape=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial({color:0x7dff9a,transparent:true,opacity:0.5,depthWrite:false}));
const ghostEdges=new THREE.LineSegments(new THREE.BufferGeometry(),new THREE.LineBasicMaterial({color:0xffffff}));
ghostShape.add(ghostEdges);
const ghostBox=new THREE.Mesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial({color:0xffffff,wireframe:true}));
const footMat=new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:0.4,depthWrite:false});
const footprint=new THREE.Mesh(new THREE.BufferGeometry(),footMat);
const dot=new THREE.Mesh(new THREE.CircleGeometry(0.45,12).rotateX(-Math.PI/2),footMat);
const dropGeo=new THREE.BufferGeometry();
dropGeo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(6),3));
const dropLine=new THREE.Line(dropGeo,new THREE.LineBasicMaterial({color:0xffee55}));
dropLine.frustumCulled=false;
const grid1=new THREE.GridHelper(64,64,0xffffff,0xffffff),grid2=new THREE.GridHelper(60,12,0xffffff,0xffffff);
for(const g of[grid1,grid2]){g.material.transparent=true;g.material.depthWrite=false;}
grid1.material.opacity=0.12;grid2.material.opacity=0.3;
helpers.add(grid1,grid2,ghostShape,ghostBox,footprint,dot,dropLine);
const drawGeo=new THREE.BufferGeometry();
const drawLine=new THREE.LineLoop(drawGeo,new THREE.LineBasicMaterial({color:0xffee55,depthTest:false}));
const drawPts=new THREE.Points(drawGeo,new THREE.PointsMaterial({color:0xffffff,size:6,sizeAttenuation:false,depthTest:false}));
for(const o of[drawLine,drawPts]){o.frustumCulled=false;o.renderOrder=10;o.visible=false;helpers.add(o);}
let lastDrawKey='';
function refreshDraw(cursor){const pts=cursor?[...ed.draw,cursor]:ed.draw.slice();const key=JSON.stringify([pts,ed.drawY]);drawLine.visible=drawPts.visible=pts.length>0;if(key===lastDrawKey)return;lastDrawKey=key;const arr=new Float32Array(pts.length*3);pts.forEach((q,i)=>arr.set([q[0],ed.drawY+0.06,q[1]],i*3));drawGeo.setAttribute('position',new THREE.BufferAttribute(arr,3));drawGeo.setDrawRange(0,pts.length);drawLine.material.color.setHex(pts.length>=3&&!isSimplePolygon(pts)?0xff5555:0xffee55);}
function rebuildGhost(){const pl=normPlat([0,0,0,ed.w,ed.d,ed.shape,0,ed.tilt,ed.k]);const geo=platGeometry(localParts(pl),Math.tan(ed.tilt*DEG));ghostShape.geometry.dispose();ghostShape.geometry=geo;ghostEdges.geometry.dispose();ghostEdges.geometry=new THREE.EdgesGeometry(geo,25);footprint.geometry=geo;ed.dirty=false;}
const hist=[];
const snap=()=>JSON.stringify({name:L.name,plats:L.plats,coins:L.coins,cps:L.cps,shapes:L.shapes,req:L.req,theme:L.theme,goal:L.goal,start:L.start});
function pushHist(){hist.push(snap());if(hist.length>60)hist.shift();}
function undo(){const s=hist.pop();if(!s)return warn('Нечего отменять');Object.assign(L,JSON.parse(s));ed.draw=[];audio.sfx('undo');edited();$('ename').value=L.name;syncLevelUI();}
function computePlacement(){const rd=(x)=>Math.round(x/ed.step)*ed.step,lim=(x)=>Math.max(-290,Math.min(290,x));ray.setFromCamera(mouse,camera);const planeY=ed.tool==='draw'&&ed.draw.length?ed.drawY:ed.h;let x=0,z=0,y=planeY,got=false;if(ed.snap&&ed.tool!=='erase'&&ed.tool!=='draw'){const hit=ray.intersectObjects(platMeshes,false)[0];if(hit&&hit.face&&hit.face.normal.y>0.5){x=rd(hit.point.x);z=rd(hit.point.z);y=Math.round(hit.point.y*100)/100;got=true;}}if(!got){plane.constant=-planeY;if(!ray.ray.intersectPlane(plane,hitP))return false;x=rd(hitP.x);z=rd(hitP.z);}ed.mx=lim(x);ed.mz=lim(z);ed.my=y;rayO.set(ed.mx,ed.my+0.02,ed.mz);ray2.set(rayO,DOWN);ray2.far=200;const b=ray2.intersectObjects(platMeshes,false)[0];ed.below=b?b.point.y:null;return true;}
function setHover(o){if(hoverObj===o)return;if(hoverObj){if(hoverObj.userData.k==='p')hoverObj.material.emissive.setHex(0);else hoverObj.scale.setScalar(1);}hoverObj=o;if(o){if(o.userData.k==='p')o.material.emissive.setHex(0xaa2222);else o.scale.setScalar(1.5);}}
const fmt=(x)=>String(Math.round(x*100)/100);
let lastInfo='';
const GHOST_BOX={coin:[0.8,0.8,0.8,1.3],goal:[1.4,1.4,1.4,1.6],start:[0.8,1.2,0.8,0.6],cp:[0.6,2.4,0.6,1.2]};
function updateGuides(){const t=ed.tool,plat=t==='plat';const have=ed.over&&computePlacement();ghostShape.visible=have&&plat;ghostBox.visible=have&&!!GHOST_BOX[t];dropLine.visible=footprint.visible=dot.visible=false;const gx=have?ed.mx:ed.tx,gz=have?ed.mz:ed.tz,gy=have?ed.my:ed.h;grid1.position.set(Math.round(gx),gy+0.03,Math.round(gz));grid2.position.set(Math.round(gx/5)*5,gy+0.03,Math.round(gz/5)*5);let txt='';if(have){if(t==='erase'){ray.setFromCamera(mouse,camera);const hit=ray.intersectObjects(levelGroup.children,false)[0];setHover(hit&&(hit.object.userData.k==='p'||hit.object.userData.k==='c'||hit.object.userData.k==='f')?hit.object:null);}else{setHover(null);let startY=ed.my;if(plat){if(ed.dirty)rebuildGhost();ghostShape.position.set(ed.mx,ed.my,ed.mz);ghostShape.rotation.y=ed.rot*DEG;}else if(GHOST_BOX[t]){const S=GHOST_BOX[t];ghostBox.scale.set(S[0],S[1],S[2]);ghostBox.position.set(ed.mx,ed.my+S[3],ed.mz);startY=ed.my+S[3];}const bottom=ed.below!=null?ed.below:startY-30;const a=dropGeo.attributes.position;a.setXYZ(0,ed.mx,startY,ed.mz);a.setXYZ(1,ed.mx,bottom,ed.mz);a.needsUpdate=true;dropLine.visible=startY-bottom>0.05;if(ed.below!=null&&ed.my-ed.below>0.05){const f2=plat?footprint:dot;f2.visible=true;f2.position.set(ed.mx,ed.below+0.04,ed.mz);if(plat){f2.rotation.y=ed.rot*DEG;f2.scale.set(1,0.02,1);}}}txt=`X ${fmt(ed.mx)}   Z ${fmt(ed.mz)}   ВЫСОТА ${fmt(ed.my)}`+(ed.below!=null?`   (над платформой +${fmt(ed.my-ed.below)})`:'   (под ним пусто)')+'\n';}else setHover(null);if(t==='draw')refreshDraw(have?[ed.mx,ed.mz]:null);else drawLine.visible=drawPts.visible=false;txt+=`Плоскость: ${fmt(ed.h)}${ed.snap?' (прилипание)':''}   Платформ: ${L.plats.length}/80   Монет: ${L.coins.length}/100`;if(txt!==lastInfo){$('edinfo').textContent=txt;lastInfo=txt;}}
function updateEdit(dt){if(input.device==='pad')padEdit();ed.yaw+=((keys.KeyQ?1:0)-(keys.KeyE?1:0)-pad.lookX*1.2)*1.8*dt;ed.pitch=Math.max(0.08,Math.min(1.5,ed.pitch-pad.lookY*1.1*dt));ed.dist=Math.max(4,Math.min(180,ed.dist*Math.exp(-pad.zoom*1.4*dt)));const f=(keys.KeyW?1:0)-(keys.KeyS?1:0)+pad.moveY,r=(keys.KeyD?1:0)-(keys.KeyA?1:0)+pad.moveX,sp=ed.dist*0.8*dt;ed.tx+=(-Math.sin(ed.yaw)*f+Math.cos(ed.yaw)*r)*sp;ed.tz+=(-Math.cos(ed.yaw)*f-Math.sin(ed.yaw)*r)*sp;ed.ty+=(ed.h-ed.ty)*(1-Math.exp(-8*dt));const cp=Math.cos(ed.pitch);camera.position.set(ed.tx+Math.sin(ed.yaw)*cp*ed.dist,ed.ty+Math.sin(ed.pitch)*ed.dist,ed.tz+Math.cos(ed.yaw)*cp*ed.dist);camera.lookAt(ed.tx,ed.ty,ed.tz);camera.updateMatrixWorld();updateGuides();coins.forEach((c)=>(c.rotation.y+=dt*4));goal.rotation.y+=dt*2;}
function fitView(){const B=partsBounds(parts);let x0=B.minX,x1=B.maxX,z0=B.minZ,z1=B.maxZ;for(const[x,,z]of[...L.coins,...(L.cps||[]),L.goal,L.start]){x0=Math.min(x0,x);x1=Math.max(x1,x);z0=Math.min(z0,z);z1=Math.max(z1,z);}ed.tx=(x0+x1)/2;ed.tz=(z0+z1)/2;ed.dist=Math.min(180,Math.max(10,Math.hypot(x1-x0,z1-z0)*0.9+6));ed.pitch=0.9;}
function edited(){L.seed=null;L.id=null;L.style=null;buildLevel(L);if(mode==='edit')setGoalOpen(true);$('lvname').textContent=L.name;}
function erase(){ray.setFromCamera(mouse,camera);const hit=ray.intersectObjects(levelGroup.children,false)[0];const u=hit&&hit.object.userData;if(!u)return;if(u.k==='p'&&L.plats.length>1){pushHist();L.plats.splice(u.i,1);}else if(u.k==='c'){pushHist();L.coins.splice(u.i,1);}else if(u.k==='f'){pushHist();L.cps.splice(u.i,1);}else return;audio.sfx('erase');edited();}
function place(){if(!computePlacement())return;const{tool:t,mx:x,my:y,mz:z}=ed;if(t==='erase')return erase();if(t==='draw')return addDrawPoint();if(t==='cp'&&L.cps.length>=20)return warn('Максимум 20 чекпоинтов');if(t==='plat'&&L.plats.length>=80)return warn('Максимум 80 платформ');if(t==='coin'&&L.coins.length>=100)return warn('Максимум 100 монет');pushHist();if(t==='plat')L.plats.push([x,y,z,ed.w,ed.d,ed.shape,ed.rot,ed.tilt,ed.k]);else if(t==='coin')L.coins.push([x,y+1.3,z]);else if(t==='goal')L.goal=[x,y+1.6,z];else if(t==='start')L.start=[x,y,z];else if(t==='cp')L.cps.push([x,y,z]);audio.sfx(PLACE_SFX[t]);edited();}
const cv=renderer.domElement;
const drag={on:false,btn:0,x:0,y:0,sx:0,sy:0,moved:false,shift:false};
const setMouse=(e)=>mouse.set((e.clientX/innerWidth)*2-1,-(e.clientY/innerHeight)*2+1);
cv.addEventListener('contextmenu',(e)=>e.preventDefault());
cv.addEventListener('mousedown',(e)=>{if(e.button===1)e.preventDefault();});
cv.addEventListener('pointerdown',(e)=>{if(mode!=='edit')return;cv.setPointerCapture(e.pointerId);Object.assign(drag,{on:true,btn:e.button,x:e.clientX,y:e.clientY,sx:e.clientX,sy:e.clientY,moved:false,shift:e.shiftKey});setMouse(e);ed.over=true;});
cv.addEventListener('pointermove',(e)=>{if(mode!=='edit')return;setMouse(e);ed.over=true;if(!drag.on)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;if(!drag.moved&&Math.hypot(e.clientX-drag.sx,e.clientY-drag.sy)>5)drag.moved=true;if(!drag.moved)return;if(drag.btn===0&&!drag.shift){ed.yaw-=dx*0.006;ed.pitch=Math.max(0.08,Math.min(1.5,ed.pitch+dy*0.005));}else{const k=ed.dist*0.0012,sx=Math.cos(ed.yaw),sz=-Math.sin(ed.yaw),fx=-Math.sin(ed.yaw),fz=-Math.cos(ed.yaw);const fk=k/Math.max(0.35,Math.sin(ed.pitch));ed.tx+=-sx*dx*k+fx*dy*fk;ed.tz+=-sz*dx*k+fz*dy*fk;}});
cv.addEventListener('pointerup',(e)=>{if(!drag.on)return;drag.on=false;if(mode!=='edit'||drag.moved)return;setMouse(e);if(drag.btn===0)place();else if(drag.btn===2){if(ed.tool==='draw'&&ed.draw.length)undoDrawPoint();else erase();}});
cv.addEventListener('pointerleave',()=>{if(!drag.on)ed.over=false;});
cv.addEventListener('wheel',(e)=>{if(mode!=='edit')return;e.preventDefault();const dlt=e.deltaY||e.deltaX;if(e.shiftKey){ed.h+=dlt<0?0.5:-0.5;syncUI();audio.sfx('tick',{rate:dlt<0?1.15:0.87});}else ed.dist=Math.max(4,Math.min(180,ed.dist*(1+Math.sign(dlt)*0.1)));},{passive:false});

// ── Меню ──────────────────────────────────────────────────────
let sayT;
function say(t){$('status').textContent=t;clearTimeout(sayT);sayT=setTimeout(()=>($('status').textContent=''),4000);}
function warn(t){say(t);audio.sfx('error');}
function syncUI(){$('edw').value=ed.w;$('edd').value=ed.d;$('edrot').value=ed.rot;$('edtilt').value=ed.tilt;$('edk').value=ed.k;$('edh').value=ed.h;}
function syncLevelUI(){$('edreq').checked=!!L.req;$('edtheme').value=L.theme|0;}
function updateDrawUI(){const n=ed.draw.length;$('drawinfo').textContent=n?`Точек: ${n}. ${n<3?'Нужно минимум 3.':'Замкните: клик по первой точке или Enter.'}` : 'Кликайте точки контура. Форма без самопересечений.';$('btnDrawDone').disabled=n<3;$('btnDrawUndo').disabled=n<1;}
function setTool(t,quiet){if(!quiet&&t!==ed.tool)audio.sfx('tool');ed.tool=t;if(t!=='draw')ed.draw=[];$('drawbox').style.display=t==='draw'?'block':'none';updateDrawUI();document.querySelectorAll('#tools button').forEach((b)=>b.classList.toggle('on',b.dataset.tool===t));}
function addDrawPoint(){const pt=[ed.mx,ed.mz],n=ed.draw.length;if(n===0)ed.drawY=ed.h;if(n>=3&&Math.hypot(pt[0]-ed.draw[0][0],pt[1]-ed.draw[0][1])<Math.max(0.35,ed.step*0.75))return finishDraw();if(n>=40)return warn('Максимум 40 точек');if(!chainOk(ed.draw,pt))return warn('Линии не должны пересекаться');ed.draw.push(pt);audio.sfx('point',{rate:Math.min(1.7,1+ed.draw.length*0.04)});updateDrawUI();}
function undoDrawPoint(){if(ed.draw.length)audio.sfx('back');ed.draw.pop();updateDrawUI();}
function cancelDraw(){ed.draw=[];updateDrawUI();}
const r3=(x)=>Math.round(x*1000)/1000;
function finishDraw(){const pts=ed.draw;if(pts.length<3)return warn('Нужно минимум 3 точки');if(!isSimplePolygon(pts))return warn('Контур пересекает сам себя');if(L.shapes.length>=24)return warn('Максимум 24 своих формы');if(L.plats.length>=80)return warn('Максимум 80 платформ');const nz=normalizeShape(pts);if(nz.w<1||nz.d<1||nz.w>30||nz.d>30)return warn('Размер формы должен быть 1–30');pushHist();L.shapes.push(nz.poly);const idx=SHAPES.length+L.shapes.length-1;L.plats.push([r3(nz.cx),r3(ed.drawY),r3(nz.cz),r3(nz.w),r3(nz.d),idx,0,ed.tilt,ed.k]);ed.draw=[];ed.shape=idx;ed.w=r3(nz.w);ed.d=r3(nz.d);ed.rot=0;ed.dirty=true;edited();setTool('plat',true);syncUI();audio.sfx('done');say('Форма добавлена и сразу установлена!');}
function delShape(){const i=ed.shape-SHAPES.length;if(i<0)return warn('Встроенные формы удалить нельзя');if(L.plats.some((a)=>(a[5]??0)===ed.shape))return warn('Форма используется: сначала сотрите платформы с ней');pushHist();L.shapes.splice(i,1);L.plats.forEach((a)=>{if(a[5]>ed.shape)a[5]--;});ed.shape=0;ed.dirty=true;edited();}
function markShape(){document.querySelectorAll('#shapes button').forEach((b)=>b.classList.toggle('on',+b.dataset.shape===ed.shape));$('shapename').textContent=shapeDef(ed.shape).name;$('btnDelShape').disabled=ed.shape<SHAPES.length;}
function refreshShapeButtons(){const holder=$('shapes'),n=shapeCount();holder.textContent='';for(let i=0;i<n;i++){const b=document.createElement('button'),def=shapeDef(i);b.className='btn';b.dataset.shape=i;b.textContent=def.icon;b.title=def.name;b.onclick=()=>setShape(i);holder.append(b);}if(ed.shape>=n){ed.shape=0;ed.dirty=true;}markShape();}
function setShape(i){ed.shape=i;ed.dirty=true;setTool('plat',true);audio.sfx('tick',{rate:1+(i%9)*0.06});markShape();}
const TOOL_ICONS={plat:'▬',coin:'●',goal:'★',start:'⌂',erase:'✖',cp:'⚑',draw:'✎'};
TOOLS.forEach(([id,name],i)=>{const b=document.createElement('button');b.className='slot';b.dataset.tool=id;b.title=`${name} (${i+1})`;b.innerHTML=`<span class="n">${i+1}</span><span class="ic">${TOOL_ICONS[id]}</span><span class="nm">${name}</span>`;b.onclick=()=>setTool(id);$('tools').append(b);});

// ── Музыка и звук: старт при первом взаимодействии ────────────
let musicStarted=false,userGesture=false;
function startMusic(){if(!userGesture||musicStarted)return;musicStarted=true;music.play(musicPreset);}
const onGesture=()=>{audio.unlock();userGesture=true;startMusic();};
document.addEventListener('click',onGesture,{once:true});
document.addEventListener('keydown',onGesture,{once:true});
// Щелчок по любой кнопке меню/редактора (у кнопок инструментов и форм свои звуки)
document.addEventListener('click',(e)=>{const b=e.target.closest&&e.target.closest('button');if(!b||b.closest('#tools')||b.closest('#shapes'))return;audio.sfx(b.classList.contains('back')?'back':'ui');});

function showMenu(screen){
  menuOpen=!!screen; menuScreen=screen||'main';
  document.body.classList.toggle('menu',menuOpen);
  document.querySelectorAll('.screen').forEach((el)=>el.classList.toggle('on',!!screen&&el.id==='scr-'+screen));
  if(menuOpen){for(const k in keys)keys[k]=false;jumpBuf=0;}
  if(screen==='main')$('mPlay').textContent=introDone?'▶ Продолжить':'▶ Играть';
  if(screen==='work')loadWork();
  if(screen==='char')initCharPreview();
  // Музыка стартует при закрытии меню
  if(!screen)startMusic();
  if(screen&&input.device==='pad')input.menuFocusFirst();else input.clearFocus();
}
const toggleMenu=()=>showMenu(menuOpen?null:'main');

function setTab(t){
  if(t==='work')return showMenu('work');
  showMenu(null);
  const e=t==='edit';
  helpers.visible=marker.visible=e;
  outlines.forEach((o)=>(o.visible=e));
  if(!e){setHover(null);ed.over=false;cancelDraw();}
  dust.visible=!e;
  document.body.classList.toggle('editing',e);
  refreshHints(e);
  cv.style.cursor=e?'crosshair':'';
  if(e!==(mode==='edit')){
    mode=e?'edit':'play';audio.sfx(e?'editOn':'editOff');
    setFar(e?600:250); // расстояние тумана считает updateEnv (оно зависит ещё и от погоды)
    if(e){player.visible=shadow.visible=false;setGoalOpen(true);msg.style.display='none';$('ename').value=L.name;syncLevelUI();ed.tx=L.start[0];ed.tz=L.start[2];ed.h=L.start[1];ed.ty=ed.h;hist.length=0;syncUI();fitView();}
    else{player.visible=true;testRun=true;reset();}
  }
}
function play(lv){lv.shapes=lv.shapes||[];lv.cps=lv.cps||[];lv.theme=lv.theme|0;lv.req=!!lv.req;L=lv;buildLevel(L);hist.length=0;$('lvname').textContent=L.name;$('seed').value=L.seed??'';if(L.seed){$('seedStyle').value=L.style||'mix';$('seedDiff').value=L.diff||2;}syncLevelUI();const wasEdit=mode==='edit';setTab('play');testRun=false;if(!wasEdit)reset();}
async function copyLink(){const base=location.href.split('#')[0];const link=L.seed?`${base}#S=${encodeURIComponent(L.seed)}&T=${L.style||'mix'}&D=${L.diff||2}`:`${base}#L=${enc(L)}`;try{await navigator.clipboard.writeText(link);say('Ссылка скопирована');}catch{prompt('Скопируйте ссылку:',link);}}
const ghRepo=()=>({owner:location.hostname.endsWith('github.io')?location.hostname.split('.')[0]:'OWNER',repo:location.pathname.split('/')[1]||'REPO'});
async function loadWork(){const list=$('worklist'),{owner,repo}=ghRepo();list.textContent='Загрузка…';try{const res=await fetch(`https://api.github.com/repos/${owner}/${repo}/issues?labels=workshop&state=open&per_page=50`);if(!res.ok)throw new Error(res.status);const items=[];for(const it of await res.json()){if(it.pull_request)continue;const m=/```level\s+([\w-]+)\s+```/.exec(it.body||'');const lv=m&&dec(m[1]);if(lv)items.push({lv,author:it.user.login,likes:(it.reactions&&it.reactions['+1'])||0,url:it.html_url});}items.sort((a,b)=>b.likes-a.likes);list.textContent=items.length?'':'Пока пусто. Станьте первым!';for(const it of items){const row=document.createElement('div');row.className='item';const b=document.createElement('button');b.className='btn';b.textContent=`${it.lv.name} · ${it.author} · 👍${it.likes}`;b.onclick=()=>play(it.lv);const a=document.createElement('a');a.href=it.url;a.target='_blank';a.textContent='↗';row.append(b,a);list.append(row);}}catch{list.textContent='Не удалось загрузить Мастерскую (работает на GitHub Pages).';}}

$('mPlay').onclick=()=>{introDone=true;showMenu(null);};
$('mLevels').onclick=()=>showMenu('levels');
$('mEdit').onclick=()=>{introDone=true;setTab('edit');};
$('mWork').onclick=()=>showMenu('work');
$('mChar').onclick=()=>showMenu('char');
$('mSet').onclick=()=>showMenu('settings');
$('mCtl').onclick=()=>showMenu('controls');
document.querySelectorAll('.back').forEach((b)=>(b.onclick=()=>showMenu('main')));
document.querySelectorAll('.openmenu').forEach((b)=>(b.onclick=toggleMenu));
$('btnProps').onclick=()=>document.body.classList.toggle('noprops');
document.addEventListener('click',(e)=>{if(e.target.tagName==='BUTTON')e.target.blur();});
document.querySelectorAll('.link').forEach((b)=>(b.onclick=copyLink));
const genLevel=(seed)=>generate(seed,$('seedStyle').value,+$('seedDiff').value,THEMES.length);
$('btnSeed').onclick=()=>play(genLevel($('seed').value.trim()||'default'));
$('btnRand').onclick=()=>{const s=Math.random().toString(36).slice(2,8);$('seed').value=s;play(genLevel(s));};
$('btnClassic').onclick=()=>play(classic());
$('btnCode').onclick=()=>{const lv=dec($('code').value.trim());lv?play(lv):warn('Код не подходит');};
$('btnTest').onclick=()=>setTab('play');
$('btnNew').onclick=()=>{pushHist();L={name:'Мой уровень',plats:[[0,0,0,6,6]],coins:[],cps:[],shapes:[],req:false,theme:0,goal:[0,1.6,-8],start:[0,0,0]};buildLevel(L);setGoalOpen(true);$('ename').value=L.name;$('lvname').textContent=L.name;syncLevelUI();hist.length=0;ed.tx=0;ed.tz=0;ed.h=0;syncUI();fitView();};
$('btnWork').onclick=loadWork;
$('btnUndo').onclick=undo;
$('camTop').onclick=()=>{ed.pitch=1.5;};
$('camSide').onclick=()=>{ed.pitch=0.12;};
$('camFit').onclick=fitView;
$('btnDrawDone').onclick=finishDraw;
$('btnDrawUndo').onclick=undoDrawPoint;
$('btnDrawCancel').onclick=cancelDraw;
$('btnDelShape').onclick=delShape;
$('btnReset').onclick=()=>{if(!confirm('Сбросить все рекорды?'))return;save.best={};persist();};
$('btnSubmit').onclick=()=>{const{owner,repo}=ghRepo();const body=`Название: ${L.name}\n\n\`\`\`level\n${enc(L)}\n\`\`\`\n`;window.open(`https://github.com/${owner}/${repo}/issues/new?title=${encodeURIComponent('[Уровень] '+L.name)}&body=${encodeURIComponent(body)}`,'_blank');say('Нажмите Submit new issue на GitHub');};

// Музыка: выбор мелодии
MUSIC_NAMES.forEach((n,i)=>$('musicPreset').add(new Option(n,i)));
$('musicPreset').value=String(musicPreset);
$('musicPreset').onchange=(e)=>{musicPreset=+e.target.value;save.musicPreset=musicPreset;persist();if(musicStarted)music.play(musicPreset);e.target.blur();};

// Громкости: общая, музыка, эффекты, окружение, меню и редактор + «Старая консоль» (глухость звука).
// Ползунки идут от 0 до 100 %; при 100 % звук действительно на полную (запас громкости заложен в audio.js).
const SND_KEYS=['master','music','sfx','amb','ui','lofi'];
const SND_PREVIEW={sfx:'jump',amb:'chime',ui:'place'};
let sndPrevT=-9;
for(const k of SND_KEYS){
  const sl=$('snd_'+k),lab=$('snd_'+k+'_v');
  const show=()=>{lab.textContent=Math.round(audio.vol[k]*100)+'%';};
  sl.value=String(audio.vol[k]);show();
  sl.oninput=(e)=>{audio.unlock();audio.set(k,+e.target.value);show();persist();if(SND_PREVIEW[k]&&clockT-sndPrevT>0.25){sndPrevT=clockT;audio.preview(SND_PREVIEW[k]);}};
}
$('btnSndTest').onclick=()=>audio.demo();

const num=(id,lo,hi,fn)=>{$(id).oninput=(e)=>{const x=parseFloat(e.target.value);if(Number.isFinite(x)){fn(Math.max(lo,Math.min(hi,x)));ed.dirty=true;}};};
num('edw',1,30,(x)=>(ed.w=x));num('edd',1,30,(x)=>(ed.d=x));num('edrot',-720,720,(x)=>(ed.rot=x));
num('edtilt',-60,60,(x)=>(ed.tilt=x));num('edk',0.25,20,(x)=>(ed.k=x));num('edh',-300,300,(x)=>(ed.h=x));
$('edstep').onchange=(e)=>{ed.step=+e.target.value;e.target.blur();};
$('edsnap').onchange=(e)=>{ed.snap=e.target.checked;e.target.blur();};
$('edreq').onchange=(e)=>{L.req=e.target.checked;L.seed=null;L.id=null;L.style=null;e.target.blur();};
$('edtheme').onchange=(e)=>{L.theme=+e.target.value;edited();e.target.blur();};
$('ename').oninput=(e)=>{L.name=e.target.value.slice(0,40);$('lvname').textContent=L.name;};
for(const[k,n]of Object.entries(STYLES))$('seedStyle').add(new Option(n,k));
for(const[k,n]of Object.entries(DIFFS))$('seedDiff').add(new Option(n,k));
THEMES.forEach((t,i)=>$('edtheme').add(new Option(t.name,i)));
$('seedDiff').value=2;
$('qualitySel').value=QUALITY;
$('fpsSel').value=String(FPS_CAP);
$('fpsSel').onchange=(e)=>{FPS_CAP=+e.target.value;save.fps=FPS_CAP;persist();e.target.blur();};
$('qualitySel').onchange=(e)=>{save.quality=e.target.value;persist();if(save.quality===QUALITY)return;if(mode==='edit'&&!confirm('Страница перезагрузится. Уровень сохранится в ссылке. Продолжить?')){e.target.value=QUALITY;save.quality=QUALITY;persist();return;}location.hash=L.id==='classic'?'':L.seed?`S=${encodeURIComponent(L.seed)}&T=${L.style||'mix'}&D=${L.diff||2}`:`L=${enc(L)}`;location.reload();};
SKINS.forEach((sk,i)=>$('skinSel').add(new Option(sk.name,i)));
$('skinSel').add(new Option('Свои цвета','custom'));
{
  const ids={legs:'skLegs',shirt:'skShirt',head:'skHead',cap:'skCap',belt:'skBelt'};
  const readColors=()=>Object.fromEntries(SKIN_KEYS.map((k)=>[k,parseInt($(ids[k]).value.slice(1),16)]));
  for(const k of SKIN_KEYS)$(ids[k]).oninput=()=>customSkin(readColors());
  $('skinSel').onchange=(e)=>{const v=e.target.value;if(v==='custom')customSkin(save.skin&&save.skin.colors?save.skin.colors:Object.fromEntries(SKIN_KEYS.map((k)=>[k,skin[k]])));else chooseSkin(+v);e.target.blur();};
  $('btnSkinRand').onclick=()=>{const c=new THREE.Color(),h=Math.random(),col=(dh,sat,lig)=>{c.setHSL((h+dh)%1,sat,lig);return c.getHex();};customSkin({legs:col(0.5,0.6,0.35),shirt:col(0,0.75,0.5),head:col(0.08+Math.random()*0.02,0.6,0.78),cap:col(0.33,0.7,0.45),belt:col(0.16,0.5,0.3)});};
  const sv=save.skin;
  if(sv&&sv.id==='custom'&&sv.colors)chooseSkin('custom');
  else chooseSkin(sv&&Number.isInteger(sv.id)&&SKINS[sv.id]?sv.id:0);
}
function loadHash(){const h=location.hash.slice(1);if(h.startsWith('S=')){const q=new URLSearchParams(h);play(generate(q.get('S'),q.get('T')||'mix',+q.get('D')||2,THEMES.length));}else if(h.startsWith('L=')){const lv=dec(h.slice(2));if(lv)play(lv);else warn('Ссылка на уровень повреждена');}}
addEventListener('hashchange',loadHash);

// ── Геймпад: меню, редактор, служебные кнопки ─────────────────
function padActions(){
  if(pad.any){audio.unlock();userGesture=true;startMusic();music.resume();} // кнопка геймпада тоже считается «первым действием»
  if(menuOpen){
    if(pad.start)showMenu(null);
    else if(pad.cancel)showMenu(menuScreen==='main'?null:'main');
    return;
  }
  if(pad.start)return toggleMenu();
  if(mode==='play'){if(pad.back&&testRun)setTab('edit');}
}
// Редактор с геймпада: в центре экрана прицел, он заменяет курсор мыши
function padEdit(){
  mouse.set(0,0);ed.over=true;
  const tools=TOOLS.map((t)=>t[0]),n=tools.length;
  if(pad.nav==='left'||pad.nav==='right')setTool(tools[(tools.indexOf(ed.tool)+(pad.nav==='right'?1:-1)+n)%n]);
  else if(pad.nav==='up'){ed.h+=0.5;syncUI();audio.sfx('tick',{rate:1.15});}
  else if(pad.nav==='down'){ed.h-=0.5;syncUI();audio.sfx('tick',{rate:0.87});}
  if(pad.lb||pad.rb){const c=shapeCount();setShape((ed.shape+(pad.rb?1:-1)+c)%c);}
  if(pad.a)place();
  if(pad.x){if(ed.tool==='draw'&&ed.draw.length)undoDrawPoint();else erase();} // как ПКМ
  if(pad.b)undo();
  if(pad.y){if(ed.tool==='draw'&&ed.draw.length>=3)finishDraw();else{ed.rot=(ed.rot+15)%360;ed.dirty=true;syncUI();audio.sfx('tick',{rate:1.3});}}
  if(pad.r3)fitView();
  if(pad.back)$('btnTest').click();
}


// ── Окружение: время суток и погода ────────────────────────────
// Состояние плавно «догоняет» выбор игрока: n — ночь (0..1), w — дождь (0..1), wet — насколько мокрые платформы.
// Свет, туман, облака и звук считаются из n и w в каждом кадре, а картинка неба меняется на лету, пока кадр
// чуть притемнён (см. backgroundIntensity). Ждать пересчёта неба в игре не приходится: нужный вариант
// рисуется заранее, в момент выбора в настройках.
const TIMES = { day: 'День', night: 'Ночь' }, WEATHERS = { clear: 'Ясно', rain: 'Дождь' };
const LOOK = {
  day:       { fog: 0xb0d8ff, amb: 0xffffff, ambK: 0.30, sun: 0xffffff, sunK: 1.30, cloud: 0xffffff, cloudEm: 0x7388b0, dust: 0xeeeae2, fogK: 1 },
  night:     { fog: 0x0b1530, amb: 0x7087d6, ambK: 0.50, sun: 0xaec4ff, sunK: 0.95, cloud: 0x7a88b8, cloudEm: 0x10172c, dust: 0x6d7698, fogK: 1 },
  rain:      { fog: 0x8f9aa7, amb: 0xdde4ec, ambK: 0.42, sun: 0xdfe6ee, sunK: 0.50, cloud: 0x9aa3ae, cloudEm: 0x49515c, dust: 0xb9bec6, fogK: 0.7 },
  nightRain: { fog: 0x0c1220, amb: 0x6a7aa6, ambK: 0.44, sun: 0x93a4d0, sunK: 0.50, cloud: 0x3a4153, cloudEm: 0x0a0e18, dust: 0x50586f, fogK: 0.6 },
};
const SUN_POS = new THREE.Vector3(5, 10, 6), MOON_POS = new THREE.Vector3(MOON[0], MOON[1], MOON[2]).multiplyScalar(12.5);
const env = { time: TIME, weather: WEATHER, n: TIME === 'night' ? 1 : 0, w: WEATHER === 'rain' ? 1 : 0, wet: WEATHER === 'rain' ? 1 : 0, wetApplied: -1, key: skyKey(TIME === 'night', WEATHER === 'rain'), ns: 0, ws: 0 };
const eA = new THREE.Color(), eB = new THREE.Color(), cloudCol = new THREE.Color(), cloudEm = new THREE.Color();
const smooth = (x) => x * x * (3 - 2 * x);
const approach = (x, to, d) => (x < to ? Math.min(to, x + d) : Math.max(to, x - d));
// Цвет «угла» таблицы LOOK -> out с учётом ночи (nn) и дождя (ww)
function blendColor(out, prop, nn, ww) {
  out.set(LOOK.day[prop]).lerp(eB.set(LOOK.night[prop]), nn);
  eA.set(LOOK.rain[prop]).lerp(eB.set(LOOK.nightRain[prop]), nn);
  return out.lerp(eA, ww);
}
function blendNum(prop, nn, ww) {
  const a = LOOK.day[prop] + (LOOK.night[prop] - LOOK.day[prop]) * nn, b = LOOK.rain[prop] + (LOOK.nightRain[prop] - LOOK.rain[prop]) * nn;
  return a + (b - a) * ww;
}
function setEnvMaps() {
  if (!HIGH) return;
  glossMats.forEach((m) => { m.envMap = envTex; });
  platMeshes.forEach((m) => { m.material.envMap = envTex; });
}
function updateEnv(dt) {
  if (!menuOpen) { // пока открыто меню, ничего не меняется: смену видно после закрытия
    env.n = approach(env.n, env.time === 'night' ? 1 : 0, dt / 1.8);
    env.w = approach(env.w, env.weather === 'rain' ? 1 : 0, dt / 2.6);
    env.wet = approach(env.wet, env.w > 0.55 ? 1 : 0, env.w > 0.55 ? dt / 5 : dt / 16); // мокнет за ~5 с, сохнет ~16 с
  }
  const nn = env.ns = smooth(env.n), ww = env.ws = smooth(env.w);
  // картинка неба и карта отражений меняются, когда переход пройдёт середину
  const night = env.n > 0.5, rainy = env.w > 0.5, key = skyKey(night, rainy);
  if (key !== env.key) {
    env.key = key; scene.background = skyTex(night, rainy);
    if (HIGH) { envTex = envFor(night, rainy); setEnvMaps(); }
  }
  const mid = (x) => Math.min(1, Math.abs(x - 0.5) * 3.2);
  scene.backgroundIntensity = 0.1 + 0.9 * Math.min(mid(env.n), mid(env.w)); // в момент смены неба кадр на миг темнеет
  blendColor(scene.fog.color, 'fog', nn, ww);
  const fk = blendNum('fogK', nn, ww), edit = mode === 'edit';
  scene.fog.near = (edit ? 80 : 24) * fk; scene.fog.far = (edit ? 420 : 150) * fk;
  blendColor(ambient.color, 'amb', nn, ww); ambient.intensity = blendNum('ambK', nn, ww);
  blendColor(sun.color, 'sun', nn, ww); sun.intensity = blendNum('sunK', nn, ww);
  sun.position.lerpVectors(SUN_POS, MOON_POS, nn);
  clouds.setLook(blendColor(cloudCol, 'cloud', nn, ww), blendColor(cloudEm, 'cloudEm', nn, ww));
  blendColor(dust.material.color, 'dust', nn, ww);
  if (Math.abs(env.wet - env.wetApplied) > 0.004) { env.wetApplied = env.wet; platMeshes.forEach((m) => applyWet(m.material)); }
}
// Выбор в настройках. Нужное небо рисуем сразу (за меню этого не видно), игра потом лишь плавно переходит.
function setEnv(time, weather) {
  if (time) env.time = save.time = time;
  if (weather) env.weather = save.weather = weather;
  persist();
  const night = env.time === 'night', rainy = env.weather === 'rain';
  setTimeout(() => { skyTex(night, rainy); if (HIGH) envFor(night, rainy); }, 0);
  music.setEnv(night, rainy);
}

// ── Главный цикл ──────────────────────────────────────────────
const clock=new THREE.Clock();
let frameAcc=0;
function loop(){
  requestAnimationFrame(loop);
  frameAcc+=clock.getDelta();
  if(FPS_CAP&&frameAcc<(1/FPS_CAP)*0.9)return;
  const dt=Math.min(frameAcc,0.05); frameAcc=0; clockT+=dt;
  pad=input.poll(dt,{menuOpen});
  padActions();
  // Геймпад двигает рамку по меню: тихий «тик» на каждый переход
  if(menuOpen&&input.device==='pad'){const c=input._cur;if(c!==padFocusEl){padFocusEl=c;if(c)audio.sfx('move');}}else padFocusEl=null;
  if(!menuOpen){if(mode==='play')update(dt);else updateEdit(dt);}
  if(menuOpen&&menuScreen==='char')renderPreview(dt);
  // Окружение: ветер крепчает на высоте и в падении; в меню тише
  const live=mode==='play'&&!menuOpen;
  updateEnv(dt);
  gulls.update(dt,clockT,p,mode==='play'?env.ns:0); // чайки-фонарики: только ночью и в игре
  rain.update(dt,p,parts,mode==='play'?env.ws:0); // в редакторе камера далеко, дождь там не рисуем (платформы при этом мокрые)
  audio.update(dt,{level:menuOpen?0.45:(mode==='edit'?0.7:1),height:mode==='play'?p.y:camera.position.y,speed:live?Math.hypot(v.x,v.z):0,fall:live?Math.max(0,-v.y):0,rain:env.ws,night:env.ns});
  clouds.update(dt,clockT,camera.position);
  if(composer)composer.render();else renderer.render(scene,camera);
}

// Время суток и погода
for(const[k,n]of Object.entries(TIMES))$('timeSel').add(new Option(n,k));
for(const[k,n]of Object.entries(WEATHERS))$('weatherSel').add(new Option(n,k));
$('timeSel').value=env.time;$('weatherSel').value=env.weather;
$('timeSel').onchange=(e)=>{setEnv(e.target.value,null);e.target.blur();};
$('weatherSel').onchange=(e)=>{setEnv(null,e.target.value);e.target.blur();};
music.setEnv(env.time==='night',env.weather==='rain');
setTool('plat'); syncUI();
input.onChange(()=>refreshHints());
input.onPadEvent((name,on)=>toast(on?`${name} подключён`:`${name} отключён`));
play(classic());
loadHash();
update(1e-4);
showMenu('main');
refreshHints();
loop();
