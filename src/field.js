import * as THREE from 'three';
import {
  FIELD, GRID, COMMUNITY, CHARGE_STATION as CS, CABLE_BUMP, LOADING_ZONE as LZ, BARRIER, STAGING, IN, GROUP, groups,
} from './constants.js';
import { W, MAT, canvasTexture, aprilTagTexture, textTexture, box, clamp } from './util.js';
import { R, phys, fixedBox, fixedHull, fixedCylinder, register } from './physics.js';

// Geometry follows the 2023 FRC Game Manual §5 (ARENA) and the official field drawings.
const L = FIELD.length;
const FW = FIELD.width;
const DEG = Math.PI / 180;

// Mirror an x-range / x for red (the 2023 field is mirrored, not rotated)
const mxr = (a, b, alliance) => (alliance === 'red' ? [L - b, L - a] : [a, b]);
const mx = (x, alliance) => (alliance === 'red' ? L - x : x);

// Meshes hidden when the camera is behind that end wall (so walls never block the third-person view)
const endUpper = { blue: [], red: [] };
const tagEnd = (end, ...meshes) => {
  for (const m of meshes) if (m) endUpper[end].push(m);
};

// Axis-aligned box spanning field ranges, with visual mesh and (optional) collider
function fbox(scene, [x0, x1], [y0, y1], [z0, z1], mat, { collide = true, kind = 'field', shadow = true, friction = 0.6 } = {}) {
  const sx = x1 - x0, sy = y1 - y0, sz = z1 - z0;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  let mesh = null;
  if (mat) {
    mesh = box(sx, sz, sy, mat, W(cx, cy, cz), scene);
    mesh.castShadow = shadow && !mat.transparent;
  }
  if (collide) fixedBox(cx, cy, cz, sx, sy, sz, { kind, friction });
  return mesh;
}

// Parallelepiped from a corner `o` and edge vectors u, v, w (field coords) — slopes, fins, ramps
const unitBox = new THREE.BoxGeometry(1, 1, 1);
function para(scene, o, u, v, w, mat, { collide = false, kind = 'field', friction = 0.6 } = {}) {
  const t = (p) => new THREE.Vector3(p[0], p[2], -p[1]);
  let [U, V, Wv] = [t(u), t(v), t(w)];
  if (new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeBasis(U, V, Wv)).determinant() < 0) [V, Wv] = [Wv, V];
  const c = t(o).add(U.clone().add(V).add(Wv).multiplyScalar(0.5));
  const m = new THREE.Mesh(unitBox, mat);
  m.matrixAutoUpdate = false;
  m.matrix.makeBasis(U, V, Wv).setPosition(c);
  m.castShadow = !mat.transparent;
  m.receiveShadow = true;
  scene.add(m);
  if (collide) {
    const pts = [];
    for (const a of [0, 1]) for (const b of [0, 1]) for (const d of [0, 1]) {
      pts.push([o[0] + a * u[0] + b * v[0] + d * w[0], o[1] + a * u[1] + b * v[1] + d * w[1], o[2] + a * u[2] + b * v[2] + d * w[2]]);
    }
    fixedHull(pts, { kind, friction });
  }
  return m;
}

function cyl(scene, fx, fy, z0, z1, r, mat, segs = 14) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, z1 - z0, segs), mat);
  m.position.copy(W(fx, fy, (z0 + z1) / 2));
  m.castShadow = true;
  scene.add(m);
  return m;
}

function tagPlane(scene, id, fx, fy, zBottom, facingPlusX, size = 10.5 * IN) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: aprilTagTexture(id) }));
  // tag bottom is 1.25in above the panel bottom
  m.position.copy(W(fx, fy, zBottom - 1.25 * IN + size / 2));
  m.rotation.y = facingPlusX ? Math.PI / 2 : -Math.PI / 2;
  scene.add(m);
  return m;
}

export function communityPoly(alliance) {
  const p = [
    [0, 0], [COMMUNITY.outerX, 0], [COMMUNITY.outerX, COMMUNITY.midY],
    [COMMUNITY.midX, COMMUNITY.midY], [COMMUNITY.midX, COMMUNITY.leftY], [0, COMMUNITY.leftY],
  ];
  return p.map(([x, y]) => [mx(x, alliance), y]);
}

// Loading zone belonging to `alliance` (sits at the OPPOSING end)
export function loadingZonePoly(alliance) {
  const far = alliance === 'blue' ? 'red' : 'blue';
  const p = [
    [0, LZ.rightY], [LZ.wideDepth, LZ.rightY], [LZ.wideDepth, LZ.midY],
    [LZ.narrowDepth, LZ.midY], [LZ.narrowDepth, FW], [0, FW],
  ];
  return p.map(([x, y]) => [mx(x, far), y]);
}

export function driverStationY(i) {
  const w = (LZ.doubleSubstationCenterY - LZ.doubleSubstationWidth / 2) / 3;
  return w * (i + 0.5);
}

export function buildField(scene) {
  endUpper.blue = [];
  endUpper.red = [];
  const field = { nodes: { blue: [], red: [] }, cs: {}, substations: {}, endUpper, dsLeds: { blue: [], red: [] } };
  buildCarpet(scene);
  buildGuardrails(scene);
  for (const a of ['blue', 'red']) {
    buildAllianceWall(scene, a, field);
    buildGrid(scene, a, field);
    field.cs[a] = buildChargeStation(scene, a);
    buildBarrierAndCable(scene, a);
    field.substations[a] = buildSubstations(scene, a);
  }
  return field;
}

