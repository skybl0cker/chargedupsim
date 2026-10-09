import * as THREE from 'three';
import { FIELD, GRID, MATCH, POINTS, STAGING, CHARGE_STATION as CS, LOADING_ZONE as LZ } from './constants.js';
import { pointInPoly, Wr } from './util.js';
import { communityPoly, loadingZonePoly, mx } from './field.js';
import { Piece, CONE_HALF, CUBE_HALF } from './pieces.js';
import { Robot } from './robot.js';
import { AIController } from './ai.js';

const ROW_NAMES = ['LOW', 'MID', 'HIGH'];
const TEAMS = { blue: [254, 1678, 6328], red: [118, 2056, 4414] };

export class Game {
  constructor(scene, field, config, hooks = {}) {
    this.scene = scene;
    this.field = field;
    this.config = config;
    this.hooks = hooks; // { toast(msg, alliance) }
    this.robots = [];
    this.pieces = [];
    this.ais = [];
    this.phase = 'pre';
    this.phaseTime = 0;
    this.matchTime = 0;
    this.request = { blue: 'cone', red: 'cone' };
    this.autoCS = { blue: null, red: null }; // 'docked' | 'engaged' | null
    this.endCS = { blue: [], red: [] };
    this.fouls = { blue: [], red: [] }; // violations committed BY each alliance
    this.time = 0;
    this.anims = [];
    this.settleTimer = 0;
    this.player = null;
    this.endgameEvaluated = false;
    this.lastLinks = { blue: 0, red: 0 };
    this.setup();
  }

  // ------------------------------------------------------------ setup
  setup() {
    const cfg = this.config;
    // Single-robot sim: only the player's robot is on the field
    const a0 = cfg.alliance;
    const i0 = cfg.station;
    const r = new Robot(this.scene, { alliance: a0, station: i0, team: TEAMS[a0][i0], isPlayer: true, skill: 1, profile: cfg.robot });
    r.driveMode = cfg.driveMode;
    const col = [0, 4, 8][i0];
    r.startCol = col;
    // start facing the grid with whichever side scores the preload high
    const backScore = r.mech.scoreSide && r.mech.scoreSide(2) < 0;
    r.place(mx(GRID.outerX + r.half + 0.03, a0), GRID.nodeY[col], (a0 === 'blue') !== backScore ? Math.PI : 0);
    r.setMode(GRID.isCubeCol(col) ? 'cube' : 'cone');
    r.setPreset('stow');
    this.robots.push(r);
    // preload
    const pre = new Piece(this.scene, r.mode, 0, 0, 2);
    pre.grab(r);
    r.held = pre;
    pre.body.setTranslation(r.heldPose().pos, true);
    this.player = r;
    for (const a of ['blue', 'red']) {
      // staged pieces
      const pattern = cfg.staging === 'cubes' ? ['cube', 'cube', 'cube', 'cube']
        : cfg.staging === 'cones' ? ['cone', 'cone', 'cone', 'cone'] : ['cone', 'cube', 'cube', 'cone'];
      STAGING.y.forEach((y, k) => this.pieces.push(new Piece(this.scene, pattern[k], mx(STAGING.x, a), y)));
    }
    for (const r of this.robots) if (r.held) this.pieces.push(r.held);
    if (this.player) this.playerAuto = new AIController(this.player, this, { routine: cfg.autoRoutine, autoOnly: true });
    if (cfg.practice) {
      this.phase = 'teleop';
      this.matchTime = Infinity;
    }
  }

  dispose() {
    for (const r of this.robots) r.dispose();
    for (const p of this.pieces) p.dispose();
  }

  // ------------------------------------------------------------ timing
  get isAuto() {
    return this.phase === 'auto';
  }

  get enabled() {
    return this.phase === 'auto' || this.phase === 'teleop';
  }

