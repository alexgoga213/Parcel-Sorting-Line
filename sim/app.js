// Browser simulator: runs the PLC program (plc.js) against the plant model (plant.js)
// with a 10 ms cycle, and draws the machine, operator panel, HMI and I/O monitor.
import { FB_Sorter, ALARMS, STATES } from './plc.js';
import { Plant, GEOM } from './plant.js';

const CYCLE = 10;
const plc = new FB_Sorter();
const plant = new Plant();
const Q = {};
let I = plant.inputs();
let speed = 1;
let tab = 'overview';
const alarmSince = {};
const held = { jogC1: false, jogC2: false, fire: [null, false, false, false] };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

// ---------------------------------------------------------------- simulation loop
function cycle() {
  plc.HMI.Cmd.JogC1 = held.jogC1;
  plc.HMI.Cmd.JogC2 = held.jogC2;
  for (let n = 1; n <= 3; n++) plc.HMI.Cmd.ManualFire[n] = held.fire[n];
  I = plant.inputs();
  plc.scan(I, Q, plant.t);
  plant.step(Q, CYCLE);
}

let last = performance.now();
let acc = 0;
let uiTick = 0;
// setInterval instead of requestAnimationFrame: keeps the PLC running at a steady pace
function frame() {
  const now = performance.now();
  const elapsed = Math.min(100, now - last);
  last = now;
  acc += elapsed * speed;
  let n = 0;
  while (acc >= CYCLE && n < 2000) {
    cycle();
    acc -= CYCLE;
    n++;
  }
  drawMachine();
  drawTower();
  if (++uiTick % 6 === 0) {
    drawHmi();
    drawIO();
    $('#clock').textContent = clock(plant.t);
  }
}

// ---------------------------------------------------------------- machine view
const SC = 0.2; // px per mm
const X0 = 2750 * SC;
const BELT_Y = 260;
const BELT_W = 650 * SC;
const X = (mm) => X0 + mm * SC;
const TOP = BELT_Y - BELT_W / 2;
const BOT = BELT_Y + BELT_W / 2;
const LANE_W = 440 * SC;
const LANE_TOP = 40;
const LANE_LABEL = [null, 'Lane 1 · small', 'Lane 2 · medium', 'Lane 3 · large'];

function stripes(x0, x1, travel) {
  let s = '';
  const step = 120;
  const off = travel % step;
  for (let mm = x0 + off - step; mm < x1; mm += step) {
    if (mm < x0) continue;
    s += `<line x1="${X(mm)}" y1="${TOP + 3}" x2="${X(mm)}" y2="${BOT - 3}" stroke="var(--equip)" stroke-width="2" opacity=".55"/>`;
  }
  return s;
}

function parcelRect(p, x, y, w, h, extra = '') {
  const light = 62 + p.tint * 14;
  return `<g ${extra}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="hsl(34 42% ${light}%)" stroke="hsl(34 35% 38%)" stroke-width="1.5"/>
    <line x1="${x + 2}" y1="${y + h / 2}" x2="${x + w - 2}" y2="${y + h / 2}" stroke="hsl(34 30% 45%)" stroke-width="2" opacity=".5"/></g>`;
}

function motor(x, y, label, runFb, fault) {
  const fill = fault ? 'var(--fault)' : runFb ? 'var(--equip-dark)' : 'var(--card)';
  const txt = runFb || fault ? 'var(--card)' : 'var(--equip-dark)';
  return `<g><circle cx="${x}" cy="${y}" r="17" fill="${fill}" stroke="${fault ? 'var(--fault)' : 'var(--equip-dark)'}" stroke-width="3"/>
    <text x="${x}" y="${y + 7}" text-anchor="middle" style="fill:${txt};font-weight:700;font-size:20px">M</text>
    <text x="${x}" y="${y + 44}" text-anchor="middle">${label}</text></g>`;
}

function photoEye(xmm, blocked, label) {
  const x = X(xmm);
  return `<g><rect x="${x - 7}" y="${TOP - 22}" width="14" height="14" fill="var(--equip-dark)"/><rect x="${x - 7}" y="${BOT + 8}" width="14" height="14" fill="var(--equip-dark)"/>
    <line x1="${x}" y1="${TOP - 8}" x2="${x}" y2="${BOT + 8}" stroke="${blocked ? 'var(--ink)' : 'var(--ink-3)'}" stroke-width="${blocked ? 5 : 2}" ${blocked ? '' : 'stroke-dasharray="6 6"'}/>
    <text x="${x}" y="${TOP - 32}" text-anchor="middle">${label}</text></g>`;
}

