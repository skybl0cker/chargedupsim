import * as THREE from 'three';
import { IN } from '../constants.js';
import { MAT, box, clamp, canvasTexture } from '../util.js';

// FRC 4414 HighTide — 2023 robot "Tsunami" (2023 World Champions).
// No CAD or code was released, so this is built from competition photos and their Chief Delphi build thread:
// 26x26 frame, ~125 lb, MK4i Falcon swerve, a continuous belt-driven elevator slanted forward (low at the back,
// high at the front, reaching out over the grid) and a 1323-style arm + roller claw on the carriage.
// From their reveal video: with the carriage at the bottom, the arm swings out past the low (back) end to pick
// standing and tipped cones off the carpet; cubes come in a pivoting floor intake that flips down off the front
// and hands them to the claw. Black anodized tube with teal crossbars, a cable carrier along the elevator,
// and a black sponsor panel on each side.
const deg = (d) => (d * Math.PI) / 180;
const THETA = deg(37); // elevator slant from the carpet
const U = [Math.cos(THETA), Math.sin(THETA)]; // along the elevator
const BASE = [-0.27, 0.13]; // bottom of the elevator (x from robot center, height off the carpet)
const RAIL = 0.75; // outer stage length
const R0 = 0.3; // carriage (arm pivot) distance up the elevator when fully down
const E_MAX = 1.25; // carriage travel (3 stages, continuous rigging)
const ARM = 0.45; // arm pivot -> roller axles
const HOLD = 0.17; // roller axles -> center of a held piece
const REACH = ARM + HOLD;
const A_LIM = [deg(-80), deg(200)];
const V_E = 3.0, V_A = deg(600); // very fast and light, per the team
const CI_PIVOT = [0.35, 0.16]; // cube intake pivot at the front of the frame
const CI_LEN = 0.38;
const CI_UP = deg(100), CI_DOWN = deg(-28);
const CI_CUBE = [0.24, 0.08]; // cube center in the intake's frame (along it, toward its rollers)
const V_CI = deg(600), V_SCOOP = deg(150);
// where a cube in the intake sits for intake angle phi
function ciCube(phi) {
  const c = Math.cos(phi), s = Math.sin(phi);
  return [CI_PIVOT[0] + CI_CUBE[0] * c - CI_CUBE[1] * s, CI_PIVOT[1] + CI_CUBE[0] * s + CI_CUBE[1] * c];
}
const CI_POINT = ciCube(CI_DOWN); // cube on the carpet in front of the bumper

// piece position for carriage travel e and arm angle a (from the carpet)
function holdAt(e, a) {
  const r = R0 + e;
  return [BASE[0] + r * U[0] + REACH * Math.cos(a), BASE[1] + r * U[1] + REACH * Math.sin(a)];
}

// inverse kinematics: carriage travel + arm angle that put the piece at (x, h).
// Along the slant h = BASE_h + tanθ·(x − BASE_x) + REACH·sin(a − θ)/cosθ, so the arm angle has a closed form.
function solve(x, h) {
  const s = ((h - BASE[1] - Math.tan(THETA) * (x - BASE[0])) * Math.cos(THETA)) / REACH;
  const a = THETA + Math.asin(clamp(s, -1, 1));
  const e = clamp((x - BASE[0] - REACH * Math.cos(a)) / U[0] - R0, 0, E_MAX);
  return { e, a };
}

// piece targets (x forward of robot center, height of the piece center), matched to what scores on the field
const POSES = {
  stow: { e: 0, a: deg(50) }, // claw tucked at the top front of the elevator
  hybrid: solve(0.6, 0.28),
  midCone: solve(1.03, 0.98),
  midCube: solve(0.9, 0.74),
  highCone: solve(1.45, 1.29),
  highCube: solve(1.28, 1.04),
  double: solve(0.69, 1.15),
  single: { e: 0, a: deg(80) },
  // cones (standing or tipped): carriage at the bottom, arm swung out past the back bumper
  groundCone: { e: 0, a: Math.PI - Math.asin((0.15 - BASE[1] - R0 * U[1]) / REACH) },
};

