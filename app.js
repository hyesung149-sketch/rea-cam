/* REA Cam — 개인용 실시간 뷰티 카메라 (클린룸 구현)
 * 카메라/사진 → WebGL 셰이더(얼굴 변형 · 피부 보정 · 메이크업 · 필터 · 편집) → JPEG
 * 얼굴 인식: MediaPipe Face Landmarker (온디바이스, 사진은 어디로도 전송되지 않음)
 */
const $ = (id) => document.getElementById(id);
function toast(t, ms = 2200) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (el.hidden = true), ms); }
addEventListener('error', (e) => toast('오류: ' + (e.message || e.error), 6000));
addEventListener('unhandledrejection', (e) => toast('오류: ' + ((e.reason && e.reason.message) || e.reason), 6000));

/* ───── 설정값 ───── */
const SLIDERS = {
  filter: [['intensity', '필터 강도', 0, 100, 80]],
  beauty: [['smooth', '피부 보정', 0, 100, 45], ['bright', '화사하게', 0, 100, 25], ['tone', '피부톤', -50, 50, 10, 50], ['sharp', '선명하게', 0, 100, 20]],
  face:   [['eye', '눈 크게', 0, 100, 30], ['slim', '갸름하게', 0, 100, 35]],
  makeup: [['lipAmt', '립 강도', 0, 100, 55], ['blushAmt', '블러셔', 0, 100, 35]],
  edit:   [['eBright', '밝기', -50, 50, 0, 50], ['eCon', '대비', -50, 50, 0, 50], ['eSat', '채도', -50, 50, 0, 50],
           ['eTemp', '색온도', -50, 50, 0, 50], ['eVig', '비네팅', 0, 100, 0], ['eGrain', '그레인', 0, 100, 0]],
};
const LIPS = [['없음', null], ['코랄', [1.0, 0.45, 0.38]], ['로즈', [0.9, 0.32, 0.45]], ['레드', [0.85, 0.12, 0.18]], ['누드', [0.85, 0.55, 0.48]], ['플럼', [0.6, 0.2, 0.35]]];
const BLUSH = [['없음', null], ['피치', [1.0, 0.84, 0.78]], ['핑크', [1.0, 0.8, 0.86]], ['코랄', [1.0, 0.76, 0.7]]];
const ID = { expo: 1, con: 1, sat: 1, warm: 0, tint: [1, 1, 1], fade: 0, vig: 0, grain: 0, mono: 0 };
const FILTERS = [
  { name: '원본' },
  { name: '내추럴', expo: 1.03, con: 1.03, sat: 1.05, warm: 0.1 },
  { name: '밀크',   expo: 1.08, con: 0.92, sat: 0.85, fade: 0.5, tint: [1.0, 0.99, 0.98] },
  { name: '피치',   expo: 1.05, sat: 0.95, warm: 0.25, fade: 0.2, tint: [1.04, 0.97, 0.97] },
  { name: '크림',   expo: 1.06, sat: 0.9, fade: 0.3, tint: [1.03, 1.01, 0.94] },
  { name: '클리어', expo: 1.02, con: 1.08, sat: 1.12, warm: -0.1 },
  { name: '쿨',     con: 1.05, warm: -0.35, tint: [0.97, 1.0, 1.04] },
  { name: '선셋',   con: 1.05, sat: 1.15, warm: 0.5, tint: [1.06, 0.98, 0.92] },
  { name: '필름',   con: 1.1, sat: 0.9, warm: 0.1, fade: 0.45, grain: 0.6, vig: 0.35, tint: [1.02, 1.0, 0.95] },
  { name: '빈티지', sat: 0.7, warm: 0.4, fade: 0.5, grain: 0.5, vig: 0.5, tint: [1.05, 1.0, 0.88] },
  { name: '무드',   expo: 0.94, con: 1.12, sat: 0.85, warm: -0.15, fade: 0.2, vig: 0.4 },
  { name: '모노',   con: 1.15, mono: 1 },
].map((f) => ({ ...ID, ...f }));
// 눈 위치만 알 때 쓰는 평균 얼굴 비율 (입술 중심·반지름, 양 볼)
const FEAT0 = { mc: [0, 1.08], mr: [0.44, 0.22], c1: [-0.62, 0.72], c2: [0.62, 0.72] };
const RATIOS = [{ k: '3:4', r: 3 / 4 }, { k: '1:1', r: 1 }, { k: '9:16', r: 9 / 16 }, { k: '원본', r: 0 }];
const TIMERS = [0, 3, 10];