// ---------------------------------------------------------------- carpet + tape
function buildCarpet(scene) {
  const PX = 4096 / L; // pixels per meter
  const H = Math.round(FW * PX);
  const tex = canvasTexture(4096, H, (g, w, h) => {
    // Shaw Neyland II "Medallion": dark charcoal low-pile carpet
    g.fillStyle = '#3c3e42';
    g.fillRect(0, 0, w, h);
    const img = g.getImageData(0, 0, w, h);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 16;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    g.putImageData(img, 0, 0);
    const P = (x, y) => [x * PX, (FW - y) * PX]; // canvas y is flipped vs field y
    const tape = FIELD.tapeWidth * PX;
    const line = (pts, color) => {
      g.strokeStyle = color;
      g.lineWidth = tape;
      g.lineCap = 'square';
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(...P(x, y)) : g.moveTo(...P(x, y))));
      g.stroke();
    };
    line([[L / 2, 0], [L / 2, FW]], '#f2f2f2'); // CENTER LINE
    for (const a of ['blue', 'red']) {
      const col = a === 'blue' ? '#1f5cff' : '#e4262b';
      const cp = communityPoly(a);
      line([cp[0], cp[1], cp[2], cp[3], cp[4]], col);
      const lz = loadingZonePoly(a);
      line([lz[0], lz[1], lz[2], lz[3], lz[4]], col);
      // GRID front tape (part of the GRID, defines its front plane)
      const gx = mx(GRID.outerX - FIELD.tapeWidth / 2, a);
      line([[gx, 0], [gx, GRID.leftY]], col);
      // STAGING MARKS: 4in black tape crosses
      for (const y of STAGING.y) {
        const [x0, y0] = P(mx(STAGING.x, a), y);
        const r = 2 * IN * PX;
        g.strokeStyle = '#0c0c0c';
        g.lineWidth = 1 * IN * PX;
        g.beginPath();
        g.moveTo(x0 - r, y0); g.lineTo(x0 + r, y0);
        g.moveTo(x0, y0 - r); g.lineTo(x0, y0 + r);
        g.stroke();
      }
    }
  });
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(L, FW), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.97, envMapIntensity: 0.15 }));
  carpet.rotation.x = -Math.PI / 2;
  carpet.position.copy(W(L / 2, FW / 2, 0));
  carpet.receiveShadow = true;
  scene.add(carpet);
  MAT.carpet = carpet.material;

  // venue floor + the white STARTING LINES in the alliance areas
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), new THREE.MeshStandardMaterial({ color: 0x26272b, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.copy(W(L / 2, FW / 2, -0.004));
  floor.receiveShadow = true;
  scene.add(floor);
  const startMat = new THREE.MeshBasicMaterial({ color: 0xe8e8e8 });
  for (const s of [-1, 1]) {
    const x = s < 0 ? -(28 * IN + 1 * IN) : L + 28 * IN + 1 * IN;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * IN, FW), startMat);
    m.rotation.x = -Math.PI / 2;
    m.position.copy(W(x, FW / 2, -0.002));
    scene.add(m);
  }

  // carpet collider (top surface at z = 0)
  fixedBox(L / 2, FW / 2, -0.25, L + 6, FW + 6, 0.5, { kind: 'carpet', friction: 0.8, group: GROUP.CARPET });
}

// ---------------------------------------------------------------- guardrails
function buildGuardrails(scene) {
  const gh = FIELD.guardrailHeight; // 1ft 8in transparent polycarbonate system
  const ext = 1.5 * IN;
  const yellow = new THREE.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.6 });
  for (const side of [0, 1]) {
    const y = side ? FW + ext / 2 : -ext / 2;
    const out = side ? 1 : -1;
    fbox(scene, [0, L], [y - ext / 2, y + ext / 2], [0, ext], MAT.alu, { collide: false });
    fbox(scene, [0, L], [y - 0.004, y + 0.004], [ext, gh - ext], MAT.clear, { collide: false, shadow: false });
    fbox(scene, [0, L], [y - ext / 2, y + ext / 2], [gh - ext, gh], MAT.alu, { collide: false });
    // uprights + yellow support feet on the outside
    for (let k = 0; k <= 14; k++) {
      const x = (k / 14) * L;
      fbox(scene, [x - 0.02, x + 0.02], [y - ext / 2, y + ext / 2], [0, gh], MAT.alu, { collide: false });
      if (k > 0 && k < 14) fbox(scene, [x - 0.3, x + 0.3], [y + out * 0.05, y + out * 0.3].sort((p, q) => p - q), [0, 0.04], yellow, { collide: false });
    }
    fixedBox(L / 2, y + out * 0.2, gh / 2, L + 2, 0.4, gh, { kind: 'field' });
  }
}

