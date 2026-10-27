import * as THREE from '/vendor/three/three.module.js';

const N = 34000;
const SHAPES = ['球体', '环体', '螺旋', '星系', '立方', '头像'];
const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = (s) => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * (s || 1); };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- 六种形态：每个粒子在每种形态下的坐标 ---------- */
function shapeSphere() {
  const p = new Float32Array(N * 3), R = 1.42;
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = i * 2.399963;
    p[i * 3] = Math.cos(phi) * r * R + gauss(0.012);
    p[i * 3 + 1] = y * R + gauss(0.012);
    p[i * 3 + 2] = Math.sin(phi) * r * R + gauss(0.012);
  }
  return p;
}

function shapeRing() {
  const p = new Float32Array(N * 3), R = 1.5, r = 0.11, tilt = 1.02;
  const ct = Math.cos(tilt), stl = Math.sin(tilt);
  for (let i = 0; i < N; i++) {
    const u = Math.random() * Math.PI * 2, v = Math.random() * Math.PI * 2;
    const rr = r * Math.sqrt(Math.random());
    const x = (R + rr * Math.cos(v)) * Math.cos(u);
    const y = rr * Math.sin(v);
    const z = (R + rr * Math.cos(v)) * Math.sin(u);
    p[i * 3] = x;
    p[i * 3 + 1] = y * ct - z * stl;
    p[i * 3 + 2] = y * stl + z * ct;
  }
  return p;
}

function shapeDna() {
  const p = new Float32Array(N * 3), rad = 0.66, turns = 3.4;
  for (let i = 0; i < N; i++) {
    const t = Math.random();
    const ang = t * Math.PI * 2 * turns;
    const y = (t - 0.5) * 3.3;
    if (Math.random() < 0.24) {
      const k = Math.random() * 2 - 1;
      p[i * 3] = Math.cos(ang) * rad * k;
      p[i * 3 + 1] = y + gauss(0.01);
      p[i * 3 + 2] = Math.sin(ang) * rad * k;
    } else {
      const side = Math.random() < 0.5 ? 0 : Math.PI;
      const jr = rad + gauss(0.03);
      p[i * 3] = Math.cos(ang + side) * jr;
      p[i * 3 + 1] = y;
      p[i * 3 + 2] = Math.sin(ang + side) * jr;
    }
  }
  return p;
}

function shapeGalaxy() {
  const p = new Float32Array(N * 3), arms = 3;
  for (let i = 0; i < N; i++) {
    const r = Math.pow(Math.random(), 0.55) * 2.45;
    const arm = Math.floor(Math.random() * arms);
    const th = (arm * Math.PI * 2) / arms + r * 2.0 + gauss(0.16);
    p[i * 3] = Math.cos(th) * r;
    p[i * 3 + 1] = gauss(0.09) * (1 - r / 3.2);
    p[i * 3 + 2] = Math.sin(th) * r;
  }
  return p;
}

function shapeCube() {
  const p = new Float32Array(N * 3), h = 1.12;
  for (let i = 0; i < N; i++) {
    const face = Math.floor(Math.random() * 6);
    const axis = face % 3, sign = face < 3 ? 1 : -1;
    let u = rand(-1, 1), v = rand(-1, 1);
    if (Math.random() < 0.28) { u = Math.round(u * 6) / 6; }
    const c = [u * h, v * h];
    const out = [0, 0, 0];
    let k = 0;
    for (let a = 0; a < 3; a++) out[a] = a === axis ? sign * h : c[k++] * h;
    p[i * 3] = out[0] + gauss(0.008);
    p[i * 3 + 1] = out[1] + gauss(0.008);
    p[i * 3 + 2] = out[2] + gauss(0.008);
  }
  return p;
}

function shapeAvatar() {
  const p = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    if (Math.random() < 0.44) {
      const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      const r = 0.54 + gauss(0.01);
      p[i * 3] = Math.sin(ph) * Math.cos(th) * r;
      p[i * 3 + 1] = Math.cos(ph) * r * 1.06 + 0.96;
      p[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * r * 0.9;
    } else {
      const t = Math.random();
      const y = -1.45 + t * 1.86;
      const w = 0.52 + 0.42 * Math.pow(t, 3) + 0.05;
      const a = Math.random() * Math.PI * 2;
      p[i * 3] = Math.cos(a) * w * (0.92 + gauss(0.05));
      p[i * 3 + 1] = y;
      p[i * 3 + 2] = Math.sin(a) * w * 0.52;
    }
  }
  return p;
}

const shapePos = [shapeSphere(), shapeRing(), shapeDna(), shapeGalaxy(), shapeCube(), shapeAvatar()];

const params = new URLSearchParams(location.search);
const sp = Number(params.get('shape'));
const initIdx = Number.isFinite(sp) && sp >= 1 && sp <= SHAPES.length ? sp - 1 : 0;

/* ---------- 渲染器 ---------- */
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.setClearColor(0x02040a, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.1, 5.9);

const group = new THREE.Group();
scene.add(group);

/* 光晕贴图 */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.25, 'rgba(140,200,255,0.35)');
  grd.addColorStop(0.6, 'rgba(80,120,255,0.10)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const glowTex = glowTexture();
const halo1 = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x5b8cff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.20 }));
halo1.scale.set(5.0, 5.0, 1);
scene.add(halo1);
const halo2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xa78bfa, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.14 }));
halo2.scale.set(3.4, 3.4, 1);
scene.add(halo2);

