import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/* 示例模型配置来自 index.html 的 window.SAMPLE_MODELS（在那里修改即可）；
 * 若配置缺失则退回内置示例，保证页面仍可用。 */
const SAMPLE_MODELS = Array.isArray(window.SAMPLE_MODELS) && window.SAMPLE_MODELS.length
  ? window.SAMPLE_MODELS
  : [{ name: '环面纽结（内置）', builtin: true }];

/* ================= 基础工具 ================= */
const $ = (id) => document.getElementById(id);
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ISODIR = new THREE.Vector3(1, .82, 1).normalize();
const AXVEC = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) };
const VIEW_DIRS = { front:[0,0,1], back:[0,0,-1], left:[-1,0,0], right:[1,0,0], top:[0,1,0], bottom:[0,-1,0], iso:[1,.82,1] };

function toast(msg, type='info'){
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3200);
}
const fmtCount = n => n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e4 ? (n/1e3).toFixed(1)+'k' : String(n);
const fmtLen = v => v === 0 ? '0' : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : Math.abs(v) >= .01 ? v.toFixed(3) : v.toExponential(1);
const easeInOut = k => k < .5 ? 4*k*k*k : 1 - Math.pow(-2*k + 2, 3) / 2;

const BG_DIM   = new THREE.Color(0x05070b);
const BG_DARK  = new THREE.Color(0x0f1319);
const BG_LIGHT = new THREE.Color(0xf0f3f8);

/* ================= 渲染器 / 场景 ================= */
const vp = $('viewport');
let W = vp.clientWidth || 1, H = vp.clientHeight || 1;
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  document.body.innerHTML = '<div style="display:grid;place-items:center;height:100vh;color:#e6ebf4">无法创建 WebGL 上下文，请检查浏览器显卡加速设置</div>';
  throw e;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.autoClear = false;
vp.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color().copy(BG_DARK);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
pmrem.dispose();

scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1c1a17, .55));
const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(4, 7, 5); scene.add(key);
const rim = new THREE.DirectionalLight(0x9db8ff, .8); rim.position.set(-6, 3, -5); scene.add(rim);

/* ================= 相机 ================= */
const persp = new THREE.PerspectiveCamera(45, W/H, .1, 2000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, .001, 5000);
let camera = ortho;
let orthoHalf = 1.6;
let camMode = 'ortho';

function updateOrtho(){
  const a = W / H;
  ortho.left = -orthoHalf * a; ortho.right = orthoHalf * a;
  ortho.top = orthoHalf; ortho.bottom = -orthoHalf;
  ortho.updateProjectionMatrix();
}
ortho.position.set(3, 2.6, 3); ortho.zoom = 1;
persp.position.copy(ortho.position);
updateOrtho();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = .08;
controls.zoomToCursor = true;
controls.screenSpacePanning = true;
controls.addEventListener('start', () => cancelCamAnim());

/* ================= 状态 ================= */
let model = null, modelRadius = 1, currentName = '—';
const modelCenter = new THREE.Vector3();
const modelBox = new THREE.Box3();
const modelPos0 = new THREE.Vector3(), modelQuat0 = new THREE.Quaternion();
let mixer = null, animPlaying = true;
let shadeMode = 'shaded';
let gridOn = true, axesOn = true, outlineOn = false;
let rotAxis = null, rotSpeed = 30;   // deg/s
let modelBrightness = 1;             // 模型本身亮度（1 = 原始）

/* ================= 共享材质 / 着色模式 ================= */
const wireMat = new THREE.MeshBasicMaterial({ wireframe: true, color: 0x9db8e8 });
wireMat.userData.isShared = true;
const normalMat = new THREE.MeshNormalMaterial();
normalMat.userData.isShared = true;
const outlineMat = new THREE.LineBasicMaterial({ color: 0x000000 });
outlineMat.userData.isShared = true;


function setPolyOffset(mats, on){
  const arr = Array.isArray(mats) ? mats : [mats];
  arr.forEach(m => {
    if (!m) return;
    m.polygonOffset = on; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
    m.needsUpdate = true;
  });
}
function applyShading(mode){
  shadeMode = mode;
  if (!model) return;
  model.traverse(o => {
    if (!o.isMesh || o.userData.isOverlay) return;
    const base = o.userData.origMaterial;
    const ov = o.userData.overlay;
    if (mode === 'wire'){ o.material = wireMat; if (ov) ov.visible = false; setPolyOffset(base, false); }
    else if (mode === 'normal'){ o.material = normalMat; if (ov) ov.visible = false; setPolyOffset(base, false); }
    else if (mode === 'hybrid'){ o.material = base; if (ov) ov.visible = true; setPolyOffset(base, true); }
    else { o.material = base; if (ov) ov.visible = false; setPolyOffset(base, false); }
  });
}
function setOutline(on){
  outlineOn = on;
  if (model) model.traverse(o => { if (o.userData && o.userData.outline) o.userData.outline.visible = on; });
  $('btn-outline').classList.toggle('active', on);
}
function setAxesOn(v){
  axesOn = v; axesGroup.visible = v;
  $('btn-axes').classList.toggle('active', v);
}
function setGridOn(v){
  gridOn = v;
  if (grid) grid.visible = v;
  $('btn-grid').classList.toggle('active', v);
}