// ---------------------------------------------------------------- alliance walls (3 DRIVER STATIONS)
function buildAllianceWall(scene, a, field) {
  const x = a === 'blue' ? -0.03 : L + 0.03;
  const out = a === 'blue' ? -1 : 1;
  const xr = [x - 0.03, x + 0.03];
  const yEnd = LZ.doubleSubstationCenterY - LZ.doubleSubstationWidth / 2; // opponent's double substation fills the rest
  const baseH = 36.75 * IN; // diamond plate base
  const winTop = baseH + 42 * IN; // transparent sheet + top rail
  const diamond = canvasTexture(256, 256, (g) => {
    g.fillStyle = '#9ea3aa';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#c3c7cc';
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
      g.save();
      g.translate(i * 32 + (j % 2) * 16 + 8, j * 32 + 8);
      g.rotate(Math.PI / 4 * (j % 2 ? 1 : -1));
      g.fillRect(-9, -2, 18, 4);
      g.restore();
    }
  });
  diamond.wrapS = diamond.wrapT = THREE.RepeatWrapping;
  diamond.repeat.set(12, 2);
  const plate = new THREE.MeshStandardMaterial({ map: diamond, metalness: 0.75, roughness: 0.4 });
  tagEnd(a, fbox(scene, xr, [0, yEnd], [0, baseH], plate, { collide: false }));
  tagEnd(a,
    fbox(scene, xr, [0, yEnd], [baseH, winTop], MAT.clear, { collide: false, shadow: false }),
    fbox(scene, [x - 0.025, x + 0.025], [0, yEnd], [winTop - 0.04, winTop], MAT.alu, { collide: false }),
  );
  tagEnd(a, fbox(scene, [x - 0.025, x + 0.025], [0, yEnd], [baseH, baseH + 0.03], MAT.alu, { collide: false }));
  const dsw = yEnd / 3;
  const allianceHex = a === 'blue' ? 0x2a62ff : 0xff3030;
  for (let i = 0; i < 3; i++) {
    const y0 = i * dsw;
    const yc = y0 + dsw / 2;
    // tube uprights at the station boundaries
    for (const yy of [y0 + 0.03, y0 + dsw - 0.03]) tagEnd(a, cyl(scene, x, yy, 0, winTop + 0.12, 0.025, MAT.alu, 10));
    // operator console shelf on the drive team side
    tagEnd(a, fbox(scene, [x + out * 0.03, x + out * (0.03 + 12.25 * IN)].sort((p, q) => p - q), [yc - 34.5 * IN, yc + 34.5 * IN], [baseH - 0.02, baseH], MAT.darkAlu, { collide: false }));
    // team sign + LED stack at the top
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.22), new THREE.MeshBasicMaterial({
      map: textTexture(`${a.toUpperCase()} ${i + 1}`, { bg: a === 'blue' ? '#1d3fb0' : '#b51c1c', font: 'bold 76px Arial' }),
    }));
    sign.position.copy(W(x - out * 0.03, yc, winTop + 0.14));
    sign.rotation.y = a === 'blue' ? Math.PI / 2 : -Math.PI / 2;
    scene.add(sign);
    tagEnd(a, sign);
    const stack = new THREE.MeshStandardMaterial({ color: allianceHex, emissive: allianceHex, emissiveIntensity: 0.8 });
    tagEnd(a, fbox(scene, [x - 0.03, x + 0.03], [yc - 0.03, yc + 0.03], [winTop + 0.27, winTop + 0.37], stack, { collide: false }));
    // LED string along the bottom of the window frame: fills with LINKS (see manual table 5-2)
    for (let k = 0; k < 10; k++) {
      const ly = y0 + 0.12 + (k / 9) * (dsw - 0.24);
      const m = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x000000 });
      tagEnd(a, fbox(scene, [x - out * 0.035 - 0.01, x - out * 0.035 + 0.01], [ly - 0.03, ly + 0.03], [baseH + 0.035, baseH + 0.06], m, { collide: false }));
      field.dsLeds[a].push({ mat: m, order: a === 'blue' ? (2 - i) * 10 + (9 - k) : i * 10 + k });
    }
  }
  field.dsLeds[a].sort((p, q) => p.order - q.order);
  fixedBox(x + out * 0.2, yEnd / 2, 1.1, 0.4, yEnd, 2.2, { kind: 'field' });
}

