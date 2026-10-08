import { GRID } from './constants.js';

const $ = (id) => document.getElementById(id);

// Icons for the 2023 real-time scoring bar (inline SVG so everything stays offline)
const ICONS = {
  link: "<path d='M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z'/>",
  coop: "<path d='M2 11.5 6.5 7l3 1.2L12 6.6l2.5 1.6 3-1.2 4.5 4.5-2 2-1.2-1.2-5.6 5.6a1.4 1.4 0 0 1-2-2l-.6.6a1.4 1.4 0 0 1-2-2l-.6.6a1.4 1.4 0 0 1-2-2L4 13.5z'/><path d='M8.2 10.4 12 8l3.6 2.3-1.2 1.2-2.4-1.5-2.6 1.6z' fill-opacity='.55'/>",
  batt: "<path d='M4 7h14a1 1 0 0 1 1 1v1.5h1.5v5H19V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm.8 1.8v6.4h12.4V8.8z'/>",
  battBolt: "<path d='M4 7h14a1 1 0 0 1 1 1v1.5h1.5v5H19V16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm.8 1.8v6.4h12.4V8.8z'/><path d='M11.8 8.6 7.6 12.6h3l-1 2.8 4.4-4h-3z'/>",
  robot: "<path d='M11 2h2v2h4a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4zm-2.5 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM6 17h12v4h-3v-2H9v2H6z'/>",
  pad: "<path d='M7 6h10a5 5 0 0 1 4.9 6l-.8 4.3a2.6 2.6 0 0 1-4.5 1.2L14.9 16H9.1l-1.7 1.5a2.6 2.6 0 0 1-4.5-1.2L2.1 12A5 5 0 0 1 7 6zm0 3v1.5H5.5V12H7v1.5h1.5V12H10v-1.5H8.5V9zm9.5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm-2 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z'/>",
};
const svgUrl = (body, color) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='${color}'>${body}</svg>`)}")`;

export class HUD {
  constructor() {
    const root = document.documentElement.style;
    root.setProperty('--ico-link-blue', svgUrl(ICONS.link, '#1f7ad8'));
    root.setProperty('--ico-link-red', svgUrl(ICONS.link, '#e3222d'));
    root.setProperty('--ico-coop', svgUrl(ICONS.coop, '#fff'));
    root.setProperty('--ico-batt', svgUrl(ICONS.batt, '#fff'));
    root.setProperty('--ico-batt-bolt', svgUrl(ICONS.battBolt, '#fff'));
    root.setProperty('--ico-robot', svgUrl(ICONS.robot, '#111'));
    root.setProperty('--ico-pad', svgUrl(ICONS.pad, '#111'));
    this.cells = { blue: [], red: [] };
    for (const a of ['blue', 'red']) {
      const el = $(a === 'blue' ? 'gridBlue' : 'gridRed');
      el.innerHTML = '';
      // display rows top = high
      for (let row = 2; row >= 0; row--) {
        for (let c = 0; c < 9; c++) {
          const d = document.createElement('div');
          const kind = row === 0 ? '' : GRID.isCubeCol(c) ? 'cube-node' : 'cone-node';
          d.className = `cell ${kind} ${c >= 3 && c <= 5 ? 'coop' : ''}`;
          d.title = `${['Low', 'Mid', 'High'][row]} col ${c + 1}`;
          el.appendChild(d);
          this.cells[a][row * 9 + c] = d;
        }
      }
    }
    this.lastHtml = {};
  }

  show(on) {
    // clean broadcast view: just the game and the scoring bar
    $('rtBar').classList.toggle('hidden', !on);
  }

  set(id, html) {
    if (this.lastHtml[id] !== html) {
      this.lastHtml[id] = html;
      $(id).innerHTML = html;
    }
  }