// cube handoff: the claw waits low in front, pointing out over the bumper, exactly where the intake
// lifts the cube to (the claw hold point sits at the cube's radius from the intake pivot)
{
  const r = Math.hypot(...CI_CUBE);
  const dist = (a) => { const [x, h] = holdAt(0, a); return Math.hypot(x - CI_PIVOT[0], h - CI_PIVOT[1]); };
  let lo = deg(-40), hi = deg(30);
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (dist(m) < r) lo = m; else hi = m; }
  POSES.handoff = { e: 0, a: (lo + hi) / 2 };
}
const CI_HANDOFF = (() => {
  const [x, h] = holdAt(0, POSES.handoff.a);
  return Math.atan2(h - CI_PIVOT[1], x - CI_PIVOT[0]) - Math.atan2(CI_CUBE[1], CI_CUBE[0]);
})();

export class Elev4414 {
  constructor(robot) {
    this.robot = robot;
    this.q = { ...POSES.stow };
    this.qt = { ...POSES.stow };
    this.staging = false; // cube being lifted from the floor intake into the claw
    this.stageT = 0;
    this.after = null; // preset asked for during the handoff, applied once the claw has the cube
    this.ci = CI_UP; // cube intake angle (folded up / flipped down onto the carpet in front)
  }

  // ---------------------------------------------------------------- visuals
  build(root) {
    const fy = (h) => h - this.robot.floorY;
    const black = new THREE.MeshStandardMaterial({ color: 0x1c1d20, metalness: 0.55, roughness: 0.4 });
    const teal = new THREE.MeshStandardMaterial({ color: 0x17a398, metalness: 0.5, roughness: 0.35 });
    const roller = new THREE.MeshStandardMaterial({ color: 0x2a2b2e, metalness: 0.1, roughness: 0.75 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.85, roughness: 0.3 });
    const ledGreen = new THREE.MeshStandardMaterial({ color: 0x5dff7a, emissive: 0x2bff52, emissiveIntensity: 1.6 });
    const zf = this.robot.frameY / 2 - 0.01; // just inside the frame perimeter
    const xb = this.robot.frameX / 2 - 0.01;

    // black sponsor panels: a triangle on each side, tall at the front
    const tri = new THREE.Shape();
    const tip = [BASE[0] + RAIL * U[0], BASE[1] + RAIL * U[1]];
    tri.moveTo(-xb, 0.1);
    tri.lineTo(tip[0], 0.1);
    tri.lineTo(tip[0], tip[1] - 0.02);
    tri.closePath();
    const triGeo = new THREE.ShapeGeometry(tri);
    const uv = triGeo.attributes.uv, pos = triGeo.attributes.position;
    for (let k = 0; k < pos.count; k++) uv.setXY(k, (pos.getX(k) + xb) / (tip[0] + xb), (pos.getY(k) - 0.1) / (tip[1] - 0.1));
    const sponsor = (flip) => canvasTexture(512, 512, (g) => {
      g.fillStyle = '#121315';
      g.fillRect(0, 0, 512, 512);
      if (flip) { g.translate(512, 0); g.scale(-1, 1); }
      g.fillStyle = '#ffffff';
      g.textAlign = 'right';
      // laid out to stay inside the triangle (its sloped edge runs corner to corner)
      const lines = [['bold 34px Arial', 'SESSA MFG.', 250], ['bold 32px Arial', 'fabworks.', 298], ['600 29px Arial', 'Google  DoDSTEM', 344], ['italic bold 25px Arial', 'FASTSIGNS', 384], ['bold 54px Arial', 'Tsunami', 448], ['19px Arial', 'Family Sponsors · Pierpont · Cold Stone', 492]];
      for (const [f, t, y] of lines) { g.font = f; g.fillText(t, 496, y); }
    });
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(triGeo, new THREE.MeshStandardMaterial({ map: sponsor(s < 0), metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide }));
      m.position.set(0, -this.robot.floorY, s * zf);
      root.add(m);
      // teal upright at the front corner, black rail along the bottom
      box(0.03, tip[1] - 0.1, 0.03, teal, new THREE.Vector3(tip[0] - 0.015, fy((tip[1] + 0.1) / 2), s * (zf - 0.02)), root);
      box(2 * xb, 0.03, 0.03, black, new THREE.Vector3(0, fy(0.115), s * (zf - 0.02)), root);
    }