  // Seconds remaining shown on the arena clock
  get clock() {
    if (this.phase === 'pre') return MATCH.autoTime;
    if (this.phase === 'auto') return Math.max(0, MATCH.autoTime - this.phaseTime);
    if (this.phase === 'pause') return MATCH.teleopTime;
    if (this.phase === 'teleop') return this.config.practice ? Infinity : Math.max(0, MATCH.teleopTime - this.phaseTime);
    return 0;
  }

  setPhase(p) {
    this.phase = p;
    this.phaseTime = 0;
    this.hooks.phase?.(p);
  }

  update(dt) {
    this.phaseTime += dt;
    this.time += dt;
    switch (this.phase) {
      case 'pre':
        if (this.phaseTime > 3) { this.setPhase('auto'); this.hooks.sound?.('start'); }
        break;
      case 'auto':
        if (this.phaseTime >= MATCH.autoTime) { this.setPhase('pause'); this.hooks.sound?.('end-auto'); }
        break;
      case 'pause':
        if (!this.autoEvaluated && this.phaseTime > 1.5) { this.evaluateAutoCS(); this.autoEvaluated = true; }
        if (this.phaseTime >= MATCH.autoTeleopDelay) { this.setPhase('teleop'); this.hooks.sound?.('teleop'); }
        break;
      case 'teleop':
        if (!this.config.practice) {
          const remaining = MATCH.teleopTime - this.phaseTime;
          if (remaining <= MATCH.endgameTime && !this.endgameWarned) { this.endgameWarned = true; this.hooks.sound?.('endgame'); this.hooks.toast?.('ENDGAME', null); }
          if (remaining <= 0) { this.setPhase('post'); this.hooks.sound?.('end'); }
        }
        break;
      case 'post':
        if (!this.endgameEvaluated && this.phaseTime > 3) {
          this.evaluateEndCS();
          this.endgameEvaluated = true;
          this.hooks.matchOver?.(this.results());
        }
        break;
    }
    this.updateHumanPlayers(dt);
    this.settleTimer += dt;
    if (this.settleTimer > 0.2) {
      this.settleTimer = 0;
      this.checkSettledPieces();
    }
    if (this.isAuto) this.trackMobility();
    this.updateAnims(dt);
    this.trackPieces();
    if (this.enabled) for (const r of this.robots) this.monitorRules(r, dt);
  }

  // ------------------------------------------------------------ fouls (2023 manual §7 G-rules)
  addFoul(robot, rule, desc, tech = false) {
    this.fouls[robot.alliance].push({ rule, desc, tech, time: this.time });
    this.hooks.foul?.({ rule, desc, tech, alliance: robot.alliance });
    this.hooks.sound?.('foul');
  }

  // points credited TO `alliance` from opponent violations
  foulPoints(alliance) {
    const opp = alliance === 'blue' ? 'red' : 'blue';
    return this.fouls[opp].reduce((s, f) => s + (f.tech ? POINTS.techFoul : POINTS.foul), 0);
  }

  anyIn(robot, poly) {
    const p = robot.pose();
    return pointInPoly(p.x, p.y, poly) || robot.corners().some(([x, y]) => pointInPoly(x, y, poly));
  }

  fullyIn(robot, poly) {
    return robot.corners().every(([x, y]) => pointInPoly(x, y, poly));
  }