function drawMachine() {
  const W = X(4870);
  const H = 470;
  const C2fault = plc.C2.Fault;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Top view of the sorting line">`;

  // lanes (above the sorter)
  for (let n = 1; n <= 3; n++) {
    const cx = X(GEOM.pushers[n]);
    const full = I[`B_Lane${n}Full`];
    s += `<rect x="${cx - LANE_W / 2}" y="${LANE_TOP}" width="${LANE_W}" height="${TOP - LANE_TOP}" fill="var(--card-2)" stroke="${full ? 'var(--warn)' : 'var(--line)'}" stroke-width="${full ? 4 : 2}"/>`;
    for (let r = LANE_TOP + 10; r < TOP; r += 18) s += `<line x1="${cx - LANE_W / 2 + 4}" y1="${r}" x2="${cx + LANE_W / 2 - 4}" y2="${r}" stroke="var(--line)" stroke-width="2"/>`;
    plant.lanes[n].forEach((p, i) => {
      const h = 22;
      s += parcelRect(p, cx - 26, LANE_TOP + 6 + i * (h + 4), 52, h);
    });
    s += `<text x="${cx}" y="${LANE_TOP - 8}" text-anchor="middle">${LANE_LABEL[n]}</text>`;
    if (!plc.S.LaneEnabled[n]) s += `<text x="${cx}" y="${LANE_TOP + (TOP - LANE_TOP) / 2}" text-anchor="middle" style="font-weight:700">CLOSED</text>`;
  }

  // belts
  s += `<rect x="${X(GEOM.infeedStart)}" y="${TOP}" width="${(0 - GEOM.infeedStart) * SC - 4}" height="${BELT_W}" rx="6" fill="var(--belt)" stroke="${plc.C1.Fault ? 'var(--fault)' : 'var(--equip-dark)'}" stroke-width="${plc.C1.Fault ? 4 : 2}"/>`;
  s += stripes(GEOM.infeedStart, -10, plant.c1Travel);
  s += `<rect x="${X(0)}" y="${TOP}" width="${GEOM.sorterEnd * SC}" height="${BELT_W}" rx="6" fill="var(--belt)" stroke="${C2fault ? 'var(--fault)' : 'var(--equip-dark)'}" stroke-width="${C2fault ? 4 : 2}"/>`;
  s += stripes(10, GEOM.sorterEnd - 10, plant.encoder);
  s += `<text x="${X(-1100)}" y="${TOP - 32}" text-anchor="middle">C1 infeed</text><text x="${X(560)}" y="${TOP - 32}" text-anchor="middle">C2 sorter</text>`;

  // reject chute and bin
  const bx = X(GEOM.sorterEnd + 60);
  const binFull = I.B_RejectBinFull;
  s += `<path d="M${bx} ${TOP} L${bx + 70} ${TOP + 20} L${bx + 70} ${BOT - 20} L${bx} ${BOT} Z" fill="var(--card-2)" stroke="var(--line)" stroke-width="2"/>`;
  s += `<rect x="${bx + 78}" y="${TOP - 10}" width="58" height="${BELT_W + 20}" fill="var(--card-2)" stroke="${binFull ? 'var(--fault)' : 'var(--equip-dark)'}" stroke-width="${binFull ? 4 : 2}"/>`;
  const fill = Math.min(1, plant.bin / GEOM.binCapacity);
  s += `<rect x="${bx + 81}" y="${BOT + 7 - fill * (BELT_W + 14)}" width="52" height="${fill * (BELT_W + 14)}" fill="hsl(34 40% 62%)" opacity=".85"/>`;
  s += `<text x="${bx + 107}" y="${BOT + 46}" text-anchor="middle">Reject ${plant.bin}/${GEOM.binCapacity}</text>`;

  // parcels on the belts
  for (const p of plant.parcels) {
    const w = p.width * SC;
    s += parcelRect(p, X(p.lead - p.len), BELT_Y - w / 2, p.len * SC, w, p.jam ? 'class="jam"' : '');
    if (p.jam) s += `<text x="${X(p.lead - p.len / 2)}" y="${BELT_Y + 7}" text-anchor="middle" style="fill:var(--fault);font-weight:700">JAM</text>`;
  }
  // parcels being pushed / falling
  for (const l of plant.leaving) {
    const k = Math.min(1, (plant.t - l.from) / 450);
    const w = l.width * SC;
    if (l.kind === 'lane') {
      const y = BELT_Y - w / 2 - k * (BELT_Y - LANE_TOP - 40);
      s += parcelRect(l, X(GEOM.pushers[l.lane]) - (l.len * SC) / 2, y, l.len * SC, w, `opacity="${1 - k * 0.3}"`);
    } else {
      s += parcelRect(l, X(l.lead - l.len) + k * 90, BELT_Y - w / 2, l.len * SC, w, `opacity="${1 - k}"`);
    }
  }

  // PLC tracking image (ghosts) and tags
  for (const p of plc.Tracking.Parcels) {
    if (!p.Active) continue;
    const len = p.Measured ? p.LengthMm : p.LeadMm;
    const x = X(p.LeadMm - len);
    s += `<rect x="${x}" y="${TOP + 4}" width="${Math.max(2, len * SC)}" height="${BELT_W - 8}" fill="none" stroke="var(--info)" stroke-width="2" stroke-dasharray="5 4" rx="3"/>`;
    const dest = !p.Measured ? '…' : p.TargetLane ? `L${p.TargetLane}` : 'REJ';
    s += `<text x="${X(p.LeadMm - len / 2)}" y="${TOP + 22}" text-anchor="middle" style="fill:var(--info);font-size:18px;font-weight:600">#${p.Id}→${dest}</text>`;
  }

  // pushers (below the sorter)
  for (let n = 1; n <= 3; n++) {
    const cx = X(GEOM.pushers[n]);
    const pos = plant.pusherPos[n];
    const fault = plc[`Pusher${n}`].State === 9;
    const reach = pos * (BELT_W + 6);
    s += `<rect x="${cx - 16}" y="${BOT + 26}" width="32" height="70" rx="4" fill="${fault ? 'var(--fault)' : 'var(--equip)'}" stroke="var(--equip-dark)" stroke-width="2"/>`;
    s += `<rect x="${cx - 4}" y="${BOT + 26 - reach}" width="8" height="${reach}" fill="var(--equip-dark)"/>`;
    s += `<rect x="${cx - (GEOM.paddle * SC) / 2}" y="${BOT + 14 - reach}" width="${GEOM.paddle * SC}" height="12" rx="2" fill="var(--equip-dark)"/>`;
    s += `<circle cx="${cx + 26}" cy="${BOT + 38}" r="6" fill="${I[`P${n}_Extended`] ? 'var(--ink)' : 'none'}" stroke="var(--ink-3)" stroke-width="2"/>`;
    s += `<circle cx="${cx + 26}" cy="${BOT + 84}" r="6" fill="${I[`P${n}_Retracted`] ? 'var(--ink)' : 'none'}" stroke="var(--ink-3)" stroke-width="2"/>`;
    s += `<text x="${cx}" y="${BOT + 124}" text-anchor="middle">Pusher ${n}</text>`;
  }

  // sensors, encoder, motors
  s += photoEye(GEOM.entryPE, I.B_EntryPE, 'Entry eye');
  ['B_HeightLow', 'B_HeightMid', 'B_HeightHigh'].forEach((k, i) => {
    s += `<rect x="${X(-420) + i * 24}" y="${TOP - 26}" width="16" height="16" rx="3" fill="${I[k] ? 'var(--ink)' : 'none'}" stroke="var(--ink-3)" stroke-width="2"/>`;
  });
  s += `<text x="${X(-420) - 8}" y="${TOP - 12}" text-anchor="end" style="font-size:17px">height 40/150/300</text>`;
  s += photoEye(GEOM.exitPE, I.B_ExitPE, 'Exit eye');
  s += `<g><circle cx="${X(600)}" cy="${BOT + 32}" r="14" fill="none" stroke="var(--equip-dark)" stroke-width="3"/><line x1="${X(600)}" y1="${BOT + 32}" x2="${X(600) + 12 * Math.cos(plant.encoder / 40)}" y2="${BOT + 32 + 12 * Math.sin(plant.encoder / 40)}" stroke="var(--equip-dark)" stroke-width="3"/>
    <text x="${X(600)}" y="${BOT + 72}" text-anchor="middle" style="font-size:17px">encoder ${I.HSC_Sorter}</text></g>`;
  s += motor(X(-2050), BOT + 34, 'M1', I.C1_RunFb, plc.C1.Fault);
  s += motor(X(3350), BOT + 34, 'M2', I.C2_RunFb, plc.C2.Fault);
  s += `</svg>`;
  $('#machine').innerHTML = s;
}

