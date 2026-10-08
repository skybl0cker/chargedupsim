import RAPIER from '../vendor/rapier/rapier.es.js';
import { Wr } from './util.js';
import { GROUP, groups } from './constants.js';

export let R = null;
export const phys = {
  world: null,
  dt: 1 / 120,
  // collider handle -> { kind: 'carpet' | 'field' | 'cs' | 'piece' | 'robot', ref }
  info: new Map(),
};

export async function initPhysics() {
  await RAPIER.init();
  R = RAPIER;
  createWorld();
}

export function createWorld() {
  if (phys.world) phys.world.free();
  phys.world = new R.World({ x: 0, y: -9.81, z: 0 });
  phys.world.timestep = phys.dt;
  phys.world.integrationParameters.numSolverIterations = 8;
  phys.info.clear();
}

export const yawQuat = (yaw) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });

export function register(collider, kind, ref = null) {
  phys.info.set(collider.handle, { kind, ref });
  return collider;
}

// Static box in field coords: center (fx,fy,fz), size along field axes (sx,sy,sz)
export function fixedBox(fx, fy, fz, sx, sy, sz, { kind = 'field', yaw = 0, friction = 0.6, group = GROUP.FIELD } = {}) {
  const body = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(fx, fz, -fy).setRotation(yawQuat(yaw)));
  const desc = R.ColliderDesc.cuboid(sx / 2, sz / 2, sy / 2)
    .setFriction(friction)
    .setRestitution(0.05)
    .setCollisionGroups(groups(group, 0xffff));
  return register(phys.world.createCollider(desc, body), kind);
}

// Static convex hull from field-coordinate points
export function fixedHull(points, { kind = 'field', friction = 0.6, group = GROUP.FIELD } = {}) {
  const body = phys.world.createRigidBody(R.RigidBodyDesc.fixed());
  const arr = new Float32Array(points.length * 3);
  points.forEach(([x, y, z], i) => {
    const w = Wr(x, y, z);
    arr.set([w.x, w.y, w.z], i * 3);
  });
  const desc = R.ColliderDesc.convexHull(arr).setFriction(friction).setCollisionGroups(groups(group, 0xffff));
  return register(phys.world.createCollider(desc, body), kind);
}

export function fixedCylinder(fx, fy, z0, z1, radius, opts = {}) {
  const h = z1 - z0;
  const body = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(fx, z0 + h / 2, -fy));
  const desc = R.ColliderDesc.cylinder(h / 2, radius)
    .setFriction(opts.friction ?? 0.4)
    .setCollisionGroups(groups(opts.group ?? GROUP.FIELD, 0xffff));
  return register(phys.world.createCollider(desc, body), opts.kind ?? 'field');
}

export function hitToi(hit) {
  return hit.timeOfImpact ?? hit.toi;
}

// Downward ray from a world point; returns { toi, kind, normal } or null
export function rayDown(origin, maxDist, excludeBody, filterGroups) {
  const ray = new R.Ray(origin, { x: 0, y: -1, z: 0 });
  const hit = phys.world.castRayAndGetNormal(ray, maxDist, true, undefined, filterGroups, undefined, excludeBody);
  if (!hit) return null;
  const info = phys.info.get(hit.collider.handle);
  return { toi: hitToi(hit), kind: info?.kind ?? 'field', ref: info?.ref, normal: hit.normal };
}
