// Remappable controls. Each action has one keyboard key and one gamepad input.
// Keyboard starts on the default layout; gamepad starts blank until the player binds it.
// Gamepad bindings: 'b<n>' = button n, 'a<n>+' / 'a<n>-' = axis n pushed positive / negative.

export const ACTIONS = [
  { id: 'forward', label: 'Drive forward', kb: 'KeyW', group: 'Drive' },
  { id: 'back', label: 'Drive back', kb: 'KeyS', group: 'Drive' },
  { id: 'left', label: 'Drive left', kb: 'KeyA', group: 'Drive' },
  { id: 'right', label: 'Drive right', kb: 'KeyD', group: 'Drive' },
  { id: 'turnLeft', label: 'Turn left', kb: 'KeyJ', group: 'Drive' },
  { id: 'turnRight', label: 'Turn right', kb: 'KeyL', group: 'Drive' },
  { id: 'balance', label: 'Auto-balance (hold)', kb: 'KeyB', group: 'Drive' },
  { id: 'intake', label: 'Intake (hold) — arm drops to the floor', kb: 'ShiftLeft', group: 'Arm' },
  { id: 'score', label: 'Score / release', kb: 'KeyK', group: 'Arm' },
  { id: 'high', label: 'High node · no piece: substation + intake', kb: 'KeyP', group: 'Arm' },
  { id: 'mid', label: 'Mid node', kb: 'KeyO', group: 'Arm' },
  { id: 'low', label: 'Low (hybrid) node', kb: 'KeyI', group: 'Arm' },
  { id: 'mode', label: 'Switch cone / cube mode', kb: 'KeyE', group: 'Arm' },
  { id: 'flip', label: 'Flip camera front ⇄ back', kb: 'Space', group: 'Other' },
  { id: 'camera', label: 'Other camera views', kb: 'KeyC', group: 'Other' },
  { id: 'help', label: 'Toggle help', kb: 'KeyH', group: 'Other' },
  { id: 'pause', label: 'Pause (Esc always works too)', kb: null, group: 'Other' },
];

const STORE = 'controls.v1';

export function defaultBindings() {
  const kb = {}, gp = {};
  for (const a of ACTIONS) { kb[a.id] = a.kb; gp[a.id] = null; }
  return { kb, gp };
}

export function loadBindings() {
  const b = defaultBindings();
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (s) for (const a of ACTIONS) {
      if (s.kb && a.id in s.kb) b.kb[a.id] = s.kb[a.id];
      if (s.gp && a.id in s.gp) b.gp[a.id] = s.gp[a.id];
    }
  } catch {}
  return b;
}

export function saveBindings(b) {
  try { localStorage.setItem(STORE, JSON.stringify(b)); } catch {}
}

// left/right modifier keys count as the same key
export const normKey = (code) => code && code.replace(/^(Shift|Control|Alt|Meta)Right$/, '$1Left');

const KEY_NAMES = { ShiftLeft: 'Shift', ControlLeft: 'Ctrl', AltLeft: 'Alt', MetaLeft: 'Meta', Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', CapsLock: 'Caps Lock' };
export function keyName(code) {
  if (!code) return '';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

const BTN_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L stick click', 'R stick click', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home'];
const AXIS_NAMES = { '0-': 'L stick ←', '0+': 'L stick →', '1-': 'L stick ↑', '1+': 'L stick ↓', '2-': 'R stick ←', '2+': 'R stick →', '3-': 'R stick ↑', '3+': 'R stick ↓' };
export function padName(b) {
  if (!b) return '';
  if (b[0] === 'b') return BTN_NAMES[+b.slice(1)] ?? `Button ${b.slice(1)}`;
  return AXIS_NAMES[b.slice(1)] ?? `Axis ${b.slice(1, -1)} ${b.slice(-1)}`;
}

// 0..1 value of a gamepad binding (sticks get a deadzone)
export function padValue(gp, b) {
  if (!gp || !b) return 0;
  if (b[0] === 'b') return gp.buttons[+b.slice(1)]?.value ?? 0;
  const v = (gp.axes[+b.slice(1, -1)] ?? 0) * (b.endsWith('-') ? -1 : 1);
  return v < 0.15 ? 0 : (v - 0.15) / 0.85;
}