const DEF = { ratioIdx: 0, filterIdx: 1, lipIdx: 0, blushIdx: 0, timerIdx: 0 };
for (const list of Object.values(SLIDERS)) for (const [k, , , , d, sc = 100] of list) DEF[k] = d / sc;
const KEEP = Object.keys(DEF);
const S = { ...DEF, source: 'none', facing: 'user', mirror: true, showOrig: false, img: null,
  eyes: [], manual: false, picking: false, busy: false };
try { const s = JSON.parse(localStorage.getItem('rea-cam-settings') || '{}'); for (const k of KEEP) if (typeof s[k] === 'number') S[k] = s[k]; } catch {}
let saveT = 0;
function remember() { clearTimeout(saveT); saveT = setTimeout(() => { try { const o = {}; for (const k of KEEP) o[k] = S[k]; localStorage.setItem('rea-cam-settings', JSON.stringify(o)); } catch {} }, 300); }

/* ───── UI (엔진보다 먼저 연결) ───── */
const sliderEls = {};
for (const [tab, list] of Object.entries(SLIDERS)) {
  for (const [k, label, min, max, , sc = 100] of list) {
    const lab = document.createElement('label'); lab.className = 'slider';
    lab.innerHTML = `<span>${label}</span><input id="s-${k}" type="range" min="${min}" max="${max}"><b></b>`;
    const inp = lab.querySelector('input'), out = lab.querySelector('b');
    inp.oninput = () => { S[k] = inp.value / sc; out.textContent = inp.value; remember(); render(); };
    sliderEls[k] = { inp, out, sc };
    $('sl-' + tab).appendChild(lab);
  }
}
function syncSliders() { for (const [k, { inp, out, sc }] of Object.entries(sliderEls)) { inp.value = Math.round(S[k] * sc); out.textContent = inp.value; } }