/* 轨道环 */
const ringMat = new THREE.MeshBasicMaterial({ color: 0x2f7fd0, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
const ringA = new THREE.Mesh(new THREE.RingGeometry(2.05, 2.065, 160), ringMat);
ringA.rotation.x = Math.PI / 2.35;
group.add(ringA);
const ringB = new THREE.Mesh(new THREE.RingGeometry(2.42, 2.428, 160), ringMat.clone());
ringB.material.opacity = 0.2;
ringB.rotation.x = Math.PI / 1.75;
ringB.rotation.z = 0.6;
group.add(ringB);

/* ---------- 粒子系统（颜色 = 资料构成） ---------- */
const cur = new Float32Array(shapePos[initIdx]);
const geo = new THREE.BufferGeometry();
const posAttr = new THREE.BufferAttribute(cur, 3);
posAttr.setUsage(THREE.DynamicDrawUsage);
geo.setAttribute('position', posAttr);

const colArr = new Float32Array(N * 3);
for (let i = 0; i < N; i++) { colArr[i * 3] = 0.36; colArr[i * 3 + 1] = 0.55; colArr[i * 3 + 2] = 1.0; }
const colAttr = new THREE.BufferAttribute(colArr, 3);
geo.setAttribute('aColor', colAttr);

const aRand = new Float32Array(N);
for (let i = 0; i < N; i++) aRand[i] = Math.random();
geo.setAttribute('aRand', new THREE.BufferAttribute(aRand, 1));

const VERT = [
  'attribute float aRand;',
  'attribute vec3 aColor;',
  'uniform float uTime; uniform float uSize; uniform float uPulse; uniform float uSpread;',
  'varying float vR; varying float vPulse; varying vec3 vColor;',
  'void main() {',
  '  vR = aRand; vPulse = uPulse; vColor = aColor;',
  '  vec3 p = position * uSpread;',
  '  p.x += sin(uTime * 0.7 + aRand * 6.2831) * 0.010;',
  '  p.y += cos(uTime * 0.9 + aRand * 6.2831) * 0.010;',
  '  vec4 mv = modelViewMatrix * vec4(p, 1.0);',
  '  gl_PointSize = uSize * (0.45 + aRand * 0.85) * (1.0 + uPulse * 0.45) * (8.0 / max(0.9, -mv.z)) * 1.1;',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');

const FRAG = [
  'uniform float uPulse; uniform float uTintG; uniform float uTintB; uniform float uColorMix;',
  'varying float vR; varying float vPulse; varying vec3 vColor;',
  'void main() {',
  '  vec2 d = gl_PointCoord - 0.5;',
  '  float r = length(d);',
  '  if (r > 0.5) discard;',
  '  float a = smoothstep(0.5, 0.02, r);',
  '  vec3 c1 = vec3(0.16, 0.48, 1.0);',
  '  vec3 c2 = vec3(0.30, 0.90, 1.0);',
  '  vec3 c3 = vec3(0.68, 0.55, 1.0);',
  '  vec3 base = mix(mix(c1, c2, smoothstep(0.0, 0.5, vR)), c3, smoothstep(0.52, 1.0, vR));',
  '  vec3 c = mix(base, vColor, uColorMix);',
  '  c = mix(c, vec3(uTintG, uTintB, 1.0), 0.24);',
  '  c = mix(c, vec3(1.0), vPulse * 0.16);',
  '  gl_FragColor = vec4(c, a * (0.20 + 0.35 * vPulse));',
  '}'
].join('\n');

const uniforms = {
  uTime: { value: 0 }, uSize: { value: 2.05 }, uPulse: { value: 0.25 }, uSpread: { value: 1 },
  uTintG: { value: 0.55 }, uTintB: { value: 0.95 }, uColorMix: { value: 0 }
};
const mat = new THREE.ShaderMaterial({
  uniforms, vertexShader: VERT, fragmentShader: FRAG,
  transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending
});
const points = new THREE.Points(geo, mat);
group.add(points);

/* ---------- 资料构成配色：按来源在球面上结成色块 ---------- */
const SRC_COLORS = {
  obsidian: [0.36, 0.55, 1.00], hzcu: [0.13, 0.83, 0.93], phone: [0.65, 0.55, 0.98],
  wechat: [0.98, 0.60, 0.24], fs: [0.58, 0.65, 0.78], note: [0.20, 0.85, 0.60],
  foreground: [0.98, 0.75, 0.28], other: [0.78, 0.84, 0.96]
};
const SRC_LABEL = {
  obsidian: '笔记', hzcu: '学在城院', phone: '手机', wechat: '微信', fs: '文件',
  note: '手记', foreground: '窗口', other: '其它'
};
const srcLabel = (s) => SRC_LABEL[s] || (s ? String(s) : '其它');
const rgb = (c) => 'rgb(' + c.map((v) => Math.round(clamp(v, 0, 1) * 255)).join(',') + ')';

/* 把每个粒子的球面方向量化成格子，同格同色 —— 颜色因此聚成可辨认的区块 */
const gridDirs = new Float32Array(N * 3);
(function initDirs() {
  const base = shapePos[0];
  for (let i = 0; i < N; i++) {
    const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    gridDirs[i * 3] = x / l; gridDirs[i * 3 + 1] = y / l; gridDirs[i * 3 + 2] = z / l;
  }
})();

let srcBounds = [];
let focusSrc = '';
const RAND = 0.22; // 每格允许的随机散点比例，保留一点颗粒感

function setSourceData(bySource) {
  const list = (bySource || []).filter((s) => s && s.n > 0).sort((a, b) => b.n - a.n);
  if (!list.length) return false;
  const total = list.reduce((a, s) => a + s.n, 0);
  let acc = 0;
  srcBounds = list.map((s) => {
    acc += s.n / total;
    return { at: acc, src: s.source, n: s.n, color: SRC_COLORS[s.source] || SRC_COLORS.other };
  });
  return true;
}

function cellPick(i) {
  const qx = Math.floor((gridDirs[i * 3] + 1) * 3.2);
  const qy = Math.floor((gridDirs[i * 3 + 1] + 1) * 3.2);
  const qz = Math.floor((gridDirs[i * 3 + 2] + 1) * 3.2);
  let h = (qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791) ^ 0x9e3779b9;
  h = (h ^ (h >>> 13)) * 1274126177;
  const t = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  let k = 0;
  while (k < srcBounds.length - 1 && t > srcBounds[k].at) k++;
  return srcBounds[k];
}

function paintColors() {
  if (!srcBounds.length) return;
  for (let i = 0; i < N; i++) {
    const b = cellPick(i);
    const f = !focusSrc || b.src === focusSrc ? 1 : 0.14;
    const j = i * 3;
    colArr[j] = b.color[0] * f;
    colArr[j + 1] = b.color[1] * f;
    colArr[j + 2] = b.color[2] * f;
  }
  colAttr.needsUpdate = true;
  uniforms.uColorMix.value = 0.86;
}

function applySources(bySource) {
  if (!setSourceData(bySource)) return;
  paintColors();
  const box = $('#legend');
  box.innerHTML = srcBounds.slice(0, 7).map((b) =>
    '<span data-src="' + esc(b.src) + '" class="' + (focusSrc === b.src ? 'on' : '') + '">' +
    '<i style="background:' + rgb(b.color) + '"></i>' + esc(srcLabel(b.src)) + ' ' + b.n + '</span>').join('');
  box.querySelectorAll('span[data-src]').forEach((el) => {
    el.addEventListener('click', () => {
      focusSrc = focusSrc === el.dataset.src ? '' : el.dataset.src;
      paintColors();
      box.querySelectorAll('span[data-src]').forEach((s) => s.classList.toggle('on', s.dataset.src === focusSrc));
      subtitle(focusSrc ? '只看「' + srcLabel(focusSrc) + '」，' + (srcBounds.find((b) => b.src === focusSrc) || {}).n + ' 条' : '显示全部资料构成', 2200);
    });
  });
}

/* ---------- 数据星图：把真实条目钉在球面上，连线可点 ---------- */
const lead = $('#lead');
const lctx = lead.getContext('2d');
const nodesWrap = $('#nodes');
const nodeList = [];
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

function fitLead() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  lead.width = Math.round(window.innerWidth * dpr);
  lead.height = Math.round(window.innerHeight * dpr);
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
fitLead();

function hashDir(key, northBias) {
  let hsh = 2166136261;
  const s = String(key);
  for (let i = 0; i < s.length; i++) { hsh ^= s.charCodeAt(i); hsh = (hsh * 16777619) >>> 0; }
  const u = (hsh >>> 8) / 16777216;
  const v = ((hsh >>> 3) & 0xffff) / 65536;
  const cosPhi = northBias ? 0.42 - 1.0 * v : 2 * v - 1;
  const phi = Math.acos(clamp(cosPhi, -1, 1));
  const theta = u * Math.PI * 2;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

function addNode(item, kind) {
  if (!item || item.id == null) return;
  if (nodeList.some((n) => String(n.id) === String(item.id))) return;
  const el = document.createElement('div');
  el.className = 'node ' + kind;
  el.innerHTML = '<i class="nd"></i><span class="nt">' + esc(item.title || '(无标题)') + '</span>';
  el.title = (item.title || '') + ' · 点击查看';
  el.addEventListener('click', () => openDoc(item.id));
  nodesWrap.appendChild(el);
  nodeList.push({ el, dir: hashDir(kind + '|' + item.id, kind === 'due'), kind, id: item.id, phase: Math.random() * 6.28 });
}

function clearNodes(kind) {
  for (let i = nodeList.length - 1; i >= 0; i--) {
    if (!kind || nodeList[i].kind === kind) { nodeList[i].el.remove(); nodeList.splice(i, 1); }
  }
}

function syncDueNodes(due) {
  clearNodes('due');
  (due || []).slice(0, 3).forEach((d) => addNode(d, 'due'));
}

function syncFreshNodes(fresh) {
  clearNodes('fresh');
  (fresh || []).slice(0, 3).forEach((f) => addNode(f, 'fresh'));
}

function syncHitNodes(hits) {
  clearNodes('hit');
  (hits || []).slice(0, 5).forEach((h) => addNode(h, 'hit'));
}

const KIND_ANGLE = { due: -0.55, fresh: 1.15, hit: 0.32 };

function updateNodes(time) {
  const w = window.innerWidth, h = window.innerHeight;
  lctx.clearRect(0, 0, w, h);
  if (!nodeList.length) return;
  const cx = w * 0.5, cy = h * 0.5;
  const RX = Math.min(w * 0.30, 400);
  const RY = Math.min(h * 0.26, 290);
  for (const n of nodeList) {
    _v.set(n.dir[0], n.dir[1], n.dir[2]).applyEuler(group.rotation);
    _p.copy(_v).applyMatrix4(camera.matrixWorldInverse);
    const front = _p.z < 0;
    _p.copy(_v).multiplyScalar(1.02).project(camera);
    const ax = (_p.x * 0.5 + 0.5) * w;
    const ay = (-_p.y * 0.5 + 0.5) * h;
    // 标签沿球体外圈排布：角度取自锚点方向，半径固定，保证可读
    const ang = Math.atan2(ay - cy, ax - cx) + (KIND_ANGLE[n.kind] || 0);
    const lx = cx + Math.cos(ang) * RX;
    const ly = cy + Math.sin(ang) * RY;
    n.el.style.transform = 'translate(' + Math.round(lx) + 'px,' + Math.round(ly) + 'px) translate(-50%,-50%)';
    n.el.style.opacity = front ? '1' : '0.18';
    if (front) {
      const depth = clamp(-_p.z, 0, 1);
      lctx.strokeStyle = 'rgba(120,190,255,' + (0.34 - depth * 0.18).toFixed(3) + ')';
      lctx.lineWidth = 1;
      const mx = (ax + lx) / 2, my = (ay + ly) / 2;
      lctx.beginPath(); lctx.moveTo(ax, ay);
      lctx.quadraticCurveTo(mx + (my - cy) * 0.06, my - (mx - cx) * 0.06, lx, ly);
      lctx.stroke();
      const r = 2.2 + Math.sin(time * 2.2 + n.phase) * 0.8;
      lctx.fillStyle = n.kind === 'due' ? 'rgba(255,196,120,.95)' : n.kind === 'hit' ? 'rgba(220,150,255,.95)' : 'rgba(120,220,255,.9)';
      lctx.beginPath(); lctx.arc(ax, ay, r, 0, Math.PI * 2); lctx.fill();
      lctx.strokeStyle = 'rgba(140,200,255,.3)';
      lctx.beginPath(); lctx.arc(ax, ay, r + 4, 0, Math.PI * 2); lctx.stroke();
    }
  }
}

/* ---------- 形态变换 ---------- */
const st = { shape: initIdx, morph: 1, from: null, to: shapePos[initIdx], spread: 1, spreadTarget: 1, pulse: 0.25 };
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function setShape(i, silent) {
  i = ((i % SHAPES.length) + SHAPES.length) % SHAPES.length;
  st.from = cur.slice();
  st.to = shapePos[i];
  st.morph = 0;
  st.shape = i;
  $('#m-shape').textContent = SHAPES[i];
  document.querySelectorAll('.sbtn').forEach((b) => b.classList.toggle('on', Number(b.dataset.shape) === i));
  if (!silent) subtitle('形态切换：' + SHAPES[i], 1600);
}

/* ---------- 视角交互 ---------- */
const view = { rotX: -0.06, rotY: 0.4, tRotX: -0.06, tRotY: 0.4, z: 5.9, tZ: 5.9, auto: true };
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; view.auto = false; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointerup', (e) => { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (err) {} });
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  view.tRotY += (e.clientX - lastX) * 0.006;
  view.tRotX = clamp(view.tRotX + (e.clientY - lastY) * 0.005, -1.1, 1.1);
  lastX = e.clientX; lastY = e.clientY;
});
canvas.addEventListener('wheel', (e) => { e.preventDefault(); view.tZ = clamp(view.tZ + e.deltaY * 0.0025, 3.1, 9.5); }, { passive: false });

/* ---------- 字幕 ---------- */
const subEl = $('#sub');
let subTimer = 0;
function subtitle(text, ms) {
  subEl.textContent = text;
  subEl.classList.remove('hide');
  if (subTimer) clearTimeout(subTimer);
  if (ms) subTimer = setTimeout(() => subEl.classList.add('hide'), ms);
}
function typewriter(text, done) {
  subEl.textContent = '';
  subEl.classList.remove('hide');
  let i = 0;
  const step = Math.max(1, Math.round(text.length / 220));
  const timer = setInterval(() => {
    i += step;
    subEl.textContent = text.slice(0, i);
    if (i >= text.length) { clearInterval(timer); if (done) done(); }
  }, 26);
  return timer;
}

/* ---------- 语音合成 ---------- */
let voices = [];
function loadVoices() { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; }
if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function speak(text) {
  if (!window.speechSynthesis || !text) { setState('idle'); return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.slice(0, 600));
  const zh = voices.find((v) => /zh[-_]CN|Chinese|Xiaoxiao|Yunxi|Huihui/i.test(v.lang + v.name));
  if (zh) u.voice = zh;
  u.lang = 'zh-CN'; u.rate = 1.02; u.pitch = 0.98;
  u.onstart = () => setState('speak');
  u.onend = () => setState('idle');
  u.onerror = () => setState('idle');
  speechSynthesis.speak(u);
}

/* ---------- 状态 ---------- */
const stateEl = () => $('#t-state');
const STATES = {
  idle: { label: '待命', tint: [0.55, 0.95], speed: 0.32 },
  listen: { label: '监听中', tint: [0.95, 0.72], speed: 0.9 },
  think: { label: '检索中', tint: [0.82, 0.62], speed: 1.4 },
  speak: { label: '应答中', tint: [0.62, 1.0], speed: 0.7 }
};
let state = 'idle';
function setState(s) {
  state = s;
  const cfg = STATES[s] || STATES.idle;
  stateEl().textContent = cfg.label;
  uniforms.uTintG.value = cfg.tint[0];
  uniforms.uTintB.value = cfg.tint[1];
  subEl.classList.toggle('speak', s === 'speak');
}

/* ---------- 工具 ---------- */
const pad = (n) => String(n).padStart(2, '0');
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 86400000);
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  if (diff === 0) return '今天 ' + hm;
  if (diff === 1) return '明天 ' + hm;
  if (diff === -1) return '昨天 ' + hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}