  toast(msg, alliance, cls = '') {
    const t = document.createElement('div');
    t.className = `toast ${alliance || 'neutral'} ${cls}`;
    t.textContent = msg;
    const box = $('toasts');
    box.appendChild(t);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => t.remove(), 2300);
  }

  update(game, camName) {
    const b = game.breakdown('blue');
    const r = game.breakdown('red');
    this.set('rtScoreBlue', String(b.total));
    this.set('rtScoreRed', String(r.total));
    this.set('rtMatch', game.config.practice ? 'Practice' : 'Qualification 1');
    this.set('rtEvent', 'Charged Up Sim');
    this.set('rtLabelRed', 'RED');
    this.set('rtLabelBlue', 'BLUE');
    // three team rows per alliance, like the real display
    const teams = (a) => {
      const list = game.robots.filter((x) => x.alliance === a).map((x) => `<div class="${x.isPlayer ? 'me' : ''}">${x.team}</div>`);
      while (list.length < 3) list.push('<div>&nbsp;</div>');
      return list.join('');
    };
    this.set('rtTeamsBlue', teams('blue'));
    this.set('rtTeamsRed', teams('red'));
    const linkTxt = (x) => String(x.links); // the real display shows just the link count
    this.set('rtLinksBlue', linkTxt(b));
    this.set('rtLinksRed', linkTxt(r));
    $('rtCoopBlue').classList.toggle('on', b.coopCount >= 3);
    $('rtCoopRed').classList.toggle('on', r.coopCount >= 3);
    for (const [a, id] of [['blue', 'rtBattBlue'], ['red', 'rtBattRed']]) {
      const st = game.autoCS[a];
      $(id).classList.toggle('on', !!st);
      $(id).classList.toggle('charged', st === 'engaged');
    }
    const clock = game.clock;
    let t;
    if (game.phase === 'pre') t = String(Math.ceil(3 - game.phaseTime));
    else if (!Number.isFinite(clock)) t = '∞';
    else t = String(Math.ceil(clock)); // the 2023 display counts down in whole seconds
    this.set('rtTime', t);
    $('rtTime').classList.toggle('urgent', game.phase === 'teleop' && clock <= 10);
    const mode = game.phase === 'auto' ? 'auto' : game.phase === 'teleop' ? 'teleop' : '';
    if ($('rtMode').className !== mode) $('rtMode').className = mode;

    // grid maps
    for (const a of ['blue', 'red']) {
      const nodes = game.field.nodes[a];
      const linked = new Set();
      for (let row = 0; row < 3; row++) {
        let run = [];
        for (let c = 0; c < 9; c++) {
          const n = nodes[row * 9 + c];
          if (n.piece) { run.push(row * 9 + c); if (run.length === 3) { run.forEach((i) => linked.add(i)); run = []; } } else run = [];
        }
      }
      nodes.forEach((n, i) => {
        const el = this.cells[a][i];
        const cls = ['cell'];
        if (n.row > 0) cls.push(GRID.isCubeCol(n.col) ? 'cube-node' : 'cone-node');
        if (n.col >= 3 && n.col <= 5) cls.push('coop');
        if (n.piece) cls.push(n.piece.type === 'cone' ? 'f-cone' : 'f-cube');
        if (linked.has(i)) cls.push('link');
        if (n.extra.length) cls.push('sc');
        const c = cls.join(' ');
        if (el.className !== c) el.className = c;
      });
    }
    // charge stations
    let cs = '';
    for (const a of ['blue', 'red']) {
      const st = game.csState(a);
      const tilt = game.field.cs[a].tiltDeg;
      const docked = st.filter((s) => s.docked).length;
      const engaged = st.some((s) => s.engaged);
      const lvl = Math.abs(tilt) < 2.5;
      cs += `<div><b style="color:${a === 'blue' ? '#6c9bff' : '#ff7272'}">${a.toUpperCase()} CS</b> ${tilt.toFixed(1)}° <span class="${lvl ? 'ok' : 'warn'}">${lvl ? 'LEVEL' : 'tilted'}</span> · docked ${docked}${engaged ? ' · <span class="ok">ENGAGED</span>' : ''}</div>`;
    }
    this.set('csInfo', cs);

    // player status
    const p = game.player;
    if (p) {
      const v = p.fieldVel();
      const speed = Math.hypot(v.vx, v.vy);
      const s = game.csStatus(p);
      const held = p.held ? `<span class="mode-${p.held.type}">${p.held.type.toUpperCase()}</span>` : '—';
      const mob = game.phase === 'auto' || p.stats.mobility ? (p.stats.mobility ? '<span style="color:#4ade80">✓</span>' : '✗') : '';
      this.set('status', `
        <div class="row"><span class="k">Robot</span><span>${p.team} · ${p.driveMode}</span></div>
        <div class="row"><span class="k">Design</span><span>${p.profile.name}</span></div>
        <div class="row"><span class="k">Mode</span><span class="mode-${p.mode}">${p.mode.toUpperCase()}</span></div>
        <div class="row"><span class="k">Holding</span><span>${held}</span></div>
        ${p.held ? (() => { const n = game.findNode(p.held); return n ? `<div class="aligned">✓ RELEASE TO SCORE — ${n.alliance.toUpperCase()} ${['LOW', 'MID', 'HIGH'][n.row]} ${n.col + 1}</div>` : ''; })() : ''}
        <div class="row"><span class="k">Arm</span><span>${p.mech.describe()}</span></div>
        <div class="row"><span class="k">Speed</span><span>${speed.toFixed(2)} m/s</span></div>
        <div class="meter"><div style="width:${Math.min(100, (speed / 4.5) * 100)}%"></div></div>
        <div class="row"><span class="k">Charge station</span><span>${s.docked ? 'DOCKED' : s.contacting ? 'touching' : '—'}</span></div>
        ${mob ? `<div class="row"><span class="k">Mobility</span><span>${mob}</span></div>` : ''}
        ${game.isAuto ? '<div style="color:#ffd400;font-weight:700">AUTONOMOUS — robot running its routine</div>' : ''}
      `);
    } else this.set('status', '');
    this.set('camLabel', `Camera: <b>${camName}</b> · Space flip · C views · H help`);
  }

  results(res) {
    const B = res.blue, R = res.red;
    const winner = B.total > R.total ? '<span class="bl">BLUE WINS</span>' : R.total > B.total ? '<span class="rd">RED WINS</span>' : 'TIE';
    const row = (label, b, r) => `<tr><td>${label}</td><td class="bl">${b}</td><td class="rd">${r}</td></tr>`;
    const yes = (v) => (v ? '✓' : '—');
    const cs = (list) => list.map((e) => `${e.team}: ${e.status}`).join('<br>') || '—';
    $('resultsBody').innerHTML = `
      <div class="winner">${winner}</div>
      <table>
        <tr><th></th><th class="bl">Blue</th><th class="rd">Red</th></tr>
        ${row('Auto game pieces', B.autoPieces, R.autoPieces)}
        ${row('Mobility', B.mobility, R.mobility)}
        ${row('Auto charge station', B.autoCS, R.autoCS)}
        ${row('Teleop game pieces', B.teleopPieces, R.teleopPieces)}
        ${row('Supercharged', B.supercharged, R.supercharged)}
        ${row(`Links (${B.links} / ${R.links})`, B.linkPts, R.linkPts)}
        ${row('Endgame charge station', B.endCS, R.endCS)}
        ${row('Endgame detail', cs(B.cs), cs(R.cs))}
        ${row('Penalty points (from opponent fouls)', B.foulPts, R.foulPts)}
        ${row('Fouls / tech fouls committed', `${B.foulsCommitted} / ${B.techCommitted}`, `${R.foulsCommitted} / ${R.techCommitted}`)}
        ${row('Coopertition bonus', yes(B.coop), yes(R.coop))}
        ${row('Sustainability RP', yes(B.sustainability), yes(R.sustainability))}
        ${row('Activation RP (≥26 CS pts)', yes(B.activation), yes(R.activation))}
        <tr class="total">${`<td>Total</td><td class="bl">${B.total}</td><td class="rd">${R.total}</td>`}</tr>
        ${row('Ranking points', B.rp, R.rp)}
      </table>`;
  }
}