// ---------------------------------------------------------------- grids
function buildGrid(scene, a, field) {
  const s = a === 'blue' ? 1 : -1; // field +x direction away from this alliance wall
  const F = GRID.outerX; // front face of the grid
  const X = (d) => mx(F - d, a); // field x of a point `d` meters behind the front face
  const allianceSlope = new THREE.MeshStandardMaterial({ color: a === 'blue' ? 0x1f3fc4 : 0xc41f24, roughness: 0.8 });
  const coopSlope = new THREE.MeshStandardMaterial({ color: 0x1d1e21, roughness: 0.85 });
  const frame = new THREE.MeshStandardMaterial({ color: 0xc4c8ce, metalness: 0.7, roughness: 0.35 });

  const bounds = [0];
  for (let i = 0; i < 8; i++) bounds.push((GRID.nodeY[i] + GRID.nodeY[i + 1]) / 2);
  bounds.push(GRID.leftY);
  const slopeZ = (d) => Math.max(0, (d - GRID.hybridDepth) * GRID.slope);
  const midSurf = GRID.midCubeZ - GRID.cubeWall;
  const highSurf = GRID.highCubeZ - GRID.cubeWall;
  const dw = GRID.dividerWidth;

  // base rails along the floor; the front 16in are the 5in-tall HYBRID NODE dividers
  for (let k = 0; k < bounds.length; k++) {
    const by = bounds[k];
    const yr = k === 0 ? [0, dw / 2] : k === bounds.length - 1 ? [by - dw / 2, by] : [by - dw / 2, by + dw / 2];
    fbox(scene, mxr(0, F - 0.03, a), yr, [0, GRID.dividerHeight], frame);
    fbox(scene, mxr(F - 0.03, F, a), yr, [0, GRID.dividerHeight], MAT.black); // black end caps
  }

  for (let c = 0; c < 9; c++) {
    const yc = GRID.nodeY[c];
    if (GRID.isCubeCol(c)) {
      // ---- CUBE NODES: polycarbonate shelves with 3in walls
      const hw = GRID.cubeNodeWidth / 2;
      const yr = [yc - hw, yc + hw];
      const mid = [GRID.midCubeFront, GRID.midCubeFront + GRID.cubeNodeDepth]; // d range
      const high = [GRID.highCubeFront, GRID.highCubeFront + GRID.cubeNodeDepth];
      // shelves (solid colliders below the shelf surfaces)
      fbox(scene, mxr(F - mid[1], F - mid[0], a), yr, [midSurf - 0.012, midSurf], MAT.clear, { collide: false });
      fixedBox(X((mid[0] + mid[1]) / 2), yc, (midSurf + 0.2) / 2, mid[1] - mid[0], 2 * hw, midSurf - 0.2, { kind: 'field' });
      fixedBox(X((GRID.hybridDepth + mid[1]) / 2), yc, 0.1, mid[1] - GRID.hybridDepth, 2 * hw, 0.2, { kind: 'field' });
      fbox(scene, mxr(F - high[1], F - high[0], a), yr, [highSurf - 0.012, highSurf], MAT.clear, { collide: false });
      fixedBox(X((high[0] + high[1]) / 2), yc, highSurf / 2, high[1] - high[0], 2 * hw, highSurf, { kind: 'field' });
      // walls (front + sides; the top-row rear wall is angled back)
      const wt = 0.008;
      for (const [d0, d1, surf] of [[mid[0], mid[1], midSurf], [high[0], high[1], highSurf]]) {
        const top = surf + GRID.cubeWall;
        fbox(scene, mxr(F - d0 - wt, F - d0, a), yr, [surf, top], MAT.clear);
        for (const sy of [yc - hw, yc + hw - wt]) fbox(scene, mxr(F - d1, F - d0, a), [sy, sy + wt], [surf, top], MAT.clear);
      }
      fbox(scene, mxr(F - mid[1], F - mid[1] + wt, a), yr, [midSurf, midSurf + GRID.cubeWall], MAT.clear);
      para(scene, [X(high[1]), yc - hw, highSurf], [-s * 0.06, 0, 0.16], [0, 2 * hw, 0], [s * wt, 0, 0], MAT.clear, { collide: true });
      // clear tower sides + front faces with aluminum edges
      for (const sy of [yc - hw, yc + hw]) {
        fbox(scene, mxr(F - mid[1], F - mid[0], a), [sy - 0.003, sy + 0.003], [GRID.dividerHeight, midSurf], MAT.clear, { collide: false, shadow: false });
        fbox(scene, mxr(F - high[1], F - high[0], a), [sy - 0.003, sy + 0.003], [0, highSurf], MAT.clear, { collide: false, shadow: false });
        for (const d of [mid[0], high[0], high[1]]) fbox(scene, mxr(F - d - 0.012, F - d + 0.012, a), [sy - 0.012, sy + 0.012], [0, d === mid[0] ? midSurf + GRID.cubeWall : highSurf + GRID.cubeWall], frame, { collide: false });
      }
      fbox(scene, mxr(F - mid[0] - 0.006, F - mid[0], a), yr, [0.3, midSurf], MAT.clear, { collide: false, shadow: false });
      fbox(scene, mxr(F - high[0] - 0.006, F - high[0], a), yr, [midSurf, highSurf], MAT.clear, { collide: false, shadow: false });
      for (const z of [midSurf, highSurf]) fbox(scene, mxr(F - (z === midSurf ? mid[0] : high[0]) - 0.015, F - (z === midSurf ? mid[0] : high[0]), a), yr, [z - 0.04, z - 0.01], frame, { collide: false });
      // AprilTag on the front face of the middle-row cube node (bottom 1ft 2¼in above carpet)
      const tagIds = a === 'blue' ? { 1: 8, 4: 7, 7: 6 } : { 1: 1, 4: 2, 7: 3 };
      tagPlane(scene, tagIds[c], X(mid[0]) + s * 0.004, yc, 14.25 * IN, a === 'blue');
    } else {
      // ---- CONE NODES: aluminum pipes rising through the 35° textured slope
      const y0 = bounds[c] + (c === 0 ? 0 : dw / 2);
      const y1 = bounds[c + 1] - (c === 8 ? 0 : dw / 2);
      const coop = c >= 3 && c <= 5;
      const dBack = GRID.depth - 0.03;
      const rise = (dBack - GRID.hybridDepth) * GRID.slope;
      const thick = 0.04;
      para(scene, [X(GRID.hybridDepth), y0, 0], [-s * (dBack - GRID.hybridDepth), 0, rise], [0, y1 - y0, 0], [0, 0, -thick],
        coop ? coopSlope : allianceSlope, { collide: true, friction: 0.5 });
      const r = GRID.poleDiameter / 2;
      for (const [dFront, top, tapeBottom] of [
        [GRID.midConeFront, GRID.midConeZ, 22.125 * IN],
        [GRID.highConeFront, GRID.highConeZ, 41.875 * IN],
      ]) {
        const px = X(dFront);
        const z0 = slopeZ(dFront);
        cyl(scene, px, yc, z0, top - 0.02, r, MAT.pipe);
        cyl(scene, px, yc, top - 0.02, top, r * 1.12, MAT.black); // Caplugs top plug
        cyl(scene, px, yc, tapeBottom, tapeBottom + 4 * IN, r * 1.04, MAT.reflect); // reflective tape
        fixedCylinder(px, yc, z0, top, r);
      }
      // polycarbonate fin between the middle and top row cone nodes
      const fa = GRID.midConeFront + 0.12, fb = GRID.highConeFront - 0.12;
      para(scene, [X(fa), yc - 0.003, slopeZ(fa)], [-s * (fb - fa), 0, slopeZ(fb) - slopeZ(fa)], [0, 0.006, 0], [0, 0, 0.3], MAT.clear);
    }
  }

  // back frame: posts at the grid-assembly edges, top rail and frosted rear panel
  for (const sy of GRID.sections) {
    const yy = clamp(sy, 0.02, GRID.leftY - 0.02);
    tagEnd(a, fbox(scene, mxr(0.0, 0.05, a), [yy - 0.02, yy + 0.02], [0, GRID.height], frame));
    const dA = GRID.hybridDepth, dB = GRID.depth - 0.05;
    para(scene, [X(dA), yy - 0.02, 0.02], [-s * (dB - dA), 0, (dB - dA) * GRID.slope], [0, 0.04, 0], [0, 0, 0.06], frame);
  }
  tagEnd(a,
    fbox(scene, mxr(0.0, 0.07, a), [0, GRID.leftY], [GRID.height - 0.05, GRID.height], frame),
    fbox(scene, mxr(0.0, 0.02, a), [0, GRID.leftY], [GRID.highCubeZ, GRID.height - 0.05], MAT.frosted, { collide: false }),
  );

  // node definitions
  for (let row = 0; row < 3; row++) {
    for (let c = 0; c < 9; c++) {
      const cube = GRID.isCubeCol(c);
      const node = {
        alliance: a,
        row, // 0 = low (hybrid), 1 = mid, 2 = high
        col: c,
        accepts: row === 0 ? 'any' : cube ? 'cube' : 'cone',
        piece: null,
        extra: [], // supercharged pieces
        autoScored: false,
        y: GRID.nodeY[c],
        yMin: bounds[c] + (c === 0 ? 0 : dw / 2),
        yMax: bounds[c + 1] - (c === 8 ? 0 : dw / 2),
      };
      if (row === 0) {
        node.x = X(GRID.hybridDepth / 2);
        node.xr = mxr(F - GRID.hybridDepth, F + 0.05, a);
        node.surface = 0;
      } else {
        const front = row === 1 ? GRID.midCubeFront : GRID.highCubeFront;
        const coneFront = row === 1 ? GRID.midConeFront : GRID.highConeFront;
        if (cube) {
          node.x = X(front + GRID.cubeNodeDepth / 2);
          node.xr = mxr(F - front - GRID.cubeNodeDepth, F - front, a);
          node.surface = row === 1 ? midSurf : highSurf;
          node.yMin = node.y - GRID.cubeNodeWidth / 2;
          node.yMax = node.y + GRID.cubeNodeWidth / 2;
        } else {
          node.x = X(coneFront);
          node.xr = mxr(F - coneFront - 0.05, F - coneFront + 0.05, a);
          node.surface = row === 1 ? GRID.midConeZ : GRID.highConeZ; // pole top
          // a scored cone sits high on the pole: the pole top just reaches the cone's tip opening
          node.coneBase = node.surface - (CONE_HEIGHT - 0.03);
        }
      }
      field.nodes[a].push(node);
    }
  }
}
const CONE_HEIGHT = 12.8125 * IN;