function swatch(f) {
  const ap = (c) => {
    let x = c.map((v) => (v * f.expo - 0.5) * f.con + 0.5);
    let l = x[0] * .299 + x[1] * .587 + x[2] * .114; x = x.map((v) => l + (v - l) * f.sat);
    x = [x[0] + f.warm * .06, x[1], x[2] - f.warm * .06].map((v, i) => v * f.tint[i]);
    l = x[0] * .299 + x[1] * .587 + x[2] * .114; x = x.map((v) => v + (l - v) * f.mono).map((v) => f.fade * .12 + v * (1 - f.fade * .15));
    return `rgb(${x.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;
  };
  return `linear-gradient(160deg, ${ap([.55, .72, .9])}, ${ap([.95, .78, .68])} 55%, ${ap([.35, .25, .22])})`;
}
const fBox = $('filterList');
FILTERS.forEach((f, i) => {
  const b = document.createElement('button'); b.className = 'f';
  b.innerHTML = `<i style="background:${swatch(f)}"></i>${f.name}`;
  b.onclick = () => { S.filterIdx = i; syncChoices(); remember(); render(); };
  fBox.appendChild(b);
});
function swatchRow(host, list, key) {
  list.forEach(([name, col], i) => {
    const b = document.createElement('button'); b.title = name; b.className = 'sw' + (col ? '' : ' none');
    if (col) b.style.background = `rgb(${col.map((v) => Math.round(v * 255)).join(',')})`; else b.textContent = '✕';
    b.onclick = () => { S[key] = i; syncChoices(); remember(); render(); };
    host.appendChild(b);
  });
}
swatchRow($('lipList'), LIPS, 'lipIdx');
swatchRow($('blushList'), BLUSH, 'blushIdx');
function syncChoices() {
  fBox.querySelectorAll('.f').forEach((x, j) => x.classList.toggle('on', j === S.filterIdx));
  $('lipList').querySelectorAll('.sw').forEach((x, j) => x.classList.toggle('on', j === S.lipIdx));
  $('blushList').querySelectorAll('.sw').forEach((x, j) => x.classList.toggle('on', j === S.blushIdx));
  $('btnRatio').textContent = RATIOS[S.ratioIdx].k;
  const t = TIMERS[S.timerIdx]; $('btnTimer').textContent = t ? `⏱ ${t}초` : '⏱ 끔'; $('btnTimer').classList.toggle('on', !!t);
  $('btnMirror').classList.toggle('on', S.mirror);
}
syncSliders(); syncChoices();

let curTab = 'filter';
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => {
  curTab = t.dataset.tab;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t));
  for (const n of Object.keys(SLIDERS)) $('tab-' + n).hidden = n !== curTab;
  if (curTab !== 'face') setPicking(false);
  placeDots();
}));
$('btnRatio').onclick = () => { S.ratioIdx = (S.ratioIdx + 1) % RATIOS.length; syncChoices(); remember(); render(); };
$('btnTimer').onclick = () => { S.timerIdx = (S.timerIdx + 1) % TIMERS.length; syncChoices(); remember(); };
$('btnMirror').onclick = () => { S.mirror = !S.mirror; syncChoices(); render(); };
$('btnReset').onclick = () => { for (const k of KEEP) if (k !== 'ratioIdx' && k !== 'timerIdx') S[k] = DEF[k]; syncSliders(); syncChoices(); remember(); render(); toast('보정 값을 기본으로 되돌렸어요'); };
for (const id of ['camIn', 'albumIn']) $(id).addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
$('btnShutter').onclick = () => (S.source === 'image' ? savePhoto() : shoot());
$('btnFlip').onclick = () => {
  if (S.source === 'image') { startCamera(); return; }
  S.facing = S.facing === 'user' ? 'environment' : 'user'; startCamera();
};
$('eRetry').onclick = () => startCamera();
addEventListener('keydown', (e) => { if (e.code === 'Space' && $('gallery').hidden && $('viewer').hidden) { e.preventDefault(); $('btnShutter').click(); } });

const cmp = $('compare');
const hold = (v) => (e) => { e.preventDefault(); e.stopPropagation(); S.showOrig = v; render(); };
cmp.addEventListener('pointerdown', hold(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) cmp.addEventListener(ev, hold(false));

function setMode(src) {
  S.source = src;
  const live = src === 'camera', img = src === 'image';
  $('empty').hidden = live || img; $('frame').hidden = !(live || img);
  $('btnShutter').classList.toggle('save', img);
  $('btnShutter').firstElementChild.textContent = img ? '✓' : '';
  $('btnShutter').title = img ? '저장' : '촬영';
  $('btnFlip').textContent = img ? '📷' : '⟲'; $('btnFlip').title = img ? '카메라로 돌아가기' : '카메라 전환';
  $('btnPick').hidden = !img;
  if (!img) { S.manual = false; setPicking(false); }
  lastKey = ''; fitFrame(); updateFaceState(); render();
}

/* ───── 얼굴: 직접 지정 (사진 모드) ───── */
function setPicking(on) {
  S.picking = on && S.source === 'image';
  $('pickHint').hidden = !S.picking;
  if (S.picking) { S.eyes = []; $('pickHint').textContent = '사진에서 한쪽 눈을 탭하세요 (1/2)'; render(); }
  $('btnPick').textContent = S.picking ? '취소' : '👀 직접 지정';
  placeDots();
}
$('btnPick').onclick = () => setPicking(!S.picking);
$('frame').addEventListener('pointerup', (e) => {
  if (!S.picking || e.target === cmp) return;
  const r = canvas.getBoundingClientRect();
  const cx = (e.clientX - r.left) / r.width, cy = (e.clientY - r.top) / r.height;
  if (cx < 0 || cx > 1 || cy < 0 || cy > 1) return;
  S.eyes.push(screenToTex(cx, cy));
  if (S.eyes.length === 1) $('pickHint').textContent = '다른 쪽 눈을 탭하세요 (2/2)';
  else { S.eyes = sortEyes(S.eyes); S.feat = FEAT0; S.manual = true; setPicking(false); updateFaceState(); toast('얼굴 보정과 메이크업이 켜졌어요'); }
  placeDots(); render();
});
function updateFaceState() {
  const ok = S.eyes.length === 2;
  let t;
  if (FACE.state === 'loading') t = '자동 얼굴 인식을 불러오는 중…';
  else if (FACE.state === 'failed') t = '자동 인식을 쓸 수 없어요' + (S.source === 'image' ? ' · 직접 지정하세요' : '');
  else t = ok ? (S.manual ? '직접 지정한 얼굴에 적용 중' : '얼굴 자동 인식됨 ✓') : '얼굴을 찾는 중…';
  $('faceState').textContent = t;
  const b = $('badge'); b.hidden = !(S.source !== 'none' && FACE.state === 'ready');
  b.textContent = ok ? '● 얼굴 인식' : '○ 얼굴 없음';
}
function sortEyes(e) { return e[0][0] <= e[1][0] ? e : [e[1], e[0]]; }

/* ───── 갤러리 (이 기기 브라우저에만 보관) ───── */
const DB = (() => {
  let db = null; const mem = [];
  const ready = new Promise((res) => { try {
    const rq = indexedDB.open('rea-cam', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('photos', { keyPath: 'id' });
    rq.onsuccess = () => { db = rq.result; res(); }; rq.onerror = () => res(); rq.onblocked = () => res();
    setTimeout(res, 2000);
  } catch { res(); } });
  const st = (m) => db.transaction('photos', m).objectStore('photos');
  const p = (rq) => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
  return {
    async add(x) { await ready; if (db) { try { return await p(st('readwrite').put(x)); } catch {} } mem.push(x); },
    async all() { await ready; let l = []; if (db) { try { l = await p(st('readonly').getAll()); } catch {} } return [...l, ...mem].sort((a, b) => b.id - a.id); },
    async del(id) { await ready; if (db) { try { await p(st('readwrite').delete(id)); } catch {} } const i = mem.findIndex((x) => x.id === id); if (i >= 0) mem.splice(i, 1); },
    async clear() { await ready; if (db) { try { await p(st('readwrite').clear()); } catch {} } mem.length = 0; },
  };
})();
const urls = new Map();
const urlOf = (x) => { if (!urls.has(x.id)) urls.set(x.id, URL.createObjectURL(x.blob)); return urls.get(x.id); };
let current = null;
async function refreshThumb() { const l = await DB.all(); $('btnGallery').style.backgroundImage = l[0] ? `url(${urlOf(l[0])})` : ''; }
async function openGallery() {
  const l = await DB.all(), g = $('gGrid'); g.innerHTML = ''; $('gCount').textContent = `${l.length}장`;
  if (!l.length) g.innerHTML = '<div class="none">아직 찍은 사진이 없어요</div>';
  for (const x of l) { const i = new Image(); i.src = urlOf(x); i.alt = x.name; i.onclick = () => { current = x; $('vImg').src = urlOf(x); $('viewer').hidden = false; }; g.appendChild(i); }
  $('gallery').hidden = false;
}
function ask(msg) {
  return new Promise((res) => {
    $('askMsg').textContent = msg; $('ask').hidden = false;
    const done = (v) => { $('ask').hidden = true; $('askYes').onclick = $('askNo').onclick = null; res(v); };
    $('askYes').onclick = () => done(true); $('askNo').onclick = () => done(false);
  });
}
function download(p) { const a = document.createElement('a'); a.href = urlOf(p); a.download = p.name; document.body.appendChild(a); a.click(); a.remove(); }
async function share(p) {
  const f = new File([p.blob], p.name, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [f] })) { try { await navigator.share({ files: [f] }); } catch {} }
  else download(p);
}
$('btnGallery').onclick = openGallery;
$('gClose').onclick = () => ($('gallery').hidden = true);
$('gClear').onclick = async () => { if (await ask('갤러리 사진을 모두 삭제할까요?')) { await DB.clear(); openGallery(); refreshThumb(); } };
$('vBack').onclick = () => ($('viewer').hidden = true);
$('vSave').onclick = () => current && download(current);
$('vShare').onclick = () => current && share(current);
$('vDel').onclick = async () => { if (current && await ask('이 사진을 삭제할까요?')) { await DB.del(current.id); $('viewer').hidden = true; openGallery(); refreshThumb(); } };
const stamp = () => { const d = new Date(), z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`; };

/* ───── WebGL 엔진 ───── */
const VS = 'attribute vec2 p; varying vec2 v; void main(){ v = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }';
const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v;
uniform sampler2D u_t;
uniform vec2 u_px, u_size, u_scale, u_off, u_e1, u_e2, u_mc, u_mr, u_c1, u_c2;
uniform float u_mirror, u_rad, u_smooth, u_bright, u_tone, u_sharp, u_inten, u_seed;
uniform float u_face, u_eye, u_slim, u_lipAmt, u_blushAmt;
uniform vec3 u_lip, u_blush;
uniform float u_expo, u_con, u_sat, u_warm, u_fade, u_vig, u_grain, u_mono;
uniform vec3 u_tint;
uniform float u_eb, u_ec, u_es, u_et, u_ev, u_eg;
const vec3 LUM = vec3(0.299, 0.587, 0.114);

float skinMask(vec3 c){
  float y = dot(c, LUM);
  vec2 cbcr = vec2((c.b - y)*0.564 + 0.5, (c.r - y)*0.713 + 0.5);
  float d = length((cbcr - vec2(0.41, 0.60)) / vec2(0.09, 0.075));
  return (1.0 - smoothstep(0.7, 1.3, d)) * smoothstep(0.12, 0.28, y);
}
vec2 toFace(vec2 uv, out vec2 c, out vec2 ex, out vec2 ey, out float d){
  vec2 P = uv * u_size; c = (u_e1 + u_e2) * 0.5; vec2 dv = u_e2 - u_e1;
  d = max(length(dv), 1.0); ex = dv / d; ey = vec2(ex.y, -ex.x);
  return vec2(dot(P - c, ex), dot(P - c, ey)) / d;
}
vec2 warp(vec2 uv){
  if (u_face < 0.5) return uv;
  vec2 c, ex, ey; float d;
  vec2 L = toFace(uv, c, ex, ey, d);
  for (int k = 0; k < 2; k++) {
    vec2 E = vec2(k == 0 ? -0.5 : 0.5, 0.0);
    vec2 D = L - E; float t = dot(D, D) / 0.18;
    if (t < 1.0) { float s = 1.0 - u_eye * 0.38 * (1.0 - t) * (1.0 - t); L = E + D * s; }
  }
  float wy = smoothstep(0.15, 0.8, L.y) * (1.0 - smoothstep(1.45, 1.95, L.y));
  float wx = 1.0 - smoothstep(0.7, 1.5, abs(L.x));
  L.x *= 1.0 + u_slim * 0.16 * wy * wx;
  return (c + (L.x * ex + L.y * ey) * d) / u_size;
}
float noise(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5; }

void main(){
  vec2 q = v;
  if (u_mirror > 0.5) q.x = 1.0 - q.x;
  vec2 uv = warp(u_off + q * u_scale);
  vec3 c = texture2D(u_t, uv).rgb;
  float m = skinMask(c);
  vec3 col = c;
  if (u_smooth > 0.001) {
    vec3 sum = c; float ws = 1.0;
    for (int i = 0; i < 24; i++) {
      float fi = float(i);
      float a = fi * 2.39996;
      float r = sqrt((fi + 0.5) / 24.0) * u_rad;
      vec3 s = texture2D(u_t, uv + vec2(cos(a), sin(a)) * r * u_px).rgb;
      vec3 dd = s - c;
      float w = exp(-dot(dd, dd) * 90.0);
      sum += s * w; ws += w;
    }
    col = mix(c, sum / ws, u_smooth * m * 0.95);
  }
  if (u_sharp > 0.001) {
    vec3 n = texture2D(u_t, uv + vec2(u_px.x, 0.0)).rgb + texture2D(u_t, uv - vec2(u_px.x, 0.0)).rgb
           + texture2D(u_t, uv + vec2(0.0, u_px.y)).rgb + texture2D(u_t, uv - vec2(0.0, u_px.y)).rgb;
    col += (c - n * 0.25) * u_sharp * 1.6 * (1.0 - 0.8 * m);
  }
  col = pow(max(col, 0.0), vec3(1.0 - u_bright * 0.28));
  col += m * u_bright * 0.04;
  vec3 pinkTone = vec3(0.05, -0.012, 0.03), tanTone = vec3(0.03, 0.008, -0.05);
  col += m * (u_tone > 0.0 ? pinkTone * u_tone : tanTone * (-u_tone));
  if (u_face > 0.5) {
    vec2 fc, fx, fy; float fd;
    vec2 L = toFace(uv, fc, fx, fy, fd);
    if (u_lipAmt > 0.001) {
      float area = 1.0 - smoothstep(0.6, 1.0, length((L - u_mc) / u_mr));
      float lipness = 1.0 - smoothstep(0.7, 0.86, c.g / max(c.r, 0.01));
      vec3 target = u_lip * (dot(col, LUM) * 1.9 + 0.06);
      col = mix(col, target, clamp(area * lipness * u_lipAmt * 0.7, 0.0, 1.0));
    }
    if (u_blushAmt > 0.001) {
      float b1 = 1.0 - smoothstep(0.0, 1.0, length((L - u_c1) / 0.36));
      float b2 = 1.0 - smoothstep(0.0, 1.0, length((L - u_c2) / 0.36));
      col = mix(col, col * u_blush, clamp((b1 + b2) * m * u_blushAmt * 0.6, 0.0, 1.0));
    }
  }
  vec3 f = col * u_expo;
  f = (f - 0.5) * u_con + 0.5;
  float l = dot(f, LUM);
  f = mix(vec3(l), f, u_sat);
  f += u_warm * vec3(0.06, 0.0, -0.06);
  f *= u_tint;
  f = mix(f, vec3(dot(f, LUM)), u_mono);
  f = u_fade * 0.12 + f * (1.0 - u_fade * 0.15);
  f *= 1.0 - u_vig * smoothstep(0.35, 0.85, distance(v, vec2(0.5)));
  float nz = noise(v * 1000.0 + u_seed);
  f += nz * u_grain * 0.08;
  col = mix(col, f, u_inten);
  col *= 1.0 + u_eb * 0.35;
  col = (col - 0.5) * (1.0 + u_ec * 0.5) + 0.5;
  float l2 = dot(col, LUM);
  col = mix(vec3(l2), col, 1.0 + u_es);
  col += u_et * vec3(0.07, 0.0, -0.07);
  col *= 1.0 - u_ev * 0.6 * smoothstep(0.3, 0.85, distance(v, vec2(0.5)));
  col += nz * u_eg * 0.1;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const canvas = $('view');
const video = document.createElement('video');
video.playsInline = true; video.muted = true; video.autoplay = true;
video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
let gl = null, U = {}, tex = null, glError = '', stream = null;
const seed = Math.random() * 100;
try {
  gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false }) || canvas.getContext('experimental-webgl', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL을 쓸 수 없는 브라우저예요');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('셰이더: ' + gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('링크: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const pLoc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(pLoc); gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(prog, i); U[info.name] = gl.getUniformLocation(prog, info.name); }
} catch (e) { gl = null; glError = e.message || String(e); }
const u1 = (n, x) => U[n] && gl.uniform1f(U[n], x), u2 = (n, a, b) => U[n] && gl.uniform2f(U[n], a, b), u3 = (n, a) => U[n] && gl.uniform3fv(U[n], a);

