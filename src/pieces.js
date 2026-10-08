import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/RoundedBoxGeometry.js';
import { PIECES, GROUP, groups } from './constants.js';
import { MAT, Wr } from './util.js';
import { R, phys, register } from './physics.js';

const CONE = PIECES.cone;
const CUBE = PIECES.cube;
export const CONE_HALF = CONE.height / 2; // body origin is at mid-height of the cone
export const CUBE_HALF = CUBE.size / 2;
const FREE_GROUPS = groups(GROUP.PIECE, GROUP.FIELD | GROUP.ROBOT | GROUP.PIECE | GROUP.CS | GROUP.CARPET);

let coneGeo = null;
let cubeGeo = null;

function makeConeMesh() {
  if (!coneGeo) {
    const pts = [];
    const r0 = CONE.botDia / 2;
    const r1 = CONE.topDia / 2;
    const z0 = -CONE_HALF + CONE.baseThick;
    const z1 = CONE_HALF;
    pts.push(new THREE.Vector2(0.001, z0));
    pts.push(new THREE.Vector2(r0, z0));
    for (let i = 1; i <= 10; i++) {
      const t = i / 10;
      pts.push(new THREE.Vector2(r0 + (r1 - r0) * t, z0 + (z1 - z0) * t));
    }
    pts.push(new THREE.Vector2(0.001, z1));
    const body = new THREE.LatheGeometry(pts, 28);
    const base = new THREE.BoxGeometry(CONE.base, CONE.baseThick, CONE.base);
    base.translate(0, -CONE_HALF + CONE.baseThick / 2, 0);
    coneGeo = { body, base };
  }
  const g = new THREE.Group();
  const m1 = new THREE.Mesh(coneGeo.body, MAT.cone);
  const m2 = new THREE.Mesh(coneGeo.base, MAT.cone);
  // reflective-ish white band like the real cone collar
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.05, 20, 1, true), MAT.white);
  band.position.y = 0.04;
  for (const m of [m1, m2, band]) {
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  }
  return g;
}

function makeCubeMesh() {
  if (!cubeGeo) cubeGeo = new RoundedBoxGeometry(CUBE.size, CUBE.size, CUBE.size, 4, 0.045);
  const m = new THREE.Mesh(cubeGeo, MAT.cube);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function coneHull() {
  const pts = [];
  const hb = CONE.base / 2;
  const yb = -CONE_HALF;
  for (const [x, z] of [[hb, hb], [hb, -hb], [-hb, hb], [-hb, -hb]]) {
    pts.push(x, yb, z, x, yb + CONE.baseThick, z);
  }
  const n = 12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(Math.cos(a) * (CONE.botDia / 2), yb + CONE.baseThick, Math.sin(a) * (CONE.botDia / 2));
    pts.push(Math.cos(a) * (CONE.topDia / 2), CONE_HALF, Math.sin(a) * (CONE.topDia / 2));
  }
  return new Float32Array(pts);
}

let nextId = 1;

export class Piece {
  constructor(scene, type, fx, fy, fz, yaw = 0) {
    this.id = nextId++;
    this.type = type;
    this.state = 'free'; // free | held | scored
    this.holder = null;
    this.node = null;
    this.mesh = type === 'cone' ? makeConeMesh() : makeCubeMesh();
    scene.add(this.mesh);
    this.scene = scene;
    const half = type === 'cone' ? CONE_HALF : CUBE_HALF;
    const p = Wr(fx, fy, fz ?? half + 0.002);
    this.body = phys.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setLinearDamping(0.15).setAngularDamping(0.4).setCcdEnabled(true)
    );
    const desc = type === 'cone'
      ? R.ColliderDesc.convexHull(coneHull()).setMass(CONE.mass).setFriction(0.7).setRestitution(0.1)
      : R.ColliderDesc.roundCuboid(CUBE_HALF - 0.04, CUBE_HALF - 0.04, CUBE_HALF - 0.04, 0.04).setMass(CUBE.mass).setFriction(0.8).setRestitution(0.25);
    desc.setCollisionGroups(FREE_GROUPS);
    this.collider = register(phys.world.createCollider(desc, this.body), 'piece', this);
    this.sync();
  }

  get half() {
    return this.type === 'cone' ? CONE_HALF : CUBE_HALF;
  }

  fieldPos() {
    const t = this.body.translation();
    return { x: t.x, y: -t.z, z: t.y };
  }

  // cosine of the angle between the cone's axis (base -> tip) and straight up
  axisUp() {
    const q = this.body.rotation();
    return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).y;
  }

  speed() {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  grab(robot) {
    this.state = 'held';
    this.holder = robot;
    this.body.setBodyType(R.RigidBodyType.KinematicPositionBased, true);
    this.collider.setCollisionGroups(groups(GROUP.PIECE, 0));
  }

  release(vel) {
    this.state = 'free';
    this.holder = null;
    this.body.setBodyType(R.RigidBodyType.Dynamic, true);
    this.collider.setCollisionGroups(FREE_GROUPS);
    if (vel) this.body.setLinvel(vel, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // Snap into a node; becomes part of the static field
  lock(fx, fy, fz, yaw) {
    this.state = 'scored';
    this.holder = null;
    this.body.setBodyType(R.RigidBodyType.Fixed, true);
    this.collider.setCollisionGroups(FREE_GROUPS);
    if (fx !== undefined) {
      const p = Wr(fx, fy, fz);
      this.body.setTranslation(p, true);
      this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    }
    this.sync();
  }

  moveKinematic(pos, quat) {
    this.body.setNextKinematicTranslation(pos);
    this.body.setNextKinematicRotation(quat);
  }

  sync() {
    const t = this.body.translation();
    const q = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(q.x, q.y, q.z, q.w);
  }

  dispose() {
    this.scene.remove(this.mesh);
    phys.info.delete(this.collider.handle);
    phys.world.removeRigidBody(this.body);
  }
}