/* ================= 网格与坐标轴 ================= */
const helpers = new THREE.Group(); scene.add(helpers);
const axesGroup = new THREE.Group(); helpers.add(axesGroup);
let grid = null;

function buildGrid(R, center, minY){
  if (grid){ helpers.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid = null; }
  grid = new THREE.GridHelper(R * 4, 40, 0x3d495e, 0x252d3c);
  grid.material.transparent = true; grid.material.opacity = .33;
  grid.position.set(center.x, minY, center.z);
  grid.visible = gridOn;
  helpers.add(grid);
}
/* 新增：坐标轴字母标签（Canvas 贴图 Sprite，始终面向相机，颜色与轴一致） */
function makeAxisLabel(t, colorCss, R){
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 44px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = colorCss;
  g.fillText(t, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  s.scale.setScalar(R * .14);
  s.renderOrder = 2;
  return s;
}

function buildAxes(R, origin){
  axesGroup.traverse(o => {
    if (o.isSprite){
      /* Sprite 在 three.js 中共用模块级 geometry，不能 dispose，
       * 只清理自己的贴图与材质，避免影响右下角罗盘的字母 */
      if (o.material && o.material.map) o.material.map.dispose();
      if (o.material) o.material.dispose();
      return;
    }
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  axesGroup.clear();
  axesGroup.add(new THREE.Mesh(
    new THREE.SphereGeometry(R * .02, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0x8b98ab })
  ));
  const cols = { x: 0xff5c5c, y: 0x4fd07a, z: 0x4f8cff };
  const labelCols = { x: '#ff5c5c', y: '#4fd07a', z: '#4f8cff' };
  for (const name of ['x', 'y', 'z']){
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: cols[name] });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(R*.008, R*.008, R*.8, 8), mat);
    shaft.position.y = R * .4;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(R*.03, R*.1, 12), mat);
    cone.position.y = R * .95;
    grp.add(shaft, cone);
    /* 新增：箭头前方的字母，位于箭尖（R*1.0）再往外一点 */
    const label = makeAxisLabel(name.toUpperCase(), labelCols[name], R);
    label.position.y = R * 1.16;
    grp.add(label);
    if (name === 'x') grp.rotation.z = -Math.PI / 2;
    if (name === 'z') grp.rotation.x = Math.PI / 2;
    axesGroup.add(grp);
  }
  axesGroup.position.copy(origin);
  axesGroup.visible = axesOn;
}


/* ================= 模型载入 / 替换 ================= */
function clearModel(){
  if (mixer){ mixer.stopAllAction(); mixer = null; }
  if (!model) return;
  scene.remove(model);
  model.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats){
      if (!m || (m.userData && m.userData.isShared)) continue;
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
  model = null;
}

