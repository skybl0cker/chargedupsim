import { FIELD, GRID, CHARGE_STATION as CS, COMMUNITY, BARRIER, LOADING_ZONE as LZ, STAGING, MATCH } from './constants.js';
import { clamp, wrapAngle } from './util.js';
import { mx, mxr } from './field.js';

const L = FIELD.length;
const FW = FIELD.width;
const RES = 0.1;
const NX = Math.ceil(L / RES);
const NY = Math.ceil(FW / RES);

// ------------------------------------------------------------ static navigation grid (A*)
let occ = null;
function buildOcc() {
  occ = new Uint8Array(NX * NY);
  const rects = [];
  for (const a of ['blue', 'red']) {
    const far = a === 'blue' ? 'red' : 'blue';
    rects.push([mxr(0, GRID.outerX, a), [0, GRID.leftY], 0.3]);
    rects.push([mxr(CS.innerX, CS.outerX, a), [CS.rightY, CS.leftY], 0.52]);
    rects.push([mxr(BARRIER.startX, BARRIER.endX, a), [BARRIER.y, BARRIER.y + BARRIER.thickness], 0.52]);
    rects.push([mxr(0, LZ.doubleSubstationDepth, far), [LZ.doubleSubstationCenterY - 1.22, FW], 0.3]);
  }
  for (let i = 0; i < NX; i++)
    for (let j = 0; j < NY; j++) {
      const x = (i + 0.5) * RES, y = (j + 0.5) * RES;
      let blocked = x < 0.45 || x > L - 0.45 || y < 0.45 || y > FW - 0.45;
      for (const [[x0, x1], [y0, y1], inf] of rects) {
        if (x > x0 - inf && x < x1 + inf && y > y0 - inf && y < y1 + inf) { blocked = true; break; }
      }
      occ[j * NX + i] = blocked ? 1 : 0;
    }
}

const cellOf = (x, y) => [clamp(Math.floor(x / RES), 0, NX - 1), clamp(Math.floor(y / RES), 0, NY - 1)];
const free = (i, j) => i >= 0 && j >= 0 && i < NX && j < NY && !occ[j * NX + i];

function nearestFree(i, j) {
  if (free(i, j)) return [i, j];
  for (let r = 1; r < 25; r++)
    for (let di = -r; di <= r; di++)
      for (const dj of [-r, r]) {
        if (free(i + di, j + dj)) return [i + di, j + dj];
        if (free(i + dj, j + di)) return [i + dj, j + di];
      }
  return [i, j];
}

function lineFree(x0, y0, x1, y1) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (RES * 0.5));
  for (let k = 0; k <= n; k++) {
    const [i, j] = cellOf(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
    if (!free(i, j)) return false;
  }
  return true;
}

export function planPath(sx, sy, gx, gy) {
  if (!occ) buildOcc();
  const [si, sj] = nearestFree(...cellOf(sx, sy));
  const [gi, gj] = nearestFree(...cellOf(gx, gy));
  const N = NX * NY;
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = [];
  const push = (idx, f) => {
    heap.push([f, idx]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  const h = (i, j) => {
    const dx = Math.abs(i - gi), dy = Math.abs(j - gj);
    return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
  };
  const start = sj * NX + si, goal = gj * NX + gi;
  g[start] = 0;
  push(start, h(si, sj));
  let found = false;
  while (heap.length) {
    const [, cur] = pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === goal) { found = true; break; }
    const ci = cur % NX, cj = (cur / NX) | 0;
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (!free(ni, nj)) continue;
        if (di && dj && (!free(ci + di, cj) || !free(ci, cj + dj))) continue;
        const nIdx = nj * NX + ni;
        const ng = g[cur] + (di && dj ? Math.SQRT2 : 1);
        if (ng < g[nIdx]) {
          g[nIdx] = ng;
          came[nIdx] = cur;
          push(nIdx, ng + h(ni, nj));
        }
      }
  }
  if (!found) return [[gx, gy]];
  const cells = [];
  for (let c = goal; c !== -1; c = came[c]) cells.push([((c % NX) + 0.5) * RES, (((c / NX) | 0) + 0.5) * RES]);
  cells.reverse();
  // string-pull smoothing
  const out = [];
  let anchor = [sx, sy];
  let k = 0;
  while (k < cells.length - 1) {
    let far = k + 1;
    for (let m = cells.length - 1; m > k; m--) {
      if (lineFree(anchor[0], anchor[1], cells[m][0], cells[m][1])) { far = m; break; }
    }
    out.push(cells[far]);
    anchor = cells[far];
    k = far;
  }
  out.push([gx, gy]);
  return out;
}

