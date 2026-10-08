import * as THREE from 'three';
import { FIELD } from './constants.js';

// Field (x, y, z-up) -> three/rapier world (x, y-up, z = -fieldY)
export const W = (x, y, z = 0) => new THREE.Vector3(x, z, -y);
export const Wr = (x, y, z = 0) => ({ x, y: z, z: -y });
export const toField = (v) => ({ x: v.x, y: -v.z, z: v.y });

// Mirror a field-x for the red alliance (2023 field is mirrored, not rotated)
export const mirrorX = (x, alliance) => (alliance === 'red' ? FIELD.length - x : x);

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrapAngle = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
export const approach = (cur, target, maxDelta) =>
  cur < target ? Math.min(target, cur + maxDelta) : Math.max(target, cur - maxDelta);

// Yaw (field heading, CCW from +x) from a rapier/three quaternion
export function yawFromQuat(q) {
  const v = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  return Math.atan2(-v.z, v.x);
}

export function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Real AprilTag 16h5 markers (the family used on the 2023 field), from AprilRobotics tag16h5.c
const TAG16H5 = [0x27c8, 0x31b6, 0x3859, 0x569c, 0x6c76, 0x7ddb, 0xaf09, 0xf5a1, 0xfb8b, 0x1cb9];
const BIT_X = [1, 2, 3, 2, 4, 4, 4, 3, 4, 3, 2, 3, 1, 1, 1, 2];
const BIT_Y = [1, 1, 1, 2, 1, 2, 3, 2, 4, 4, 4, 3, 4, 3, 2, 3];

// 8x8 cells (white border, black border, 4x4 data) drawn on a 10.5in polycarbonate panel with an ID label
export function aprilTagTexture(id) {
  return canvasTexture(336, 336, (g) => {
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#f4f6f8';
    g.fillRect(0, 0, 336, 336);
    const cell = 32; // 8 cells = 256px = 8in; panel = 336px = 10.5in
    const ox = 40;
    const oy = 336 - 40 - 256; // tag bottom sits 1.25in above the panel bottom
    g.fillStyle = '#fff';
    g.fillRect(ox, oy, 256, 256);
    g.fillStyle = '#000';
    g.fillRect(ox + cell, oy + cell, cell * 6, cell * 6);
    const code = TAG16H5[id];
    g.fillStyle = '#fff';
    for (let i = 0; i < 16; i++) {
      if (code & (1 << (15 - i))) g.fillRect(ox + (BIT_X[i] + 1) * cell, oy + (BIT_Y[i] + 1) * cell, cell, cell);
    }
    g.fillStyle = '#222';
    g.font = 'bold 22px Arial';
    g.textAlign = 'center';
    g.fillText(`ID ${id}`, 168, 28);
  });
}

export function textTexture(text, { bg = '#000', fg = '#fff', w = 512, h = 128, font = 'bold 84px Arial' } = {}) {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.fillStyle = fg;
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 4);
  });
}

export const MAT = {};
export function initMaterials() {
  const std = (o) => new THREE.MeshStandardMaterial(o);
  Object.assign(MAT, {
    carpet: null, // set by field
    alu: std({ color: 0xb8bcc2, metalness: 0.75, roughness: 0.35 }),
    darkAlu: std({ color: 0x55595f, metalness: 0.7, roughness: 0.45 }),
    black: std({ color: 0x1a1a1c, roughness: 0.8 }),
    steel: std({ color: 0x8a8d92, metalness: 0.9, roughness: 0.3 }),
    poly: new THREE.MeshPhysicalMaterial({
      color: 0xdfefff, metalness: 0, roughness: 0.05, transmission: 0.85, transparent: true, opacity: 0.25, depthWrite: false,
    }),
    white: std({ color: 0xf2f2f2, roughness: 0.6 }),
    wood: std({ color: 0x9a7b55, roughness: 0.85 }),
    blue: std({ color: 0x1f4fd1, roughness: 0.55 }),
    red: std({ color: 0xd1201f, roughness: 0.55 }),
    blueGlow: std({ color: 0x2a62ff, emissive: 0x1840c0, emissiveIntensity: 0.9 }),
    redGlow: std({ color: 0xff3030, emissive: 0xb01010, emissiveIntensity: 0.9 }),
    cone: std({ color: 0xffd400, roughness: 0.55 }),
    cube: std({ color: 0x7a2bd6, roughness: 0.7 }),
    diamond: std({ color: 0xa7abb1, metalness: 0.8, roughness: 0.4 }),
    green: std({ color: 0x2dd36f, emissive: 0x16a34a, emissiveIntensity: 0.6 }),
    clear: std({ color: 0xe8f1fa, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.22, depthWrite: false }),
    clearTint: std({ color: 0x9fe6ee, roughness: 0.15, transparent: true, opacity: 0.32, depthWrite: false }),
    frosted: std({ color: 0xd9dde2, roughness: 0.6, transparent: true, opacity: 0.55 }),
    pipe: std({ color: 0xc9ccd0, metalness: 0.85, roughness: 0.3 }),
    hdpe: std({ color: 0x1b1b1d, roughness: 0.9 }),
    reflect: std({ color: 0xf2f2f2, metalness: 0.6, roughness: 0.1, emissive: 0x555555 }),
  });
  return MAT;
}

export function box(w, h, d, mat, pos, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  if (pos) m.position.copy(pos);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
