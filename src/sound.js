// Tiny WebAudio synth for arena sounds (no audio assets needed)
export class Sound {
  constructor() {
    this.ctx = null;
  }

  // Real FRC field sounds (the same files the field uses, via Team 254's Cheesy Arena):
  // start = match start "charge", end = buzzer (end of auto / end of match), resume = teleop start, warning = endgame
  unlock() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        this.ctx = null;
      }
      this.buffers = {};
      if (this.ctx) {
        for (const name of ['start', 'end', 'resume', 'warning']) {
          fetch(`assets/audio/${name}.wav`)
            .then((r) => r.arrayBuffer())
            .then((data) => this.ctx.decodeAudioData(data))
            .then((buf) => { this.buffers[name] = buf; })
            .catch(() => {});
        }
      }
    }
    this.ctx?.resume?.();
  }

  sample(name, vol = 0.9) {
    const buf = this.buffers?.[name];
    if (!this.ctx || !buf) return false;
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.buffer = buf;
    src.connect(g).connect(this.ctx.destination);
    src.start();
    return true;
  }

  tone(freq, dur, { type = 'square', vol = 0.08, delay = 0, slide = 0 } = {}) {
    const c = this.ctx;
    if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  play(name) {
    const field = { start: 'start', 'end-auto': 'end', end: 'end', teleop: 'resume', endgame: 'warning' }[name];
    if (field && this.sample(field)) return;
    switch (name) {
      case 'start': // "charge" fanfare
        [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.18, { delay: i * 0.12, type: 'sawtooth', vol: 0.06 }));
        break;
      case 'end-auto':
      case 'end':
        this.tone(110, 1.2, { type: 'sawtooth', vol: 0.12 });
        this.tone(116, 1.2, { type: 'square', vol: 0.05 });
        break;
      case 'teleop':
        this.tone(880, 0.25, { type: 'triangle', vol: 0.1 });
        this.tone(1320, 0.3, { type: 'triangle', vol: 0.08, delay: 0.25 });
        break;
      case 'endgame':
        for (let i = 0; i < 3; i++) this.tone(660, 0.15, { type: 'square', vol: 0.07, delay: i * 0.25 });
        break;
      case 'foul':
        this.tone(220, 0.35, { type: 'square', vol: 0.07 });
        this.tone(165, 0.4, { type: 'square', vol: 0.06, delay: 0.12 });
        break;
      case 'score':
        this.tone(1046, 0.12, { type: 'sine', vol: 0.06 });
        this.tone(1568, 0.16, { type: 'sine', vol: 0.05, delay: 0.07 });
        break;
    }
  }
}
