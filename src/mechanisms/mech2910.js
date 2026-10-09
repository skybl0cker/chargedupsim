import * as THREE from 'three';
import { IN } from '../constants.js';
import { MAT, box, clamp, canvasTexture } from '../util.js';

// FRC 2910 Jack in the Bot — 2023 robot "Phantom".
// Geometry, limits, speeds and every arm pose come from their public code
// (FRCTeam2910/2023CompetitionRobot-Public: ArmSubsystem.java, ArmPoseConstants.java, ArmIOFalcon500.java);
// look from their CAD release, reveal and competition photos ("26x28 frame, <17 in tall stowed, 2-stage cascade telescoping arm").
const deg = (d) => (d * Math.PI) / 180;
const PIVOT_X = -10.25 * IN; // shoulder pivot: behind robot center...
const PIVOT_H = 13.25 * IN; // ...and above the carpet (ORIGIN_PIVOT_OFFSET)
const OFFSET = (6.75 - 0.125) * IN; // arm tube runs this far off the pivot axis (ARM_PIVOT_OFFSET)
const L_MIN = 22.75 * IN, L_MAX = 53 * IN; // telescope extension (MIN/MAX_EXTENSION_LENGTH)
const SH_LIM = [0, deg(200)];
const W_LIM = [deg(-80), deg(113.1)];
const V_SH = deg(300), V_EXT = 100 * IN, V_WR = deg(1000); // motion magic cruise velocities
const HOLD = 0.25; // wrist joint -> center of a game piece in the roller intake
const RETRACT_ANGLE = deg(25); // telescope pulls in before big shoulder swings, like their ArmSubsystem

// [shoulder deg, extension in, wrist deg] straight from ArmPoseConstants.java
const pose = (s, l, w) => ({ s: deg(s), L: l * IN, w: deg(w) });
const POSES = {
  stow: pose(1.6905, 23.0, 109.608),
  hybrid: pose(26.82, 24.51575, -73.358), // L1_CONE (out the front)
  midCone: pose(138.0, 34.0, 56.41), // L2_CONE (over the back)
  midCube: pose(143.0, 33.4252, 112.6915), // L2_CUBE_BACK
  highCone: pose(141.0, 53.0, 45.0), // L3_CONE
  highCube: pose(142.3663, 52.48031, 112.7227), // L3_CUBE
  portalCone: pose(111.5, 43.5, 88.7846), // double substation, cone over the back
  portalCube: pose(59.0, 43.0, -50.0), // double substation, cube out the front
  groundCube: pose(1.6905, 26.0, 13.1927), // GROUND_CUBE (front)
  groundCone: pose(8.0, 29.13386, -61.5), // GROUND_CONE_FLAT: cones (tipped or standing) come in the front, same side as cubes
  single: pose(33.7, 22.95, 44.86), // SINGLE_SUBSTATION_CUBE
};

// wrist joint position for shoulder angle s and extension L (calcCurrentPose)
function wristPos(s, L) {
  const d = Math.hypot(OFFSET, L);
  const v = s - Math.asin(OFFSET / d);
  return [PIVOT_X + d * Math.cos(v), PIVOT_H + d * Math.sin(v)];
}

export class Arm2910 {
  constructor(robot) {
    this.robot = robot;
    this.q = { ...POSES.stow };
    this.qt = { ...POSES.stow };
    this.staging = false;
  }