// ---------------------------------------------------------------- stack light
function drawTower() {
  const lamp = (y, on, col, dim) => `<rect x="10" y="${y}" width="50" height="40" rx="6" fill="${on ? col : dim}" ${on ? `style="filter:drop-shadow(0 0 8px ${col})"` : ''}/>`;
  $('#tower').innerHTML = `<svg viewBox="0 0 70 234" role="img" aria-label="Stack light: ${[Q.H_Red && 'red', Q.H_Yellow && 'yellow', Q.H_Green && 'green'].filter(Boolean).join(', ') || 'off'}">
    ${lamp(6, Q.H_Red, '#ff3b3b', '#5a2a2a')}${lamp(50, Q.H_Yellow, '#ffc21a', '#5a4a1e')}${lamp(94, Q.H_Green, '#2fe06a', '#21462d')}
    <rect x="27" y="138" width="16" height="52" fill="#3a4046"/><rect x="8" y="188" width="54" height="16" rx="3" fill="#2b3136"/>
    <text x="35" y="226" text-anchor="middle" style="fill:${Q.H_Horn ? 'var(--warn)' : 'var(--ink-3)'};font:700 13px sans-serif">${Q.H_Horn ? 'HORN ON' : 'horn'}</text></svg>`;
  $('#pb-reset').classList.toggle('lamp', Boolean(Q.H_ResetLamp));
}

