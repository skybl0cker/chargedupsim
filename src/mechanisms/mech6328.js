import * as THREE from 'three';
import { GRID, LOADING_ZONE as LZ, IN, GROUP, groups } from '../constants.js';
import { R, phys, register } from '../physics.js';
import { MAT, box, clamp, canvasTexture } from '../util.js';
import { CONE_HALF } from '../pieces.js';

// Double-jointed arm robot (team 9999), modeled on the geometry of FRC 6328's 2023 robot.
// Arm geometry and limits are based on 6328's public code (RobotCode2023/src/main/deploy/arm_config.json,
// ArmKinematics.java, ArmPose.java, CubeIntake.java); appearance from their 2023 Open Alliance build thread.
const deg = (d) => (d * Math.PI) / 180;
const ORIGIN_H = 0.654; // shoulder joint height above carpet, at robot center
const L1 = 0.638429; // shoulder segment
const L2 = 0.80645; // elbow segment
const L3 = 0.261; // wrist segment (gripper)
const HOLD = 0.3; // wrist joint -> center of a held game piece
const SHOULDER_LIM = [0, Math.PI];
const ELBOW_LIM = [0.872664626, 5.4105206812];
const WRIST_LIM = [-deg(120), deg(120)];
const VMAX = [deg(170), deg(300), deg(420)]; // shoulder, elbow, wrist joint speed limits (rad/s)
// lateral stack: tower at the frame perimeter, each segment stepped inward so the arm can pass through itself
const Z_TOWER = 0.27, Z_SHOULDER = 0.215, Z_ELBOW = 0.145, Z_GRIP = 0.0;
// cube intake (CubeIntake.java): pivot 0.28 m forward, 0.197 m up; neutral 92°, deployed 8°
const CI_ROOT = [0.28, 0.197];
const CI_LEN = 0.3;
const CI_NEUTRAL = deg(92), CI_DEPLOY = deg(8);

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const wrap2Pi = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