function fmtAgo(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.round(s / 60) + ' 分钟前';
  if (s < 86400) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}
function fmtSize(b) {
  const n = Number(b) || 0;
  if (n > 1073741824) return (n / 1073741824).toFixed(2) + ' GB';
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}
async function getJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let msg = r.status + '';
    try { const e = await r.json(); msg = e.error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

/* ---------- 作战面板 ---------- */
let briefData = { due: [], week: [], fresh: [] };
let currentDoc = null;

function listItem(title, meta, id, urgent) {
  const li = document.createElement('li');
  li.tabIndex = 0;
  li.dataset.id = String(id);
  li.innerHTML = '<div class="it">' + esc(title || '(无标题)') + '</div><div class="im' + (urgent ? ' urgent' : '') + '">' + meta + '</div>';
  const open = () => openDoc(id);
  li.addEventListener('click', open);
  li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return li;
}

function fillList(sel, rows, countSel, emptyText) {
  const ul = $(sel);
  ul.innerHTML = '';
  if (countSel) $(countSel).textContent = String(rows.length);
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText;
    ul.appendChild(li);
    return;
  }
  for (const li of rows) ul.appendChild(li);
}

function renderDashboard(b) {
  briefData = { due: b.due || [], week: b.week || [], fresh: b.fresh || [] };
  buildDayline(briefData.due);
  const dueRows = briefData.due.slice(0, 5).map((d) => {
    const left = d.overdue ? '已过期' : (Number.isFinite(d.hoursLeft) ? '还剩 ' + Math.max(1, Math.round(d.hoursLeft)) + ' 小时' : '');
    const meta = '<span>' + esc(d.course || '') + '</span><span>' + esc(left) + ' · ' + esc(fmtWhen(d.endTime)) + '</span>';
    return listItem(d.title, meta, d.id, !!d.overdue || d.hoursLeft <= 24);
  });
  fillList('#list-due', dueRows, '#c-due', '近期没有到期作业');
  syncDueNodes(briefData.due);

  const weekRows = briefData.week.slice(0, 5).map((w) => {
    const meta = '<span>' + esc(w.course || w.kind || '') + '</span><span>' + esc(fmtWhen(w.at || w.endTime || w.startTime)) + '</span>';
    return listItem(w.title, meta, w.id, false);
  });
  fillList('#list-week', weekRows, '#c-week', '本周没有活动');

  const freshRows = briefData.fresh.slice(0, 6).map((f) => {
    const meta = '<span>' + esc(srcLabel(f.source)) + ' · ' + esc(f.kind || '') + '</span><span>' + esc(fmtAgo(f.docTime)) + '</span>';
    return listItem(f.title, meta, f.id, false);
  });
  fillList('#list-fresh', freshRows, '#c-fresh', '最近没有新资料');
  syncFreshNodes(briefData.fresh);

  $('#t-due').textContent = briefData.due.length + ' 项';
  $('#t-week').textContent = briefData.week.length + ' 项';
  $('#o-date').textContent = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

async function refresh() {
  try {
    const [b, s] = await Promise.all([getJson('/api/brief'), getJson('/api/stats')]);
    renderDashboard(b);
    $('#t-docs').textContent = Number(s.total || 0).toLocaleString('zh-CN');
    $('#t-bytes').textContent = fmtSize(s.bytes);
    $('#t-latest').textContent = fmtAgo(s.latest);
    $('#m-sync').textContent = fmtAgo(s.latest);
    applySources(s.bySource || []);
  } catch (e) {
    $('#m-sync').textContent = '离线';
    $('#t-latest').textContent = '离线';
    $('#list-due').innerHTML = '<li class="empty">连不上中枢（服务没启动？）</li>';
  }
}

/* ---------- 今天时间条：真实时钟 + 今天的到期点 ---------- */
function pctOfDay(d) { return ((d.getHours() * 60 + d.getMinutes()) / 1440) * 100; }

function buildDayline(due) {
  const track = $('#dl-track');
  if (!track) return;
  track.querySelectorAll('.dl-due,.dl-empty').forEach((el) => el.remove());
  const now = new Date();
  const nowEl = $('#dl-now');
  if (nowEl) nowEl.style.left = pctOfDay(now).toFixed(2) + '%';
  const today = now.toDateString();
  let marked = 0;
  for (const d of due || []) {
    const t = new Date(d.endTime || d.at || '');
    if (!Number.isFinite(t.getTime())) continue;
    const dayGap = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    if (dayGap < 0 || dayGap > 6) continue; // 只标未来一周，避免堆满
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'dl-due';
    el.style.left = pctOfDay(t).toFixed(2) + '%';
    if (dayGap > 0) el.style.opacity = '0.45';
    el.title = (d.title || '') + ' · ' + (dayGap === 0 ? '今天' : dayGap + ' 天后') + ' ' + t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    el.addEventListener('click', () => openDoc(d.id));
    track.appendChild(el);
    marked++;
  }
  if (!marked) {
    const el = document.createElement('span');
    el.className = 'dl-empty';
    el.textContent = '今天没有到期的';
    el.style.cssText = 'position:absolute;left:8px;top:-2px;font-size:9px;color:#4a5d7c;line-height:12px';
    track.appendChild(el);
  }
}

/* ---------- 文档抽屉 ---------- */
async function openDoc(id) {
  try {
    const d = await getJson('/api/doc?id=' + encodeURIComponent(id));
    currentDoc = d;
    $('#d-title').textContent = d.title || '(无标题)';
    $('#d-meta').textContent = [srcLabel(d.source), d.kind, fmtSize(d.size), fmtWhen(d.doc_time || d.mtime), d.uri].filter(Boolean).join(' · ');
    $('#d-body').textContent = String(d.body || '（这份资料没有可读正文，可能是图片或扫描件）').slice(0, 20000);
    const abs = /^[a-zA-Z]:[\\/]/.test(String(d.uri || ''));
    $('#d-open').hidden = !abs;
    $('#drawer').hidden = false;
    document.body.classList.add('drawer-open');
    hideHits();
    setState('idle');
  } catch (e) {
    subtitle('打不开这份资料：' + e.message, 5000);
  }
}
function closeDoc() {
  $('#drawer').hidden = true;
  document.body.classList.remove('drawer-open');
  currentDoc = null;
}
$('#d-close').addEventListener('click', closeDoc);
$('#d-open').addEventListener('click', async () => {
  if (!currentDoc || !currentDoc.uri) return;
  try {
    await getJson('/api/open?uri=' + encodeURIComponent(currentDoc.uri));
    subtitle('已在资源管理器里定位到这份文件', 3500);
  } catch (e) {
    subtitle('定位失败：' + e.message, 4000);
  }
});
$('#d-ask').addEventListener('click', () => {
  if (!currentDoc) return;
  const q = '《' + currentDoc.title + '》讲了什么？请结合正文要点回答。';
  closeDoc();
  ask(q);
});

/* ---------- 检索结果 ---------- */
let hitsArr = [];
let hitsActive = -1;
let searchTimer = 0;
let searchSeq = 0;

function renderHits(hits, total, heading) {
  hitsArr = Array.isArray(hits) ? hits : [];
  hitsActive = -1;
  const box = $('#hits');
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'hhead';
  head.innerHTML = '<span>' + esc(heading || ('命中 ' + (total != null ? total : hitsArr.length) + ' 条')) + '</span><span>↑↓ 选择 · Enter 提问 · Ctrl+Enter 打开</span>';
  box.appendChild(head);
  if (!hitsArr.length) {
    const empty = document.createElement('div');
    empty.className = 'hit';
    empty.textContent = '没有相关条目，换个关键词试试。';
    box.appendChild(empty);
  }
  hitsArr.forEach((h, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hit';
    btn.dataset.i = String(i);
    const snip = String(h.snippet || '').replace(/\s+/g, ' ').slice(0, 120);
    btn.innerHTML = '<div class="ht"><em>' + esc(srcLabel(h.source)) + '</em><b>' + esc(h.title || '(无标题)') + '</b></div>' +
      (snip ? '<div class="hs">' + esc(snip) + '</div>' : '') +
      '<div class="hm">' + [esc(fmtWhen(h.docTime)), esc(fmtSize(h.size)), h.kind ? esc(h.kind) : ''].filter(Boolean).join(' · ') + '</div>';
    btn.addEventListener('click', () => openDoc(h.id));
    btn.addEventListener('mouseenter', () => { hitsActive = i; highlightHits(); });
    box.appendChild(btn);
  });
  box.hidden = false;
  document.body.classList.add('hits-open');
  box.scrollTop = 0;
  syncHitNodes(hitsArr);
}

function highlightHits() {
  document.querySelectorAll('#hits .hit').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === hitsActive));
  const on = document.querySelector('#hits .hit.on');
  if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
}