  monitorRules(r, dt) {
    const st = (r.rules ||= {});
    // a violation "episode": fires once after `grace` seconds (MOMENTARY = under ~3 s), resets when it ends
    const ep = (key, cond, grace, fire) => {
      const e = (st[key] ||= { t: 0, fired: false, count: 0 });
      if (cond) {
        e.t += dt;
        if (!e.fired && e.t >= grace) { e.fired = true; e.count++; fire(e.count); }
      } else { e.t = 0; e.fired = false; }
    };
    const own = r.alliance, opp = own === 'blue' ? 'red' : 'blue';
    const env = r.mech.envelope ? r.mech.envelope() : { maxH: 0, front: 0, back: 0 };
    r.envelope = env;
    const ownZones = [communityPoly(own), loadingZonePoly(own)];
    const oppZones = [communityPoly(opp), loadingZonePoly(opp)];
    const extended = env.front > 0.03 || env.back > 0.03;
    ep('G106', env.maxH > 78 * 0.0254, 0, () => this.addFoul(r, 'G106', 'robot taller than 6 ft 6 in'));
    ep('G107', Math.max(env.front, env.back) > 48 * 0.0254, 3, () => this.addFoul(r, 'G107', 'extended more than 48 in past the frame'));
    ep('G108', extended && oppZones.some((z) => this.anyIn(r, z)), 3,
      (n) => this.addFoul(r, 'G108', "extended in the opponent's zone", n > 1));
    if (this.isAuto) {
      const crossed = r.corners().some(([x]) => (own === 'blue' ? x > FIELD.length / 2 - 0.0254 : x < FIELD.length / 2 + 0.0254));
      ep('G302', crossed, 0, () => this.addFoul(r, 'G302', 'crossed the center line in auto'));
    }
    const ocs = this.field.cs[opp];
    const p = r.pose();
    const touchingOppCS = r.ground.cs === opp || ocs.contains(p.x, p.y, r.half + 0.02);
    ep('G304', touchingOppCS && Math.abs(ocs.tiltRate) > 3, 0, () => this.addFoul(r, 'G304', "moved the opponent's charge station"));
    // G403: more than one game piece in CONTROL while completely outside own LOADING ZONE and COMMUNITY
    const v = r.fieldVel();
    const rs = Math.hypot(v.vx, v.vy);
    let controlled = r.held ? 1 : 0;
    if (rs > 0.4) {
      for (const pc of this.pieces) {
        if (pc.state !== 'free') continue;
        const q = pc.fieldPos();
        const lv = pc.body.linvel();
        const local = Math.hypot(q.x - p.x, q.y - p.y);
        if (local < r.half + 0.2 && Math.hypot(lv.x - v.vx, -lv.z - v.vy) < 0.4) controlled++;
      }
    }
    ep('G403', controlled > 1 && !ownZones.some((z) => this.anyIn(r, z)), 3,
      () => { for (let k = 1; k < controlled; k++) this.addFoul(r, 'G403', 'controlling more than 1 game piece'); });
  }

  // G404: launching is only OK with part of the robot in its own COMMUNITY
  onRelease(robot, piece, speed) {
    if (speed > 0.5 && !this.anyIn(robot, communityPoly(robot.alliance))) {
      this.addFoul(robot, 'G404', 'launched a game piece outside the community', true);
    }
  }