// Port of 6328's ArmKinematics.inverse (elbow-up solution, mirrored when reaching behind the robot)
export function inverse6328(x, y) {
  let rx = x, ry = y - ORIGIN_H;
  const flipped = rx < 0;
  if (flipped) rx = -rx;
  rx = Math.max(rx, 1e-6);
  const c = clamp((rx * rx + ry * ry - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
  let elbow = -Math.acos(c);
  let shoulder = Math.atan(ry / rx) - Math.atan((L2 * Math.sin(elbow)) / (L1 + L2 * Math.cos(elbow)));
  const fx = L1 * Math.cos(shoulder) + L2 * Math.cos(shoulder + elbow);
  const fy = L1 * Math.sin(shoulder) + L2 * Math.sin(shoulder + elbow);
  if (Math.hypot(fx - rx, fy - ry) > 1e-3) shoulder += Math.PI;
  if (flipped) {
    shoulder = Math.PI - shoulder;
    elbow = -elbow;
  }
  return [wrapPi(shoulder), wrap2Pi(elbow)];
}

export function forward6328(s, e) {
  return [L1 * Math.cos(s) + L2 * Math.cos(s + e), ORIGIN_H + L1 * Math.sin(s) + L2 * Math.sin(s + e)];
}

// Poses: piece-hold point (x forward of robot center, h above carpet) + global wrist angle (0 = pointing forward).
// Scoring poses assume bumpers against the grid; wrist angles are 6328's AutoScore / ArmPose values.
function makePoses(half) {
  const hold = (x, h, wristDeg) => ({ hold: [x, h], wrist: deg(wristDeg) });
  const wristAt = (x, h, wristDeg) => ({ wristPos: [x, h], wrist: deg(wristDeg) });
  const d = (front) => half + front; // robot center -> node, bumpers touching
  return {
    stow: wristAt(0, ORIGIN_H + L1 - L2, -180), // HOMED: shoulder up, forearm folded down
    hybrid: hold(half + 0.25, 0.5, 0), // 6328 drops into the hybrid row from ~0.5 m up
    midcube: hold(d(GRID.outerX - GRID.midX), GRID.midCubeZ + 0.24, -30),
    highcube: hold(d(GRID.outerX - GRID.highX) - 0.06, GRID.highCubeZ + 0.25, -10), // just inside the 48 in extension limit
    midcone: hold(d(GRID.outerX - GRID.midX), GRID.midConeZ + 0.07 + CONE_HALF, 55),
    highcone: hold(d(GRID.outerX - GRID.highX), GRID.highConeZ + 0.07 + CONE_HALF, 55),
    midconetipped: hold(d(GRID.outerX - GRID.midX), GRID.midConeZ + 0.07 + CONE_HALF, 70),
    highconetipped: hold(d(GRID.outerX - GRID.highX), GRID.highConeZ + 0.07 + CONE_HALF, 55), // elbow limit: a tipped cone only gets to ~35° off vertical this high
    double: hold(half + 0.19, LZ.doubleSubstationShelfZ + 0.16, 0),
    single: hold(half, LZ.singleSubstationLowZ + 0.1, 30),
    floorcone: wristAt(-0.55, 0.22, -175), // cones are picked up off the floor behind the robot (opposite the cube intake)
    handoff: wristAt(0.44, 0.62, -80), // CUBE_HANDOFF from the cube intake
  };
}

export class Arm6328 {
  constructor(robot) {
    this.robot = robot;
    this.poses = makePoses(robot.half);
    const [s0, e0] = inverse6328(0, ORIGIN_H + L1 - L2);
    this.q = [s0, e0, 0]; // shoulder, elbow (relative), wrist (relative)
    this.qt = [...this.q];
    this.qt[2] = this.q[2] = wrapPi(deg(-180) - s0 - e0);
    this.intakeAngle = CI_NEUTRAL;
    this.staging = false; // cube held by the cube intake, waiting for the handoff
    this.pendingPreset = null;
    this.flip = 1;
    this.ciTarget = null;
  }

  // ---------------------------------------------------------------- visuals
  build(root) {
    const r = this.robot;
    const fy = (h) => h - r.floorY; // carpet height -> robot-local y
    const holes = canvasTexture(64, 256, (g, w, h) => {
      g.fillStyle = '#b9bdc3';
      g.fillRect(0, 0, w, h);
      g.fillStyle = '#4b4f55';
      for (let y = 16; y < h; y += 32) { g.beginPath(); g.arc(w / 2, y, 9, 0, Math.PI * 2); g.fill(); }
    });
    holes.wrapS = holes.wrapT = THREE.RepeatWrapping;
    const tube = (len) => {
      const t = holes.clone();
      t.needsUpdate = true;
      t.repeat.set(1, Math.max(1, len / 0.2));
      t.rotation = Math.PI / 2;
      return new THREE.MeshStandardMaterial({ map: t, metalness: 0.6, roughness: 0.4 });
    };
    const chain = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.8, roughness: 0.5 });
    const sprocketMat = new THREE.MeshStandardMaterial({ color: 0x8f1f1f, metalness: 0.6, roughness: 0.4 });

    // ---- A-frame tower at the frame perimeter
    const top = fy(ORIGIN_H);
    const base = fy(0.06);
    const leg = (x0) => {
      const len = Math.hypot(x0, top - base);
      const m = box(0.05, len, 0.025, tube(len), new THREE.Vector3(x0 / 2, (top + base) / 2, Z_TOWER), root);
      m.rotation.z = Math.atan2(x0, top - base);
    };
    leg(0.24);
    leg(-0.24);
    box(0.05, top - base, 0.05, tube(top - base), new THREE.Vector3(0, (top + base) / 2, Z_TOWER + 0.03), root);
    const gusset = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.008, 6), MAT.alu);
    gusset.rotation.x = Math.PI / 2;
    gusset.position.set(0, top - 0.06, Z_TOWER - 0.016);
    root.add(gusset);
    box(0.5, 0.03, 0.05, MAT.alu, new THREE.Vector3(0, base, Z_TOWER), root);
    // LED strips on the tower legs (signal the human player)
    r.ledMat = new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0xffd400, emissiveIntensity: 1.3 });
    for (const x0 of [0.11, -0.11]) {
      const m = box(0.012, 0.42, 0.012, r.ledMat, new THREE.Vector3(x0, fy(0.36), Z_TOWER + 0.02), root);
      m.rotation.z = x0 > 0 ? deg(19) : deg(-19);
    }
    // dead-axle shoulder gearbox in the belly pan + chain run to the shoulder
    box(0.12, 0.1, 0.1, MAT.darkAlu, new THREE.Vector3(0, fy(0.11), Z_TOWER - 0.06), root);
    box(0.02, top - fy(0.11), 0.01, chain, new THREE.Vector3(0.0, (top + fy(0.11)) / 2, Z_SHOULDER + 0.03), root);

    // ---- shoulder segment
    this.gShoulder = new THREE.Group();
    this.gShoulder.position.set(0, top, 0);
    root.add(this.gShoulder);
    const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.012, 28), sprocketMat);
    sp.rotation.x = Math.PI / 2;
    sp.position.z = Z_SHOULDER + 0.03;
    this.gShoulder.add(sp);
    box(L1 + 0.06, 0.05, 0.05, tube(L1), new THREE.Vector3(L1 / 2, 0, Z_SHOULDER), this.gShoulder);
    for (const zz of [Z_SHOULDER - 0.03, Z_SHOULDER + 0.03]) {
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.01, 16), MAT.darkAlu);
      hub.rotation.x = Math.PI / 2;
      hub.position.set(L1, 0, zz);
      this.gShoulder.add(hub);
    }

    // ---- elbow segment (carries the elbow + wrist motors)
    this.gElbow = new THREE.Group();
    this.gElbow.position.set(L1, 0, 0);
    this.gShoulder.add(this.gElbow);
    const esp = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.01, 24), sprocketMat);
    esp.rotation.x = Math.PI / 2;
    esp.position.z = Z_ELBOW + 0.035;
    this.gElbow.add(esp);
    box(L2 + 0.05, 0.05, 0.05, tube(L2), new THREE.Vector3(L2 / 2, 0, Z_ELBOW), this.gElbow);
    for (const xx of [0.12, 0.2]) {
      const neo = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.07, 16), MAT.darkAlu);
      neo.rotation.x = Math.PI / 2;
      neo.position.set(xx, 0.0, Z_ELBOW - 0.06);
      this.gElbow.add(neo);
    }
    box(0.03, 0.04, 0.01, chain, new THREE.Vector3(L2 / 2, 0.03, Z_ELBOW + 0.03), this.gElbow).scale.x = L2 / 0.03;

    // ---- wrist + gripper (NEO 550, yellow 3in/4in compliant wheels)
    this.gWrist = new THREE.Group();
    this.gWrist.position.set(L2, 0, 0);
    this.gElbow.add(this.gWrist);
    box(0.06, 0.05, Z_ELBOW - Z_GRIP + 0.16, MAT.darkAlu, new THREE.Vector3(0.02, 0, (Z_ELBOW + Z_GRIP) / 2), this.gWrist);
    const plateMat = new THREE.MeshStandardMaterial({ color: 0x1d1d20, roughness: 0.5 });
    for (const zz of [Z_GRIP - 0.14, Z_GRIP + 0.14]) box(L3 + 0.04, 0.17, 0.008, plateMat, new THREE.Vector3(L3 / 2 + 0.02, 0, zz), this.gWrist);
    const yellow = new THREE.MeshStandardMaterial({ color: 0xffc21a, roughness: 0.75 });
    this.wheels = [];
    const wheelRow = (x, y, r0) => {
      for (let k = -2; k <= 2; k++) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(r0, r0, 0.022, 14), yellow);
        w.rotation.x = Math.PI / 2;
        w.position.set(x, y, Z_GRIP + k * 0.052);
        w.castShadow = true;
        this.gWrist.add(w);
        this.wheels.push({ m: w, dir: y > 0 ? 1 : -1 });
      }
    };
    wheelRow(0.13, 0.085, 2 * IN);
    wheelRow(0.13, -0.085, 2 * IN);
    wheelRow(0.25, 0.075, 1.5 * IN);
    wheelRow(0.25, -0.075, 1.5 * IN);
    const n550 = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.06, 14), MAT.steel);
    n550.position.set(0.06, 0.12, Z_GRIP + 0.1);
    this.gWrist.add(n550);

    // ---- cube intake: fixed uprights, pivoting arms, black roller tube and polycarb flaps
    for (const s of [-1, 1]) box(0.04, fy(0.42) - fy(0.06), 0.012, MAT.alu, new THREE.Vector3(CI_ROOT[0], (fy(0.42) + fy(0.06)) / 2, s * 0.285), root);
    this.gIntake = new THREE.Group();
    this.gIntake.position.set(CI_ROOT[0], fy(CI_ROOT[1]), 0);
    root.add(this.gIntake);
    for (const s of [-1, 1]) box(CI_LEN + 0.04, 0.05, 0.012, MAT.alu, new THREE.Vector3(CI_LEN / 2, 0, s * 0.3), this.gIntake);
    this.ciRoller = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.62, 18), new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.6 }));
    this.ciRoller.rotation.x = Math.PI / 2;
    this.ciRoller.position.set(CI_LEN, 0, 0);
    this.gIntake.add(this.ciRoller);
    box(0.15, 0.004, 0.55, MAT.clear, new THREE.Vector3(CI_LEN - 0.1, 0.03, 0), this.gIntake);
  }

  colliders() {
    // A-frame tower (the arm itself is not a physics body)
    return [{ half: [0.24, 0.28, 0.03], pos: [0, 0.075 + 0.28, Z_TOWER], mass: 1.5 }]; // light: the robot's weight sits low in the drivetrain
  }

  // ---------------------------------------------------------------- arm physics
  // Arm links, gripper and cube-intake roller are real colliders on the robot body: they push loose
  // game pieces, and the robot can't drive them through field elements.
  createColliders(body) {
    const hit = groups(GROUP.ROBOT, GROUP.FIELD | GROUP.PIECE | GROUP.CS);
    const noPieces = groups(GROUP.ROBOT, GROUP.FIELD | GROUP.CS); // gripper mouth / intake roller let pieces in
    const mk = (desc, g) => register(phys.world.createCollider(desc.setDensity(0).setFriction(0.3).setCollisionGroups(g), body), 'robot', this.robot);
    this.cols = {
      upper: mk(R.ColliderDesc.capsule(L1 / 2, 0.035), hit),
      fore: mk(R.ColliderDesc.capsule(L2 / 2, 0.035), hit),
      grip: mk(R.ColliderDesc.cuboid(0.16, 0.085, 0.15), noPieces),
      roller: mk(R.ColliderDesc.capsule(0.3, 0.04), noPieces),
    };
    // slightly smaller shapes for the "would this move hit something?" test, so resting contact never jams
    this.testShapes = {
      upper: new R.Capsule(L1 / 2 - 0.02, 0.028),
      fore: new R.Capsule(L2 / 2 - 0.02, 0.028),
      grip: new R.Cuboid(0.15, 0.075, 0.14),
      roller: new R.Capsule(0.28, 0.034),
    };
    this.updateColliders();
  }

  // link poses in the robot-local frame (x forward, y up from body origin, z = robot right)
  linkPoses(q, ia) {
    const fy = this.robot.floorY;
    const Z = new THREE.Vector3(0, 0, 1);
    const qz = (a) => new THREE.Quaternion().setFromAxisAngle(Z, a);
    const ex = L1 * Math.cos(q[0]), ey = ORIGIN_H + L1 * Math.sin(q[0]);
    const [wx, wy] = forward6328(q[0], q[1]);
    const a = q[0] + q[1] + q[2];
    const rx = CI_ROOT[0] + CI_LEN * Math.cos(ia), ry = CI_ROOT[1] + CI_LEN * Math.sin(ia);
    return {
      upper: { p: new THREE.Vector3(ex / 2, (ORIGIN_H + ey) / 2 - fy, Z_SHOULDER), q: qz(q[0] - Math.PI / 2) },
      fore: { p: new THREE.Vector3((ex + wx) / 2, (ey + wy) / 2 - fy, Z_ELBOW), q: qz(q[0] + q[1] - Math.PI / 2) },
      grip: { p: new THREE.Vector3(wx + 0.17 * Math.cos(a), wy + 0.17 * Math.sin(a) - fy, Z_GRIP), q: qz(a) },
      roller: { p: new THREE.Vector3(rx, ry - fy, 0), q: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2) },
    };
  }

  updateColliders() {
    if (!this.cols) return;
    const lp = this.linkPoses(this.q, this.intakeAngle);
    for (const k in this.cols) {
      this.cols[k].setTranslationWrtParent(lp[k].p);
      this.cols[k].setRotationWrtParent(lp[k].q);
    }
  }

  // true if the arm/intake at (q, ia) would overlap a field element, charge station or scored game piece
  collidesAt(q, ia, which = null) {
    if (!this.testShapes) return false;
    const body = this.robot.body;
    const bt = body.translation(), br = body.rotation();
    const bq = new THREE.Quaternion(br.x, br.y, br.z, br.w);
    const lp = this.linkPoses(q, ia);
    const filter = groups(0xffff, GROUP.FIELD | GROUP.CS | GROUP.PIECE);
    for (const k of which || Object.keys(this.testShapes)) {
      const p = lp[k].p.clone().applyQuaternion(bq).add(new THREE.Vector3(bt.x, bt.y, bt.z));
      const rq = bq.clone().multiply(lp[k].q);
      let hit = false;
      phys.world.intersectionsWithShape({ x: p.x, y: p.y, z: p.z }, { x: rq.x, y: rq.y, z: rq.z, w: rq.w }, this.testShapes[k], (c) => {
        const info = phys.info.get(c.handle);
        if (!info || info.kind === 'carpet' || info.kind === 'robot') return true;
        if (info.kind === 'piece' && info.ref.state !== 'scored') return true; // loose pieces just get pushed
        hit = true;
        return false;
      }, undefined, filter, undefined, body);
      if (hit) return true;
    }
    return false;
  }

  // Measurements for the rules (as if resting on flat floor): max height, extension beyond the frame front/back
  envelope() {
    const frameHalf = this.robot.profile.frame / 2;
    let maxH = 0, front = 0, back = 0;
    const pts = this.armSamples(this.q);
    const a = this.wristAngle();
    const [wx, wy] = forward6328(this.q[0], this.q[1]);
    pts.push([wx + (L3 + 0.03) * Math.cos(a), wy + (L3 + 0.03) * Math.sin(a)]);
    for (const [x, h] of pts) {
      maxH = Math.max(maxH, h + 0.04);
      front = Math.max(front, x + 0.03 - frameHalf);
      back = Math.max(back, -x + 0.03 - frameHalf);
    }
    front = Math.max(front, CI_ROOT[0] + CI_LEN * Math.cos(this.intakeAngle) + 0.04 - frameHalf);
    return { maxH, front, back };
  }

  gripperAngle() {
    return this.wristAngle();
  }

  // ---------------------------------------------------------------- control
  // Pick front or back scoring like 6328's AutoScore: whichever side faces the target
  sideToward(dirX, dirY) {
    const yaw = this.robot.pose().yaw;
    return Math.cos(yaw) * dirX + Math.sin(yaw) * dirY >= 0 ? 1 : -1;
  }

  poseFor(name) {
    const r = this.robot;
    const towardWall = r.alliance === 'blue' ? -1 : 1;
    const type = r.held ? r.held.type : r.mode;
    const tipped = r.held?.holdMode === 'tipped';
    switch (name) {
      case 'stow': return { pose: this.poses.stow, side: 1 };
      // cube mode: arm waits at the cube intake for an instant handoff; cone mode: arm reaches out the back
      case 'floor': return { pose: r.mode === 'cube' ? this.poses.handoff : this.poses.floorcone, side: 1 };
      case 'handoff': return { pose: this.poses.handoff, side: 1 };
      case 'hybrid': return { pose: this.poses.hybrid, side: this.sideToward(towardWall, 0) };
      case 'mid': return { pose: type === 'cube' ? this.poses.midcube : tipped ? this.poses.midconetipped : this.poses.midcone, side: this.sideToward(towardWall, 0) };
      case 'high': return { pose: type === 'cube' ? this.poses.highcube : tipped ? this.poses.highconetipped : this.poses.highcone, side: this.sideToward(towardWall, 0) };
      case 'double': return { pose: this.poses.double, side: this.sideToward(-towardWall, 0) };
      case 'single': return { pose: this.poses.single, side: this.sideToward(0, 1) };
      default: return null;
    }
  }

  setPreset(name) {
    if (this.staging && name !== 'handoff') {
      this.pendingPreset = name;
      return true;
    }
    const pf = this.poseFor(name);
    if (!pf) return false;
    const { pose, side } = pf;
    let wristAng = pose.wrist;
    let wx, wy;
    if (pose.wristPos) [wx, wy] = pose.wristPos;
    else {
      wx = pose.hold[0] - HOLD * Math.cos(wristAng);
      wy = pose.hold[1] - HOLD * Math.sin(wristAng);
    }
    this.flip = side;
    if (side < 0) { // flip to the back of the robot
      wx = -wx;
      wristAng = Math.PI - wristAng;
    }
    wy = Math.min(wy, 1.5); // 6328 maxHeight constraint
    let [s, e] = inverse6328(wx, wy);
    s = clamp(s, ...SHOULDER_LIM);
    e = clamp(e, ...ELBOW_LIM);
    const w = clamp(wrapPi(wristAng - s - e), ...WRIST_LIM);
    const same = this.qt && [s, e, w].every((v, i) => Math.abs(v - this.qt[i]) < 1e-4);
    this.qt = [s, e, w];
    // during a cube pickup/handoff the gripper is supposed to meet the intake
    this.ignoreIntake = name === 'handoff' || (name === 'floor' && this.robot.mode === 'cube');
    if (!same || !this.path?.length) this.planPath(); // only re-plan when the target changes
    this.flip = side;
    return true;
  }

  // joint state for a wrist position + global wrist angle (or null if out of reach / limits)
  solve(wx, wy, wristAng) {
    let [s, e] = inverse6328(wx, wy);
    if (s < SHOULDER_LIM[0] - 0.01 || s > SHOULDER_LIM[1] + 0.01 || e < ELBOW_LIM[0] || e > ELBOW_LIM[1]) return null;
    return [clamp(s, ...SHOULDER_LIM), e, clamp(wrapPi(wristAng - s - e), ...WRIST_LIM)];
  }

  segmentClear(a, b) {
    const arm = ['upper', 'fore', 'grip'];
    const n = Math.max(8, Math.ceil(Math.max(...a.map((v, i) => Math.abs(b[i] - v))) / deg(4)));
    // go over the folded intake (unless we're already tangled with it, then any way out is fine)
    const checkIntake = !this.ignoreIntake && this.intakeAngle > deg(60) && !this.intakeHits(this.intakeAngle, this.armSamples(a));
    for (let k = 1; k <= n; k++) {
      const q = a.map((v, i) => v + ((b[i] - v) * k) / n);
      if (this.collidesAt(q, this.intakeAngle, arm)) return false;
      if (checkIntake && this.intakeHits(this.intakeAngle, this.armSamples(q))) return false;
    }
    return true;
  }

  // Like 6328's trajectory planner (which kept the arm out of the node zones): if the straight joint-space
  // move would hit the field, go up and over through a raised waypoint first.
  planPath() {
    const goal = this.qt;
    this.path = [goal];
    if (!this.testShapes) return;
    // joint-space "tuck" waypoints: shoulder leaned all the way back (or forward) lets the forearm swing
    // through inside the robot's footprint when something is right in front of (or behind) the bumpers
    const tuck = (sDeg, eDeg) => {
      const sh = deg(sDeg), el = deg(eDeg);
      return [sh, el, clamp(wrapPi(Math.PI / 2 - sh - el), ...WRIST_LIM)];
    };
    const vias = [
      this.solve(0.3 * this.flip, 1.45, this.flip > 0 ? 0 : Math.PI),
      this.solve(0.3, 1.45, 0),
      this.solve(-0.3, 1.45, Math.PI),
      this.solve(0.05, 1.42, Math.PI / 2),
      tuck(170, 150), tuck(170, 230), tuck(10, 210), tuck(10, 130),
    ].filter(Boolean);
    const saved = this.ignoreIntake;
    // strict first (field + folded intake); if nothing works, allow brushing past the intake but never the field
    for (const relaxIntake of [false, true]) {
      this.ignoreIntake = saved || relaxIntake;
      const ok = (a, b) => this.segmentClear(a, b);
      if (ok(this.q, goal)) { this.ignoreIntake = saved; return; }
      for (const v of vias) {
        if (ok(this.q, v) && ok(v, goal)) { this.path = [v, goal]; this.ignoreIntake = saved; return; }
      }
      for (const v1 of vias) for (const v2 of vias) {
        if (v1 !== v2 && ok(this.q, v1) && ok(v1, v2) && ok(v2, goal)) { this.path = [v1, v2, goal]; this.ignoreIntake = saved; return; }
      }
    }
    this.ignoreIntake = saved;
  }


  atTarget(tol = 1) {
    return this.q.every((v, i) => Math.abs(v - this.qt[i]) < deg(2.5 * tol));
  }

  update(dt) {
    // cube intake deploys while ground-intaking for a cube, otherwise stays neutral —
    // unless the arm is (or is about to be) in its way, then it swings clear (like 6328's auto-deploy zones)
    const r = this.robot;
    const deploy = r.intaking && !r.held && r.preset === 'floor' && r.mode === 'cube';
    const want = deploy ? CI_DEPLOY : CI_NEUTRAL;
    const Tleft = Math.max(...this.qt.map((t, i) => Math.abs(t - this.q[i]) / VMAX[i]), 1e-3);
    const look = this.q.map((v, i) => v + (this.qt[i] - v) * Math.min(1, 0.5 / Tleft));
    const mid = this.q.map((v, i) => (v + look[i]) / 2);
    const armPts = [...this.armSamples(this.q), ...this.armSamples(mid), ...this.armSamples(look)];
    const nowPts = this.armSamples(this.q);
    // usable if the intake can swing there without sweeping through the arm now, and stays clear of where the arm is headed
    const reachable = (a) => {
      const n = Math.ceil(Math.abs(a - this.intakeAngle) / deg(8));
      for (let k = 1; k <= n; k++) if (this.intakeHits(this.intakeAngle + ((a - this.intakeAngle) * k) / n, nowPts)) return false;
      return !this.intakeHits(a, armPts) && !this.collidesAt(this.q, a, ['roller']); // and the field isn't in the way
    };
    const other = want === CI_NEUTRAL ? CI_DEPLOY : CI_NEUTRAL;
    // during a cube pickup/handoff the gripper is supposed to sit over the intake
    let ciT = deploy || this.staging ? want : [want, other].find(reachable);
    if (ciT === undefined) ciT = this.ciTarget ?? want; // neither is clear yet: keep going where it was headed
    this.ciTarget = ciT;
    const ciStep = 11 * dt;
    const iaPrev = this.intakeAngle;
    const iaNext = this.intakeAngle + clamp(ciT - this.intakeAngle, -ciStep, ciStep);
    if (!this.collidesAt(this.q, iaNext, ['roller']) || this.collidesAt(this.q, this.intakeAngle, ['roller'])) this.intakeAngle = iaNext;
    const intakeMoving = Math.abs(this.intakeAngle - iaPrev) > 1e-5; // only wait on an intake that is actually moving
    // synchronized joint-space move (all joints arrive together), like a time-optimal trajectory
    if (!this.path || !this.path.length) this.path = [this.qt];
    let tgt = this.path[0];
    if (this.path.length > 1 && tgt.every((v, i) => Math.abs(v - this.q[i]) < deg(4))) { this.path.shift(); tgt = this.path[0]; }
    const dq = tgt.map((t, i) => t - this.q[i]);
    const T = Math.max(...dq.map((d, i) => Math.abs(d) / VMAX[i]), dt);
    const next = this.q.map((v, i) => v + dq[i] * Math.min(1, dt / T));
    // the arm waits a moment if the intake is still swinging out of its path
    const blocked = intakeMoving && !deploy && !this.staging && this.intakeHits(this.intakeAngle, this.armSamples(next));
    // the arm stalls against field elements instead of passing through them
    const arm = ['upper', 'fore', 'grip'];
    this.stalled = !blocked && this.collidesAt(next, this.intakeAngle, arm) && !this.collidesAt(this.q, this.intakeAngle, arm);
    this.blocked = blocked;
    if (!blocked && !this.stalled) this.q = next;
    // stuck against something for a moment: re-plan from here (up and over)
    this.stallT = this.stalled ? (this.stallT || 0) + dt : 0;
    if (this.stallT > 0.2) { this.stallT = 0; this.planPath(); }
    this.updateColliders();
    // finish a cube handoff once the gripper reaches the intake
    if (this.staging && this.atTarget(0.8)) {
      this.staging = false;
      const next = this.pendingPreset || 'stow';
      this.pendingPreset = null;
      r.preset = next;
      this.setPreset(next);
    }
  }

  // points along the arm (x forward, h above carpet) for a joint state, incl. gripper + held piece
  armSamples(q) {
    const pts = [];
    const ex = L1 * Math.cos(q[0]), ey = ORIGIN_H + L1 * Math.sin(q[0]);
    const [wx, wy] = forward6328(q[0], q[1]);
    const a = q[0] + q[1] + q[2];
    const seg = (x0, y0, x1, y1, n) => { for (let k = 0; k <= n; k++) pts.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]); };
    seg(0, ORIGIN_H, ex, ey, 6);
    seg(ex, ey, wx, wy, 8);
    seg(wx, wy, wx + (HOLD + 0.1) * Math.cos(a), wy + (HOLD + 0.1) * Math.sin(a), 5);
    return pts;
  }

  // does the cube intake at angle `ang` touch any arm point?
  intakeHits(ang, armPts) {
    const rad = 0.11; // arm/gripper half-thickness + intake roller + margin
    for (let k = 1; k <= 5; k++) {
      const t = (CI_LEN * k) / 5;
      const ix = CI_ROOT[0] + t * Math.cos(ang), iy = CI_ROOT[1] + t * Math.sin(ang);
      for (const [x, y] of armPts) if (Math.hypot(x - ix, y - iy) < rad) return true;
    }
    return false;
  }

  wristAngle() {
    return this.q[0] + this.q[1] + this.q[2];
  }

  holdPoint() {
    const fy = this.robot.floorY;
    if (this.staging) return new THREE.Vector3(0.49, 0.3 - fy, 0);
    const [x, y] = forward6328(this.q[0], this.q[1]);
    const a = this.wristAngle();
    return new THREE.Vector3(x + HOLD * Math.cos(a), y + HOLD * Math.sin(a) - fy, Z_GRIP);
  }

  intakePoints() {
    const pts = [];
    if (this.intakeAngle < deg(30)) {
      // cube rolls under the roller and up over the bumper
      pts.push({ id: 'cubeIntake', pos: new THREE.Vector3(CI_ROOT[0] + CI_LEN + 0.07, 0.12 - this.robot.floorY, 0), radius: 0.24, accepts: 'cube' });
    }
    if (!this.staging) pts.push({ id: 'gripper', pos: this.holdPoint(), radius: 0.22, accepts: 'any' });
    return pts;
  }

  onGrab(point) {
    if (point.id === 'cubeIntake') {
      this.staging = true;
      this.robot.preset = 'handoff';
      this.setPreset('handoff');
    }
  }

  canRelease() {
    return !this.staging;
  }

  // 6328 ejects game pieces out of the gripper rollers (cubes get thrown, cones are dropped)
  releaseVelocity(piece) {
    const a = this.wristAngle();
    const sp = 0.15; // arcade: pieces are placed, not thrown
    return new THREE.Vector3(Math.cos(a) * sp, Math.sin(a) * sp, 0);
  }

  floorPickup(type) {
    return type === 'cube' ? { side: 1, reach: CI_ROOT[0] + CI_LEN + 0.07 } : { side: -1, reach: 0.85 };
  }

  describe() {
    const d = (v) => (v * 57.3).toFixed(0);
    const tag = this.staging ? 'HANDOFF' : this.robot.preset.toUpperCase();
    return `${tag}${this.flip < 0 ? ' (back)' : ''} · S${d(this.q[0])}° E${d(this.q[1])}° W${d(this.q[2])}°`;
  }

  sync() {
    this.gShoulder.rotation.z = this.q[0];
    this.gElbow.rotation.z = this.q[1];
    this.gWrist.rotation.z = this.q[2];
    this.gIntake.rotation.z = this.intakeAngle;
    if (this.robot.intaking) {
      for (const w of this.wheels) w.m.rotation.y += 0.45 * w.dir;
      this.ciRoller.rotation.y += 0.5;
    }
  }
}