// ---------------------------------------------------------------- HMI
function stateHint() {
  const st = plc.Line.State;
  if (st === 5) return I.K_EStopOk ? 'E-stop released: press Reset' : 'Release the emergency stop, then press Reset';
  if (st === 4) return plc.Alarms.FaultActive && (plc.Alarms.PrevConditions & 0xffff) ? 'Fix the cause shown in Alarms, then press Reset' : 'Cause cleared: press Reset';
  if (st === 0) return I.S_Auto ? (plc.Line.ReadyToStart ? 'Ready: press Start' : 'Not ready: check alarms') : 'Manual mode: jog and test in the Manual tab';
  if (st === 1) return 'Start warning: horn sounds, keep clear of the line';
  if (st === 2) return 'Sorting';
  return 'Controlled stop: infeed stopped, emptying the sorter';
}

function hmiOverview() {
  const C = plc.HMI.Sts.Counters;
  const st = plc.Line.State;
  const cls = st >= 4 ? 'fault' : plc.Alarms.WarningActive ? 'warn' : '';
  return `<div class="state ${cls}"><div><b>${STATES[st]}</b><small>${esc(stateHint())}</small></div></div>
    <div class="lanes">
      ${[1, 2, 3].map((n) => `<div class="lane ${plc.S.LaneEnabled[n] ? '' : 'off'}"><span>Lane ${n}</span><b>${C.Lane[n]}</b></div>`).join('')}
      <div class="lane"><span>Reject</span><b>${C.Rejected}</b></div>
    </div>
    <dl class="kv">
      <dt>Throughput</dt><dd>${C.PerHour} /h</dd>
      <dt>Total sorted</dt><dd>${C.Total}</dd>
      <dt>Parcels on the belt</dt><dd>${plc.HMI.Sts.ParcelsOnBelt}</dd>
      <dt>Oversize</dt><dd>${C.Oversize}</dd>
      <dt>Lost</dt><dd>${C.Lost}</dd>
      <dt>Mode</dt><dd>${I.S_Auto ? 'Automatic' : 'Manual'}</dd>
    </dl>
    <div class="hmi-actions">
      <button class="btn" data-cmd="Start">Start</button><button class="btn" data-cmd="Stop">Stop</button>
      <button class="btn" data-cmd="Reset">Reset</button><button class="btn" data-cmd="ResetCounters">Reset counters</button>
    </div>`;
}