function srcEl() { return S.source === 'image' ? S.img : video; }
function srcWH() { const e = srcEl(); return S.source === 'image' ? [e.width, e.height] : [video.videoWidth, video.videoHeight]; }
function crop() {
  const [w, h] = srcWH(), sa = w / h, tr = RATIOS[S.ratioIdx].r || sa;
  let sx = 1, sy = 1; if (sa > tr) sx = tr / sa; else sy = sa / tr;
  return { w, h, sx, sy };
}
function screenToTex(cx, cy) {
  const c = crop(); let qx = cx; const qy = 1 - cy; if (S.mirror) qx = 1 - qx;
  return [((1 - c.sx) / 2 + qx * c.sx) * c.w, ((1 - c.sy) / 2 + qy * c.sy) * c.h];
}
function texToScreen(p) {
  const c = crop(); let qx = (p[0] / c.w - (1 - c.sx) / 2) / c.sx; const qy = (p[1] / c.h - (1 - c.sy) / 2) / c.sy;
  if (S.mirror) qx = 1 - qx; return [qx, 1 - qy];
}
function placeDots() {
  const host = $('dots'); host.innerHTML = '';
  if (S.source !== 'image' || !(curTab === 'face' || S.picking)) return;
  for (const p of S.eyes) {
    const [x, y] = texToScreen(p); if (x < 0 || x > 1 || y < 0 || y > 1) continue;
    const d = document.createElement('div'); d.className = 'dot'; d.style.left = x * 100 + '%'; d.style.top = y * 100 + '%'; host.appendChild(d);
  }
}

