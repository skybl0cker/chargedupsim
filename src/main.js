import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/RoomEnvironment.js';
import { FIELD } from './constants.js';
import { W, initMaterials } from './util.js';
import { initPhysics, createWorld, phys } from './physics.js';
import { buildField, driverStationY } from './field.js';
import { Game } from './game.js';
import { Input } from './input.js';
import { ACTIONS, defaultBindings, keyName, padName, normKey } from './controls.js';
import { HUD } from './hud.js';
import { Sound } from './sound.js';
import { AIController, planPath } from './ai.js';

const L = FIELD.length;
const FW = FIELD.width;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ renderer
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
const orbit = new OrbitControls(camera, canvas);
orbit.enabled = false;
orbit.target.copy(W(L / 2, FW / 2, 0));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let scene = null;
let envTex = null;
let field = null;
let game = null;
let config = null;
let paused = false;
const input = new Input();
const hud = new HUD();
const sound = new Sound();

function buildScene(gfx) {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d12);
  scene.fog = new THREE.Fog(0x0b0d12, 28, 70);
  initMaterials();
  // soft studio reflections so aluminum/polycarbonate read correctly
  if (!envTex) envTex = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.55;
  const hemi = new THREE.HemisphereLight(0xe6edff, 0x3a3a34, 1.0);
  scene.add(hemi);
  // arena truss lights
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.copy(W(L / 2 - 3, FW / 2 - 5, 14));
  sun.target.position.copy(W(L / 2, FW / 2, 0));
  scene.add(sun, sun.target);
  if (gfx === 'high') {
    renderer.shadowMap.enabled = true;
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const s = sun.shadow.camera;
    s.left = -11; s.right = 11; s.top = 8; s.bottom = -8; s.near = 1; s.far = 40;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
  } else renderer.shadowMap.enabled = false;
  for (const [x, y] of [[2, 1], [2, 7], [L - 2, 1], [L - 2, 7], [L / 2, 4]]) {
    const pl = new THREE.PointLight(0xffffff, 18, 14, 1.6);
    pl.position.copy(W(x, y, 6));
    scene.add(pl);
  }
  // simple arena: stands silhouettes & truss
  const standMat = new THREE.MeshStandardMaterial({ color: 0x1a1d25, roughness: 1 });
  for (const s of [-1, 1]) {
    const stands = new THREE.Mesh(new THREE.BoxGeometry(L + 8, 4, 6), standMat);
    stands.position.copy(W(L / 2, s < 0 ? -6.5 : FW + 6.5, 1.5));
    stands.rotation.x = s * 0.5;
    scene.add(stands);
  }
  const truss = new THREE.MeshStandardMaterial({ color: 0x3a3f48, metalness: 0.6, roughness: 0.5 });
  for (const x of [-1.5, L + 1.5]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, FW + 3), truss);
    t.position.copy(W(x, FW / 2, 7));
    scene.add(t);
    // scoreboard screens above alliance walls
    const scr = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 3), new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: 0x112244, emissiveIntensity: 0.6 }));
    scr.position.copy(W(x, FW / 2, 5.6));
    scene.add(scr);
    // arena screens show the game + season branding
    for (const [file, dy, w] of [['assets/charged-up.png', -0.75, 1.3], ['assets/first-energize-light.png', 0.8, 1.2]]) {
      const tex = new THREE.TextureLoader().load(file, (t) => {
        sign.scale.y = (w * t.image.height) / t.image.width;
      });
      tex.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
      sign.position.copy(W(x + (x < 0 ? 0.06 : -0.06), FW / 2 + dy, 5.6));
      sign.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2;
      scene.add(sign);
    }
  }
  field = buildField(scene);
}

// ------------------------------------------------------------ cameras
const CAMS = ['Third person', 'Driver station', 'Chase', 'Robot POV', 'Overhead', 'Broadcast', 'Free orbit'];
let camIdx = 0;
let camFlip = 1; // third person: 1 = behind the robot looking downfield, -1 = looking back at our grid
input.handlers.flip = () => {
  if (CAMS[camIdx] !== 'Third person') { camIdx = 0; orbit.enabled = false; } else camFlip = -camFlip;
};
input.handlers.camera = () => {
  camIdx = (camIdx + 1) % CAMS.length;
  orbit.enabled = CAMS[camIdx] === 'Free orbit';
  if (orbit.enabled) {
    camera.position.copy(W(L / 2, -5, 9));
    orbit.target.copy(W(L / 2, FW / 2, 0));
  }
};
const TP_BACK = 5.4; // third-person distance behind the robot (m)
const TP_HEIGHT = 3.6; // third-person camera height (m)
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();