  // ---------------------------------------------------------------- visuals
  build(root) {
    const fy = (h) => h - this.robot.floorY;
    // lightened (triangle-truss) aluminum, the look of 2910's arm and rails; green powder-coated plates
    const lattice = (bg, hole, w = 256, h = 64, rows = 1) => {
      const t = canvasTexture(w, h, (g) => {
        g.fillStyle = bg;
        g.fillRect(0, 0, w, h);
        g.fillStyle = hole;
        const n = Math.round((w / h) * 2 * rows);
        const ch = h / rows;
        for (let r = 0; r < rows; r++) for (let k = 0; k < n; k++) {
          const x0 = (k * w) / n, x1 = ((k + 1) * w) / n, y0 = r * ch + ch * 0.18, y1 = (r + 1) * ch - ch * 0.18, inset = (x1 - x0) * 0.16;
          g.beginPath();
          if (k % 2) { g.moveTo(x0 + inset, y0); g.lineTo(x1 - inset, y0); g.lineTo((x0 + x1) / 2, y1); }
          else { g.moveTo((x0 + x1) / 2, y0); g.lineTo(x1 - inset, y1); g.lineTo(x0 + inset, y1); }
          g.fill();
        }
      });
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      return t;
    };
    const mat = (tex, rep, metal = 0.75) => {
      const t = tex.clone();
      t.needsUpdate = true;
      t.repeat.set(rep, 1);
      return new THREE.MeshStandardMaterial({ map: t, metalness: metal, roughness: 0.35 });
    };
    const silverTex = lattice('#c9cdd2', '#3b3f45');
    const greenTex = lattice('#2e8a3e', '#163d1d', 128, 128, 2);
    const silverArm = (len) => mat(silverTex, Math.max(1, len / 0.12));
    const green = new THREE.MeshStandardMaterial({ color: 0x2e8a3e, metalness: 0.35, roughness: 0.45 });
    const greenLat = mat(greenTex, 1, 0.35);
    const silver = new THREE.MeshStandardMaterial({ color: 0xc4c8cd, metalness: 0.8, roughness: 0.3 });
    const darkRoller = new THREE.MeshStandardMaterial({ color: 0x2b2d30, metalness: 0.2, roughness: 0.6 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xc9a03a, metalness: 0.85, roughness: 0.3 });
    const ledGreen = new THREE.MeshStandardMaterial({ color: 0x5dff7a, emissive: 0x2bff52, emissiveIntensity: 1.6 });

    // silver triangle-truss rail down the middle of the robot (belly structure under the arm)
    for (const z of [-0.07, 0.07]) box(0.62, 0.1, 0.008, silverArm(0.62), new THREE.Vector3(0.02, fy(0.11), z), root);
    box(0.62, 0.012, 0.15, silver, new THREE.Vector3(0.02, fy(0.165), 0), root);

    // shoulder tower: green lattice side plates + silver center plate up to the pivot at the back
    const plate = new THREE.Shape();
    plate.moveTo(-0.16, 0.07 - PIVOT_H);
    plate.lineTo(0.2, 0.07 - PIVOT_H);
    plate.lineTo(0.08, 0.04);
    plate.lineTo(-0.08, 0.09);
    plate.closePath();
    const plateGeo = new THREE.ExtrudeGeometry(plate, { depth: 0.01, bevelEnabled: false });
    plateGeo.computeBoundingBox();
    // planar UVs for the lattice texture
    const pos = plateGeo.attributes.position, uv = plateGeo.attributes.uv;
    for (let k = 0; k < pos.count; k++) uv.setXY(k, (pos.getX(k) + 0.2) / 0.4, (pos.getY(k) + 0.35) / 0.45);
    for (const z of [-0.155, 0.135]) {
      const m = new THREE.Mesh(plateGeo, greenLat);
      m.position.set(PIVOT_X, fy(PIVOT_H), z);
      m.castShadow = true;
      root.add(m);
    }
    box(0.22, PIVOT_H - 0.08, 0.008, silver, new THREE.Vector3(PIVOT_X - 0.02, fy((PIVOT_H + 0.08) / 2), 0.0), root);
    // shoulder motors (Falcon 500s) coaxial-ish behind the pivot
    for (const [dx, dh] of [[-0.11, 0.0], [-0.11, -0.09]]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.26, 20), silver);
      f.rotation.x = Math.PI / 2;
      f.position.set(PIVOT_X + dx, fy(PIVOT_H + dh), -0.01);
      f.castShadow = true;
      root.add(f);
    }

    // shoulder drive: big green spoked sprocket at the pivot, gold chain down to a small sprocket mid-robot
    const spokes = canvasTexture(128, 128, (g) => {
      g.fillStyle = '#2e8a3e';
      g.beginPath(); g.arc(64, 64, 63, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#123018';
      for (let k = 0; k < 6; k++) {
        g.beginPath();
        g.moveTo(64, 64);
        g.arc(64, 64, 52, (k * Math.PI) / 3 + 0.18, ((k + 1) * Math.PI) / 3 - 0.18);
        g.closePath();
        g.fill();
      }
      g.fillStyle = '#2e8a3e';
      g.beginPath(); g.arc(64, 64, 20, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#b8bcc1';
      g.beginPath(); g.arc(64, 64, 12, 0, Math.PI * 2); g.fill();
    });
    const sprR = 0.165, smallR = 0.05;
    const sprMat = new THREE.MeshStandardMaterial({ map: spokes, metalness: 0.4, roughness: 0.45, transparent: true, alphaTest: 0.5 });
    const sprZ = 0.165;
    // small drive sprocket + chain run (fixed to the chassis)
    const small = [0.12, 0.14]; // x, h of the motor sprocket
    const smallM = new THREE.Mesh(new THREE.CylinderGeometry(smallR, smallR, 0.015, 20), green);
    smallM.rotation.x = Math.PI / 2;
    smallM.position.set(small[0], fy(small[1]), sprZ);
    root.add(smallM);
    const chainRun = (ax, ah, bx, bh) => {
      const len = Math.hypot(bx - ax, bh - ah);
      const m = box(len, 0.012, 0.012, gold, new THREE.Vector3((ax + bx) / 2, fy((ah + bh) / 2), sprZ), root);
      m.rotation.z = Math.atan2(bh - ah, bx - ax);
    };
    const ang = Math.atan2(small[1] - PIVOT_H, small[0] - PIVOT_X);
    const nrm = ang + Math.PI / 2;
    chainRun(PIVOT_X + sprR * Math.cos(nrm), PIVOT_H + sprR * Math.sin(nrm), small[0] + smallR * Math.cos(nrm), small[1] + smallR * Math.sin(nrm));
    chainRun(PIVOT_X - sprR * Math.cos(nrm), PIVOT_H - sprR * Math.sin(nrm), small[0] - smallR * Math.cos(nrm), small[1] - smallR * Math.sin(nrm));

    // arm: rotates about the pivot; the telescope runs OFFSET off the pivot axis
    this.gArm = new THREE.Group();
    this.gArm.position.set(PIVOT_X, fy(PIVOT_H), 0);
    root.add(this.gArm);
    const spr = new THREE.Mesh(new THREE.CylinderGeometry(sprR, sprR, 0.015, 40), sprMat);
    spr.rotation.x = Math.PI / 2;
    spr.position.z = sprZ;
    this.gArm.add(spr);
    const chainRing = new THREE.Mesh(new THREE.TorusGeometry(sprR + 0.004, 0.007, 6, 48), gold);
    chainRing.position.z = sprZ;
    this.gArm.add(chainRing);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.34, 24), silver);
    hub.rotation.x = Math.PI / 2;
    this.gArm.add(hub);
    const tube = new THREE.Group();
    tube.position.y = -OFFSET;
    this.gArm.add(tube);
    // sloped silver bracket from the hub down to the telescope (why the stowed arm slopes toward the front)
    const brLen = Math.hypot(0.3, OFFSET);
    const bracket = box(brLen, 0.07, 0.12, silverArm(brLen), new THREE.Vector3(0.15, OFFSET / 2, 0), tube);
    bracket.rotation.z = -Math.atan2(OFFSET, 0.3);
    const ledA = box(brLen, 0.012, 0.03, ledGreen, new THREE.Vector3(0.15, OFFSET / 2 + 0.042, 0), tube);
    ledA.rotation.z = bracket.rotation.z;
    // stage 1 (outer) with the green lattice housing at its base
    box(L_MIN - 0.04, 0.085, 0.12, silverArm(L_MIN), new THREE.Vector3((L_MIN - 0.04) / 2 - 0.04, 0, 0), tube);
    box(0.36, 0.12, 0.16, greenLat, new THREE.Vector3(0.2, 0, 0), tube);
    box(L_MIN - 0.08, 0.01, 0.03, ledGreen, new THREE.Vector3((L_MIN - 0.08) / 2, 0.047, 0), tube);
    this.stage2 = new THREE.Group();
    tube.add(this.stage2);
    box(L_MIN - 0.08, 0.07, 0.1, silverArm(L_MIN), new THREE.Vector3((L_MIN - 0.08) / 2 - 0.02, 0, 0), this.stage2);
    this.stage3 = new THREE.Group();
    tube.add(this.stage3);
    box(L_MIN - 0.1, 0.058, 0.084, silverArm(L_MIN), new THREE.Vector3(-(L_MIN - 0.1) / 2, 0, 0), this.stage3);

    // wrist + claw: silver spoked side plates with dark rollers
    this.gWrist = new THREE.Group();
    this.stage3.add(this.gWrist);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.44, 16), silver);
    axle.rotation.x = Math.PI / 2;
    this.gWrist.add(axle);
    const clawTex = canvasTexture(128, 128, (g) => {
      g.clearRect(0, 0, 128, 128);
      g.strokeStyle = '#c4c8cd';
      g.lineWidth = 9;
      g.lineJoin = 'round';
      const P = [[6, 64], [122, 10], [122, 118]];
      g.beginPath(); g.moveTo(...P[0]); g.lineTo(...P[1]); g.lineTo(...P[2]); g.closePath(); g.stroke();
      for (const [x, y] of [[64, 37], [64, 91], [122, 64]]) { g.beginPath(); g.moveTo(...P[0]); g.lineTo(x, y); g.stroke(); }
      g.beginPath(); g.moveTo(64, 37); g.lineTo(122, 118); g.moveTo(64, 91); g.lineTo(122, 10); g.stroke();
    });
    const clawMat = new THREE.MeshStandardMaterial({ map: clawTex, metalness: 0.8, roughness: 0.3, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide });
    for (const z of [-0.205, 0.205]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.34), clawMat);
      pl.position.set(0.16, 0, z);
      this.gWrist.add(pl);
    }
    this.rollers = [];
    for (const [x, y, r] of [[0.31, 0.135, 0.042], [0.31, -0.135, 0.042], [0.1, 0.08, 0.035]]) {
      const ro = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.4, 20), darkRoller);
      ro.rotation.x = Math.PI / 2;
      ro.position.set(x, y, 0);
      ro.castShadow = true;
      this.gWrist.add(ro);
      this.rollers.push({ m: ro, dir: y > 0 ? 1 : -1 });
    }

    // orange robot signal light on top + small LED strips that signal the human player
    this.rsl = new THREE.MeshStandardMaterial({ color: 0xff9a1f, emissive: 0xff7a00, emissiveIntensity: 1.5 });
    const rsl = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), this.rsl);
    rsl.position.set(0.0, fy(0.175), -0.11);
    root.add(rsl);
    box(0.04, 0.03, 0.04, MAT.black, new THREE.Vector3(0.0, fy(0.16), -0.11), root);
    this.robot.ledMat = new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0xffd400, emissiveIntensity: 1.3 });
    for (const z of [0.18, -0.19]) box(0.2, 0.012, 0.012, this.robot.ledMat, new THREE.Vector3(PIVOT_X + 0.02, fy(0.1), z), root);
  }

  colliders() {
    return [{ half: [0.12, 0.12, 0.15], pos: [PIVOT_X, 0.075 + 0.14, 0], mass: 2 }];
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
      case 'double': return type === 'cube' ? POSES.portalCube : POSES.portalCone;
      case 'single': return POSES.single;
      case 'floor': return type === 'cube' ? POSES.groundCube : POSES.groundCone;
      default: return null;
    }
  }

  setPreset(name) {
    const p = this.poseFor(name);
    if (!p) return false;
    this.qt = {
      s: clamp(p.s, ...SH_LIM),
      L: clamp(p.L, L_MIN, L_MAX),
      w: clamp(p.w, ...W_LIM),
    };
    return true;
  }

  atTarget(tol = 1) {
    return Math.abs(this.q.s - this.qt.s) < deg(2.5 * tol) && Math.abs(this.q.L - this.qt.L) < 0.0254 * tol && Math.abs(this.q.w - this.qt.w) < deg(3 * tol);
  }

  update(dt) {
    const q = this.q, t = this.qt;
    const step = (cur, tgt, v) => cur + clamp(tgt - cur, -v * dt, v * dt);
    // pull the telescope in before a big shoulder swing, then extend once it's close
    const swinging = Math.abs(t.s - q.s) > RETRACT_ANGLE;
    q.s = step(q.s, t.s, V_SH);
    q.L = step(q.L, swinging ? L_MIN : t.L, V_EXT);
    q.w = step(q.w, t.w, V_WR);
  }

  gripperAngle() {
    return this.q.s + this.q.w; // wrist angle measured from the carpet
  }

  holdPoint() {
    const [wx, wh] = wristPos(this.q.s, this.q.L);
    const a = this.gripperAngle();
    return new THREE.Vector3(wx + HOLD * Math.cos(a), wh + HOLD * Math.sin(a) - this.robot.floorY, 0);
  }

  intakePoints() {
    return [{ id: 'intake', pos: this.holdPoint(), radius: 0.28, accepts: 'any' }];
  }

  onGrab() {}

  canRelease() {
    return true;
  }

  releaseVelocity() {
    const a = this.gripperAngle();
    return new THREE.Vector3(Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0);
  }

  // which side of the robot does what (2910 scored mid/high over the back; the floor intake and low row are off the front)
  scoreSide(row) {
    return row === 0 ? 1 : -1;
  }

  substationSide(type) {
    return type === 'cube' ? 1 : -1;
  }

  floorPickup(type) {
    return type === 'cube' ? { side: 1, reach: 0.65 } : { side: 1, reach: 0.66 }; // everything is intaken off the front
  }

  // for the rules: max height and extension past the frame perimeter (front/back)
  envelope() {
    const fx = this.robot.frameX / 2;
    const [wx, wh] = wristPos(this.q.s, this.q.L);
    const a = this.gripperAngle();
    const tip = [wx + (HOLD + 0.08) * Math.cos(a), wh + (HOLD + 0.08) * Math.sin(a)];
    const foot = [PIVOT_X + OFFSET * Math.cos(this.q.s - Math.PI / 2), PIVOT_H + OFFSET * Math.sin(this.q.s - Math.PI / 2)];
    let maxH = 0, front = 0, back = 0;
    for (const [x, h] of [foot, [wx, wh], tip]) {
      maxH = Math.max(maxH, h + 0.05);
      front = Math.max(front, x - fx);
      back = Math.max(back, -x - fx);
    }
    return { maxH, front, back };
  }

  describe() {
    const d = (v) => (v * 57.3).toFixed(0);
    return `${this.robot.preset.toUpperCase()} · S${d(this.q.s)}° ${(this.q.L / IN).toFixed(0)}in W${d(this.q.w)}°`;
  }

  sync() {
    this.gArm.rotation.z = this.q.s;
    // 2-stage cascade: stage 2 travels half as far as stage 3
    const e = this.q.L - L_MIN;
    this.stage2.position.x = e / 2;
    this.stage3.position.x = this.q.L;
    this.gWrist.rotation.z = this.q.w;
    if (this.rsl) this.rsl.emissiveIntensity = Math.floor(performance.now() / 500) % 2 ? 1.6 : 0.25;
    if (this.robot.intaking) for (const r of this.rollers) r.m.rotation.y += 0.5 * r.dir;
  }
}