// Charge station balance: creep toward the high side only while the station is still,
// back off a touch as soon as it starts tipping (how most 2023 teams' auto-balance worked).
export function balanceSpeed(cs) {
  const tilt = cs.tiltDeg;
  const rate = cs.tiltRate;
  // hysteresis: once level, hold the brakes until it really drifts
  if (Math.abs(tilt) < 1.2) cs.balanceHold = true;
  if (cs.balanceHold && Math.abs(tilt) < 2.0) return 0; // stay inside the 2.5° ENGAGED window
  cs.balanceHold = false;
  if (Math.abs(rate) > 5 && Math.sign(rate) !== Math.sign(tilt)) return -Math.sign(tilt) * 0.1; // tipping our way: ease back
  const creep = Math.abs(tilt) > 10 ? 0.4 : Math.abs(tilt) > 5 ? 0.22 : 0.07;
  return Math.sign(tilt) * creep;
}

// ------------------------------------------------------------ controller
export class AIController {
  constructor(robot, game, { routine = 'none', autoOnly = false } = {}) {
    this.r = robot;
    this.game = game;
    this.routine = routine;
    this.autoOnly = autoOnly;
    this.gen = null;
    this.phase = null;
    this.path = null;
    this.pathGoal = null;
    this.replanT = 0;
    this.stuckT = 0;
    this.backoffT = 0;
    this.backoffDir = [0, 0];
    this.reserved = null;
    this.dt = 1 / 120;
    this.skill = robot.skill;
    this.dir = robot.alliance === 'blue' ? 1 : -1; // +x direction away from own wall
    this.faceGrid = robot.alliance === 'blue' ? Math.PI : 0;
    this.faceAway = robot.alliance === 'blue' ? 0 : Math.PI;
  }

  update(dt) {
    this.dt = dt;
    const g = this.game;
    const want = g.isAuto ? 'auto' : g.phase === 'teleop' ? (this.inEndgameWindow() ? 'endgame' : 'teleop') : null;
    if (want !== this.phase) {
      this.phase = want;
      this.release();
      this.r.intaking = false;
      if (want === 'auto') this.gen = this.autoRoutine();
      else if (want === 'teleop' && !this.autoOnly) this.gen = this.teleopLoop();
      else if (want === 'endgame' && !this.autoOnly) this.gen = this.endgame();
      else this.gen = null;
    }
    this.r.cmd = { vx: 0, vy: 0, omega: 0 };
    if (this.gen) {
      const res = this.gen.next();
      if (res.done) this.gen = null;
    }
  }

  inEndgameWindow() {
    if (this.game.config.practice) return false;
    const rem = MATCH.teleopTime - this.game.phaseTime;
    if (this.phase === 'endgame') return true;
    if (!this.isBalancer()) return rem <= 6;
    // leave early enough to drive over and balance from wherever we are
    const p = this.r.pose();
    const cs = this.game.field.cs[this.r.alliance];
    const dist = Math.hypot(p.x - cs.centerX, p.y - cs.centerY);
    return rem <= 11 + dist / (1.6 + this.skill);
  }

  isBalancer() {
    const mates = this.game.ais.filter((a) => a.r.alliance === this.r.alliance);
    const pref = mates.find((a) => a.r.station === 1) || mates[0];
    return pref === this;
  }

