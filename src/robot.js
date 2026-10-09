import * as THREE from 'three';
import { GROUP, groups, IN } from './constants.js';
import { MAT, Wr, box, clamp, approach, yawFromQuat, textTexture, canvasTexture } from './util.js';
import { R, phys, register, rayDown } from './physics.js';
import { ROBOTS } from './robots.js';

const CH_HALF_H = 0.075; // chassis collider half height (body origin = chassis center)

// A robot = drivetrain/chassis physics (shared) + a mechanism from its profile (arm, intakes, presets).
export class Robot {
  constructor(scene, { alliance, station, team, isPlayer = false, skill = 1, profile = 'dja' }) {
    this.profile = ROBOTS[profile] || ROBOTS.dja;
    const P = this.profile;
    this.scene = scene;
    this.alliance = alliance;
    this.station = station;
    this.team = P.team ?? team;
    this.isPlayer = isPlayer;
    this.skill = skill;
    // frame can be rectangular: X = front-to-back length, Y = side-to-side width
    this.frameX = P.frameX ?? P.frame;
    this.frameY = P.frameY ?? P.frame;
    this.halfX = this.frameX / 2 + P.bumper;
    this.halfY = this.frameY / 2 + P.bumper;
    this.half = this.halfX; // distance from center to the front/back bumper face
    this.modX = P.moduleX ?? P.moduleOffset;
    this.modY = P.moduleY ?? P.moduleOffset;
    this.floorY = CH_HALF_H; // carpet -> body origin height
    this.mode = 'cone';
    this.preset = 'stow';
    this.held = null;
    this.intaking = false;
    this.outtakeRequest = false;
    this.ground = { carpet: false, cs: null, fraction: 1, csCount: 0, normal: { x: 0, y: 1, z: 0 } };
    this.cmd = { vx: 0, vy: 0, omega: 0 };
    this.driveMode = 'swerve';
    this.moduleAngles = [0, 0, 0, 0];
    this.wheelSpin = 0;
    this.stats = { mobility: false, scored: 0, autoCS: null };
    this.mech = P.mechanism(this);

    // ---- physics
    this.body = phys.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(0, CH_HALF_H + 0.01, 0).setAngularDamping(0.6).setLinearDamping(0.05).setCanSleep(false).setCcdEnabled(true)
    );
    const g = groups(GROUP.ROBOT, GROUP.FIELD | GROUP.ROBOT | GROUP.PIECE | GROUP.CS | GROUP.CARPET);
    const extra = this.mech.colliders();
    const extraMass = extra.reduce((m, c) => m + c.mass, 0);
    const chassis = R.ColliderDesc.roundCuboid(this.halfX - 0.03, CH_HALF_H - 0.03, this.halfY - 0.03, 0.03)
      .setMass(P.mass - extraMass).setFriction(0.0).setFrictionCombineRule(R.CoefficientCombineRule.Min).setRestitution(0.05).setCollisionGroups(g);
    register(phys.world.createCollider(chassis, this.body), 'robot', this);
    for (const c of extra) {
      const d = R.ColliderDesc.cuboid(...c.half).setTranslation(...c.pos).setMass(c.mass).setFriction(0.1).setCollisionGroups(g);
      register(phys.world.createCollider(d, this.body), 'robot', this);
    }

    this.prevVel = { x: 0, z: 0 };
    this.impact = 0;