function updateCamera(dt) {
  if (!game) return;
  const name = CAMS[camIdx];
  if (name === 'Free orbit') { orbit.update(); return; }
  const p = game.player;
  const a = config.alliance;
  const s = a === 'blue' ? 1 : -1;
  const pp = p ? p.pose() : { x: L / 2, y: FW / 2, yaw: 0 };
  let pos, look;
  // which way "W" points on screen: third person follows the flip, other views use the driver's side
  input.viewDir = name === 'Third person' ? s * camFlip : s;
  if (name === 'Third person') {
    // follows the robot's position only; never rotates with it
    const d = s * camFlip;
    // constant offset; walls between the camera and the robot are hidden below instead
    pos = W(pp.x - d * TP_BACK, pp.y, TP_HEIGHT);
    look = W(pp.x + d * 2.2, pp.y, 0.35);
  } else if (name === 'Driver station') {
    const y = driverStationY(config.station);
    pos = W(a === 'blue' ? -0.9 : L + 0.9, y, 1.85);
    // drivers turn their heads: look partly toward the robot
    const base = W(a === 'blue' ? 7 : L - 7, FW / 2, 0);
    look = base.lerp(W(pp.x, pp.y, 0.3), 0.55);
  } else if (name === 'Chase') {
    pos = W(pp.x - Math.cos(pp.yaw) * 4.0, pp.y - Math.sin(pp.yaw) * 4.0, 2.8);
    look = W(pp.x + Math.cos(pp.yaw) * 1.5, pp.y + Math.sin(pp.yaw) * 1.5, 0.6);
  } else if (name === 'Robot POV') {
    pos = W(pp.x - Math.cos(pp.yaw) * 0.25, pp.y - Math.sin(pp.yaw) * 0.25, 1.15);
    look = W(pp.x + Math.cos(pp.yaw) * 3, pp.y + Math.sin(pp.yaw) * 3, 0.5);
  } else if (name === 'Overhead') {
    pos = W(L / 2 - s * 0.01, FW / 2 - 0.5, 15.5);
    look = W(L / 2, FW / 2, 0);
  } else {
    pos = W(pp.x * 0.35 + L / 2 * 0.65, -5.5, 5.5);
    look = W(pp.x * 0.5 + L / 2 * 0.5, FW / 2, 0);
  }
  const k = 1 - Math.exp(-dt * (name === 'Robot POV' ? 30 : 6));
  camPos.lerp(pos, k);
  camLook.lerp(look, k);
  camera.position.copy(camPos);
  if (name === 'Overhead') camera.up.set(s, 0, 0); else camera.up.set(0, 1, 0);
  camera.lookAt(camLook);
  // hide the upper alliance wall / double substation structure when the camera is behind it
  const behindBlue = camera.position.x < 0.05;
  const behindRed = camera.position.x > L - 0.05;
  for (const m of field.endUpper.blue) m.visible = !behindBlue;
  for (const m of field.endUpper.red) m.visible = !behindRed;
}

// ------------------------------------------------------------ game lifecycle
// Single player defaults (menu options come back when more robots are added)
function readConfig(practice = false) {
  return {
    alliance: 'blue',
    station: +(document.getElementById('optStation')?.value ?? 1), // 0 scoring table side, 1 center, 2 loading zone side
    driveMode: 'swerve',
    robot: document.getElementById('optRobot')?.value || '2910',
    autoRoutine: document.getElementById('optAuto')?.value || 'high_mobility_engage',
    staging: 'mixed',
    gfx: 'high',
    practice,
  };
}

