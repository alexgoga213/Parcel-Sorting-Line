// Physical model of the sorting line: belts, parcels, sensors, pneumatic pushers, lanes,
// reject bin and the operator panel. It turns the PLC outputs (Q) into the inputs (I).
//
// Coordinates along the line in mm: 0 = entry photo-eye. Infeed C1: -2200..0,
// sorter C2: 0..3900, then the reject chute. Pushers at 1000 / 2000 / 3000.

export const GEOM = {
  infeedStart: -2200,
  sorterEnd: 3900,
  entryPE: 0,
  exitPE: 3600,
  pushers: [null, 1000, 2000, 3000],
  paddle: 300,
  beams: [40, 150, 300],
  laneCapacity: 6,
  laneFullAt: 5,
  binCapacity: 25,
};

const SPEED = 500; // mm/s, both belts

let nextParcelId = 1;

export function randomParcel(rng = Math.random, mix = 'normal') {
  const r = rng();
  let cls;
  if (mix === 'small') cls = 1;
  else cls = r < 0.04 ? 'flat' : r < 0.09 ? 'over' : r < 0.42 ? 1 : r < 0.75 ? 2 : 3;
  const span = (a, b) => Math.round(a + rng() * (b - a));
  const spec = {
    1: { len: [150, 300], h: [60, 140] },
    2: { len: [200, 400], h: [170, 280] },
    3: { len: [300, 480], h: [320, 420] },
    over: { len: [530, 650], h: [180, 300] },
    flat: { len: [200, 320], h: [15, 30] },
  }[cls];
  return { id: nextParcelId++, len: span(...spec.len), height: span(...spec.h), width: span(220, 360), lead: GEOM.infeedStart, tint: rng() };
}

export class Plant {
  constructor() {
    this.t = 0;
    this.parcels = []; // on the belts
    this.leaving = []; // being pushed or falling into the chute (animation only)
    this.lanes = [null, [], [], []];
    this.bin = 0;
    this.encoder = 0;
    this.c1Travel = 0;
    this.encoderAcc = 0;
    this.pusherPos = [null, 0, 0, 0];
    this.c1Fb = false;
    this.c2Fb = false;
    this.fbDelay = [0, 0];
    // operator panel
    this.panel = { start: false, stopPressed: false, reset: false, estop: false, auto: true };
    // faults the user can inject
    this.faults = { air: false, c1Overload: false, c2Overload: false, c2Contactor: false, pusherStuck: [null, false, false, false], laneBlocked: [null, false, false, false], jamNext: false };
    // parcel feed
    this.feed = { on: true, perMinute: 40, mix: 'normal', nextAt: 0 };
    this.laneDrainAt = [null, 0, 0, 0];
    this.events = [];
  }

  /** Input image for the PLC. */
  inputs() {
    const at = (x) => this.parcels.find((p) => p.lead >= x && p.lead - p.len < x);
    const entry = at(GEOM.entryPE);
    const exit = at(GEOM.exitPE);
    const h = entry ? entry.height : 0;
    const I = {
      S_Start: this.panel.start,
      S_Stop: !this.panel.stopPressed,
      S_Reset: this.panel.reset,
      K_EStopOk: !this.panel.estop,
      S_Auto: this.panel.auto,
      B_AirOk: !this.faults.air,
      B_EntryPE: Boolean(entry),
      B_HeightLow: h > GEOM.beams[0],
      B_HeightMid: h > GEOM.beams[1],
      B_HeightHigh: h > GEOM.beams[2],
      B_ExitPE: Boolean(exit),
      B_RejectBinFull: this.bin >= GEOM.binCapacity,
      C1_RunFb: this.c1Fb,
      C1_OverloadOk: !this.faults.c1Overload,
      C2_RunFb: this.c2Fb,
      C2_OverloadOk: !this.faults.c2Overload,
      HSC_Sorter: this.encoder,
    };
    for (let n = 1; n <= 3; n++) {
      I[`P${n}_Retracted`] = this.pusherPos[n] <= 0.02;
      I[`P${n}_Extended`] = this.pusherPos[n] >= 0.98;
      I[`B_Lane${n}Full`] = this.lanes[n].length >= GEOM.laneFullAt;
    }
    return I;
  }

