import { clamp } from './util.js';
import { balanceSpeed } from './ai.js';
import { ACTIONS, loadBindings, saveBindings, normKey, padValue } from './controls.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered this frame
    this.handlers = {}; // camera, flip, pause, help
    this.viewDir = 1; // +1: screen-forward is field +x, -1: field -x (set by the camera)
    this.substationIntake = false; // P with no piece: latch intake on at the substation shelf
    this.prevHeld = null;
    this.stowTimer = 0;
    this.bindings = loadBindings();
    this.capture = null; // set by the controls screen while it waits for a key / button
    this.padPrev = {};
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (this.capture) { e.preventDefault(); if (!e.repeat) this.capture({ key: e.code }); return; }
      const code = normKey(e.code);
      if (!this.keys.has(code)) this.pressed.add(code);
      this.keys.add(code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      const kb = this.bindings.kb;
      for (const id of ['flip', 'camera', 'pause', 'help']) if (kb[id] === code) this.handlers[id]?.();
      if (e.code === 'Escape' && kb.pause !== 'Escape') this.handlers.pause?.();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(normKey(e.code));
      if (e.code === 'Space') e.preventDefault(); // never let Space re-click a focused menu button
    });
    window.addEventListener('blur', () => this.keys.clear());
  }

  setBindings(b) {
    this.bindings = b;
    saveBindings(b);
  }

  reset() {
    this.substationIntake = false;
    this.prevHeld = null;
    this.stowTimer = 0;
    this.keys.clear();
  }

  gamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  // 0..1 how hard an action is held (keyboard = 0 or 1, sticks/triggers analog)
  value(id) {
    const kv = this.keys.has(this.bindings.kb[id]) ? 1 : 0;
    return Math.max(kv, padValue(this.gp, this.bindings.gp[id]));
  }

  // Must be called once per rendered frame (edge detection for gamepad inputs)
  poll() {
    const gp = this.gamepad();
    this.gp = gp;
    this.gpPressed = new Set();
    if (gp) {
      for (const a of ACTIONS) {
        const down = padValue(gp, this.bindings.gp[a.id]) > 0.5;
        if (down && !this.padPrev[a.id]) this.gpPressed.add(a.id);
        this.padPrev[a.id] = down;
      }
      if (this.capture) this.gpPressed.clear();
      for (const id of ['flip', 'camera', 'pause', 'help']) if (this.gpPressed.has(id)) this.handlers[id]?.();
    }
    this.frameEdges = this.pressed;
    this.pressed = new Set();
  }

  // Apply driver input to the player robot (called every physics step)
  apply(robot, game, dt) {
    const edges = this.frameEdges || new Set();
    const gpEdges = this.gpPressed || new Set();
    this.frameEdges = new Set();
    this.gpPressed = new Set();
    const pressed = (id) => edges.has(this.bindings.kb[id]) || gpEdges.has(id);

    // ---- drive: swerve, relative to the camera (W = away from the camera)
    const v = (id) => this.value(id) ** 2; // squared for finer stick control (keys stay at 1)
    const fwd = v('forward') - v('back');
    const left = v('left') - v('right');
    let rot = v('turnLeft') - v('turnRight');
    const mag = Math.max(1, Math.hypot(fwd, left));
    rot = clamp(rot, -1, 1);
    const s = this.viewDir;
    robot.cmd = {
      vx: (s * fwd * robot.profile.maxSpeed) / mag,
      vy: (s * left * robot.profile.maxSpeed) / mag,
      omega: rot * robot.profile.maxOmega * 0.6,
    };

    // ---- auto-balance assist (hold B)
    if (this.value('balance') > 0.5) {
      robot.cmd.vx = balanceSpeed(game.field.cs[robot.alliance]);
      robot.cmd.vy = 0;
    }

    // ---- manipulator
    const holding = !!robot.held;
    if (pressed('mode')) robot.setMode(robot.mode === 'cone' ? 'cube' : 'cone');
    if (pressed('high')) {
      if (holding) robot.setPreset('high');
      else {
        // no piece: go to the double substation shelf and run the intake until we have one
        this.substationIntake = !this.substationIntake;
        robot.setPreset(this.substationIntake ? 'double' : 'stow');
      }
    }
    if (pressed('mid') && holding) robot.setPreset('mid');
    if (pressed('low') && holding) robot.setPreset('hybrid');
    if (pressed('score') && holding) robot.outtakeRequest = true;

    // Shift: intake. With no piece the arm drops to the floor position automatically.
    const intakeHeld = this.value('intake') > 0.3;
    if (intakeHeld && !holding) {
      if (this.substationIntake) this.substationIntake = false;
      if (robot.preset !== 'floor') robot.setPreset('floor');
    } else if (!intakeHeld && !holding && robot.preset === 'floor') {
      robot.setPreset('stow');
    }
    robot.intaking = !holding && (intakeHeld || this.substationIntake);

    // Got a piece -> stow; scored/dropped it -> stow shortly after
    if (robot.held && !this.prevHeld) {
      this.substationIntake = false;
      robot.setPreset('stow');
    }
    if (!robot.held && this.prevHeld) this.stowTimer = 0.35;
    this.prevHeld = robot.held;
    if (this.stowTimer > 0) {
      this.stowTimer -= dt;
      if (this.stowTimer <= 0 && !robot.held && robot.preset !== 'floor' && robot.preset !== 'double') robot.setPreset('stow');
    }

    // ---- signal the human player (LEDs) when near our substation
    const sub = game.field.substations[robot.alliance];
    const p = robot.pose();
    if (Math.abs(p.x - sub.approachX) < 5 && p.y > 4.5) game.request[robot.alliance] = robot.mode;
  }
}