// ---------------------------------------------------------------- charge station
// Main pivoting frame (4ft x 8ft) on hinges at its top surface, self-centering, ±15°.
// Polycarbonate ramps pivot at the frame edge and slide on the carpet (34¼° level, ~11° / ~71½° fully tilted).
function buildChargeStation(scene, a) {
  const cx = mx(CS.centerX, a);
  const cy = CS.centerY;
  const hingeZ = CS.topHeight;
  const halfP = CS.platformDepth / 2;
  const halfW = CS.platformWidth / 2;
  const rampHalfW = CS.width / 2;
  const rampLen = CS.rampLength;
  const rampDrop = hingeZ - rampLen * Math.sin(34.25 * DEG); // ramp hinge sits slightly below the top surface
  const csGroups = groups(GROUP.CS, GROUP.ROBOT | GROUP.PIECE);

  const base = phys.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(cx, hingeZ, -cy));
  const body = phys.world.createRigidBody(
    R.RigidBodyDesc.dynamic().setTranslation(cx, hingeZ, -cy).setAngularDamping(6.0).setLinearDamping(0.5).setCanSleep(false)
  );
  const plate = R.ColliderDesc.cuboid(halfP, 0.03, halfW).setTranslation(0, -0.03, 0).setDensity(160).setFriction(0.9).setCollisionGroups(csGroups);
  register(phys.world.createCollider(plate, body), 'cs', a);
  // side guards (short edges) hang below the frame
  for (const sgn of [-1, 1]) {
    const g = R.ColliderDesc.cuboid(halfP, 0.05, 0.01).setTranslation(0, -0.07, sgn * halfW).setDensity(100).setCollisionGroups(csGroups);
    register(phys.world.createCollider(g, body), 'cs', a);
  }
  const joint = phys.world.createImpulseJoint(
    R.JointData.revolute({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), base, body, true
  );
  const lim = CS.maxTilt * DEG;
  joint.setLimits(-lim, lim);

  // ramps: kinematic bodies posed every step from the frame angle
  const ramps = [-1, 1].map((side) => {
    const rb = phys.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(cx, 0.1, -cy));
    const col = R.ColliderDesc.cuboid(rampLen / 2, 0.012, rampHalfW).setFriction(0.9).setCollisionGroups(csGroups);
    register(phys.world.createCollider(col, rb), 'cs', a);
    return { side, body: rb, angle: 34.25 * DEG };
  });

  // ---- visuals
  const group = new THREE.Group();
  scene.add(group);
  const topTex = canvasTexture(512, 1024, (g, w, h) => {
    g.fillStyle = '#d4d8dd';
    g.fillRect(0, 0, w, h);
    // textured polycarbonate panels between aluminum frame members
    g.strokeStyle = '#9aa0a8';
    g.lineWidth = 10;
    for (let i = 0; i <= 2; i++) { g.beginPath(); g.moveTo((i * w) / 2, 0); g.lineTo((i * w) / 2, h); g.stroke(); }
    for (let j = 0; j <= 4; j++) { g.beginPath(); g.moveTo(0, (j * h) / 4); g.lineTo(w, (j * h) / 4); g.stroke(); }
    g.strokeStyle = '#7c838c';
    g.lineWidth = 16;
    g.strokeRect(8, 8, w - 16, h - 16);
  });
  // official CHARGED UP logo decal in the middle of the top (drawn once the image loads)
  const logo = new Image();
  logo.onload = () => {
    const c = topTex.image;
    const g = c.getContext('2d');
    g.save();
    g.translate(c.width / 2, c.height / 2);
    g.rotate(-Math.PI / 2);
    const lw = 560, lh = (lw * logo.height) / logo.width;
    g.drawImage(logo, -lw / 2, -lh / 2, lw, lh);
    g.restore();
    topTex.needsUpdate = true;
  };
  logo.src = 'assets/charged-up.png';
  const topMat = new THREE.MeshStandardMaterial({ map: topTex, metalness: 0.3, roughness: 0.55 });
  const topMesh = new THREE.Mesh(new THREE.BoxGeometry(halfP * 2, 0.06, halfW * 2), [MAT.alu, MAT.alu, topMat, MAT.alu, MAT.alu, MAT.alu]);
  topMesh.position.y = -0.03;
  topMesh.castShadow = topMesh.receiveShadow = true;
  group.add(topMesh);
  for (const sgn of [-1, 1]) box(halfP * 2, 0.1, 0.02, MAT.frosted, new THREE.Vector3(0, -0.07, sgn * halfW), group);
  // LEVEL lights: alliance-colored strips on the short edges and the four top corners
  const lightHex = a === 'blue' ? 0x2a62ff : 0xff3030;
  const lightMat = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: lightHex, emissiveIntensity: 0 });
  for (const sgn of [-1, 1]) {
    box(halfP * 2 - 0.1, 0.02, 0.012, lightMat, new THREE.Vector3(0, -0.04, sgn * (halfW + 0.012)), group);
    for (const sx of [-1, 1]) {
      box(0.3, 0.008, 0.025, lightMat, new THREE.Vector3(sx * (halfP - 0.18), 0.002, sgn * (halfW - 0.05)), group);
      box(0.025, 0.008, 0.3, lightMat, new THREE.Vector3(sx * (halfP - 0.05), 0.002, sgn * (halfW - 0.18)), group);
    }
  }
  const rampTex = canvasTexture(128, 512, (g, w, h) => {
    g.fillStyle = '#e6eaee';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#c3c9d0';
    for (let j = 0; j < h; j += 24) g.fillRect(0, j, w, 6); // tread texture
  });
  const rampMat = new THREE.MeshStandardMaterial({ map: rampTex, roughness: 0.5, transparent: true, opacity: 0.92 });
  const rampMeshes = ramps.map(() => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(rampLen, 0.024, rampHalfW * 2), rampMat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    return m;
  });
  // fixed base frame (visual)
  const baseMat = MAT.darkAlu;
  for (const sgn of [-1, 1]) {
    box(halfP * 2 + 0.2, 0.06, 0.06, baseMat, W(cx, cy + sgn * (halfW - 0.1), 0.03), scene);
    box(0.08, hingeZ - 0.06, 0.08, baseMat, W(cx, cy + sgn * (halfW - 0.1), (hingeZ - 0.06) / 2), scene);
  }
  box(0.08, 0.06, halfW * 2 - 0.2, baseMat, W(cx, cy, 0.03), scene);

  const cs = {
    alliance: a, body, joint, group, centerX: cx, centerY: cy, ramps, lightMat,
    // tilt in degrees: positive = +x side up
    get tiltDeg() {
      const q = body.rotation();
      const v = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
      return Math.atan2(v.y, v.x) / DEG;
    },
    get tiltRate() {
      return body.angvel().z / DEG;
    },
    // Called before every physics step: self-centering spring, hinge friction, ramp poses
    update(dt) {
      const th = this.tiltDeg * DEG;
      const w = body.angvel().z;
      const I = body.principalInertia().z + 8;
      body.applyTorqueImpulse({ x: 0, y: 0, z: -150 * th * dt }, true); // returns to the middle of the LEVEL range
      const maxImpulse = 40 * dt; // breakaway friction in the double hinges
      body.applyTorqueImpulse({ x: 0, y: 0, z: clamp(-I * w, -maxImpulse, maxImpulse) }, true);
      for (const r of ramps) {
        // frame edge (ramp hinge) in the vertical x-z plane
        const ex = cx + r.side * halfP * Math.cos(th) + rampDrop * Math.sin(th);
        const ez = hingeZ + r.side * halfP * Math.sin(th) - rampDrop * Math.cos(th);
        let ang = Math.asin(clamp(ez / rampLen, -1, 1));
        ang = clamp(ang, 2 * DEG, 72 * DEG);
        const run = rampLen * Math.cos(ang);
        const endX = ex + r.side * run;
        const endZ = ez - rampLen * Math.sin(ang);
        const mxp = (ex + endX) / 2, mzp = (ez + endZ) / 2 - 0.012;
        const rot = r.side > 0 ? -ang : ang;
        r.angle = ang;
        const pos = { x: mxp, y: mzp, z: -cy };
        const q = { x: 0, y: 0, z: Math.sin(rot / 2), w: Math.cos(rot / 2) };
        if (dt === 0) {
          r.body.setTranslation(pos, true);
          r.body.setRotation(q, true);
        } else {
          r.body.setNextKinematicTranslation(pos);
          r.body.setNextKinematicRotation(q);
        }
      }
    },
    sync() {
      const t = body.translation();
      const q = body.rotation();
      group.position.set(t.x, t.y, t.z);
      group.quaternion.set(q.x, q.y, q.z, q.w);
      ramps.forEach((r, i) => {
        const rt = r.body.translation();
        const rq = r.body.rotation();
        rampMeshes[i].position.set(rt.x, rt.y, rt.z);
        rampMeshes[i].quaternion.set(rq.x, rq.y, rq.z, rq.w);
      });
      lightMat.emissiveIntensity = Math.abs(this.tiltDeg) < CS.levelTolerance ? 1.4 : 0;
    },
    contains(fx, fy, margin = 0) {
      const [x0, x1] = mxr(CS.innerX, CS.outerX, a);
      return fx > x0 - margin && fx < x1 + margin && fy > CS.rightY - margin && fy < CS.leftY + margin;
    },
  };
  cs.update(0);
  return cs;
}