  release() {
    if (this.reserved) { this.reserved.reservedBy = null; this.reserved = null; }
  }

  // ---------------------------------------------------------- low-level motion
  // Drive toward a field pose. Returns true when settled at the pose.
  navigate(x, y, yaw, { tol = 0.04, yawTol = 0.05, speed = 1, direct = false, gentle = 3.2 } = {}) {
    const r = this.r;
    const p = r.pose();
    const dist = Math.hypot(x - p.x, y - p.y);
    const maxV = r.profile.maxSpeed * 0.92 * speed * (0.35 + 0.65 * this.skill);
    let tx = x, ty = y;
    if (!direct && dist > 0.9) {
      this.replanT -= this.dt;
      const goalMoved = !this.pathGoal || Math.hypot(this.pathGoal[0] - x, this.pathGoal[1] - y) > 0.2;
      if (!this.path || goalMoved || this.replanT <= 0) {
        this.path = planPath(p.x, p.y, x, y);
        this.pathGoal = [x, y];
        this.replanT = 1.2;
      }
      // pure pursuit: furthest waypoint within the lookahead, or the next one
      while (this.path.length > 1 && Math.hypot(this.path[0][0] - p.x, this.path[0][1] - p.y) < 0.35) this.path.shift();
      [tx, ty] = this.path[0];
    }
    let ex = tx - p.x, ey = ty - p.y;
    const ed = Math.hypot(ex, ey) || 1e-6;
    let v;
    // continuous braking curve the drivetrain can actually follow, then a gentle final approach
    v = Math.min(maxV, Math.sqrt(2 * r.profile.maxAccel * 0.45 * dist));
    if (dist < 0.9) v = Math.min(v, dist * gentle + 0.03);
    let vx = (ex / ed) * v;
    let vy = (ey / ed) * v;
    if (dist < 0.004) { vx = 0; vy = 0; }
    // avoid other robots
    for (const o of this.game.robots) {
      if (o === r) continue;
      const op = o.pose();
      const dx = p.x - op.x, dy = p.y - op.y;
      const d = Math.hypot(dx, dy);
      if (!direct && d < 1.25 && d > 0.01 && dist > 0.5) {
        const push = (1.25 - d) * 2.2;
        // sidestep perpendicular to travel direction plus a little separation
        const side = Math.sign(vx * dy - vy * dx) || 1;
        vx += (dx / d) * push * 0.5 + (-vy / (v || 1)) * push * side * 0.6;
        vy += (dy / d) * push * 0.5 + (vx / (v || 1)) * push * side * 0.6;
      }
    }
    // stuck detection -> back off
    const vel = r.fieldVel();
    if (this.backoffT > 0) {
      this.backoffT -= this.dt;
      vx = this.backoffDir[0];
      vy = this.backoffDir[1];
    } else if (v > 0.6 && Math.hypot(vel.vx, vel.vy) < 0.12) {
      this.stuckT += this.dt;
      if (this.stuckT > 0.9) {
        this.stuckT = 0;
        this.backoffT = 0.5;
        const ang = Math.atan2(-ey, -ex) + (Math.random() - 0.5) * 2.2;
        this.backoffDir = [Math.cos(ang) * 1.5, Math.sin(ang) * 1.5];
        this.path = null;
      }
    } else this.stuckT = Math.max(0, this.stuckT - this.dt);

    const yerr = wrapAngle(yaw - p.yaw);
    const omega = clamp(yerr * 5, -r.profile.maxOmega * 0.6, r.profile.maxOmega * 0.6);
    r.cmd = { vx, vy, omega };
    return dist < tol && Math.abs(yerr) < yawTol && Math.hypot(vel.vx, vel.vy) < 0.15;
  }

  *driveTo(x, y, yaw, opts = {}) {
    const timeout = opts.timeout ?? 12;
    let t = 0;
    while (!this.navigate(x, y, yaw, opts)) {
      t += this.dt;
      if (t > timeout) return false;
      yield;
    }
    return true;
  }