function setModel(object, name){
  cancelCamAnim();
  clearModel();
  rotAxis = null; syncRotUI();
  let verts = 0, tris = 0;
  object.traverse(o => {
    if (o.userData && o.userData.isOverlay) return;
    if (o.isMesh){
      const geo = o.geometry;
      if (geo && !geo.attributes.normal) geo.computeVertexNormals();
      if (geo){
        verts += geo.attributes.position.count;
        tris += Math.round((geo.index ? geo.index.count : geo.attributes.position.count) / 3);
      }
      o.userData.origMaterial = o.material;
      o.userData.overlay = null;
      o.userData.outline = null;
      /* 为「模型亮度」记录原始 color / emissive（支持 emissive 的材质才记录） */
      const mats0 = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats0){
        if (m && m.emissive !== undefined && !m.userData._baseEmissive){
          m.userData._baseEmissive = m.emissive.clone();
          m.userData._baseColor   = m.color.clone();
        }
      }
      if (!o.isSkinnedMesh && geo){
        const ov = new THREE.Mesh(geo, wireMat);
        ov.userData.isOverlay = true;
        ov.visible = false;
        ov.raycast = () => {};
        o.add(ov);
        o.userData.overlay = ov;
      }
      if (o.isSkinnedMesh) o.frustumCulled = false;
    } else if (o.isPoints && o.geometry && o.geometry.attributes.position){
      verts += o.geometry.attributes.position.count;
    }
  });
  model = object;
  scene.add(object);
  modelPos0.copy(object.position);
  modelQuat0.copy(object.quaternion);
  modelBox.setFromObject(object);
  const size = modelBox.getSize(new THREE.Vector3());
  modelRadius = Math.max(size.length() / 2, 1e-6);
  modelBox.getCenter(modelCenter);

  /* 轮廓线：沿法线外扩的反面外壳 */
  /* 轮廓线：EdgesGeometry 特征边线框（相邻面夹角小于阈值的光滑边不显示） */
  const EDGE_THRESHOLD = 30;   // 单位：度。1 ≈ 几乎所有边都显示；45 ≈ 只保留明显折角
  model.traverse(o => {
    if (o.userData && o.userData.isOverlay) return;
    if (o.isMesh && !o.isSkinnedMesh && o.geometry){
      const g2 = new THREE.EdgesGeometry(o.geometry, EDGE_THRESHOLD);
      if (!g2.attributes.position || g2.attributes.position.count === 0){ g2.dispose(); return; }
      const line = new THREE.LineSegments(g2, outlineMat);
      line.userData.isOverlay = true;
      line.visible = outlineOn;
      line.raycast = () => {};
      o.add(line);
      o.userData.outline = line;
    }
  });

  buildGrid(modelRadius, modelCenter, modelBox.min.y);
  buildAxes(modelRadius, new THREE.Vector3(modelCenter.x, modelBox.min.y, modelCenter.z));
  controls.minDistance = modelRadius * .03;
  controls.maxDistance = modelRadius * 60;
  const clips = object.animations || [];
  if (clips.length){
    mixer = new THREE.AnimationMixer(object);
    for (const c of clips) mixer.clipAction(c).play();
  }
  animPlaying = $('chk-anim').checked;
  $('row-anim').classList.toggle('hide', clips.length === 0);
  applyShading(shadeMode);
  applyModelBrightness(modelBrightness);   /* 模型切换后沿用当前亮度滑块值 */
  currentName = name;
  $('chip-file').textContent = name;
  $('chip-stats').innerHTML =
    `<b>${fmtCount(verts)}</b> 顶点 · <b>${fmtCount(tris)}</b> 面片 · <b>${fmtLen(size.x)}×${fmtLen(size.y)}×${fmtLen(size.z)}</b>`;
  fitView(false);
}
/* ================= 模型本身亮度（不影响背景亮度） ================= */
function applyModelBrightness(mult){
  if (!model) return;
  const extra = Math.max(0, mult - 1) * .55;
  model.traverse(o => {
    if (!o.isMesh || (o.userData && o.userData.isOverlay)) return;
    const mats = Array.isArray(o.userData.origMaterial)
      ? o.userData.origMaterial
      : (o.userData.origMaterial ? [o.userData.origMaterial] : []);
    for (const m of mats){
      if (!m || m.emissive === undefined || !m.userData._baseEmissive) continue;
      if (mult <= 1){
        m.color.copy(m.userData._baseColor).multiplyScalar(mult);
        m.emissive.copy(m.userData._baseEmissive).multiplyScalar(mult);
      } else {
        m.color.copy(m.userData._baseColor);
        m.emissive.copy(m.userData._baseEmissive).addScalar(extra);
      }
    }
  });
}

/* ================= 模型旋转（绕世界 X/Y/Z 轴） ================= */
const _rq = new THREE.Quaternion(), _raxis = new THREE.Vector3();
function stepModelRotation(dt){
  if (!rotAxis || !model) return;
  _raxis.set(rotAxis === 'x' ? 1 : 0, rotAxis === 'y' ? 1 : 0, rotAxis === 'z' ? 1 : 0);
  _rq.setFromAxisAngle(_raxis, THREE.MathUtils.degToRad(rotSpeed) * dt);
  const pivot = modelCenter;
  model.position.sub(pivot).applyQuaternion(_rq).add(pivot);
  model.quaternion.premultiply(_rq);
}
function setRotAxis(ax){
  rotAxis = (rotAxis === ax) ? null : ax;
  syncRotUI();
}
function stopRotation(){
  rotAxis = null; syncRotUI();
}
function syncRotUI(){
  document.querySelectorAll('.rotbtn[data-ax]').forEach(b =>
    b.classList.toggle('active', b.dataset.ax === rotAxis));
  $('btn-rot-stop').classList.toggle('active', rotAxis === null);
}
function resetModelTransform(){
  if (!model) return;
  rotAxis = null; syncRotUI();
  model.position.copy(modelPos0);
  model.quaternion.copy(modelQuat0);
}