function hideHits() {
  $('#hits').hidden = true;
  document.body.classList.remove('hits-open');
  document.body.classList.remove('searching');
  hitsArr = [];
  hitsActive = -1;
  clearNodes('hit');
}

async function searchLive(q) {
  const seq = ++searchSeq;
  try {
    const r = await getJson('/api/search?q=' + encodeURIComponent(q) + '&limit=8');
    if (seq !== searchSeq) return;
    document.body.classList.add('searching');
    renderHits(r.hits || [], r.total, '命中 ' + (r.total || 0) + ' 条');
  } catch (e) {
    subtitle('检索失败：' + e.message, 4000);
  }
}

/* ---------- 提问 ---------- */
let asking = false;
async function ask(q) {
  if (!q || asking) return;
  asking = true;
  setState('think');
  subtitle('正在翻本机资料：' + q, 0);
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, limit: 6 }) });
    const d = await res.json();
    if (d.mode === 'llm') {
      typewriter(d.answer || '', () => speak(d.answer || ''));
      if (Array.isArray(d.sources) && d.sources.length) renderHits(d.sources, d.sources.length, '这段回答引用的 ' + d.sources.length + ' 份资料');
    } else if (d.mode === 'error') {
      subtitle('模型返回错误：' + d.error + '（检索仍可用）', 6000);
      setState('idle');
    } else {
      const n = (d.sources || []).length;
      if (n) {
        renderHits(d.sources, n, '没有配置模型，先给你 ' + n + ' 条最相关的本机资料');
        subtitle('没有配置 AI 模型：下面是最相关的本机资料，点开就能看。', 0);
      } else {
        subtitle('本机资料里没找到相关条目。换个关键词试试？', 8000);
      }
      setState('idle');
    }
  } catch (e) {
    subtitle('连不上本地中枢（server 没启动？）', 6000);
    setState('idle');
  } finally {
    asking = false;
  }
}