// ---------------------------------------------------------------- barrier & cable protector
function buildBarrierAndCable(scene, a) {
  // BARRIER: 7ft 4in long, ½in thick, 1ft ¼in tall polycarbonate wall on a 16in wide, ¼in base
  const xr = mxr(BARRIER.startX, BARRIER.endX, a);
  const yWall = [BARRIER.y, BARRIER.y + BARRIER.thickness];
  fbox(scene, xr, [BARRIER.y - BARRIER.baseWidth / 2 + BARRIER.thickness / 2, BARRIER.y + BARRIER.baseWidth / 2 + BARRIER.thickness / 2], [0, BARRIER.baseHeight], MAT.alu, { friction: 0.8 });
  fbox(scene, xr, yWall, [BARRIER.baseHeight, BARRIER.height], MAT.clear, { shadow: false });
  fbox(scene, xr, [yWall[0] - 0.012, yWall[0]], [BARRIER.baseHeight, 0.06], MAT.alu, { collide: false });
  fbox(scene, xr, [yWall[1], yWall[1] + 0.012], [BARRIER.baseHeight, 0.06], MAT.alu, { collide: false });

  // Cable protector run: black HDPE, ⅞in tall with velcro, 7in wide, ~45° lead-ins, 5ft 6in long
  const cxm = mx(CABLE_BUMP.centerX, a);
  const hw = CABLE_BUMP.width / 2;
  const h = CABLE_BUMP.height;
  const len = CABLE_BUMP.length;
  const pts = [];
  for (const y of [0, len]) pts.push([cxm - hw, y, 0], [cxm + hw, y, 0], [cxm - hw + h, y, h], [cxm + hw - h, y, h]);
  fixedHull(pts, { kind: 'field', friction: 0.8 });
  const shape = new THREE.Shape();
  shape.moveTo(-hw, 0); shape.lineTo(hw, 0); shape.lineTo(hw - h, h); shape.lineTo(-hw + h, h); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.85, side: THREE.DoubleSide }));
  m.position.copy(W(cxm, 0, 0));
  m.scale.z = -1; // extrude along field +y (= -z)
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  // exit segment over the guardrail
  fbox(scene, [cxm - 0.075, cxm + 0.075], [-0.05, 1.75 * IN], [0, 20.75 * IN], MAT.hdpe, { collide: false });
}