function startGame(cfg) {
  config = cfg;
  if (game) game.dispose();
  createWorld();
  buildScene(cfg.gfx);
  game = new Game(scene, field, cfg, {
    toast: (m, a) => hud.toast(m, a),
    foul: (f) => hud.toast(`${f.tech ? 'TECH FOUL' : 'FOUL'} · ${f.rule} ${f.desc} (+${f.tech ? 12 : 5} ${f.alliance === 'blue' ? 'RED' : 'BLUE'})`, null, 'foul'),
    sound: (s) => sound.play(s),
    matchOver: (res) => {
      hud.results(res);
      setTimeout(() => $('results').classList.remove('hidden'), 600);
    },
  });
  document.activeElement?.blur?.(); // Space flips the camera; don't leave a button focused
  $('menu').classList.add('hidden');
  $('results').classList.add('hidden');
  $('pause').classList.add('hidden');
  paused = false;
  hud.show(true);
  camIdx = 0;
  camFlip = 1;
  orbit.enabled = false;
  input.reset();
  const p = game.player.pose();
  const sgn = cfg.alliance === 'blue' ? 1 : -1;
  camPos.copy(W(p.x - sgn * TP_BACK, p.y, TP_HEIGHT));
  camLook.copy(W(p.x + sgn * 2.2, p.y, 0.35));
  accumulator = 0;
}

input.handlers.pause = () => {
  if (!$('controls').classList.contains('hidden')) { closeControls(); return; }
  if (!game || !$('menu').classList.contains('hidden') || !$('results').classList.contains('hidden')) return;
  paused = !paused;
  $('pause').classList.toggle('hidden', !paused);
};
input.handlers.help = () => $('help').classList.toggle('hidden');

// remember the robot / auto picks between visits
for (const id of ['optRobot', 'optAuto', 'optStation']) {
  const el = $(id);
  try {
    const saved = localStorage.getItem(id);
    if (saved && [...el.options].some((o) => o.value === saved)) el.value = saved;
  } catch {}
  el.addEventListener('change', () => { try { localStorage.setItem(id, el.value); } catch {} });
}
$('btnMatch').onclick = () => { sound.unlock(); startGame(readConfig(false)); };
$('btnResume').onclick = () => input.handlers.pause();
$('btnRestart').onclick = () => startGame(config);
$('btnAgain').onclick = () => startGame(config);
const toMenu = () => {
  paused = false;
  $('pause').classList.add('hidden');
  $('results').classList.add('hidden');
  $('menu').classList.remove('hidden');
  hud.show(false);
};
$('btnMenu').onclick = toMenu;

// ------------------------------------------------------------ controls remapping
const bindLabel = (id) => [keyName(input.bindings.kb[id]), padName(input.bindings.gp[id])].filter(Boolean).join('  ·  ') || '—';
function renderHelp() {
  $('helpTable').innerHTML = ACTIONS.map((a) => `<tr><td>${bindLabel(a.id)}</td><td>${a.label}</td></tr>`).join('');
}
let listening = null; // { id, dev: 'kb' | 'gp', base }
function renderControls() {
  const b = input.bindings;
  let html = '';
  let group = '';
  for (const a of ACTIONS) {
    if (a.group !== group) {
      group = a.group;
      html += `<tr><th>${group}</th><th>Keyboard</th><th>Gamepad</th></tr>`;
    }
    const cell = (dev, name) => {
      const on = listening && listening.id === a.id && listening.dev === dev;
      return `<td class="bind"><button class="bindbtn${on ? ' listen' : name ? '' : ' empty'}" data-id="${a.id}" data-dev="${dev}">${on ? 'Press…' : name || 'none'}</button></td>`;
    };
    html += `<tr><td>${a.label}</td>${cell('kb', keyName(b.kb[a.id]))}${cell('gp', padName(b.gp[a.id]))}</tr>`;
  }
  $('ctlTable').innerHTML = html;
  renderHelp();
}
function assign(value) {
  const { id, dev } = listening;
  const b = { kb: { ...input.bindings.kb }, gp: { ...input.bindings.gp } };
  if (value) for (const k in b[dev]) if (b[dev][k] === value) b[dev][k] = null; // one action per key / button
  b[dev][id] = value;
  input.setBindings(b);
  stopListening();
}
function stopListening() {
  listening = null;
  input.capture = null;
  document.activeElement?.blur?.();
  renderControls();
}
function padSnapshot() {
  const gp = input.gamepad();
  return gp ? { buttons: gp.buttons.map((x) => x.value > 0.5), axes: gp.axes.map((x) => Math.abs(x) > 0.3) } : { buttons: [], axes: [] };
}
$('ctlTable').addEventListener('click', (e) => {
  const btn = e.target.closest('.bindbtn');
  if (!btn) return;
  listening = { id: btn.dataset.id, dev: btn.dataset.dev, base: padSnapshot() };
  input.capture = ({ key }) => {
    if (key === 'Escape') stopListening();
    else if (key === 'Backspace' || key === 'Delete') assign(null);
    else if (listening.dev === 'kb') assign(normKey(key));
  };
  renderControls();
});
function watchControls() {
  if ($('controls').classList.contains('hidden')) return;
  requestAnimationFrame(watchControls);
  const gp = input.gamepad();
  $('ctlPad').textContent = gp ? `Gamepad connected` : 'No gamepad detected (press a button on it)';
  if (!listening || listening.dev !== 'gp' || !gp) return;
  const base = listening.base;
  const bi = gp.buttons.findIndex((x, i) => x.value > 0.5 && !base.buttons[i]);
  if (bi >= 0) return assign('b' + bi);
  const ai = gp.axes.findIndex((x, i) => Math.abs(x) > 0.6 && !base.axes[i]);
  if (ai >= 0) return assign(`a${ai}${gp.axes[ai] > 0 ? '+' : '-'}`);
  // release anything that was held when listening started so it can be picked next
  gp.buttons.forEach((x, i) => { if (x.value < 0.2) base.buttons[i] = false; });
  gp.axes.forEach((x, i) => { if (Math.abs(x) < 0.2) base.axes[i] = false; });
}
function openControls() {
  $('controls').classList.remove('hidden');
  renderControls();
  watchControls();
}
function closeControls() {
  stopListening();
  $('controls').classList.add('hidden');
}
$('btnControls').onclick = openControls;
$('btnControls2').onclick = openControls;
$('ctlDone').onclick = closeControls;
$('ctlResetKb').onclick = () => { input.setBindings({ kb: defaultBindings().kb, gp: { ...input.bindings.gp } }); stopListening(); };
$('ctlClearGp').onclick = () => { input.setBindings({ kb: { ...input.bindings.kb }, gp: defaultBindings().gp }); stopListening(); };
renderHelp();
$('btnResMenu').onclick = toMenu;