function hmiAlarms() {
  const latched = plc.Alarms.Latched;
  const present = plc.Alarms.PrevConditions;
  const unack = plc.Alarms.Unack;
  const items = [];
  for (let i = 0; i < ALARMS.length; i++) {
    if (!((latched >>> i) & 1)) {
      delete alarmSince[i];
      continue;
    }
    if (alarmSince[i] == null) alarmSince[i] = plant.t;
    const isUnack = (unack >>> i) & 1;
    const isPresent = (present >>> i) & 1;
    const tag = isUnack ? 'NEW' : isPresent ? 'ACTIVE' : 'RESET';
    items.push(`<li class="alarm ${i < 16 ? 'fault' : 'warn'} ${isUnack ? 'unack' : ''} ${plc.Alarms.FirstOut === i ? 'first' : ''}">
      <time>${clock(alarmSince[i])}</time><span>${esc(ALARMS[i])}${plc.Alarms.FirstOut === i ? ' <small>(first out)</small>' : ''}</span>
      <span class="tag ${!isUnack && !isPresent ? 'gone' : ''}">${tag}</span></li>`);
  }
  return `${items.length ? `<ul class="alarms">${items.join('')}</ul>` : '<p class="empty">No alarms. Inject a fault below the machine view to see one.</p>'}
    <div class="hmi-actions"><button class="btn" data-cmd="AckAlarms">Acknowledge</button><button class="btn" data-cmd="Reset">Reset</button></div>
    <p class="manual-note" style="margin-top:12px">NEW = not acknowledged (red lamp flashes) · ACTIVE = cause still present · RESET = cause gone, press Reset.</p>`;
}

function hmiTracking() {
  const rows = plc.Tracking.Parcels.map((p, i) => `<tr class="${p.Active ? '' : 'inactive'}"><td>${i}</td><td>${p.Active ? '●' : '○'}</td><td>${p.Active ? p.Id : ''}</td><td>${p.Active ? p.LeadMm : ''}</td><td>${p.Active && p.Measured ? p.LengthMm : ''}</td><td>${p.Active && p.Measured ? ['?', 'S', 'M', 'L'][p.SizeClass] : ''}</td><td>${p.Active && p.Measured ? (p.TargetLane ? `L${p.TargetLane}` : 'REJ') : ''}</td><td>${p.Active && p.PusherFired ? 'yes' : ''}</td></tr>`).join('');
  return `<p class="manual-note">"iSorter".Tracking.Parcels: the PLC's picture of the belt, updated every cycle from the encoder.</p>
    <table class="db"><thead><tr><th>Slot</th><th></th><th>Id</th><th>Lead mm</th><th>Length</th><th>Size</th><th>Target</th><th>Fired</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="hmi-actions"><button class="btn" data-cmd="ClearTracking" ${plc.Line.State === 0 ? '' : 'disabled'}>Clear tracking (stopped only)</button></div>`;
}

function hmiManual() {
  const ok = !I.S_Auto && plc.Line.State === 0 && I.K_EStopOk;
  return `<p class="manual-note">${ok ? 'Hold a button to move the equipment.' : 'Turn the key to MANUAL with the line stopped to enable these.'}</p>
    <div class="manual-grid">
      <button class="btn hold ${held.jogC1 ? 'on' : ''}" data-hold="jogC1" ${ok ? '' : 'disabled'}>Jog C1 infeed</button>
      <button class="btn hold ${held.jogC2 ? 'on' : ''}" data-hold="jogC2" ${ok ? '' : 'disabled'}>Jog C2 sorter</button>
      ${[1, 2, 3].map((n) => `<button class="btn hold ${held.fire[n] ? 'on' : ''}" data-hold="fire${n}" ${ok ? '' : 'disabled'}>Fire pusher ${n}</button>`).join('')}
    </div>
    <h3 style="margin:16px 0 6px;font-size:1rem">Lanes (DB_Settings.LaneEnabled)</h3>
    ${[1, 2, 3].map((n) => `<label class="check"><input type="checkbox" data-lane="${n}" ${plc.S.LaneEnabled[n] ? 'checked' : ''}> Lane ${n} open</label>`).join('')}`;
}