let lastKey = '';
function layout() {
  const c = crop();
  let ow = Math.round(c.w * c.sx), oh = Math.round(c.h * c.sy);
  const key = ow + 'x' + oh;
  if (key !== lastKey) { canvas.width = ow; canvas.height = oh; lastKey = key; fitFrame(); }
  return { ...c, ow, oh };
}
function fitFrame() {
  if (!canvas.width || $('frame').hidden) return;
  const st = $('stage'), ar = canvas.width / canvas.height, W = st.clientWidth - 16, H = st.clientHeight;
  let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
  $('frame').style.width = w + 'px'; $('frame').style.height = h + 'px';
}
if (window.ResizeObserver) new ResizeObserver(fitFrame).observe($('stage')); else addEventListener('resize', fitFrame);

function draw() {
  const [w, h] = srcWH(); if (!w || !h) return false;
  const L = layout(), o = S.showOrig, f = o ? FILTERS[0] : FILTERS[S.filterIdx], face = !o && S.eyes.length === 2;
  const lip = LIPS[S.lipIdx][1], blush = BLUSH[S.blushIdx][1];
  gl.viewport(0, 0, L.ow, L.oh);
  if (U.u_t) gl.uniform1i(U.u_t, 0);
  u2('u_px', 1 / L.w, 1 / L.h); u2('u_size', L.w, L.h);
  u2('u_scale', L.sx, L.sy); u2('u_off', (1 - L.sx) / 2, (1 - L.sy) / 2);
  u1('u_mirror', S.mirror ? 1 : 0);
  u1('u_rad', Math.max(2, Math.min(L.w, L.h) / 90));
  u1('u_smooth', o ? 0 : S.smooth); u1('u_bright', o ? 0 : S.bright); u1('u_tone', o ? 0 : S.tone); u1('u_sharp', o ? 0 : S.sharp);
  u1('u_inten', o ? 0 : S.intensity); u1('u_seed', seed);
  u1('u_face', face ? 1 : 0);
  if (S.eyes.length === 2) {
    u2('u_e1', S.eyes[0][0], S.eyes[0][1]); u2('u_e2', S.eyes[1][0], S.eyes[1][1]);
    const F = S.feat || FEAT0;
    u2('u_mc', F.mc[0], F.mc[1]); u2('u_mr', F.mr[0], F.mr[1]); u2('u_c1', F.c1[0], F.c1[1]); u2('u_c2', F.c2[0], F.c2[1]);
  }
  u1('u_eye', S.eye); u1('u_slim', S.slim);
  u1('u_lipAmt', lip ? S.lipAmt : 0); u3('u_lip', lip || [1, 1, 1]);
  u1('u_blushAmt', blush ? S.blushAmt : 0); u3('u_blush', blush || [1, 1, 1]);
  for (const k of ['expo', 'con', 'sat', 'warm', 'fade', 'vig', 'grain', 'mono']) u1('u_' + k, f[k]);
  u3('u_tint', f.tint);
  u1('u_eb', o ? 0 : S.eBright); u1('u_ec', o ? 0 : S.eCon); u1('u_es', o ? 0 : S.eSat);
  u1('u_et', o ? 0 : S.eTemp); u1('u_ev', o ? 0 : S.eVig); u1('u_eg', o ? 0 : S.eGrain);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return true;
}