  /** Advance the physics by dt ms with the current PLC outputs. */
  step(Q, dt) {
    this.t += dt;
    const s = dt / 1000;
    // Contactors (the safety relay also drops them on e-stop)
    const c1On = Q.K_C1 && !this.panel.estop && !this.faults.c1Overload;
    const c2On = Q.K_C2 && !this.panel.estop && !this.faults.c2Overload && !this.faults.c2Contactor;
    this.fbDelay[0] = c1On === this.c1Fb ? 0 : this.fbDelay[0] + dt;
    this.fbDelay[1] = c2On === this.c2Fb ? 0 : this.fbDelay[1] + dt;
    if (this.fbDelay[0] >= 60) this.c1Fb = c1On;
    if (this.fbDelay[1] >= 60) this.c2Fb = c2On;
    const c1Moving = this.c1Fb;
    const c2Moving = this.c2Fb;

    if (c1Moving) this.c1Travel += SPEED * s;
    // Encoder on the sorter belt (1 pulse / mm)
    if (c2Moving) {
      this.encoderAcc += SPEED * s;
      const whole = Math.floor(this.encoderAcc);
      this.encoder = (this.encoder + whole) | 0;
      this.encoderAcc -= whole;
    }

    // Parcel feed onto the infeed belt
    if (this.feed.on && this.t >= this.feed.nextAt) {
      const first = this.parcels.reduce((m, p) => Math.min(m, p.lead - p.len), Infinity);
      if (first > GEOM.infeedStart + 80) {
        const p = randomParcel(Math.random, this.feed.mix);
        if (this.faults.jamNext) {
          p.jam = true;
          this.faults.jamNext = false;
        }
        this.parcels.push(p);
        const gap = 60000 / Math.max(1, this.feed.perMinute);
        this.feed.nextAt = this.t + gap * (0.7 + Math.random() * 0.6);
      }
    }

    // Move parcels, front to back, without overlapping the one ahead
    this.parcels.sort((a, b) => b.lead - a.lead);
    let limit = Infinity;
    for (const p of this.parcels) {
      // once the leading edge is on the sorter, the running sorter belt pulls the parcel across
      const centre = p.lead - p.len / 2;
      const moving = p.lead > 30 ? c2Moving || (centre < 0 && c1Moving) : c1Moving;
      let next = p.lead + (moving ? SPEED * s : 0);
      if (p.jam && p.lead >= 120 && p.lead - p.len < GEOM.entryPE) next = p.lead; // stuck on the entry eye
      p.lead = Math.min(next, limit);
      limit = p.lead - p.len - 15;
    }

    // Pneumatic pushers
    for (let n = 1; n <= 3; n++) {
      const valve = Q[`Y_Pusher${n}`] && !this.panel.estop;
      if (this.faults.pusherStuck[n]) continue;
      if (valve && !this.faults.air) this.pusherPos[n] = Math.min(1, this.pusherPos[n] + dt / 250);
      else if (!valve) this.pusherPos[n] = Math.max(0, this.pusherPos[n] - dt / 300);
      if (this.pusherPos[n] > 0.55) {
        const x = GEOM.pushers[n];
        const hit = this.parcels.find((p) => p.lead > x - GEOM.paddle / 2 && p.lead - p.len < x + GEOM.paddle / 2);
        if (hit) {
          this.parcels.splice(this.parcels.indexOf(hit), 1);
          this.leaving.push({ ...hit, lane: n, from: this.t, kind: 'lane' });
          this.events.push({ t: this.t, type: 'diverted', lane: n, id: hit.id });
        }
      }
    }

    // End of the belt: into the reject chute
    for (const p of [...this.parcels]) {
      if (p.lead - p.len > GEOM.sorterEnd) {
        this.parcels.splice(this.parcels.indexOf(p), 1);
        this.leaving.push({ ...p, from: this.t, kind: 'chute' });
        this.bin++;
        this.events.push({ t: this.t, type: 'rejected', id: p.id });
      }
    }

    // Animations finish -> parcel arrives in its lane
    this.leaving = this.leaving.filter((l) => {
      if (this.t - l.from < 450) return true;
      if (l.kind === 'lane') {
        if (this.lanes[l.lane].length < GEOM.laneCapacity) this.lanes[l.lane].push(l);
      }
      return false;
    });

    // Operators unload the lanes (unless that lane is "blocked")
    for (let n = 1; n <= 3; n++) {
      if (this.lanes[n].length && !this.faults.laneBlocked[n] && this.t >= this.laneDrainAt[n]) {
        this.lanes[n].shift();
        this.laneDrainAt[n] = this.t + 3800;
      } else if (!this.lanes[n].length) {
        this.laneDrainAt[n] = this.t + 3800;
      }
    }
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  removeJam() {
    this.parcels = this.parcels.filter((p) => !p.jam);
  }

  emptyBin() {
    this.bin = 0;
  }
}
