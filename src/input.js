import { clamp } from './util.js';
import { balanceSpeed } from './ai.js';

export class Input {
  constructor() {
    this.keys = new Set();
    this.pressed = new Set(); // edge-triggered this frame
    this.gpPrev = [];
    this.handlers = {}; // camera, flip, pause, help
    this.viewDir = 1; // +1: screen-forward is field +x, -1: field -x (set by the camera)
    this.substationIntake = false; // P with no piece: latch intake on at the substation shelf
    this.prevHeld = null;
    this.stowTimer = 0;
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      if (e.code === 'Space') this.handlers.flip?.();
      if (e.code === 'KeyC') this.handlers.camera?.();
      if (e.code === 'Escape') this.handlers.pause?.();
      if (e.code === 'KeyH') this.handlers.help?.();
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') e.preventDefault(); // never let Space re-click a focused menu button
    });
    window.addEventListener('blur', () => this.keys.clear());
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

  // Must be called once per rendered frame (edge detection for gamepad buttons)
  poll() {
    const gp = this.gamepad();
    this.gp = gp;
    this.gpPressed = new Set();
    if (gp) {
      gp.buttons.forEach((b, i) => {
        const down = b.value > 0.5;
        if (down && !this.gpPrev[i]) this.gpPressed.add(i);
        this.gpPrev[i] = down;
      });
      if (this.gpPressed.has(8)) this.handlers.flip?.();
      if (this.gpPressed.has(9)) this.handlers.pause?.();
    }
    this.frameEdges = this.pressed;
    this.pressed = new Set();
  }

  // Apply driver input to the player robot (called every physics step)
  apply(robot, game, dt) {
    const k = this.keys;
    const edges = this.frameEdges || new Set();
    const gpEdges = this.gpPressed || new Set();
    const gp = this.gp;
    this.frameEdges = new Set();
    this.gpPressed = new Set();
    const pressed = (code, button) => edges.has(code) || gpEdges.has(button);

    // ---- drive: swerve, relative to the camera (W = away from the camera)
    let fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    let left = (k.has('KeyA') ? 1 : 0) - (k.has('KeyD') ? 1 : 0);
    let rot = (k.has('KeyJ') ? 1 : 0) - (k.has('KeyL') ? 1 : 0);
    if (gp) {
      const dz = (v) => (Math.abs(v) < 0.1 ? 0 : Math.sign(v) * ((Math.abs(v) - 0.1) / 0.9) ** 2);
      fwd += -dz(gp.axes[1] ?? 0);
      left += -dz(gp.axes[0] ?? 0);
      rot += -dz(gp.axes[2] ?? 0);
    }
    const mag = Math.hypot(fwd, left);
    if (mag > 1) { fwd /= mag; left /= mag; }
    rot = clamp(rot, -1, 1);
    const s = this.viewDir;
    robot.cmd = {
      vx: s * fwd * robot.profile.maxSpeed,
      vy: s * left * robot.profile.maxSpeed,
      omega: rot * robot.profile.maxOmega * 0.6,
    };

    // ---- auto-balance assist (hold B)
    if (k.has('KeyB')) {
      robot.cmd.vx = balanceSpeed(game.field.cs[robot.alliance]);
      robot.cmd.vy = 0;
    }

    // ---- manipulator
    const holding = !!robot.held;
    if (pressed('KeyE', 5)) robot.setMode(robot.mode === 'cone' ? 'cube' : 'cone');
    if (pressed('KeyP', 3)) {
      if (holding) robot.setPreset('high');
      else {
        // no piece: go to the double substation shelf and run the intake until we have one
        this.substationIntake = !this.substationIntake;
        robot.setPreset(this.substationIntake ? 'double' : 'stow');
      }
    }
    if (pressed('KeyO', 2) && holding) robot.setPreset('mid');
    if (pressed('KeyI', 1) && holding) robot.setPreset('hybrid');
    if (pressed('KeyK', 0) && holding) robot.outtakeRequest = true;

    // Shift: intake. With no piece the arm drops to the floor position automatically.
    const intakeHeld = k.has('ShiftLeft') || k.has('ShiftRight') || (gp?.buttons[7]?.value ?? 0) > 0.3;
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