let dirty = true;
function render() { dirty = true; }
function loop() {
  if (gl) {
    if (S.source === 'camera' && video.readyState >= 2 && video.videoWidth) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      detectVideo();
      draw();
    } else if (S.source === 'image' && dirty) { draw(); placeDots(); }
    dirty = false;
  }
  requestAnimationFrame(loop);
}

/* ───── 카메라 ───── */
async function startCamera() {
  if (!gl) { showEmpty(`이 기기에서 보정 엔진을 켜지 못했어요.<br><small>${glError}</small>`, false); return; }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; S.eyes = []; S.mirror = S.facing === 'user'; syncChoices();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showEmpty('이 브라우저에서는 실시간 카메라를 쓸 수 없어요.<br>크롬에서 열거나 아래 버튼으로 사진을 넣어 주세요.', false); return;
  }
  showEmpty('카메라를 켜는 중…', false);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: S.facing, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    setMode('camera');
  } catch (e) {
    const why = e && e.name === 'NotAllowedError' ? '카메라 권한이 꺼져 있어요. 주소창 왼쪽 자물쇠 → 권한에서 카메라를 허용해 주세요.'
      : e && e.name === 'NotFoundError' ? '사용할 수 있는 카메라를 찾지 못했어요.' : `카메라를 열 수 없어요 (${(e && e.name) || e}).`;
    showEmpty(why, true);
  }
}
function showEmpty(html, retry) { setMode('none'); $('emptyMsg').innerHTML = html; $('eRetry').hidden = !retry; }
document.addEventListener('visibilitychange', () => {
  if (document.hidden && stream && S.source === 'camera') { stream.getTracks().forEach((t) => t.stop()); stream = null; S.source = 'paused'; }
  else if (!document.hidden && S.source === 'paused') startCamera();
});