// ------------------------------------------------------------ main loop
let timeScale = 1;
let accumulator = 0;
let last = performance.now();
let simTime = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  input.poll();
  if (game && !paused) {
    accumulator += dt * timeScale;
    let steps = 0;
    const maxSteps = 6 * timeScale;
    while (accumulator >= phys.dt && steps < maxSteps) {
      game.preStep(phys.dt, input);
      for (const r of game.robots) r.physicsStep(phys.dt, game);
      phys.world.step();
      game.update(phys.dt);
      accumulator -= phys.dt;
      simTime += phys.dt;
      steps++;
    }
    if (steps === maxSteps) accumulator = 0;
    for (const r of game.robots) r.sync(simTime);
    for (const pc of game.pieces) if (pc.state !== 'scored') pc.sync();
    for (const a of ['blue', 'red']) {
      field.cs[a].sync();
      // DRIVER STATION LED strings fill with LINKS (1 LINK = 20%)
      const leds = field.dsLeds[a];
      const lit = Math.round((Math.min(5, game.linkCount(a)) / 5) * leds.length);
      const hex = a === 'blue' ? 0x2a62ff : 0xff3030;
      leds.forEach((l, i) => l.mat.emissive.setHex(i < lit ? hex : 0x000000));
    }
    hud.update(game, CAMS[camIdx] === 'Third person' ? `Third person (${camFlip > 0 ? 'front' : 'back'})` : CAMS[camIdx]);
  }
  if (scene) {
    updateCamera(dt);
    renderer.render(scene, camera);
  }
}

// ------------------------------------------------------------ boot
(async () => {
  await initPhysics();
  // idle background scene behind the menu
  buildScene('low');
  camera.position.copy(W(-2, -3, 6));
  camera.lookAt(W(L / 2, FW / 2, 0));
  for (const a of ['blue', 'red']) field.cs[a].sync();
  $('loading').classList.add('hidden');
  requestAnimationFrame(frame);
})();

// debug handle for testing from the console
window.__sim = { get physWorld() { return phys.world; }, physInfo: phys.info, setTimeScale: (s) => { timeScale = s; }, AIController, planPath, get game() { return game; }, get field() { return field; }, camera, orbit, setCam: (i) => { camIdx = i; orbit.enabled = CAMS[i] === 'Free orbit'; } };