/* ================= 相机动画 / 取景 ================= */
let camAnim = null;
function cancelCamAnim(){ camAnim = null; }
function animateCam(pos, tgt, opts = {}, dur = 450, done = null){
  camAnim = {
    p0: camera.position.clone(), t0: controls.target.clone(),
    p1: pos.clone(), t1: tgt.clone(),
    z0: ortho.zoom, z1: opts.zoom ?? ortho.zoom,
    h0: orthoHalf, h1: opts.half ?? orthoHalf,
    start: performance.now(), dur, done
  };
}
function stepAnim(now){
  if (!camAnim) return;
  let k = (now - camAnim.start) / camAnim.dur;
  if (k >= 1) k = 1;
  const e = easeInOut(k);
  camera.position.lerpVectors(camAnim.p0, camAnim.p1, e);
  controls.target.lerpVectors(camAnim.t0, camAnim.t1, e);
  if (camera === ortho){
    orthoHalf = camAnim.h0 + (camAnim.h1 - camAnim.h0) * e;
    ortho.zoom = camAnim.z0 + (camAnim.z1 - camAnim.z0) * e;
    updateOrtho();
  }
  if (k === 1){ const d = camAnim.done; camAnim = null; if (d) d(); }
}
function updateClipPlanes(){
  const R = modelRadius;
  persp.near = Math.max(R * .01, 1e-3); persp.far = R * 160; persp.updateProjectionMatrix();
  ortho.near = Math.max(R * .001, 1e-4); ortho.far = R * 160; ortho.updateProjectionMatrix();
}
function fitView(animate = true, dir){
  if (!model) return;
  const R = modelRadius, C = modelCenter;
  let d = dir ? dir.clone() : camera.position.clone().sub(controls.target);
  if (d.lengthSq() < 1e-10) d.copy(ISODIR);
  d.normalize();
  const pos = C.clone().addScaledVector(d, R * 3);
  const opts = { half: R * 1.15, zoom: 1 };
  if (animate) animateCam(pos, C, opts, 460, updateClipPlanes);
  else {
    camera.position.copy(pos); controls.target.copy(C);
    orthoHalf = opts.half; ortho.zoom = 1; updateOrtho();
    updateClipPlanes();
  }
}
function snapView(name){
  if (!model) return;
  const v = new THREE.Vector3(...VIEW_DIRS[name]).normalize();
  const C = controls.target.clone();
  const dist = Math.max(camera.position.distanceTo(C), modelRadius * .5);
  animateCam(C.clone().addScaledVector(v, dist), C);
}
function syncCamSeg(){
  document.querySelectorAll('#cam-seg button').forEach(b =>
    b.classList.toggle('active', b.dataset.cam === camMode));
}
function setCameraMode(mode){
  if (mode === camMode) return;
  const target = controls.target.clone();
  const dist = camera.position.distanceTo(target);
  if (mode === 'ortho'){
    const vh = 2 * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) * dist;
    orthoHalf = Math.max(vh / 2, 1e-4); ortho.zoom = 1; updateOrtho();
    ortho.position.copy(persp.position);
    camera = ortho;
  } else {
    const vh = (ortho.top - ortho.bottom) / ortho.zoom;
    const d = vh / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)));
    const dir = persp.position.clone().sub(target).normalize();
    persp.position.copy(target).addScaledVector(dir, d);
    updateClipPlanes();
    camera = persp;
  }
  camMode = mode;
  controls.object = camera;
  controls.update();
  syncCamSeg();
}