/* ---------- 记一笔 ---------- */
async function saveNote(text) {
  const t = String(text || '').trim();
  if (!t) { subtitle('要记什么？用法：#内容 回车', 4000); return; }
  try {
    const r = await getJson('/api/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) });
    subtitle(r.changed ? '已记下：' + (r.title || t) : '这条已经记过了：' + (r.title || t), 5000);
    setState('idle');
    refresh();
  } catch (e) {
    subtitle('记录失败：' + e.message, 4000);
  }
}

/* ---------- 命令 ---------- */
const HELP = '可用命令：/help 帮助 · /today 今日概览 · /find 关键词 检索 · /note 内容 记一笔 · /stats 库统计 · /clear 清屏。也可以直接输入问题让我先翻资料再回答。';
async function command(raw) {
  const parts = raw.slice(1).trim().split(/\s+/);
  const cmd = (parts.shift() || '').toLowerCase();
  const arg = parts.join(' ').trim();
  if (cmd === 'help' || cmd === '帮助') return subtitle(HELP, 14000);
  if (cmd === 'today' || cmd === '今天') {
    const { due, week, fresh } = briefData;
    return subtitle('今天：' + due.length + ' 项到期（' + due.slice(0, 2).map((d) => d.title).join('、') + '）· 本周 ' + week.length + ' 项活动 · 最近入库 ' + fresh.length + ' 条。点左侧面板可以直接打开。', 12000);
  }
  if (cmd === 'find' || cmd === '找' || cmd === 'search') {
    if (!arg) return subtitle('用法：/find 关键词', 4000);
    return searchLive(arg);
  }
  if (cmd === 'note' || cmd === '记') return saveNote(arg);
  if (cmd === 'stats' || cmd === '统计') {
    try {
      const s = await getJson('/api/stats');
      return subtitle('库内 ' + s.total + ' 条 · ' + fmtSize(s.bytes) + ' · 最近同步 ' + fmtAgo(s.latest) + ' · 构成：' + (s.bySource || []).slice(0, 5).map((x) => srcLabel(x.source) + ' ' + x.n).join(' / '), 12000);
    } catch (e) { return subtitle('取统计失败：' + e.message, 4000); }
  }
  if (cmd === 'clear' || cmd === '清屏') { closeDoc(); hideHits(); subtitle('已清屏', 2000); return; }
  subtitle('未知命令 /' + cmd + '，输入 /help 看全部', 4000);
}

/* ---------- 输入区 ---------- */
const input = $('#ask');
function submit() {
  const q = input.value.trim();
  if (!q) return;
  if (q.startsWith('#')) { input.value = ''; hideHits(); return saveNote(q.slice(1)); }
  if (q.startsWith('/')) { input.value = ''; hideHits(); return command(q); }
  if (hitsActive >= 0 && hitsArr[hitsActive]) { return openDoc(hitsArr[hitsActive].id); }
  input.value = '';
  hideHits();
  ask(q);
}
input.addEventListener('input', () => {
  const q = input.value.trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (!q || q.startsWith('#') || q.startsWith('/')) { hideHits(); return; }
  searchTimer = setTimeout(() => searchLive(q), 260);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { hideHits(); e.target.blur(); return; }
  if (e.key === 'ArrowDown' && hitsArr.length) { e.preventDefault(); hitsActive = (hitsActive + 1) % hitsArr.length; highlightHits(); return; }
  if (e.key === 'ArrowUp' && hitsArr.length) { e.preventDefault(); hitsActive = (hitsActive - 1 + hitsArr.length) % hitsArr.length; highlightHits(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      if (hitsArr.length) { const i = hitsActive >= 0 ? hitsActive : 0; return openDoc(hitsArr[i].id); }
    }
    submit();
  }
});
$('#b-ask').addEventListener('click', () => submit());
$('#b-stop').addEventListener('click', () => { if (window.speechSynthesis) speechSynthesis.cancel(); setState('idle'); });
$('#b-main').addEventListener('click', () => { location.href = '/'; });
$('#b-min').addEventListener('click', () => { if (window.ctxhub && window.ctxhub.winAction) window.ctxhub.winAction('min'); });
$('#b-close').addEventListener('click', () => { if (window.ctxhub && window.ctxhub.winAction) window.ctxhub.winAction('close'); else window.close(); });

/* ---------- 手势（MediaPipe Hands，本地模型） ---------- */
const camEl = $('#cam');
let handsOn = false, landmarker = null, camStream = null, lastVideoTime = -1;
let handState = { openness: 0, pinch: 9, palm: 0.1, x: 0.5, y: 0.5 };
let lastPinch = 0;

async function startHands() {
  if (handsOn) return;
  try {
    subtitle('正在加载本地手部模型（约 8MB，一次即可）…', 0);
    const vision = await import('/vendor/mediapipe/vision_bundle.mjs');
    const fileset = await vision.FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    landmarker = await vision.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/vendor/mediapipe/hand_landmarker.task', delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5
    });
    camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
    camEl.srcObject = camStream;
    await camEl.play();
    camEl.classList.remove('off');
    handsOn = true;
    $('#b-hands').classList.add('on');
    $('#b-hands').innerHTML = '关闭手势 <kbd>G</kbd>';
    $('#m-gesture').textContent = '等待手掌';
    subtitle('手部追踪已启动：张开手放大、握拳收拢、捏合切换形态', 5000);
    setState('listen');
    requestAnimationFrame(detectLoop);
  } catch (e) {
    $('#m-gesture').textContent = '不可用';
    subtitle('手势启动失败：' + (e && e.message ? e.message : e) + '（可直接用鼠标拖动旋转）', 8000);
  }
}