// ---------------------------------------------------------------- substations
// Substations for alliance `a` are at the OPPOSITE end of the field.
function buildSubstations(scene, a) {
  const far = a === 'blue' ? 'red' : 'blue';
  const s = far === 'blue' ? 1 : -1; // +x direction into the field from that wall
  const Xd = (d) => mx(d, far);
  const cy = LZ.doubleSubstationCenterY;
  const halfW = LZ.doubleSubstationWidth / 2;
  const shelfZ = LZ.doubleSubstationShelfZ;
  const depth = LZ.doubleSubstationDepth;
  const y0 = cy - halfW, y1 = cy + halfW;
  const frame = new THREE.MeshStandardMaterial({ color: 0xb6bbc3, metalness: 0.7, roughness: 0.35 });

  // ---- DOUBLE SUBSTATION: grate of 1¼in pipes (5 openings), 45° ramp, shelf rail, window, portal
  fixedBox(Xd(depth / 2), cy, (shelfZ - 0.02) / 2, depth, 2 * halfW, shelfZ - 0.02, { kind: 'field' });
  fbox(scene, mxr(0, depth, far), [y0, y1], [0, 0.04], frame, { collide: false });
  fbox(scene, mxr(depth - 0.03, depth, far), [y0, y1], [shelfZ - 0.07, shelfZ - 0.02], frame, { collide: false });
  for (let k = 0; k < 6; k++) cyl(scene, Xd(depth - 0.025), cy + (k - 2.5) * 15 * IN, 0.04, shelfZ - 0.07, (1.66 * IN) / 2, MAT.pipe, 10);
  for (const yy of [y0 + 0.02, y1 - 0.02]) fbox(scene, mxr(0, depth, far), [yy - 0.02, yy + 0.02], [0, shelfZ], frame, { collide: false });
  para(scene, [Xd(depth - 0.05), y0, 0.05], [-s * (depth - 0.08), 0, depth - 0.08], [0, 2 * halfW, 0], [0, 0, 0.006], MAT.clear);
  // shelf rail + window + uprights
  fbox(scene, mxr(0, depth, far), [y0, y1], [shelfZ - 0.02, shelfZ - 0.013], MAT.darkAlu, { collide: false });
  const upper = [
    fbox(scene, mxr(0.02, 0.03, far), [y0, y1], [shelfZ, LZ.doubleSubstationHeight - 0.05], MAT.clear, { collide: false, shadow: false }),
    fbox(scene, mxr(0.0, 0.05, far), [y0, y1], [LZ.doubleSubstationHeight - 0.05, LZ.doubleSubstationHeight], frame, { collide: false }),
  ];
  for (const yy of [y0 + 0.03, cy, y1 - 0.03]) upper.push(fbox(scene, mxr(0.0, 0.05, far), [yy - 0.025, yy + 0.025], [shelfZ, LZ.doubleSubstationHeight], frame, { collide: false }));
  // PORTAL: bent polycarbonate guard at the center
  upper.push(fbox(scene, mxr(0.03, depth - 0.02, far), [cy - 0.3, cy + 0.3], [shelfZ, shelfZ + 0.3], MAT.clearTint, { collide: false, shadow: false }));
  tagEnd(far, ...upper);
  // sliding output shelves (black textured HDPE), pulled out toward the edges
  const doubleSlots = [-1, 1].map((sgn) => {
    const y = cy + sgn * LZ.shelfOffset;
    fbox(scene, mxr(depth - LZ.shelfDepth - 0.005, depth - 0.005, far), [y - LZ.shelfWidth / 2, y + LZ.shelfWidth / 2], [shelfZ - 0.013, shelfZ], MAT.hdpe, { friction: 0.8 });
    return { x: Xd(depth - 0.005 - LZ.shelfDepth / 2), y, z: shelfZ, piece: null, cooldown: 0 };
  });
  // AprilTag centered on the grate (tag bottom 1ft 11⅜in above carpet)
  tagPlane(scene, a === 'blue' ? 4 : 5, Xd(depth + 0.004), cy, 23.375 * IN, far === 'blue');

  // ---- SINGLE SUBSTATION: wire-panel enclosure behind the guardrail with a tilted chute
  const px = mx(LZ.singleSubstationFromWall, far); // portal center
  const pw = LZ.singleSubstationWidth;
  const lowZ = LZ.singleSubstationLowZ;
  const highZ = lowZ + LZ.singleSubstationHeight;
  const yF = FW + 3.125 * IN; // field-facing wall sits 3⅛in behind the guardrail
  const yB = yF + LZ.singleSubstationDepth;
  const ssLen = LZ.singleSubstationLength;
  // portal sits at the end toward midfield; the enclosure runs back to the corner
  const xA = mx(LZ.singleSubstationFromWall + pw / 2 + 0.08, far);
  const xB = xA - s * ssLen;
  const [sx0, sx1] = [Math.min(xA, xB), Math.max(xA, xB)];
  const tall = LZ.singleSubstationTall;
  const mesh = canvasTexture(256, 256, (g) => {
    g.clearRect(0, 0, 256, 256);
    g.strokeStyle = '#151515';
    g.lineWidth = 3;
    for (let i = 0; i <= 256; i += 16) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
    }
  });
  mesh.wrapS = mesh.wrapT = THREE.RepeatWrapping;
  const wire = (wlen, hgt) => {
    const t = mesh.clone();
    t.repeat.set(wlen / 0.25, hgt / 0.25);
    t.needsUpdate = true;
    return new THREE.MeshStandardMaterial({ map: t, transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.8 });
  };
  const panel = (xa, xb, ya, yb, za, zb) => {
    const lenH = Math.max(Math.abs(xb - xa), Math.abs(yb - ya));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(lenH, zb - za), wire(lenH, zb - za));
    m.position.copy(W((xa + xb) / 2, (ya + yb) / 2, (za + zb) / 2));
    if (Math.abs(xb - xa) < Math.abs(yb - ya)) m.rotation.y = Math.PI / 2;
    scene.add(m);
  };
  const [pa, pb] = [px - pw / 2, px + pw / 2];
  // field-facing wall with the PORTAL opening
  panel(sx0, pa, yF, yF, 0, tall);
  panel(pb, sx1, yF, yF, 0, tall);
  panel(pa, pb, yF, yF, 0, lowZ);
  panel(pa, pb, yF, yF, highZ, tall);
  panel(sx0, sx1, yB, yB, 0, tall);
  panel(sx0, sx0, yF, yB, 0, tall);
  panel(sx1, sx1, yF, yB, 0, tall);
  for (const xx of [sx0, pa, pb, sx1]) fbox(scene, [xx - 0.02, xx + 0.02], [yF - 0.02, yF + 0.02], [0, tall], MAT.darkAlu, { collide: false });
  fbox(scene, [sx0, sx1], [yF - 0.02, yB], [tall - 0.03, tall], MAT.darkAlu, { collide: false });
  // chute: tilted plastic enclosure rising away from the field
  const chute = para(scene, [pa, yF, lowZ], [0, LZ.singleSubstationDepth - 0.05, 0.42], [pw, 0, 0], [0, 0, 0.006], MAT.clearTint);
  const cTop = para(scene, [pa, yF, highZ], [0, LZ.singleSubstationDepth - 0.05, 0.42], [pw, 0, 0], [0, 0, 0.006], MAT.clearTint);
  for (const xx of [pa, pb - 0.006]) para(scene, [xx, yF, lowZ], [0, LZ.singleSubstationDepth - 0.05, 0.42], [0.006, 0, 0], [0, 0, highZ - lowZ], MAT.clearTint);
  void chute; void cTop;

  return {
    alliance: a,
    doubleSlots,
    single: { x: px, y: FW - 0.05, z: lowZ + 0.05, cooldown: 0 },
    approachX: Xd(depth), // front face x
    facing: far === 'red' ? 0 : Math.PI, // robot heading when facing the double substation
  };
}

export { mx, mxr };