/* ================= 方向罗盘（右下角） ================= */
const gizmoScene = new THREE.Scene();
const gizmoCam = new THREE.OrthographicCamera(-1.7, 1.7, 1.7, -1.7, .1, 10);
const gizmoPick = [];
let gizmoRect = { x: 0, y: 12, w: 92, h: 92 };
function makeLetter(t, color){
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.font = '700 42px "Segoe UI", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = color; g.fillText(t, 32, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.setScalar(.5);
  return s;
}
{
  const mkMat = (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: o < 1, opacity: o, depthTest: false });
  const axes = [['x', 0xff5c5c, '#ff7a7a'], ['y', 0x4fd07a, '#5fe08a'], ['z', 0x4f8cff, '#7aa8ff']];
  for (const [name, col, lcol] of axes){
    const grp = new THREE.Group();
    if (name === 'x') grp.rotation.z = -Math.PI / 2;
    if (name === 'z') grp.rotation.x = Math.PI / 2;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(.03, .03, .78, 10), mkMat(col, .9));
    shaft.position.y = .39;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(.075, .22, 14), mkMat(col));
    cone.position.y = .89;
    const negLine = new THREE.Mesh(new THREE.CylinderGeometry(.013, .013, 1, 6), mkMat(0x5a6474));
    negLine.position.y = -.5;
    const negDot = new THREE.Mesh(new THREE.SphereGeometry(.06, 10, 8), mkMat(0x5a6474));
    negDot.position.y = -1;
    shaft.userData = { dir: name, sign: 1 };
    cone.userData = { dir: name, sign: 1 };
    negDot.userData = { dir: name, sign: -1 };
    negLine.userData = { dir: name, sign: -1 };
    for (const m of [shaft, cone, negLine, negDot]){ m.renderOrder = 1; grp.add(m); }
    const label = makeLetter(name.toUpperCase(), lcol);
    label.position.copy(AXVEC[name]).multiplyScalar(1.24);
    label.userData = { dir: name, sign: 1 };
    label.renderOrder = 3;
    gizmoScene.add(grp, label);
    gizmoPick.push(shaft, cone, negLine, negDot, label);
  }
  const center = new THREE.Mesh(new THREE.SphereGeometry(.13, 16, 12), mkMat(0xdfe6f2));
  center.userData = { view: 'iso' };
  center.renderOrder = 2;
  gizmoScene.add(center);
  gizmoPick.push(center);
}
function updateGizmoCam(){
  const v = camera.position.clone().sub(controls.target);
  if (v.lengthSq() < 1e-12) v.set(0, 0, 1);
  gizmoCam.position.copy(v.normalize()).multiplyScalar(3);
  gizmoCam.up.copy(camera.up);
  gizmoCam.lookAt(0, 0, 0);
}
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function gizmoNDC(e){
  const r = $('gizmo').getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  return ndc;
}
$('gizmo').addEventListener('pointerdown', e => {
  raycaster.setFromCamera(gizmoNDC(e), gizmoCam);
  const hit = raycaster.intersectObjects(gizmoPick, false)[0];
  if (!hit) return;
  const u = hit.object.userData;
  if (u.view === 'iso') fitView(true, ISODIR);
  else if (u.dir){
    const v = AXVEC[u.dir].clone().multiplyScalar(u.sign);
    const dist = Math.max(camera.position.distanceTo(controls.target), modelRadius * .5);
    animateCam(controls.target.clone().addScaledVector(v, dist), controls.target.clone());
  }
});
$('gizmo').addEventListener('pointermove', e => {
  raycaster.setFromCamera(gizmoNDC(e), gizmoCam);
  $('gizmo').style.cursor = raycaster.intersectObjects(gizmoPick, false).length ? 'pointer' : 'grab';
});

/* ================= 模型加载（本地文件与 URL 共用） ================= */
const dracoLoader = new DRACOLoader()
  .setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/');
const loadEl = $('load'), bar = $('load-bar'), barI = bar.querySelector('i');
function showLoading(name){ $('load-name').textContent = name; bar.classList.add('indet'); barI.style.width = ''; loadEl.classList.add('on'); }
function hideLoading(){ loadEl.classList.remove('on'); }

/* HEAD 预取文件总大小（作为进度分母的兜底；失败静默返回 0） */
async function probeSize(url){
  let abs;
  try { abs = new URL(url, location.href); } catch (e) { return 0; }
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return 0;
  try {
    const r = await fetch(abs.href, { method: 'HEAD' });
    if (r.ok){
      const n = parseInt(r.headers.get('Content-Length') || '0', 10);
      if (n > 0) return n;
    }
  } catch (e) {}
  return 0;
}

/* 自控 XHR 下载，进度事件必定触发（XHR 会随进度回调，且至少触发一次） */
function downloadWithProgress(url, onP){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onprogress = e => { if (onP) onP(e); };
    xhr.onload = () => {
      if (xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) resolve(xhr.response);
      else reject(new Error('HTTP ' + xhr.status));
    };
    xhr.onerror = () => reject(new Error('网络错误，无法访问 ' + url));
    xhr.onabort = () => reject(new Error('下载已中断'));
    xhr.send();
  });
}