function stopHands() {
  handsOn = false;
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null;
  camEl.classList.add('off');
  $('#b-hands').classList.remove('on');
  $('#b-hands').innerHTML = '启用手势 <kbd>G</kbd>';
  $('#m-gesture').textContent = '未启用';
  setState('idle');
}

function detectLoop() {
  if (!handsOn || !landmarker) return;
  if (camEl.readyState >= 2 && camEl.currentTime !== lastVideoTime) {
    lastVideoTime = camEl.currentTime;
    try {
      const res = landmarker.detectForVideo(camEl, performance.now());
      const lm = res && res.landmarks && res.landmarks[0];
      if (lm && lm.length >= 21) {
        const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
        const palm = Math.max(0.02, d(lm[0], lm[9]));
        const tips = [8, 12, 16, 20];
        const avg = tips.reduce((s, i) => s + d(lm[0], lm[i]), 0) / tips.length;
        handState.openness = clamp(avg / palm / 2.1, 0, 1.4);
        handState.pinch = d(lm[4], lm[8]) / palm;
        handState.palm = palm;
        handState.x = lm[9].x; handState.y = lm[9].y;
        const open = handState.openness;
        const label = open > 0.82 ? '张开 · 放大' : open < 0.42 ? '握拳 · 收拢' : handState.pinch < 0.32 ? '捏合 · 切形态' : '手掌';
        $('#m-gesture').textContent = label;
        st.spreadTarget = clamp(0.55 + open * 0.85, 0.55, 1.5);
        if (open < 0.4) st.spreadTarget *= 0.66;
        view.tRotY = (0.5 - handState.x) * 2.2;
        view.tRotX = clamp((handState.y - 0.5) * 1.6, -0.9, 0.9);
        view.auto = false;
        if (handState.pinch < 0.32 && performance.now() - lastPinch > 900) {
          lastPinch = performance.now();
          setShape(st.shape + 1);
        }
      } else {
        $('#m-gesture').textContent = '等待手掌';
      }
    } catch (err) { /* 忽略单帧失败 */ }
  }
  requestAnimationFrame(detectLoop);
}
$('#b-hands').addEventListener('click', () => (handsOn ? stopHands() : startHands()));