/* ───── 사진 불러오기 ───── */
async function loadFile(file) {
  if (!gl) { toast('이 기기에서는 보정 엔진을 쓸 수 없어요: ' + glError, 5000); return; }
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {}
  if (!src) {
    try { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(); i.src = URL.createObjectURL(file); }); }
    catch { toast('이 사진 형식을 열 수 없어요. JPG나 PNG로 해 보세요.', 4000); return; }
  }
  const w0 = src.width || src.naturalWidth, h0 = src.height || src.naturalHeight;
  const maxTex = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048);
  const k = Math.min(1, maxTex / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  S.img = c; S.eyes = []; S.manual = false; S.mirror = false; syncChoices();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, c);
  setMode('image');
  const found = await detectImage(c);
  if (FACE.state === 'ready') toast(found ? '얼굴을 찾았어요 · 보정이 적용됐어요' : '얼굴을 못 찾았어요 · 얼굴 탭에서 직접 지정할 수 있어요', 2800);
  updateFaceState(); render();
}

/* ───── 촬영 · 저장 ───── */
async function snapshot() {
  if (!draw()) return;
  const off = document.createElement('canvas'); off.width = canvas.width; off.height = canvas.height;
  off.getContext('2d').drawImage(canvas, 0, 0);
  const fl = $('flash'); fl.classList.add('go'); requestAnimationFrame(() => fl.classList.remove('go'));
  const blob = await new Promise((r) => off.toBlob(r, 'image/jpeg', 0.93));
  if (!blob) { toast('저장하지 못했어요.'); return; }
  const photo = { id: Date.now(), name: `REA_${stamp()}.jpg`, blob };
  await DB.add(photo); refreshThumb();
  download(photo);
  toast('저장했어요 · 다운로드 폴더와 앱 갤러리에 있어요');
}
async function shoot() {
  if (S.busy || S.source !== 'camera') return;
  S.busy = true;
  try {
    const cd = $('countdown');
    for (let i = TIMERS[S.timerIdx]; i > 0; i--) { cd.textContent = i; await new Promise((r) => setTimeout(r, 1000)); }
    cd.textContent = '';
    S.showOrig = false;
    await snapshot();
  } finally { S.busy = false; }
}
async function savePhoto() { S.showOrig = false; await snapshot(); }