  // touch tracking (for G401) + pieces leaving the field
  trackPieces() {
    for (const r of this.robots) {
      const p = r.pose();
      for (const pc of this.pieces) {
        if (pc.state !== 'free') continue;
        const q = pc.fieldPos();
        if (Math.hypot(q.x - p.x, q.y - p.y) < r.half + 0.3 && pc.speed() > 0.2) { pc.touchedBy = r; pc.touchedT = this.time; }
      }
    }
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const pc = this.pieces[i];
      if (pc.state !== 'free') continue;
      const q = pc.fieldPos();
      const out = q.x < -0.1 || q.x > FIELD.length + 0.1 || q.y < -0.1 || q.y > FIELD.width + 0.1 || q.z < -2;
      if (!out) continue;
      if (pc.touchedBy && this.time - pc.touchedT < 5 && this.enabled) this.addFoul(pc.touchedBy, 'G401', 'game piece left the field');
      for (const s of this.allSlots()) if (s.piece === pc) s.piece = null;
      pc.dispose();
      this.pieces.splice(i, 1);
    }
  }

  // cones slide down onto the pole instead of teleporting
  updateAnims(dt) {
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      const e = k * k; // accelerates as it drops
      const pos = a.from.clone().lerp(a.to, e);
      const rot = a.q0.clone().slerp(a.q1, Math.min(1, k * 1.5));
      a.piece.body.setNextKinematicTranslation(pos);
      a.piece.body.setNextKinematicRotation(rot);
      if (k >= 1) {
        const f = { x: a.to.x, y: -a.to.z, z: a.to.y };
        a.piece.lock(f.x, f.y, f.z, a.yaw);
        this.anims.splice(i, 1);
      }
    }
  }

  // Robots run their controllers before each physics step
  preStep(dt, input) {
    for (const r of this.robots) {
      if (!this.enabled) {
        r.cmd = { vx: 0, vy: 0, omega: 0 };
        r.intaking = false;
        r.outtakeRequest = false;
      }
    }
    if (this.enabled) {
      for (const ai of this.ais) ai.update(dt);
      if (this.player) {
        // manual auto: the driver controls the robot during the 15 s autonomous period too
        if (this.isAuto && this.config.autoRoutine !== 'manual') this.playerAuto.update(dt);
        else input.apply(this.player, this, dt);
      }
    }
    this.field.cs.blue.update(dt);
    this.field.cs.red.update(dt);
  }

  // ------------------------------------------------------------ pieces & scoring
  onPickup(robot, piece) {
    for (const slot of this.allSlots()) if (slot.piece === piece) slot.piece = null;
  }

  *allSlots() {
    for (const a of ['blue', 'red']) for (const s of this.field.substations[a].doubleSlots) yield s;
  }

  gridFull(alliance) {
    return this.field.nodes[alliance].every((n) => n.piece);
  }

  // Attempt to place a released piece into a node; returns true if scored
  // Arcade scoring: releasing a lined-up piece places it straight into the node
  tryScore(piece, robot) {
    const node = this.findNode(piece);
    if (!node) return false;
    this.scorePiece(node, piece, robot, true);
    return true;
  }

  // Node the piece would score in if released right now (or null)
  findNode(piece) {
    const p = piece.fieldPos();
    const base = p.z - piece.half;
    let best = null;
    let bestD = Infinity;
    for (const a of ['blue', 'red']) {
      const supercharge = this.gridFull(a) && this.phase === 'teleop';
      for (const n of this.field.nodes[a]) {
        if (n.piece && !supercharge) continue;
        if (n.accepts !== 'any' && n.accepts !== piece.type) continue;
        let ok = false;
        let d = Math.hypot(p.x - n.x, p.y - n.y);
        if (n.row === 0) {
          ok = p.x > Math.min(...n.xr) - 0.12 && p.x < Math.max(...n.xr) + 0.12 && p.y > n.yMin && p.y < n.yMax && base < 0.4;
        } else if (n.accepts === 'cone') {
          // the pole has to enter the cone's base: tight horizontal tolerance, cone close to upright
          ok = d < 0.085 && base > n.surface - 0.3 && base < n.surface + 0.3 && piece.axisUp() > Math.cos((37 * Math.PI) / 180);
        } else {
          ok = p.x > Math.min(...n.xr) - 0.04 && p.x < Math.max(...n.xr) + 0.04 && p.y > n.yMin + 0.02 && p.y < n.yMax - 0.02 &&
            base > n.surface + 3 * 0.0254 - 0.03 && base < n.surface + 0.55;
        }
        if (ok && d < bestD) { bestD = d; best = n; }
      }
    }
    return best;
  }

  scorePiece(node, piece, robot, snap) {
    const supercharge = !!node.piece;
    const yaw = node.alliance === 'blue' ? Math.PI : 0;
    if (snap) {
      let z;
      if (node.row === 0) z = piece.half + 0.002;
      else if (node.accepts === 'cone') z = node.coneBase + piece.half;
      else z = node.surface + piece.half + 0.002;
      if (supercharge) z += 0.12 * (node.extra.length + 1);
      const x = node.row === 0 ? node.x + (node.alliance === 'blue' ? 0.02 : -0.02) : node.x;
      {
        // quick slide into place
        const t = piece.body.translation();
        const r0 = piece.body.rotation();
        piece.state = 'scoring';
        piece.collider.setCollisionGroups(0);
        this.anims.push({
          piece, t: 0, dur: piece.type === 'cone' && node.row > 0 ? 0.2 : 0.14, yaw,
          from: new THREE.Vector3(t.x, t.y, t.z), to: new THREE.Vector3(x, z, -node.y),
          q0: new THREE.Quaternion(r0.x, r0.y, r0.z, r0.w), q1: new THREE.Quaternion(0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)),
        });
      }
    } else {
      piece.lock();
    }
    piece.node = node;
    const auto = this.phase === 'auto' || (this.phase === 'pause' && this.phaseTime < 0.5);
    if (supercharge) {
      node.extra.push(piece);
      this.hooks.toast?.(`SUPERCHARGED +${POINTS.supercharged}`, node.alliance);
    } else {
      node.piece = piece;
      node.autoScored = auto;
      const pts = (auto ? POINTS.auto : POINTS.teleop)[['low', 'mid', 'high'][node.row]];
      this.hooks.toast?.(`+${pts} ${ROW_NAMES[node.row]} ${piece.type.toUpperCase()}${auto ? ' (AUTO)' : ''}`, node.alliance);
      const links = this.linkCount(node.alliance);
      if (links > this.lastLinks[node.alliance]) this.hooks.toast?.(`LINK! +${POINTS.link}`, node.alliance);
      this.lastLinks[node.alliance] = links;
    }
    robot = robot || piece.touchedBy;
    if (robot) {
      robot.stats.scored++;
      // G107: TECH FOUL if the over-extension scores a game piece
      if (robot.rules?.G107?.fired) this.addFoul(robot, 'G107', 'scored while over-extended', true);
    }
    this.hooks.sound?.('score');
  }

  // Pieces dropped/pushed into hybrid nodes or onto cube shelves count once they settle
  checkSettledPieces() {
    for (const pc of this.pieces) {
      if (pc.state !== 'free' || pc.speed() > 0.08) continue;
      const p = pc.fieldPos();
      for (const a of ['blue', 'red']) {
        if ((a === 'blue' && p.x > 2) || (a === 'red' && p.x < FIELD.length - 2)) continue;
        const supercharge = this.gridFull(a) && this.phase === 'teleop';
        for (const n of this.field.nodes[a]) {
          if (n.piece && !supercharge) continue;
          if (n.accepts !== 'any' && n.accepts !== pc.type) continue;
          const inX = p.x > Math.min(...n.xr) && p.x < Math.max(...n.xr);
          const inY = p.y > n.yMin && p.y < n.yMax;
          if (!inX || !inY) continue;
          const top = n.piece ? 0.6 : 0.3; // a supercharged piece rests on top of the first one
          if (n.row === 0 && p.z < top) { this.scorePiece(n, pc, null, false); break; }
          if (n.accepts === 'cube' && p.z > n.surface && p.z < n.surface + top) { this.scorePiece(n, pc, null, false); break; }
        }
        if (pc.state !== 'free') break;
      }
    }
  }

  updateHumanPlayers(dt) {
    for (const a of ['blue', 'red']) {
      const sub = this.field.substations[a];
      for (const slot of sub.doubleSlots) {
        if (slot.piece) {
          const p = slot.piece;
          const fp = p.fieldPos();
          if (p.state !== 'free' || Math.hypot(fp.x - slot.x, fp.y - slot.y) > 0.3 || fp.z < slot.z - 0.2) slot.piece = null;
          else if (p.type !== this.request[a] && this.phase !== 'auto') {
            // human player swaps the piece to match the drive team's signal
            slot.swapT = (slot.swapT || 0) + dt;
            if (slot.swapT > 1.0) {
              p.dispose();
              this.pieces.splice(this.pieces.indexOf(p), 1);
              slot.piece = null;
              slot.cooldown = 0.4;
            }
          } else slot.swapT = 0;
        }
        if (!slot.piece) {
          slot.cooldown -= dt;
          if (slot.cooldown <= 0 && this.phase !== 'auto' && this.phase !== 'pre') {
            const type = this.request[a];
            const half = type === 'cone' ? CONE_HALF : CUBE_HALF;
            slot.piece = new Piece(this.scene, type, slot.x, slot.y, slot.z + half + 0.005, a === 'blue' ? 0 : Math.PI);
            this.pieces.push(slot.piece);
            slot.cooldown = 1.8;
          }
        }
      }
      // single substation: HP drops a piece down the chute when a robot is lined up for it
      const s = sub.single;
      s.cooldown -= dt;
      if (s.cooldown <= 0 && this.phase === 'teleop') {
        for (const r of this.robots) {
          if (r.alliance !== a || !r.intaking || r.held || r.preset !== 'single') continue;
          const e = r.effectorField();
          if (Math.hypot(e.x - s.x, e.y - s.y) < 1.1) {
            const type = this.request[a];
            const half = type === 'cone' ? CONE_HALF : CUBE_HALF;
            const pc = new Piece(this.scene, type, s.x, FIELD.width - half - 0.01, LZ.singleSubstationLowZ + half + 0.02);
            pc.body.setLinvel(Wr(0, -0.6, 0), true);
            this.pieces.push(pc);
            s.cooldown = 3;
            break;
          }
        }
      }
    }
    // cap loose pieces to keep the sim fast: remove oldest free pieces far from action
    if (this.pieces.length > 70) {
      const idx = this.pieces.findIndex((p) => p.state === 'free' && !this.isSlotPiece(p));
      if (idx >= 0) { this.pieces[idx].dispose(); this.pieces.splice(idx, 1); }
    }
  }

  isSlotPiece(p) {
    for (const s of this.allSlots()) if (s.piece === p) return true;
    return false;
  }

  // ------------------------------------------------------------ community / CS checks
  inCommunity(robot, fully = false) {
    const poly = communityPoly(robot.alliance);
    const c = robot.corners();
    const inside = c.map(([x, y]) => pointInPoly(x, y, poly));
    return fully ? inside.every(Boolean) : inside.some(Boolean);
  }

  trackMobility() {
    for (const r of this.robots) {
      if (r.stats.mobility) continue;
      const poly = communityPoly(r.alliance);
      if (r.corners().every(([x, y]) => !pointInPoly(x, y, poly))) {
        r.stats.mobility = true;
        this.hooks.toast?.(`MOBILITY ${r.team} +${POINTS.mobility}`, r.alliance);
      }
    }
  }

  // docked = supported only by its own charge station; contacting = touching it at all
  csStatus(robot) {
    const g = robot.ground;
    const onOwn = g.cs === robot.alliance;
    return { docked: onOwn && !g.carpet && g.csCount >= 2, contacting: onOwn };
  }

  isLevel(alliance) {
    return Math.abs(this.field.cs[alliance].tiltDeg) < CS.levelTolerance;
  }

  // Live engaged state (for HUD + scoring)
  csState(alliance) {
    const rs = this.robots.filter((r) => r.alliance === alliance);
    const st = rs.map((r) => ({ r, ...this.csStatus(r) }));
    const anyContactNotDocked = st.some((s) => s.contacting && !s.docked);
    const level = this.isLevel(alliance);
    return st.map((s) => ({
      robot: s.r,
      docked: s.docked,
      engaged: s.docked && level && !anyContactNotDocked,
    }));
  }

  evaluateAutoCS() {
    for (const a of ['blue', 'red']) {
      const st = this.csState(a);
      if (st.some((s) => s.engaged)) this.autoCS[a] = 'engaged';
      else if (st.some((s) => s.docked)) this.autoCS[a] = 'docked';
      if (this.autoCS[a]) this.hooks.toast?.(`AUTO ${this.autoCS[a].toUpperCase()} +${this.autoCS[a] === 'engaged' ? 12 : 8}`, a);
    }
  }

  evaluateEndCS() {
    for (const a of ['blue', 'red']) {
      const st = this.csState(a);
      this.endCS[a] = st.map((s) => {
        let status = 'none';
        if (s.engaged) status = 'engaged';
        else if (s.docked) status = 'docked';
        else if (this.inCommunity(s.robot, true) || this.inCommunity(s.robot)) status = 'parked';
        return { team: s.robot.team, status };
      });
    }
  }

  // ------------------------------------------------------------ score math
  linkCount(alliance) {
    const nodes = this.field.nodes[alliance];
    let links = 0;
    for (let row = 0; row < 3; row++) {
      let run = 0;
      for (let c = 0; c < 9; c++) {
        const n = nodes[row * 9 + c];
        if (n.piece) {
          run++;
          if (run === 3) { links++; run = 0; }
        } else run = 0;
      }
    }
    return links;
  }

  coopCount(alliance) {
    return this.field.nodes[alliance].filter((n) => n.piece && n.col >= 3 && n.col <= 5).length;
  }

  coopertition() {
    return this.coopCount('blue') >= 3 && this.coopCount('red') >= 3;
  }

  breakdown(alliance) {
    const nodes = this.field.nodes[alliance];
    let autoPieces = 0, teleopPieces = 0, supercharged = 0;
    for (const n of nodes) {
      if (!n.piece) continue;
      const key = ['low', 'mid', 'high'][n.row];
      if (n.autoScored) autoPieces += POINTS.auto[key];
      else teleopPieces += POINTS.teleop[key];
      supercharged += n.extra.length * POINTS.supercharged;
    }
    const robots = this.robots.filter((r) => r.alliance === alliance);
    const mobility = robots.filter((r) => r.stats.mobility).length * POINTS.mobility;
    const autoCS = this.autoCS[alliance] === 'engaged' ? POINTS.autoEngaged : this.autoCS[alliance] === 'docked' ? POINTS.autoDocked : 0;
    let endCS = 0;
    for (const e of this.endCS[alliance]) {
      endCS += e.status === 'engaged' ? POINTS.engaged : e.status === 'docked' ? POINTS.docked : e.status === 'parked' ? POINTS.park : 0;
    }
    const links = this.linkCount(alliance);
    const linkPts = links * POINTS.link;
    const foulPts = this.foulPoints(alliance);
    const total = autoPieces + teleopPieces + supercharged + mobility + autoCS + endCS + linkPts + foulPts;
    const coop = this.coopertition();
    const csPts = autoCS + endCS;
    return {
      autoPieces, teleopPieces, supercharged, mobility, autoCS, endCS, links, linkPts, foulPts, total, coop,
      coopCount: this.coopCount(alliance),
      sustainability: links >= (coop ? POINTS.sustainabilityLinksCoop : POINTS.sustainabilityLinks),
      activation: csPts >= POINTS.activationPoints,
      csPts,
      foulsCommitted: this.fouls[alliance].filter((f) => !f.tech).length,
      techCommitted: this.fouls[alliance].filter((f) => f.tech).length,
    };
  }

  results() {
    const b = this.breakdown('blue');
    const r = this.breakdown('red');
    const rp = (me, them) => (me.total > them.total ? 2 : me.total === them.total ? 1 : 0) + (me.sustainability ? 1 : 0) + (me.activation ? 1 : 0);
    return { blue: { ...b, rp: rp(b, r), cs: this.endCS.blue }, red: { ...r, rp: rp(r, b), cs: this.endCS.red } };
  }
}
