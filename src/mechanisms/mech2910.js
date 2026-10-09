import * as THREE from 'three';
import { IN } from '../constants.js';
import { MAT, box, clamp } from '../util.js';

// FRC 2910 Jack in the Bot — 2023 robot "Phantom".
// Geometry, limits, speeds and every arm pose come from their public code
// (FRCTeam2910/2023CompetitionRobot-Public: ArmSubsystem.java, ArmPoseConstants.java, ArmIOFalcon500.java);
// look from their CAD release and reveal ("26x28 frame, <17 in tall stowed, 2-stage cascade telescoping arm").
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
    const green = new THREE.MeshStandardMaterial({ color: 0x1f7a3c, metalness: 0.35, roughness: 0.45 });
    const gray = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.7, roughness: 0.35 });
    const black = new THREE.MeshStandardMaterial({ color: 0x18191b, metalness: 0.3, roughness: 0.5 });
    const pink = new THREE.MeshStandardMaterial({ color: 0xe0559b, metalness: 0.5, roughness: 0.35 });
    const gold = new THREE.MeshStandardMaterial({ color: 0xd2a72c, metalness: 0.8, roughness: 0.3 });
    const falcon = new THREE.MeshStandardMaterial({ color: 0x8c9196, metalness: 0.75, roughness: 0.35 });

    // shoulder tower: green side plates rising to the pivot at the back of the robot
    const plate = new THREE.Shape();
    plate.moveTo(-0.42 - PIVOT_X, fy(0.07) - fy(PIVOT_H));
    plate.lineTo(-0.08 - PIVOT_X, fy(0.07) - fy(PIVOT_H));
    plate.lineTo(0.07, 0.05);
    plate.lineTo(-0.09, 0.09);
    plate.closePath();
    const plateGeo = new THREE.ExtrudeGeometry(plate, { depth: 0.012, bevelEnabled: false });
    for (const z of [-0.145, 0.133]) {
      const m = new THREE.Mesh(plateGeo, green);
      m.position.set(PIVOT_X, fy(PIVOT_H), z);
      m.castShadow = true;
      root.add(m);
    }
    // four Falcon 500s driving the shoulder
    for (const [x, h] of [[-0.36, 0.3], [-0.36, 0.2], [-0.47, 0.25], [-0.25, 0.14]]) {
      const f = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.1, 18), falcon);
      f.rotation.x = Math.PI / 2;
      f.position.set(x - (-10.25 * IN - PIVOT_X), fy(h), -0.06);
      f.castShadow = true;
      root.add(f);
    }

    // arm: rotates about the pivot; the telescope runs OFFSET off the pivot axis
    this.gArm = new THREE.Group();
    this.gArm.position.set(PIVOT_X, fy(PIVOT_H), 0);
    root.add(this.gArm);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 20), gray);
    hub.rotation.x = Math.PI / 2;
    this.gArm.add(hub);
    // big gold sector gear on the shoulder
    const sector = new THREE.Mesh(new THREE.RingGeometry(0.17, 0.25, 40, 1, deg(150), deg(130)), gold);
    sector.position.z = 0.152;
    this.gArm.add(sector);
    const sectorBack = sector.clone();
    sectorBack.rotation.y = Math.PI;
    sectorBack.position.z = 0.151;
    this.gArm.add(sectorBack);
    const tube = new THREE.Group();
    tube.position.y = -OFFSET;
    this.gArm.add(tube);
    box(0.06, OFFSET + 0.04, 0.26, green, new THREE.Vector3(0.02, OFFSET / 2, 0), tube); // bracket from hub to tube
    box(L_MIN - 0.05, 0.08, 0.15, black, new THREE.Vector3((L_MIN - 0.05) / 2 - 0.08, 0, 0), tube); // stage 1
    this.stage2 = new THREE.Group();
    tube.add(this.stage2);
    box(L_MIN - 0.08, 0.066, 0.125, gray, new THREE.Vector3((L_MIN - 0.08) / 2 - 0.06, 0, 0), this.stage2);
    this.stage3 = new THREE.Group();
    tube.add(this.stage3);
    box(L_MIN - 0.1, 0.054, 0.1, pink, new THREE.Vector3(-(L_MIN - 0.1) / 2, 0, 0), this.stage3);

    // wrist + roller intake (claw of four black rollers between silver side plates)
    this.gWrist = new THREE.Group();
    this.stage3.add(this.gWrist);
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.42, 16), gray);
    axle.rotation.x = Math.PI / 2;
    this.gWrist.add(axle);
    for (const z of [-0.2, 0.2]) {
      const sp = new THREE.Shape();
      sp.moveTo(-0.03, -0.05); sp.lineTo(0.33, -0.15); sp.lineTo(0.33, 0.15); sp.lineTo(-0.03, 0.05); sp.closePath();
      const m = new THREE.Mesh(new THREE.ExtrudeGeometry(sp, { depth: 0.01, bevelEnabled: false }), MAT.alu);
      m.position.z = z - 0.005;
      m.castShadow = true;
      this.gWrist.add(m);
    }
    this.rollers = [];
    for (const [x, y, r] of [[0.1, 0.1, 0.035], [0.1, -0.1, 0.035], [0.3, 0.13, 0.04], [0.3, -0.13, 0.04]]) {
      const ro = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.39, 18), black);
      ro.rotation.x = Math.PI / 2;
      ro.position.set(x, y, 0);
      ro.castShadow = true;
      this.gWrist.add(ro);
      this.rollers.push({ m: ro, dir: y > 0 ? 1 : -1 });
    }
    // LEDs (CANdle strip) signal the human player
    this.robot.ledMat = new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0xffd400, emissiveIntensity: 1.3 });
    box(0.25, 0.015, 0.015, this.robot.ledMat, new THREE.Vector3(PIVOT_X - 0.05, fy(0.12), 0.15), root);
    box(0.25, 0.015, 0.015, this.robot.ledMat, new THREE.Vector3(PIVOT_X - 0.05, fy(0.12), -0.16), root);
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
    if (this.robot.intaking) for (const r of this.rollers) r.m.rotation.y += 0.5 * r.dir;
  }
}