  *wait(sec) {
    for (let t = 0; t < sec; t += this.dt) yield;
  }

  // ---------------------------------------------------------- tasks
  nodeApproach(node) {
    return [mx(GRID.outerX + this.r.half + 0.035, this.r.alliance), node.y, this.faceGrid];
  }

  *scoreNode(node) {
    const r = this.r;
    const [x, y0, yaw] = this.nodeApproach(node);
    // less experienced drive teams sometimes misjudge the placement and drop the piece
    const fumble = !this.game.isAuto && Math.random() < (1 - this.skill) * 0.4;
    const y = y0 + (fumble ? (Math.random() < 0.5 ? -1 : 1) * 0.13 : 0);
    const tol = node.accepts === 'cone' ? 0.025 : 0.045;
    let t = 0;
    for (;;) {
      const p = r.pose();
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < 2.2) r.setPreset(['hybrid', 'mid', 'high'][node.row]);
      else r.setPreset('stow');
      const there = this.navigate(x, y, yaw, { tol, yawTol: 0.035, gentle: 2.0 }); // ease into the grid
      if (there && r.armAtTarget(1.5, 0.02)) break;
      t += this.dt;
      if (t > 14 || !r.held) return false;
      yield;
    }
    yield* this.wait(0.15 + (1 - this.skill) * 4);
    r.outtakeRequest = true;
    yield;
    yield* this.wait(0.2);
    r.setPreset('stow');
    this.release();
    return true;
  }

  *scorePreload() {
    const r = this.r;
    if (!r.held) return;
    const nodes = this.game.field.nodes[r.alliance];
    const node = nodes[2 * 9 + r.startCol];
    yield* this.scoreNode(node);
  }

  *pickupFloor(piece, timeout = 5) {
    const r = this.r;
    r.setMode(piece.type);
    r.setPreset('floor');
    let t = 0;
    while (!r.held && piece.state === 'free') {
      const p = r.pose();
      const pp = piece.fieldPos();
      const dx = pp.x - p.x, dy = pp.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      // mechanism decides which side picks up this piece (6328: cubes in front, cones behind)
      const fp = r.mech.floorPickup(piece.type);
      const yaw = Math.atan2(dy, dx) + (fp.side < 0 ? Math.PI : 0);
      const reach = fp.reach;
      const near = d < 1.6;
      r.intaking = near;
      if (!near) r.setPreset('stow'); else r.setPreset('floor');
      this.navigate(pp.x - (dx / d) * reach * 0.9, pp.y - (dy / d) * reach * 0.9, yaw, { tol: 0.02, speed: near ? 0.5 : 1 });
      t += this.dt;
      if (t > timeout) break;
      yield;
    }
    r.intaking = false;
    r.setPreset('stow');
    return !!r.held;
  }

  chooseNode(type) {
    const g = this.game;
    const a = this.r.alliance;
    const nodes = g.field.nodes[a];
    const full = g.gridFull(a);
    const p = this.r.pose();
    const needCoop = g.coopCount(a) < 3;
    let best = null, bestS = -Infinity;
    for (const n of nodes) {
      if (n.reservedBy && n.reservedBy !== this) continue;
      if (n.piece && !full) continue;
      if (n.accepts !== 'any' && n.accepts !== type) continue;
      let s = [2, 3, 5][n.row] * 1.0;
      // link potential: neighbors filled in same row
      const row = nodes.slice(n.row * 9, n.row * 9 + 9);
      const filled = (c) => c >= 0 && c < 9 && (row[c].piece || c === n.col);
      for (let s0 = n.col - 2; s0 <= n.col; s0++) {
        if (s0 < 0 || s0 + 2 > 8) continue;
        const cnt = [s0, s0 + 1, s0 + 2].filter((c) => row[c].piece).length;
        if (filled(s0) && filled(s0 + 1) && filled(s0 + 2)) s += 5;
        else s += cnt * 0.6;
      }
      if (needCoop && n.col >= 3 && n.col <= 5) s += 2.5;
      s -= Math.abs(n.y - p.y) * 0.35;
      if (s > bestS) { bestS = s; best = n; }
    }
    return best;
  }

  neededType() {
    const nodes = this.game.field.nodes[this.r.alliance];
    let cone = 0, cube = 0;
    for (const n of nodes) {
      if (n.piece || n.reservedBy) continue;
      const v = [0.5, 3, 5][n.row];
      if (n.accepts === 'cone') cone += v;
      if (n.accepts === 'cube') cube += v;
    }
    if (cone === 0 && cube === 0) return Math.random() < 0.5 ? 'cone' : 'cube';
    // cones are slower to place; weight them slightly lower
    return cone * 0.9 > cube ? 'cone' : 'cube';
  }

  loosePieceNear(maxD) {
    const p = this.r.pose();
    let best = null, bd = maxD;
    for (const pc of this.game.pieces) {
      if (pc.state !== 'free' || this.game.isSlotPiece(pc)) continue;
      const q = pc.fieldPos();
      if (q.z > 0.3) continue;
      if (q.x < 2.0 || q.x > L - 2.0 || q.y < 0.35 || q.y > FW - 0.35) continue;
      if (this.game.field.cs.blue.contains(q.x, q.y, 0.3) || this.game.field.cs.red.contains(q.x, q.y, 0.3)) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = pc; }
    }
    return best;
  }

  *getFromSubstation() {
    const r = this.r;
    const g = this.game;
    const sub = g.field.substations[r.alliance];
    const type = this.neededType();
    r.setMode(type);
    const slots = sub.doubleSlots;
    let slot = slots.find((s) => s.piece && s.piece.type === type && !this.slotTaken(s)) || slots.find((s) => !this.slotTaken(s)) || slots[0];
    slot.claimedBy = this;
    const dirX = sub.facing === 0 ? 1 : -1;
    const x = sub.approachX - dirX * (r.half + 0.04);
    let t = 0;
    while (!r.held) {
      const p = r.pose();
      const d = Math.hypot(x - p.x, slot.y - p.y);
      if (d < 4) g.request[r.alliance] = type;
      r.setPreset(d < 2.8 ? 'double' : 'stow');
      r.intaking = d < 1.0;
      this.navigate(x, slot.y, sub.facing, { tol: 0.03 });
      t += this.dt;
      if (t > 16) break;
      yield;
    }
    slot.claimedBy = null;
    r.intaking = false;
    yield* this.wait((1 - this.skill) * 4);
    r.setPreset('stow');
  }

  slotTaken(s) {
    return s.claimedBy && s.claimedBy !== this;
  }

  *teleopLoop() {
    const r = this.r;
    for (;;) {
      if (!r.held) {
        const loose = this.loosePieceNear(2.5);
        if (loose) yield* this.pickupFloor(loose, 4);
        else yield* this.getFromSubstation();
        continue;
      }
      const node = this.chooseNode(r.held.type);
      if (!node) {
        yield* this.wait(0.5);
        continue;
      }
      this.reserved = node;
      node.reservedBy = this;
      const ok = yield* this.scoreNode(node);
      this.release();
      if (!ok && r.held) {
        // couldn't line up (traffic) — try again with a fresh choice
        yield* this.wait(0.2);
      }
    }
  }

  *endgame() {
    const r = this.r;
    r.intaking = false;
    r.setPreset('stow');
    if (this.isBalancer()) {
      yield* this.balance('outside');
    } else {
      // park inside the community, clear of the charge station
      const y = [GRID.nodeY[1], GRID.nodeY[7], GRID.nodeY[4]][r.station];
      const x = mx(GRID.outerX + r.half + 0.35, r.alliance);
      for (;;) {
        this.navigate(x, y, this.faceGrid, { tol: 0.1, yawTol: 0.3 });
        yield;
      }
    }
  }

  // Drive onto the charge station from one side and PD-balance on its tilt
  *balance(side) {
    const r = this.r;
    const a = r.alliance;
    const cs = this.game.field.cs[a];
    const outside = side === 'outside';
    const sx = outside ? mx(CS.outerX + 0.75, a) : mx(CS.innerX - 0.75, a);
    const y = cs.centerY + (r.station - 1) * 0.05;
    const yaw = outside ? this.faceGrid : this.faceAway;
    r.setPreset('stow');
    yield* this.driveTo(sx, y, yaw, { tol: 0.12, yawTol: 0.08, timeout: 10 });
    const towardX = Math.sign(cs.centerX - sx);
    // climb
    let t = 0;
    while (Math.abs(r.pose().x - cs.centerX) > 0.42 && t < 5) {
      const p = r.pose();
      r.cmd = { vx: towardX * 1.25, vy: (y - p.y) * 2, omega: wrapAngle(yaw - p.yaw) * 4 };
      t += this.dt;
      yield;
    }
    for (;;) {
      const p = r.pose();
      const onStation = r.ground.cs === a && Math.abs(p.x - cs.centerX) < 0.75;
      // fell off / never made it up (traffic, timeout): drive back onto the platform first
      const vx = onStation ? balanceSpeed(cs) * (0.85 + 0.15 * this.skill) : clamp((cs.centerX - p.x) * 2, -1.1, 1.1);
      r.cmd = { vx, vy: clamp((y - p.y) * 2, -0.3, 0.3), omega: wrapAngle(yaw - p.yaw) * 3 };
      yield;
    }
  }

  // ---------------------------------------------------------- autonomous routines
  *autoRoutine() {
    const r = this.r;
    const a = r.alliance;
    const R = this.routine;
    if (R === 'none') return;
    if (R === 'mobility') {
      const p = r.pose();
      yield* this.driveTo(mx(COMMUNITY.outerX + 0.9, a), p.y, p.yaw, { direct: true, speed: 0.5, tol: 0.15, yawTol: 0.3 });
      return;
    }
    yield* this.scorePreload();
    if (R === 'high') return;
    if (R === 'high_mobility') {
      const p = r.pose();
      const overCS = p.y > CS.rightY - 0.3 && p.y < CS.leftY + 0.3;
      yield* this.driveTo(mx(COMMUNITY.outerX + 0.9, a), p.y, this.faceAway, { direct: true, speed: overCS ? 0.4 : 0.8, tol: 0.15, yawTol: 0.3 });
      return;
    }
    if (R === 'high_engage') {
      yield* this.balance('inside');
      return;
    }
    if (R === 'high_mobility_engage') {
      const cs = this.game.field.cs[a];
      yield* this.driveTo(mx(CS.innerX - 0.7, a), cs.centerY, this.faceGrid, { tol: 0.12, yawTol: 0.1, timeout: 4 });
      yield* this.driveTo(mx(CS.outerX + 0.65, a), cs.centerY, this.faceGrid, { direct: true, speed: 0.38, tol: 0.15, yawTol: 0.2, timeout: 5 });
      yield* this.wait(0.3);
      yield* this.balance('outside');
      return;
    }
    if (R === 'two_piece') {
      // grab the staged piece nearest this robot's lane
      const p = r.pose();
      let target = null, bd = Infinity;
      for (const pc of this.game.pieces) {
        if (pc.state !== 'free') continue;
        const q = pc.fieldPos();
        if (Math.abs(q.x - mx(STAGING.x, a)) > 0.5) continue;
        const d = Math.abs(q.y - p.y);
        if (d < bd) { bd = d; target = pc; }
      }
      if (!target) return;
      const q = target.fieldPos();
      yield* this.driveTo(mx(STAGING.x - 1.0, a), q.y, this.faceAway, { tol: 0.25, yawTol: 0.25, timeout: 4 });
      const got = yield* this.pickupFloor(target, 3);
      if (!got) return;
      const node = this.chooseNode(r.held.type);
      if (node) {
        node.reservedBy = this;
        this.reserved = node;
        yield* this.scoreNode(node);
      }
    }
  }
}