/* ---------- 麦克风电平 + 语音识别 ---------- */
let micOn = false, micStream = null, analyser = null, micData = null;
async function startMic() {
  if (micOn) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(micStream);
    analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    micData = new Uint8Array(analyser.frequencyBinCount);
    micOn = true;
    $('#b-mic').classList.add('on');
    $('#b-mic').innerHTML = '关闭语音 <kbd>V</kbd>';
    if (!SR) $('#m-voice').textContent = '电平驱动';
  } catch (e) {
    $('#m-voice').textContent = '拒绝权限';
  }
}
function stopMic() {
  micOn = false;
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null; analyser = null; micData = null;
  $('#b-mic').classList.remove('on');
  $('#b-mic').innerHTML = '语音 <kbd>V</kbd>';
  $('#m-voice').textContent = '未启用';
}

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
let recog = null, recogOn = false;
function startRecog() {
  if (!SR) {
    subtitle('这个浏览器不支持语音识别（Chrome / Edge 可用）。麦克风电平已接入：说话时核心会跳动。', 7000);
    return;
  }
  if (recogOn) return;
  try {
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.continuous = false;
    recog.interimResults = true;
    recog.onstart = () => { recogOn = true; $('#m-voice').textContent = '在听…'; setState('listen'); };
    recog.onresult = (ev) => {
      let txt = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
      input.value = txt;
      if (ev.results[ev.results.length - 1].isFinal && txt.trim()) searchLive(txt.trim());
    };
    recog.onerror = (ev) => {
      subtitle('语音识别出错：' + (ev.error || '未知') + '（联网识别在大陆可能不可用，直接打字也一样）', 6000);
      recogOn = false;
      $('#m-voice').textContent = micOn ? '电平驱动' : '未启用';
    };
    recog.onend = () => { recogOn = false; if (!micOn) $('#m-voice').textContent = '未启用'; setState('idle'); };
    recog.start();
  } catch (e) {
    subtitle('语音识别启动失败：' + e.message, 4000);
  }
}
function stopRecog() { try { if (recog) recog.stop(); } catch (e) { /* ignore */ } recogOn = false; }
$('#b-mic').addEventListener('click', () => {
  if (micOn) { stopRecog(); stopMic(); }
  else { startMic(); startRecog(); }
});