    this.buildVisual();
    this.setMode(this.mode);
  }

  // ------------------------------------------------------------ visuals
  buildVisual() {
    const P = this.profile;
    const root = new THREE.Group();
    this.root = root;
    this.scene.add(root);
    const fx = this.frameX, fz = this.frameY;
    const HX = this.halfX, HZ = this.halfY;
    const allianceMat = this.alliance === 'blue' ? MAT.blue : MAT.red;
    const y0 = -CH_HALF_H;
    // drivetrain frame rails + belly pan (lightened hex pattern)
    for (const s of [-1, 1]) {
      box(fx, 0.05, 1 * IN, MAT.alu, new THREE.Vector3(0, y0 + 0.06, s * (fz / 2 - 0.5 * IN)), root);
      box(1 * IN, 0.05, fz, MAT.alu, new THREE.Vector3(s * (fx / 2 - 0.5 * IN), y0 + 0.06, 0), root);
    }
    const belly = canvasTexture(256, 256, (gx, w, h) => {
      gx.fillStyle = '#' + P.bellyColor.toString(16).padStart(6, '0');
      gx.fillRect(0, 0, w, h);
      gx.fillStyle = '#26272b';
      for (let yy = 0; yy < 9; yy++) for (let xx = 0; xx < 9; xx++) {
        const cx = xx * 30 + (yy % 2) * 15 + 8, cy = yy * 28 + 10;
        gx.beginPath();
        for (let k = 0; k < 6; k++) gx.lineTo(cx + 10 * Math.cos((k * Math.PI) / 3), cy + 10 * Math.sin((k * Math.PI) / 3));
        gx.fill();
      }
    });
    box(fx - 0.03, 0.006, fz - 0.03, new THREE.MeshStandardMaterial({ map: belly, metalness: 0.5, roughness: 0.5 }), new THREE.Vector3(0, y0 + 0.035, 0), root);
    // bumpers with team numbers on all four sides
    const bh = P.bumperTop - P.bumperBottom;
    const by = y0 + P.bumperBottom + bh / 2;
    const numTex = textTexture(String(this.team), { bg: this.alliance === 'blue' ? '#1f4fd1' : '#d1201f', w: 512, h: 128, font: 'bold 96px Arial' });
    const numMat = new THREE.MeshStandardMaterial({ map: numTex, roughness: 0.7 });
    for (const s of [-1, 1]) {
      const b1 = new THREE.Mesh(new THREE.BoxGeometry(2 * HX, bh, P.bumper), [allianceMat, allianceMat, allianceMat, allianceMat, numMat, numMat]);
      b1.position.set(0, by, s * (HZ - P.bumper / 2));
      b1.castShadow = true;
      root.add(b1);
      if (s > 0 && P.bumperGap) {
        // front bumper split around the intake opening, with the frame's bumper backing showing in the gap
        const seg = (fz - P.bumperGap) / 2;
        for (const t of [-1, 1]) {
          const bs = new THREE.Mesh(new THREE.BoxGeometry(P.bumper, bh, seg), allianceMat);
          bs.position.set(HX - P.bumper / 2, by, t * (P.bumperGap / 2 + seg / 2));
          bs.castShadow = true;
          root.add(bs);
        }
        box(0.25 * IN, bh * 0.8, P.bumperGap, new THREE.MeshStandardMaterial({ color: 0xc8a032, metalness: 0.6, roughness: 0.4 }),
          new THREE.Vector3(fx / 2 + 0.125 * IN, by, 0), root);
        continue;
      }
      const b2 = new THREE.Mesh(new THREE.BoxGeometry(P.bumper, bh, fz), [numMat, numMat, allianceMat, allianceMat, allianceMat, allianceMat]);
      b2.position.set(s * (HX - P.bumper / 2), by, 0);
      b2.castShadow = true;
      root.add(b2);
    }
    // swerve modules
    this.modules = [];
    const wheelGeo = new THREE.CylinderGeometry(2 * IN, 2 * IN, 1.5 * IN, 20);
    wheelGeo.rotateX(Math.PI / 2);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const mod = new THREE.Group();
      mod.position.set(sx * this.modX, y0 + 2 * IN - 0.005, sz * this.modY);
      const wheel = new THREE.Mesh(wheelGeo, MAT.black);
      wheel.castShadow = true;
      mod.add(wheel);
      box(0.1, 0.08, 0.1, MAT.steel, new THREE.Vector3(0, 0.08, 0), mod);
      const neo = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 14), MAT.darkAlu);
      neo.position.set(0, 0.16, 0);
      mod.add(neo);
      root.add(mod);
      this.modules.push({ group: mod, wheel });
    }
    // battery + electronics
    box(0.18, 0.1, 0.17, MAT.black, new THREE.Vector3(-0.17, y0 + 0.11, -0.12), root);
    box(0.12, 0.03, 0.15, new THREE.MeshStandardMaterial({ color: 0xff8800 }), new THREE.Vector3(0.1, y0 + 0.06, -0.15), root);
    // mechanism
    this.mech.build(root);
    // player marker
    if (this.isPlayer) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(HX, HZ) * 1.45, Math.max(HX, HZ) * 1.6, 40),
        new THREE.MeshBasicMaterial({ color: 0x22ff88, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      this.marker = ring;
      this.scene.add(ring);
    }
  }

  // ------------------------------------------------------------ pose helpers
  place(fx, fy, yaw) {
    const p = Wr(fx, fy, CH_HALF_H + 0.01);
    this.body.setTranslation(p, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevVel = { x: 0, z: 0 };
  }

  pose() {
    const t = this.body.translation();
    return { x: t.x, y: -t.z, z: t.y, yaw: yawFromQuat(this.body.rotation()) };
  }

  fieldVel() {
    const v = this.body.linvel();
    return { vx: v.x, vy: -v.z, omega: this.body.angvel().y };
  }

  quat() {
    const q = this.body.rotation();
    return new THREE.Quaternion(q.x, q.y, q.z, q.w);
  }

  localToWorld(x, y, z) {
    const t = this.body.translation();
    return new THREE.Vector3(x, y, z).applyQuaternion(this.quat()).add(new THREE.Vector3(t.x, t.y, t.z));
  }

  // bumper corners in field coords
  corners() {
    return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => {
      const w = this.localToWorld(a * this.halfX, 0, b * this.halfY);
      return [w.x, -w.z];
    });
  }

  tiltDeg() {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat());
    return (Math.acos(clamp(up.y, -1, 1)) * 180) / Math.PI;
  }

  // where a held game piece sits (the gripper / end effector)
  effectorWorld() {
    const p = this.mech.holdPoint();
    return this.localToWorld(p.x, p.y, p.z);
  }

  effectorField() {
    const w = this.effectorWorld();
    return { x: w.x, y: -w.z, z: w.y };
  }

  // ------------------------------------------------------------ control
  setPreset(name) {
    if (this.mech.setPreset(name)) this.preset = name;
  }

  setMode(mode) {
    const changed = this.mode !== mode;
    this.mode = mode;
    if (changed && this.preset === 'floor' && !this.held) this.setPreset('floor');
    if (this.ledMat) {
      this.ledMat.color.set(mode === 'cone' ? 0xffd400 : 0x8b2cf0);
      this.ledMat.emissive.set(mode === 'cone' ? 0xffd400 : 0x7a22e0);
    }
  }

  armAtTarget(tol = 1) {
    return this.mech.atTarget(tol);
  }

  // Called every physics step
  physicsStep(dt, game) {
    this.senseImpact(dt, game);
    this.senseGround();
    this.drive(dt);
    this.mech.update(dt, game);
    this.updateHeld();
    if (this.intaking && !this.held) this.tryIntake(game);
    if (this.outtakeRequest) {
      this.outtakeRequest = false;
      if (this.held && this.mech.canRelease()) this.releasePiece(game);
    }
  }

  // Hard hits (bumping a wall, field element or with the arm out) can knock the game piece loose
  senseImpact(dt, game) {
    const v = this.body.linvel();
    const acc = Math.hypot(v.x - this.prevVel.x, v.z - this.prevVel.z) / dt;
    const speedBefore = Math.hypot(this.prevVel.x, this.prevVel.z);
    this.prevVel = { x: v.x, z: v.z };
    this.impact = acc;
    if (!this.held || this.mech.staging || !game.enabled) return;
    const hp = this.mech.holdPoint();
    const extended = Math.hypot(hp.x, hp.y + this.floorY - 0.6) > 0.7;
    // calibrated: cable bump ≈ 25–160, charge station ramp ≈ 45, hitting a wall at 2 m/s ≈ 250, at 4.4 m/s ≈ 550
    const limit = (this.held.type === 'cube' ? 240 : 200) * (extended ? 0.7 : 1);
    void limit; void speedBefore; // arcade: pieces never get knocked loose
  }

  senseGround() {
    let carpet = 0, cs = 0, any = 0, csAlliance = null;
    const n = { x: 0, y: 0, z: 0 };
    const filter = groups(0xffff, GROUP.FIELD | GROUP.CS | GROUP.CARPET);
    const kx = this.modX, kz = this.modY;
    for (const [lx, lz] of [[kx, kz], [kx, -kz], [-kx, kz], [-kx, -kz]]) {
      const o = this.localToWorld(lx, 0, lz);
      const hit = rayDown({ x: o.x, y: o.y, z: o.z }, CH_HALF_H + 0.07, this.body, filter);
      if (!hit) continue;
      any++;
      n.x += hit.normal.x; n.y += hit.normal.y; n.z += hit.normal.z;
      if (hit.kind === 'carpet') carpet++;
      else if (hit.kind === 'cs') { cs++; csAlliance = hit.ref; }
    }
    const nl = Math.hypot(n.x, n.y, n.z) || 1;
    this.ground = {
      fraction: any / 4, carpet: carpet > 0, cs: cs > 0 ? csAlliance : null, csCount: cs, carpetCount: carpet,
      normal: any ? { x: n.x / nl, y: n.y / nl, z: n.z / nl } : { x: 0, y: 1, z: 0 },
    };
  }

  drive(dt) {
    const P = this.profile;
    let { vx, vy, omega } = this.cmd;
    const p = this.pose();
    if (this.driveMode === 'tank') {
      const f = vx * Math.cos(p.yaw) + vy * Math.sin(p.yaw);
      vx = f * Math.cos(p.yaw);
      vy = f * Math.sin(p.yaw);
    }
    const sp = Math.hypot(vx, vy);
    if (sp > P.maxSpeed) { vx *= P.maxSpeed / sp; vy *= P.maxSpeed / sp; }
    omega = clamp(omega, -P.maxOmega, P.maxOmega);
    const traction = this.ground.fraction;
    const lin = this.body.linvel();
    if (traction > 0) {
      let dvx = vx - lin.x;
      let dvy = vy - -lin.z;
      const dv = Math.hypot(dvx, dvy);
      const max = P.maxAccel * dt * (0.4 + 0.6 * traction);
      if (dv > max) { dvx *= max / dv; dvy *= max / dv; }
      this.body.setLinvel({ x: lin.x + dvx, y: lin.y, z: lin.z - dvy }, true);
      // wheels in brake mode hold the robot on slopes: cancel gravity's along-surface component
      const nn = this.ground.normal;
      const gdot = -9.81 * nn.y;
      const m = this.body.mass() * traction * dt;
      this.body.applyImpulse({ x: -(0 - gdot * nn.x) * m, y: -(-9.81 - gdot * nn.y) * m, z: -(0 - gdot * nn.z) * m }, true);
      const av = this.body.angvel();
      this.body.setAngvel({ x: av.x, y: approach(av.y, omega, P.maxAlpha * dt * traction), z: av.z }, true);
    }
    this.antiTip(dt);
    // module visuals
    const v = this.fieldVel();
    const spd = Math.hypot(v.vx, v.vy);
    if (spd > 0.05 || Math.abs(v.omega) > 0.05) {
      const c = Math.cos(-p.yaw), s = Math.sin(-p.yaw);
      const lvx = v.vx * c - v.vy * s;
      const lvy = v.vx * s + v.vy * c; // robot-left
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz], i) => {
        const rx = sx * this.modX, ry = -sz * this.modY;
        this.moduleAngles[i] = Math.atan2(lvy + v.omega * rx, lvx - v.omega * ry);
      });
    }
    this.wheelSpin += (spd / (2 * IN)) * dt;
  }

  // Held piece orientation: cubes ride with the gripper, upright cones stay upright, tipped cones lie
  // along the gripper with the tip pointing out (so the wrist has to point up to score them)
  // Real robots carry their battery and drivetrain low and rarely tip. Damp pitch/roll, and push back
  // upright once the lean goes past anything the charge station (±15°) can cause.
  antiTip(dt) {
    const av = this.body.angvel();
    const damp = Math.max(0, 1 - 6 * dt);
    this.body.setAngvel({ x: av.x * damp, y: av.y, z: av.z * damp }, true);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quat());
    const tilt = Math.acos(clamp(up.y, -1, 1));
    const limit = (18 * Math.PI) / 180;
    if (tilt > limit) {
      const axis = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0)).normalize();
      const k = this.body.mass() * 9.81 * 0.6 * (1 + (tilt - limit) * 6); // N·m, grows the further it leans
      this.body.applyTorqueImpulse({ x: axis.x * k * dt, y: axis.y * k * dt, z: axis.z * k * dt }, true);
    }
  }

  heldPose() {
    const w = this.effectorWorld();
    const q = this.quat();
    const a = this.mech.gripperAngle ? this.mech.gripperAngle() : 0;
    const pc = this.held;
    let local = new THREE.Quaternion();
    const Z = new THREE.Vector3(0, 0, 1);
    if (pc?.type === 'cube') local.setFromAxisAngle(Z, a);
    else if (pc?.holdMode === 'tipped') local.setFromAxisAngle(Z, a - Math.PI / 2);
    else {
      // upright: cancel the robot's own pitch/roll so the cone stays vertical
      const yaw = this.pose().yaw;
      const up = new THREE.Quaternion(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2));
      return { pos: { x: w.x, y: w.y, z: w.z }, quat: { x: up.x, y: up.y, z: up.z, w: up.w } };
    }
    const r = q.multiply(local);
    return { pos: { x: w.x, y: w.y, z: w.z }, quat: { x: r.x, y: r.y, z: r.z, w: r.w } };
  }

  updateHeld() {
    if (!this.held) return;
    const hp = this.heldPose();
    this.held.moveKinematic(hp.pos, hp.quat);
  }

  tryIntake(game) {
    let best = null, bestPt = null, bestD = Infinity;
    for (const pt of this.mech.intakePoints()) {
      const e = this.localToWorld(pt.pos.x, pt.pos.y, pt.pos.z);
      for (const pc of game.pieces) {
        if (pc.state !== 'free') continue;
        if (pc.type !== this.mode) continue; // cone mode only takes cones, cube mode only cubes
        if (pt.accepts !== 'any' && pt.accepts !== pc.type) continue;
        const t = pc.body.translation();
        const d = Math.hypot(t.x - e.x, t.y - e.y, t.z - e.z);
        if (d < pt.radius && d < bestD) { bestD = d; best = pc; bestPt = pt; }
      }
    }
    if (best) {
      best.holdMode = best.type === 'cone' ? 'upright' : 'cube'; // arcade: the gripper always rights a cone
      best.grab(this);
      this.held = best;
      this.setMode(best.type);
      this.mech.onGrab(bestPt, best);
      game.onPickup(this, best);
    }
  }

  releasePiece(game) {
    const pc = this.held;
    this.held = null;
    pc.touchedBy = this;
    pc.touchedT = game.time;
    if (game.tryScore(pc, this)) return;
    const v = this.body.linvel();
    const lvLocal = this.mech.releaseVelocity(pc);
    const lv = lvLocal.clone().applyQuaternion(this.quat());
    pc.release({ x: v.x + lv.x, y: v.y + lv.y, z: v.z + lv.z });
    game.onRelease(this, pc, lvLocal.length());
  }

  dropPiece() {
    if (!this.held) return;
    const pc = this.held;
    this.held = null;
    pc.release({ x: 0, y: 0, z: 0 });
  }

  // ------------------------------------------------------------ render sync
  sync(time) {
    const t = this.body.translation();
    const q = this.body.rotation();
    this.root.position.set(t.x, t.y, t.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);
    this.mech.sync();
    for (let i = 0; i < 4; i++) {
      this.modules[i].group.rotation.y = this.moduleAngles[i];
      this.modules[i].wheel.rotation.z = -this.wheelSpin;
    }
    if (this.marker) {
      this.marker.position.set(t.x, 0.012, t.z);
      this.marker.material.opacity = 0.35 + 0.2 * Math.sin(time * 4);
    }
  }

  dispose() {
    this.scene.remove(this.root);
    if (this.marker) this.scene.remove(this.marker);
    phys.world.removeRigidBody(this.body);
  }
}