async function loadModelByExt(ext, url, manager, opts = {}){
  const name = opts.progressName || '';
  /* 总大小兜底：事件自带 total → 已知大小（File.size 或 HEAD 预取） */
  let known = opts.knownSize || 0;
  if (!known) known = await probeSize(url);

  let lastPct = -1;
  const onP = e => {
    if (!name || !e) return;
    const total = e.total > 0 ? e.total : known;
    if (total > 0){
      const pct = Math.min(100, Math.round(e.loaded / total * 100));
      if (pct !== lastPct){
        lastPct = pct;
        bar.classList.remove('indet');
        barI.style.width = pct + '%';
        $('load-name').textContent = name + ' · ' + pct + '%';
      }
    } else if (e.loaded > 0){
      /* 完全拿不到总大小时至少显示已下载字节数 */
      $('load-name').textContent = name + ' · 已下载 ' + (e.loaded / 1048576).toFixed(1) + ' MB';
    }
  };

  /* FBX 的内部纹理路径解析依赖加载器自身逻辑，保留原有 loadAsync 通道（同样接进度回调） */
  if (ext === 'fbx') return await new FBXLoader(manager).loadAsync(url, onP);

  /* 其余格式：先自控下载（可靠进度），再交给各加载器的 parse() 解析 */
  const data = await downloadWithProgress(url, onP);
  if (!data || !data.byteLength) throw new Error('文件内容为空');
  if (name) $('load-name').textContent = name + ' · 解析中…';
  const asText = () => new TextDecoder('utf-8').decode(data);
  const base = THREE.LoaderUtils.extractUrlBase(url);

  if (ext === 'glb' || ext === 'gltf'){
    const loader = new GLTFLoader(manager);
    loader.setDRACOLoader(dracoLoader);
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await new Promise((resolve, reject) =>
      loader.parse(ext === 'glb' ? data : asText(), base, resolve, reject));
    const s = gltf.scene;
    s.animations = gltf.animations || [];
    return s;
  }
  if (ext === 'obj'){
    const loader = new OBJLoader(manager);
    if (opts.mtl){
      const mats = await new MTLLoader(manager).loadAsync(opts.mtl);
      mats.preload();
      loader.setMaterials(mats);
    }
    return loader.parse(asText());
  }
  if (ext === 'stl'){
    const geo = new STLLoader(manager).parse(data);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0xb9c2cf, metalness: .2, roughness: .55, side: THREE.DoubleSide
    }));
  }
  if (ext === 'ply'){
    const geo = new PLYLoader(manager).parse(data);
    if (!geo.attributes.normal && geo.index) geo.computeVertexNormals();
    const hasCol = !!geo.attributes.color;
    geo.computeBoundingSphere();
    if (!geo.index){
      return new THREE.Points(geo, new THREE.PointsMaterial({
        size: Math.max(geo.boundingSphere.radius * .004, 1e-4),
        vertexColors: hasCol, color: hasCol ? 0xffffff : 0xb9c2cf
      }));
    }
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: hasCol ? 0xffffff : 0xb9c2cf, vertexColors: hasCol,
      metalness: .15, roughness: .6, side: THREE.DoubleSide
    }));
  }
  throw new Error('不支持的格式 .' + ext);
}

async function handleFiles(list){
  const files = [...list];
  if (!files.length) return;
  const byExt = t => files.find(f => f.name.toLowerCase().endsWith('.' + t));
  let main = null;
  for (const t of ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply']){
    const f = byExt(t);
    if (f){ main = f; break; }
  }
  if (!main){ toast('未找到支持的模型格式（GLB / GLTF / OBJ / FBX / STL / PLY）', 'error'); return; }

  const map = new Map(files.map(f => [f.name.toLowerCase(), URL.createObjectURL(f)]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier(url => {
    const base = decodeURIComponent(url).split(/[\\/]/).pop().toLowerCase();
    return map.get(base) || url;
  });
  const url = map.get(main.name.toLowerCase());
  const type = main.name.toLowerCase().split('.').pop();
  const mtl = byExt('mtl');
  showLoading(main.name);
  try {
    const obj = await loadModelByExt(type, url, manager, {
      mtl: mtl ? map.get(mtl.name.toLowerCase()) : null,
      progressName: main.name,
      knownSize: main.size        /* 本地文件总大小已知，直接作为进度分母 */
    });
    setModel(obj, main.name);
    $('hint').classList.add('hide');
    toast('已载入 ' + main.name, 'success');
  } catch (err){
    console.error(err);
    window.__lastErr = err && err.stack ? err.stack : String(err);
    toast('加载失败：' + (err && err.message ? err.message : '未知错误'), 'error');
  } finally {
    for (const [, u] of map) URL.revokeObjectURL(u);
    hideLoading();
  }
}

/* ================= 示例模型（内置 + 本地下拉） ================= */
let curSample = 0;
function loadBuiltinSample(){
  const geo = new THREE.TorusKnotGeometry(1, .32, 240, 40);
  const mat = new THREE.MeshStandardMaterial({ color: 0xcfd6e4, metalness: .85, roughness: .28 });
  const mesh = new THREE.Mesh(geo, mat);
  const grp = new THREE.Group();
  grp.add(mesh);
  setModel(grp, '示例模型 · 环面纽结');
}
async function loadUrlSample(item){
  showLoading(item.name);
  try {
    const ext = (item.url.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
    const obj = await loadModelByExt(ext, item.url, new THREE.LoadingManager(), { progressName: item.name });
    setModel(obj, item.name);
    $('hint').classList.add('hide');
    toast('已载入 ' + item.name, 'success');
    return true;                    /* ← 新增：成功 */
  } catch (err){
    console.error(err);
    toast('加载失败（请检查路径 ' + item.url + '）：' + (err && err.message ? err.message : '未知错误'), 'error');
    return false;                   /* ← 新增：失败 */
  } finally {
    hideLoading();
  }
}
function selectSample(i){
  const s = SAMPLE_MODELS[i];
  if (!s) return;
  curSample = i;
  buildSampleMenu();
  if (s.builtin){ loadBuiltinSample(); toast('已载入内置示例'); }
  else loadUrlSample(s);
}
function buildSampleMenu(){
  const menu = $('sample-menu');
  menu.innerHTML = '';
  SAMPLE_MODELS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = i === curSample ? 'cur' : '';
    b.innerHTML = '<span class="dot"></span>' + escapeHtml(s.name);
    b.onclick = () => { $('sample-dd').classList.remove('open'); selectSample(i); };
    menu.appendChild(b);
  });
}

/* ================= 背景亮度（50% = 默认深色主题，向左更暗，向右更亮） ================= */
const _bgTmp = new THREE.Color();
function applyBrightness(t){
  t = Math.min(1, Math.max(0, t));
  if (t <= .5){
    renderer.toneMappingExposure = .45 + (t / .5) * .55;
    _bgTmp.lerpColors(BG_DIM, BG_DARK, t * 2);
  } else {
    renderer.toneMappingExposure = 1 + ((t - .5) / .5) * .9;
    _bgTmp.lerpColors(BG_DARK, BG_LIGHT, (t - .5) * 2);
  }
  scene.background.copy(_bgTmp);
  $('vig').style.opacity = String(Math.max(0, 1 - t * 1.1));
}

/* ================= UI 事件绑定 ================= */
$('btn-open').onclick = () => $('file-input').click();
$('file-input').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });

const sampleDD = $('sample-dd');
$('btn-sample').onclick = () => sampleDD.classList.toggle('open');
document.addEventListener('pointerdown', e => { if (!sampleDD.contains(e.target)) sampleDD.classList.remove('open'); });

document.querySelectorAll('#shade-seg button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#shade-seg button').forEach(x => x.classList.toggle('active', x === b));
  applyShading(b.dataset.shade);
});
document.querySelectorAll('#cam-seg button').forEach(b => b.onclick = () => setCameraMode(b.dataset.cam));

$('btn-outline').onclick = () => setOutline(!outlineOn);
$('btn-axes').onclick = () => setAxesOn(!axesOn);
$('btn-grid').onclick = () => setGridOn(!gridOn);

document.querySelectorAll('.rotbtn[data-ax]').forEach(b => b.onclick = () => setRotAxis(b.dataset.ax));
$('btn-rot-stop').onclick = stopRotation;
$('rng-rot').oninput = e => {
  rotSpeed = parseFloat(e.target.value);
  $('spd-val').textContent = rotSpeed + '°/s';
};
$('rng-bri').oninput = e => {
  const t = e.target.value / 100;
  $('bri-val').textContent = e.target.value + '%';
  applyBrightness(t);
};
/* 模型亮度滑块（0.00×–2.00×，默认 1.00×） */
$('rng-mdl-bri').oninput = e => {
  modelBrightness = e.target.value / 100;
  $('mdl-bri-val').textContent = modelBrightness.toFixed(2) + '×';
  applyModelBrightness(modelBrightness);
};
$('chk-anim').onchange = e => { animPlaying = e.target.checked; };

$('btn-fit').onclick = () => fitView(true);
$('btn-reset').onclick = () => fitView(true, ISODIR);
$('btn-model-reset').onclick = () => { resetModelTransform(); toast('模型已复位'); };
document.querySelectorAll('#viewgrid button').forEach(b => b.onclick = () => snapView(b.dataset.view));

$('btn-panel').onclick = () => document.body.classList.toggle('panel-off');
$('btn-fs').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
};
$('btn-shot').onclick = () => {
  renderer.clear();
  renderer.setViewport(0, 0, W, H);
  renderer.setScissorTest(false);
  renderer.render(scene, camera);
  renderer.domElement.toBlob(b => {
    if (!b){ toast('截图失败', 'error'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = ((currentName || 'scene').replace(/\.[^.]+$/, '') || 'scene') + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    toast('截图已保存', 'success');
  });
};

/* 拖放载入 */
let dragDepth = 0;
addEventListener('dragenter', e => {
  e.preventDefault();
  if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')){
    dragDepth++;
    $('drop').classList.add('on');
  }
});
addEventListener('dragover', e => e.preventDefault());
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop').classList.remove('on');
});
addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.remove('on');
  if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