/* ---------- 形态按钮 ---------- */
document.querySelectorAll('.sbtn').forEach((b) => b.addEventListener('click', () => setShape(Number(b.dataset.shape))));

/* ---------- 键盘 ---------- */
window.addEventListener('keydown', (e) => {
  const tag = e.target && e.target.tagName;
  if (e.key === 'Escape') { if (!$('#drawer').hidden) { closeDoc(); return; } }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (/^[1-6]$/.test(e.key)) setShape(Number(e.key) - 1);
  else if (e.key === 'g' || e.key === 'G') handsOn ? stopHands() : startHands();
  else if (e.key === 'v' || e.key === 'V') { if (micOn) { stopRecog(); stopMic(); } else { startMic(); startRecog(); } }
  else if (e.key === '/') { e.preventDefault(); input.focus(); }
  else if (e.key === 'h' || e.key === 'H') { document.body.classList.toggle('clean'); }
});

/* ---------- 主循环 ---------- */
let last = performance.now(), fpsAcc = 0, fpsN = 0, t0 = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const time = (now - t0) / 1000;

  if (st.morph < 1) {
    st.morph = Math.min(1, st.morph + dt * 1.6);
    const e = easeInOut(st.morph);
    for (let i = 0; i < cur.length; i++) cur[i] = st.from[i] + (st.to[i] - st.from[i]) * e;
    posAttr.needsUpdate = true;
  }

  st.spread += (st.spreadTarget - st.spread) * Math.min(1, dt * 3.2);
  uniforms.uSpread.value = st.spread;

  let level = 0.18 + Math.sin(time * 1.6) * 0.06;
  if (micOn && analyser) {
    analyser.getByteTimeDomainData(micData);
    let sum = 0;
    for (let i = 0; i < micData.length; i++) { const v = (micData[i] - 128) / 128; sum += v * v; }
    level = Math.max(level, Math.min(1.2, Math.sqrt(sum / micData.length) * 7));
  }
  const target = state === 'think' ? 0.55 + Math.sin(time * 9) * 0.2 : state === 'speak' ? 0.5 + level * 0.7 : state === 'listen' ? 0.35 + level * 0.9 : level;
  st.pulse += (target - st.pulse) * Math.min(1, dt * 8);
  uniforms.uPulse.value = st.pulse;
  uniforms.uTime.value = time;
  uniforms.uSize.value = 2.0 + st.pulse * 0.55;

  if (view.auto) view.tRotY += dt * 0.12;
  view.rotX += (view.tRotX - view.rotX) * Math.min(1, dt * 4);
  view.rotY += (view.tRotY - view.rotY) * Math.min(1, dt * 4);
  view.z += (view.tZ - view.z) * Math.min(1, dt * 4);
  group.rotation.x = view.rotX;
  group.rotation.y = view.rotY;
  camera.position.z = view.z;

  ringA.rotation.z += dt * 0.16;
  ringB.rotation.z -= dt * 0.11;
  halo1.material.opacity = 0.14 + st.pulse * 0.20;
  halo2.material.opacity = 0.08 + st.pulse * 0.14;
  const hs = 4.4 + st.pulse * 1.2 + st.spread * 0.6;
  halo1.scale.set(hs, hs, 1);
  halo2.scale.set(hs * 0.55, hs * 0.55, 1);

  renderer.render(scene, camera);
  updateNodes(time);

  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 0.5) { $('#t-fps').textContent = Math.round(fpsN / fpsAcc) + ' fps'; fpsAcc = 0; fpsN = 0; }
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  fitLead();
});

/* ---------- 启动 ---------- */
$('#m-shape').textContent = SHAPES[initIdx];
document.querySelectorAll('.sbtn').forEach((b) => b.classList.toggle('on', Number(b.dataset.shape) === initIdx));
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 90000);
setInterval(() => { const el = $('#dl-now'); if (el) el.style.left = pctOfDay(new Date()).toFixed(2) + '%'; }, 30000);
setTimeout(() => subtitle('系统就绪。左侧面板和球上的标签都能点开；输入即检索；# 记一笔；/help 看命令。', 9000), 800);
if (params.get('ask')) setTimeout(() => ask(params.get('ask')), 1100);
if (params.get('q')) { input.value = params.get('q'); setTimeout(() => searchLive(params.get('q')), 700); }