let lastHmi = '';
function drawHmi() {
  const html = { overview: hmiOverview, alarms: hmiAlarms, tracking: hmiTracking, manual: hmiManual }[tab]();
  if (html !== lastHmi) {
    const view = $('#hmi-view');
    // keep a pressed hold button pressed while re-rendering
    if (!view.contains(document.activeElement) || !document.activeElement.dataset.hold) {
      view.innerHTML = html;
      lastHmi = html;
    }
  }
  const n = ALARMS.filter((_, i) => (plc.Alarms.Unack >>> i) & 1).length;
  const badge = $('#alarm-badge');
  badge.hidden = n === 0;
  badge.textContent = n;
  const key = $('#key-mode');
  key.setAttribute('aria-pressed', String(plant.panel.auto));
  key.querySelector('b').textContent = plant.panel.auto ? 'AUTO' : 'MANUAL';
  key.querySelector('small').textContent = plant.panel.auto ? 'click for manual' : 'click for auto';
}

// ---------------------------------------------------------------- I/O monitor
const IO = [
  ['S_Start', '%I0.0'], ['S_Stop', '%I0.1'], ['S_Reset', '%I0.2'], ['K_EStopOk', '%I0.3'], ['S_Auto', '%I0.4'], ['B_AirOk', '%I0.5'],
  ['B_EntryPE', '%I1.0'], ['B_HeightLow', '%I1.1'], ['B_HeightMid', '%I1.2'], ['B_HeightHigh', '%I1.3'], ['B_ExitPE', '%I1.4'], ['B_RejectBinFull', '%I1.5'],
  ['C1_RunFb', '%I2.0'], ['C1_OverloadOk', '%I2.1'], ['C2_RunFb', '%I2.2'], ['C2_OverloadOk', '%I2.3'],
  ['P1_Retracted', '%I3.0'], ['P1_Extended', '%I3.1'], ['P2_Retracted', '%I3.2'], ['P2_Extended', '%I3.3'], ['P3_Retracted', '%I3.4'], ['P3_Extended', '%I3.5'],
  ['B_Lane1Full', '%I4.0'], ['B_Lane2Full', '%I4.1'], ['B_Lane3Full', '%I4.2'], ['HSC_Sorter', '%ID1000'],
  ['K_C1', '%Q0.0'], ['K_C2', '%Q0.1'], ['Y_Pusher1', '%Q0.2'], ['Y_Pusher2', '%Q0.3'], ['Y_Pusher3', '%Q0.4'],
  ['H_Green', '%Q1.0'], ['H_Yellow', '%Q1.1'], ['H_Red', '%Q1.2'], ['H_Horn', '%Q1.3'], ['H_ResetLamp', '%Q1.4'],
];
function drawIO() {
  $('#io').innerHTML = IO.map(([name, addr]) => {
    const v = name in I ? I[name] : Q[name];
    if (typeof v === 'number') return `<div class="bit word"><i></i><code>${addr}</code><span>${name} = <b class="num">${v}</b></span></div>`;
    return `<div class="bit ${v ? 'on' : ''}"><i></i><code>${addr}</code><span>${name}</span></div>`;
  }).join('');
}

// ---------------------------------------------------------------- controls
function momentary(el, key) {
  const down = () => {
    plant.panel[key] = true;
    el.classList.add('down');
  };
  const up = () => {
    setTimeout(() => (plant.panel[key] = false), 120);
    el.classList.remove('down');
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointerleave', () => el.classList.contains('down') && up());
  el.addEventListener('keydown', (e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && down());
  el.addEventListener('keyup', (e) => (e.key === ' ' || e.key === 'Enter') && up());
}
momentary($('#pb-start'), 'start');
momentary($('#pb-stop'), 'stopPressed');
momentary($('#pb-reset'), 'reset');
$('#pb-estop').addEventListener('click', (e) => {
  plant.panel.estop = !plant.panel.estop;
  e.currentTarget.setAttribute('aria-pressed', String(plant.panel.estop));
  e.currentTarget.title = plant.panel.estop ? 'Pressed: click to twist and release' : 'Click to press';
});
$('#key-mode').addEventListener('click', () => (plant.panel.auto = !plant.panel.auto));
$('#speed').addEventListener('change', (e) => (speed = Number(e.target.value)));

document.querySelectorAll('.hmi-tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.hmi-tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    lastHmi = '';
    drawHmi();
  })
);
const hmiView = $('#hmi-view');
hmiView.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b && !b.disabled) {
    plc.HMI.Cmd[b.dataset.cmd] = true;
    lastHmi = '';
  }
});
hmiView.addEventListener('change', (e) => {
  const lane = e.target.dataset.lane;
  if (lane) plc.S.LaneEnabled[Number(lane)] = e.target.checked;
});
const setHold = (name, v) => {
  if (name === 'jogC1') held.jogC1 = v;
  else if (name === 'jogC2') held.jogC2 = v;
  else held.fire[Number(name.slice(4))] = v;
};
hmiView.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-hold]');
  if (b && !b.disabled) {
    setHold(b.dataset.hold, true);
    b.classList.add('on');
  }
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
  hmiView.addEventListener(ev, () => {
    held.jogC1 = held.jogC2 = false;
    held.fire = [null, false, false, false];
    lastHmi = '';
  }, true)
);