/* ───── 자동 얼굴 인식 (MediaPipe, 기기 안에서만 처리) ───── */
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const FACE = { state: 'loading', lm: null, mode: 'VIDEO', busy: false, frame: 0, miss: 0 };
async function initFace() {
  try {
    const mod = await import(`${MP}/vision_bundle.mjs`);
    const files = await mod.FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const make = (delegate) => mod.FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL, delegate }, runningMode: 'VIDEO', numFaces: 1,
    });
    try { FACE.lm = await make('GPU'); } catch { FACE.lm = await make('CPU'); }
    FACE.state = 'ready';
    if (S.source === 'image' && S.img && !S.manual) await detectImage(S.img);
  } catch (e) {
    FACE.state = 'failed'; console.warn('face init failed', e);
  }
  updateFaceState(); render();
}
async function setRunMode(mode) {
  if (FACE.mode === mode) return;
  FACE.busy = true;
  try { await FACE.lm.setOptions({ runningMode: mode }); FACE.mode = mode; } finally { FACE.busy = false; }
}
// 얼굴 좌표계(두 눈 중심 원점, 눈 사이 거리 1)로 변환
function localOf(eyes, P) {
  const [a, b] = eyes, cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
  const d = Math.max(Math.hypot(dx, dy), 1), ex = [dx / d, dy / d], ey = [ex[1], -ex[0]], q = [P[0] - cx, P[1] - cy];
  return [(q[0] * ex[0] + q[1] * ex[1]) / d, (q[0] * ey[0] + q[1] * ey[1]) / d];
}
function eyesFrom(res, w, h) {
  const L = res && res.faceLandmarks && res.faceLandmarks[0];
  if (!L) return null;
  const pt = (i) => [L[i].x * w, (1 - L[i].y) * h];
  // 눈꼬리·눈머리 평균 = 눈 중심 (시선 방향에 흔들리지 않음)
  const mid = (a, b) => { const p = pt(a), q = pt(b); return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };
  const eyes = sortEyes([mid(33, 133), mid(362, 263)]);
  // 입술(입꼬리 61·291, 윗입술 0, 아랫입술 17)과 볼(50·280)의 실제 위치
  const m1 = localOf(eyes, pt(61)), m2 = localOf(eyes, pt(291)), mt = localOf(eyes, pt(0)), mb = localOf(eyes, pt(17));
  const ch = [localOf(eyes, pt(50)), localOf(eyes, pt(280))].sort((a, b) => a[0] - b[0]);
  const feat = {
    mc: [(m1[0] + m2[0]) / 2, (mt[1] + mb[1]) / 2],
    mr: [Math.max(0.2, Math.abs(m2[0] - m1[0]) / 2 * 1.1), Math.max(0.1, Math.abs(mb[1] - mt[1]) / 2 * 1.25)],
    c1: ch[0], c2: ch[1],
  };
  return { eyes, feat };
}
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function detectVideo() {
  if (FACE.state !== 'ready' || FACE.busy) return;
  if (FACE.mode !== 'VIDEO') { setRunMode('VIDEO'); return; }
  if (++FACE.frame % 2) return;
  let res; try { res = FACE.lm.detectForVideo(video, performance.now()); } catch { return; }
  const r = eyesFrom(res, video.videoWidth, video.videoHeight);
  const had = S.eyes.length === 2;
  if (!r) { if (++FACE.miss > 6 && had) { S.eyes = []; updateFaceState(); } return; }
  FACE.miss = 0;
  // 프레임 간 떨림 완화
  if (had && S.feat) {
    const t = 0.65, F = S.feat;
    S.eyes = S.eyes.map((p, i) => lerp2(p, r.eyes[i], t));
    S.feat = { mc: lerp2(F.mc, r.feat.mc, t), mr: lerp2(F.mr, r.feat.mr, t), c1: lerp2(F.c1, r.feat.c1, t), c2: lerp2(F.c2, r.feat.c2, t) };
  } else { S.eyes = r.eyes; S.feat = r.feat; }
  if (!had) updateFaceState();
}
async function detectImage(c) {
  if (FACE.state !== 'ready') return false;
  try {
    await setRunMode('IMAGE');
    const r = eyesFrom(FACE.lm.detect(c), c.width, c.height);
    if (r && !S.manual) { S.eyes = r.eyes; S.feat = r.feat; render(); }
    return !!r;
  } catch { return false; }
}

/* ───── 시작 ───── */
refreshThumb();
updateFaceState();
requestAnimationFrame(loop);
startCamera();
initFace();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.__rea = { S, FACE, loadFile };