/* 双击聚焦 */
renderer.domElement.addEventListener('dblclick', e => {
  if (!model) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(model, true);
  if (!hits.length) return;
  const p = hits[0].point.clone();
  const delta = p.clone().sub(controls.target);
  animateCam(camera.position.clone().add(delta), p, {}, 380);
});

/* 快捷键 */
const KEY_VIEWS = { '1':'front', '2':'back', '3':'left', '4':'right', '5':'top', '6':'bottom', '7':'iso' };
addEventListener('keydown', e => {
  if (/input|textarea|select/i.test(e.target.tagName)) return;
  const k = e.key;
  if (k === ' '){
    e.preventDefault();
    setRotAxis('y');
  }
  else if (k === 'f' || k === 'F') fitView(true);
  else if (k === 'r' || k === 'R') fitView(true, ISODIR);
  else if (k === 'g' || k === 'G') setGridOn(!gridOn);
  else if (k === 'x' || k === 'X') setAxesOn(!axesOn);
  else if (k === 'o' || k === 'O') setOutline(!outlineOn);
  else if (k === 'c' || k === 'C') setCameraMode(camMode === 'ortho' ? 'persp' : 'ortho');
  else if (k === 'Escape') sampleDD.classList.remove('open');
  else if (KEY_VIEWS[k]) snapView(KEY_VIEWS[k]);
});

/* ================= 自适应尺寸 ================= */
function resize(){
  W = vp.clientWidth || 1;
  H = vp.clientHeight || 1;
  renderer.setSize(W, H);
  persp.aspect = W / H;
  persp.updateProjectionMatrix();
  updateOrtho();
  const r = $('gizmo').getBoundingClientRect();
  const v = vp.getBoundingClientRect();
  gizmoRect = { x: r.left - v.left, y: H - (r.bottom - v.top), w: r.width, h: r.height };
}
function syncTopbarH(){
  document.documentElement.style.setProperty('--tbh', $('topbar').offsetHeight + 'px');
}
new ResizeObserver(resize).observe(vp);
new ResizeObserver(syncTopbarH).observe($('topbar'));
addEventListener('resize', () => { resize(); syncTopbarH(); });

/* ================= 主循环 ================= */
const clock = new THREE.Clock();
function loop(){
  requestAnimationFrame(loop);
  const dt = clock.getDelta();
  if (mixer && animPlaying) mixer.update(dt);
  controls.update();
  stepAnim(performance.now());
  stepModelRotation(dt);

  renderer.clear();
  renderer.setViewport(0, 0, W, H);
  renderer.setScissorTest(false);
  renderer.render(scene, camera);

  renderer.clearDepth();
  const g = gizmoRect || { x: W - 104, y: 12, w: 92, h: 92 };
  renderer.setViewport(g.x, g.y, g.w, g.h);
  renderer.setScissor(g.x, g.y, g.w, g.h);
  renderer.setScissorTest(true);
  updateGizmoCam();
  renderer.render(gizmoScene, gizmoCam);
  renderer.setScissorTest(false);
}

/* ================= 启动 ================= */
/* ================= 启动 ================= */
resize();
syncTopbarH();
applyBrightness(.75);
setOutline(true);          /* ← 新增这一行：轮廓线默认开启 */
buildSampleMenu();
loadBuiltinSample();       /* 或你配置的 INITIAL_MODEL 异步载入，均不受影响 */
if (innerWidth < 760) document.body.classList.add('panel-off');
loop();


/* 初始载入：优先 index.html 的 window.INITIAL_MODEL，
 * 未配置或载入失败（路径错误/文件缺失）时自动回退内置三叶结，页面不会空白。 */
(async function initLoad(){
  const cfg = window.INITIAL_MODEL;
  if (cfg && cfg.url){
    curSample = SAMPLE_MODELS.findIndex(s => s.url === cfg.url);  /* 在列表中则高亮，否则 -1 无高亮 */
    buildSampleMenu();
    const name = cfg.name || cfg.url.split('/').pop() || cfg.url;
    if (await loadUrlSample({ name, url: cfg.url })) return;      /* 载入成功，结束 */
  }
  curSample = SAMPLE_MODELS.findIndex(s => s.builtin);            /* 回退三叶结并同步菜单高亮 */
  if (curSample < 0) curSample = 0;
  buildSampleMenu();
  loadBuiltinSample();
})();

if (innerWidth < 760) document.body.classList.add('panel-off');
loop();