    // close the wedge: a front plate and a sloped deck under the elevator
    box(0.012, tip[1] - 0.12, 2 * zf, black, new THREE.Vector3(tip[0] - 0.008, fy((tip[1] + 0.08) / 2), 0), root);
    {
      const a0 = [-xb, 0.1], a1 = [tip[0], tip[1] - 0.02];
      const len = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]), ang = Math.atan2(a1[1] - a0[1], a1[0] - a0[0]);
      const deck = box(len, 0.012, 2 * zf, black, new THREE.Vector3((a0[0] + a1[0]) / 2 + 0.045 * Math.sin(ang), fy((a0[1] + a1[1]) / 2 - 0.045 * Math.cos(ang)), 0), root);
      deck.rotation.z = ang;
    }

    // elevator: frame aligned with the slant (local x up the elevator, y off its top face)
    const gElev = new THREE.Group();
    gElev.position.set(BASE[0], fy(BASE[1]), 0);
    gElev.rotation.z = THETA;
    root.add(gElev);
    const stage = (parent, len, zr, thick, x0, yFill) => {
      box(len - 0.02, 0.008, 2 * zr, black, new THREE.Vector3(x0 + len / 2, yFill, 0), parent); // solid back between the rails
      for (const s of [-1, 1]) {
        const rl = box(len, thick, 0.028, black, new THREE.Vector3(x0 + len / 2, 0, s * zr), parent);
        rl.castShadow = true;
      }
      for (const x of [x0 + 0.03, x0 + len - 0.03]) box(0.035, 0.03, 2 * zr, teal, new THREE.Vector3(x, -0.01, 0), parent);
    };
    stage(gElev, RAIL, 0.13, 0.055, 0, -0.026);
    this.stageM = new THREE.Group();
    gElev.add(this.stageM);
    stage(this.stageM, 0.74, 0.105, 0.048, 0, -0.019);
    this.stageI = new THREE.Group();
    gElev.add(this.stageI);
    stage(this.stageI, 0.74, 0.08, 0.042, 0, -0.012);
    // cable carrier (drag chain) running up the top of the elevator
    const treadTex = canvasTexture(256, 64, (g) => {
      g.fillStyle = '#18191b';
      g.fillRect(0, 0, 256, 64);
      g.fillStyle = '#3a3c40';
      for (let x = 0; x < 256; x += 16) g.fillRect(x, 0, 6, 64); // cleats across the belt
    });
    treadTex.wrapS = treadTex.wrapT = THREE.RepeatWrapping;
    treadTex.repeat.set(3, 1);
    const treadMat = new THREE.MeshStandardMaterial({ map: treadTex, metalness: 0.2, roughness: 0.8 });
    box(RAIL - 0.04, 0.03, 0.16, treadMat, new THREE.Vector3(RAIL / 2, 0.06, 0), gElev);
    for (const x of [0.03, RAIL - 0.04]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.17, 16), steel);
      wh.rotation.x = Math.PI / 2;
      wh.position.set(x, 0.045, 0);
      gElev.add(wh);
    }
    // gussets bolting the elevator base to the frame
    for (const s of [-1, 1]) box(0.14, 0.09, 0.012, black, new THREE.Vector3(0.04, -0.04, s * 0.15), gElev);

    // carriage + arm (positioned in sync); the arm angle is measured from the carpet
    this.gArm = new THREE.Group();
    root.add(this.gArm);
    box(0.12, 0.08, 0.2, black, new THREE.Vector3(0, -0.02, 0), this.gArm).rotation.z = THETA;
    for (const s of [-1, 1]) {
      const pl = box(ARM + 0.06, 0.06, 0.01, black, new THREE.Vector3(ARM / 2, 0, s * 0.11), this.gArm);
      pl.castShadow = true;
    }
    box(ARM, 0.045, 0.21, black, new THREE.Vector3(ARM / 2, 0, 0), this.gArm); // boxed-in arm
    box(0.03, 0.05, 0.23, teal, new THREE.Vector3(ARM * 0.45, 0, 0), this.gArm);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.26, 18), steel);
    hub.rotation.x = Math.PI / 2;
    this.gArm.add(hub);
    // roller claw: solid side plates + a back plate, top and bottom rollers that grip cones and cubes
    for (const s of [-1, 1]) box(0.22, 0.27, 0.012, black, new THREE.Vector3(ARM + 0.05, 0, s * 0.17), this.gArm);
    box(0.012, 0.27, 0.34, black, new THREE.Vector3(ARM - 0.055, 0, 0), this.gArm);
    this.rollers = [];
    for (const [x, y] of [[ARM + 0.12, 0.11], [ARM + 0.12, -0.11], [ARM - 0.01, 0.08]]) {
      const ro = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.33, 18), roller);
      ro.rotation.x = Math.PI / 2;
      ro.position.set(x, y, 0);
      ro.castShadow = true;
      this.gArm.add(ro);
      this.rollers.push({ m: ro, dir: y > 0 ? 1 : -1 });
    }
    box(0.04, 0.012, 0.3, ledGreen, new THREE.Vector3(ARM + 0.02, 0.135, 0), this.gArm);

    // cube floor intake at the front: solid teal side plates, black rollers over the top of the cube, black hood
    this.gCI = new THREE.Group();
    this.gCI.position.set(CI_PIVOT[0], fy(CI_PIVOT[1]), 0);
    root.add(this.gCI);
    // side plates: a low rail plus an upright at each roller, so the cube stays visible as it rides up
    for (const s of [-1, 1]) {
      box(CI_LEN, 0.07, 0.014, teal, new THREE.Vector3(CI_LEN / 2, 0.0, s * 0.19), this.gCI);
      for (const x of [0.12, 0.31]) box(0.06, 0.24, 0.014, teal, new THREE.Vector3(x, 0.12, s * 0.19), this.gCI);
    }
    for (const x of [0.12, 0.31]) {
      const ciRoll = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.38, 18), roller);
      ciRoll.rotation.x = Math.PI / 2;
      ciRoll.position.set(x, 0.235, 0);
      this.gCI.add(ciRoll);
      this.rollers.push({ m: ciRoll, dir: 1, cube: true });
    }
    box(CI_LEN - 0.05, 0.012, 0.39, black, new THREE.Vector3((CI_LEN + 0.05) / 2, 0.278, 0), this.gCI);
    box(0.06, 0.26, 0.38, black, new THREE.Vector3(0.03, 0.115, 0), this.gCI);

    // RSL low on the side panel, mode LEDs (signal the human player) along the front of the frame
    this.rsl = new THREE.MeshStandardMaterial({ color: 0xff9a1f, emissive: 0xff7a00, emissiveIntensity: 1.5 });
    const rsl = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 10), this.rsl);
    rsl.position.set(tip[0] - 0.03, fy(0.16), zf + 0.02);
    root.add(rsl);
    this.robot.ledMat = new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0xffd400, emissiveIntensity: 1.3 });
    box(0.012, 0.012, 2 * zf - 0.06, this.robot.ledMat, new THREE.Vector3(tip[0] + 0.005, fy(0.15), 0), root);
  }

  colliders() {
    return [{ half: [0.2, 0.1, 0.15], pos: [0, 0.075 + 0.2, 0], mass: 2 }];
  }

  // ---------------------------------------------------------------- control
  poseFor(name) {
    const r = this.robot;
    const type = r.held ? r.held.type : r.mode;
    switch (name) {
      case 'stow': return POSES.stow;
      case 'hybrid': return POSES.hybrid;
      case 'mid': return type === 'cube' ? POSES.midCube : POSES.midCone;
      case 'high': return type === 'cube' ? POSES.highCube : POSES.highCone;
      case 'double': return POSES.double;
      case 'single': return POSES.single;
      // cubes come in the front floor intake, which lifts them into the claw waiting low in front
      case 'floor': return type === 'cube' ? POSES.handoff : POSES.groundCone;
      case 'handoff': return POSES.handoff;
      default: return null;
    }
  }

  setPreset(name) {
    const p = this.poseFor(name);
    if (!p) return false;
    if (this.staging) {
      // finish handing off the cube first, then go wherever the driver asked
      this.after = name;
      return true;
    }
    this.qt = { e: clamp(p.e, 0, E_MAX), a: clamp(p.a, ...A_LIM) };
    return true;
  }

  atTarget(tol = 1) {
    return Math.abs(this.q.e - this.qt.e) < 0.0254 * tol && Math.abs(this.q.a - this.qt.a) < deg(3 * tol);
  }

  cubeIntakeDown() {
    const r = this.robot;
    return r.intaking && !r.held && r.preset === 'floor' && r.mode === 'cube';
  }

  update(dt) {
    const q = this.q, t = this.qt;
    const step = (cur, tgt, v) => cur + clamp(tgt - cur, -v * dt, v * dt);
    q.e = step(q.e, t.e, V_E);
    q.a = step(q.a, t.a, V_A);
    if (this.staging) {
      // intake scoops the cube up into the claw; once it's there and settled, the claw takes it
      this.ci = step(this.ci, CI_HANDOFF, V_SCOOP);
      this.stageT += dt;
      if (Math.abs(this.ci - CI_HANDOFF) < deg(1) && this.atTarget() && this.stageT > 0.3) {
        this.staging = false;
        const next = this.after || 'stow';
        this.after = null;
        this.setPreset(next);
      }
    } else {
      this.ci = step(this.ci, this.cubeIntakeDown() ? CI_DOWN : CI_UP, V_CI);
    }
  }

  gripperAngle() {
    if (this.staging) {
      // cube tilts with the intake, from flat on the carpet to lined up with the claw
      const t = clamp((this.ci - CI_DOWN) / (CI_HANDOFF - CI_DOWN), 0, 1);
      return this.q.a * t;
    }
    return this.q.a;
  }

  clawHold() {
    return holdAt(this.q.e, this.q.a);
  }

  holdPoint() {
    // while staging the cube rides in the intake; it meets the claw at the end of the lift
    const [x, h] = this.staging ? ciCube(this.ci) : this.clawHold();
    return new THREE.Vector3(x, h - this.robot.floorY, 0);
  }

  intakePoints() {
    const pts = [];
    if (this.staging) return pts;
    if (this.ci < CI_DOWN + deg(10)) pts.push({ id: 'cubeIntake', pos: new THREE.Vector3(CI_POINT[0], CI_POINT[1] - this.robot.floorY, 0), radius: 0.26, accepts: 'cube' });
    // in cube floor mode the claw only takes cubes from the intake
    const r = this.robot;
    if (!(r.preset === 'floor' && r.mode === 'cube')) pts.push({ id: 'claw', pos: this.holdPoint(), radius: 0.26, accepts: 'any' });
    return pts;
  }

  onGrab(point) {
    if (point.id === 'cubeIntake') {
      this.staging = true;
      this.stageT = 0;
      this.after = null;
      this.qt = { ...POSES.handoff };
    }
  }

  canRelease() {
    return !this.staging;
  }

  releaseVelocity() {
    const a = this.q.a;
    return new THREE.Vector3(Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0);
  }

  // Tsunami scores everything out the front (the tall end), up the elevator
  scoreSide() {
    return 1;
  }

  substationSide() {
    return 1;
  }

  floorPickup(type) {
    // cubes: front floor intake; cones: arm out the back
    return type === 'cube' ? { side: 1, reach: CI_POINT[0] } : { side: -1, reach: -holdAt(0, POSES.groundCone.a)[0] };
  }

  // for the rules: max height and extension past the frame perimeter (front/back)
  envelope() {
    const fx = this.robot.frameX / 2;
    const r = R0 + this.q.e;
    const piv = [BASE[0] + r * U[0], BASE[1] + r * U[1]];
    const tip = [piv[0] + (REACH + 0.08) * Math.cos(this.q.a), piv[1] + (REACH + 0.08) * Math.sin(this.q.a)];
    const top = [BASE[0] + (r + 0.45) * U[0], BASE[1] + (r + 0.45) * U[1]];
    const ci = [CI_PIVOT[0] + (CI_LEN + 0.04) * Math.cos(this.ci), CI_PIVOT[1] + (CI_LEN + 0.04) * Math.sin(this.ci)];
    let maxH = 0, front = 0, back = 0;
    for (const [x, h] of [piv, tip, top, ci]) {
      maxH = Math.max(maxH, h + 0.05);
      front = Math.max(front, x - fx);
      back = Math.max(back, -x - fx);
    }
    return { maxH, front, back };
  }

  describe() {
    const tag = this.staging ? 'HANDOFF' : this.robot.preset.toUpperCase();
    return `${tag} · E${(this.q.e / IN).toFixed(0)}in A${(this.q.a * 57.3).toFixed(0)}°`;
  }

  sync() {
    const e = this.q.e;
    // continuous rigging: every stage moves together, the carriage travels the full amount
    this.stageM.position.x = e / 3;
    this.stageI.position.x = (2 * e) / 3;
    const r = R0 + e;
    this.gArm.position.set(BASE[0] + r * U[0], BASE[1] + r * U[1] - this.robot.floorY, 0);
    this.gArm.rotation.z = this.q.a;
    this.gCI.rotation.z = this.ci;
    if (this.rsl) this.rsl.emissiveIntensity = Math.floor(performance.now() / 500) % 2 ? 1.6 : 0.25;
    const r0 = this.robot;
    if (r0.intaking || this.staging) {
      for (const ro of this.rollers) if (!ro.cube || this.ci < deg(20)) ro.m.rotation.y += 0.5 * ro.dir;
    }
  }
}