// fault injection
const FAULTS = [
  ['Compressed air low', () => plant.faults.air, (v) => (plant.faults.air = v)],
  ['C1 motor overload', () => plant.faults.c1Overload, (v) => (plant.faults.c1Overload = v)],
  ['C2 motor overload', () => plant.faults.c2Overload, (v) => (plant.faults.c2Overload = v)],
  ['C2 contactor failed', () => plant.faults.c2Contactor, (v) => (plant.faults.c2Contactor = v)],
  ...[1, 2, 3].map((n) => [`Pusher ${n} stuck`, () => plant.faults.pusherStuck[n], (v) => (plant.faults.pusherStuck[n] = v)]),
  ...[1, 2, 3].map((n) => [`Nobody empties lane ${n}`, () => plant.faults.laneBlocked[n], (v) => (plant.faults.laneBlocked[n] = v)]),
];
const ACTIONS = [
  ['Jam the next parcel', () => (plant.faults.jamNext = true)],
  ['Remove jammed parcel', () => plant.removeJam()],
  ['Empty the reject bin', () => plant.emptyBin()],
];
function drawFaults() {
  $('#faults').innerHTML =
    FAULTS.map(([label, get], i) => `<button class="fbtn" type="button" data-fault="${i}" aria-pressed="${get()}"><span>${label}</span><i></i></button>`).join('') +
    ACTIONS.map(([label], i) => `<button class="fbtn" type="button" data-action="${i}"><span>${label}</span></button>`).join('');
}
$('#faults').addEventListener('click', (e) => {
  const f = e.target.closest('[data-fault]');
  const a = e.target.closest('[data-action]');
  if (f) {
    const [, get, set] = FAULTS[Number(f.dataset.fault)];
    set(!get());
  }
  if (a) ACTIONS[Number(a.dataset.action)][1]();
  drawFaults();
});

function drawFeed() {
  $('#feed').innerHTML = `
    <label><input type="checkbox" id="feed-on" ${plant.feed.on ? 'checked' : ''}> Parcels arriving</label>
    <label>Rate <input type="range" id="feed-rate" min="10" max="70" step="5" value="${plant.feed.perMinute}"> <b class="num" id="feed-rate-v">${plant.feed.perMinute}</b>/min</label>
    <label>Mix <select id="feed-mix"><option value="normal" ${plant.feed.mix === 'normal' ? 'selected' : ''}>Mixed sizes (incl. oversize)</option><option value="small" ${plant.feed.mix === 'small' ? 'selected' : ''}>Only small</option></select></label>`;
  $('#feed-on').addEventListener('change', (e) => (plant.feed.on = e.target.checked));
  $('#feed-rate').addEventListener('input', (e) => {
    plant.feed.perMinute = Number(e.target.value);
    $('#feed-rate-v').textContent = e.target.value;
  });
  $('#feed-mix').addEventListener('change', (e) => (plant.feed.mix = e.target.value));
}

$('#theme').addEventListener('click', () => {
  const r = document.documentElement;
  const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  r.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('pso.theme', r.dataset.theme);
  } catch (e) {
    /* per-viewer preference only */
  }
});

drawFaults();
drawFeed();
drawHmi();
drawIO();
setInterval(frame, 16);

// Expose for debugging in the console
window.sim = { plc, plant, Q, get I() { return I; } };
