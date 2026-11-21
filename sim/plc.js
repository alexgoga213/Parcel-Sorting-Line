// JavaScript port of the SCL program in /plc, block by block and line by line, so the
// browser simulator behaves like the PLC. Names match the SCL (FB_Tracking -> FB_Tracking).
// Time is in milliseconds and comes from the simulated PLC clock (`now`).

// ---------- IEC standard function blocks ----------
export class TON {
  constructor() { this.Q = false; this.ET = 0; this.start = null; }
  call(IN, PT, now) {
    if (!IN) { this.Q = false; this.ET = 0; this.start = null; return this; }
    if (this.start === null) this.start = now;
    this.ET = Math.min(now - this.start, PT);
    this.Q = now - this.start >= PT;
    return this;
  }
}
export class R_TRIG {
  constructor() { this.Q = false; this.mem = false; }
  call(CLK) { this.Q = CLK && !this.mem; this.mem = CLK; return this; }
}
export class F_TRIG {
  constructor() { this.Q = false; this.mem = false; }
  call(CLK) { this.Q = !CLK && this.mem; this.mem = CLK; return this; }
}

// ---------- DB_Settings ----------
export const defaultSettings = () => ({
  MmPerPulse: 1.0,
  PusherPosMm: [null, 1000, 2000, 3000],
  FireWindowMm: 40,
  ExitPosMm: 3600,
  ExitToleranceMm: 300,
  MinLengthMm: 60,
  MaxLengthMm: 500,
  JamExtraMm: 300,
  LaneEnabled: [null, true, true, true],
  StartWarning: 3000,
  DrainTimeout: 12000,
  PusherExtendTimeout: 800,
  PusherRetractTimeout: 800,
  MotorFeedbackTimeout: 1000,
  ExitBlockedTimeout: 2000,
});

// ---------- DB_HMI ----------
export const newHmi = () => ({
  Cmd: { Start: false, Stop: false, Reset: false, AckAlarms: false, JogC1: false, JogC2: false, ManualFire: [null, false, false, false], ClearTracking: false, ResetCounters: false },
  Sts: { LineState: 0, AutoMode: true, ReadyToStart: false, ResetRequired: false, ActiveAlarms: 0, UnackAlarms: 0, FirstOut: -1, ParcelsOnBelt: 0, Counters: { Lane: [null, 0, 0, 0], Rejected: 0, Total: 0, Oversize: 0, Lost: 0, PerHour: 0 } },
});

// ---------- FB_Motor ----------
export class FB_Motor {
  constructor() { this.Contactor = false; this.Fault = false; this.FaultOverload = false; this.FaultFeedback = false; this.tonFeedback = new TON(); }
  call({ Run, RunningFb, OverloadOk, FeedbackTimeout, Reset }, now) {
    this.tonFeedback.call(this.Contactor !== RunningFb, FeedbackTimeout, now);
    if (!OverloadOk) this.FaultOverload = true;
    if (this.tonFeedback.Q) this.FaultFeedback = true;
    if (Reset && OverloadOk && !this.tonFeedback.Q) { this.FaultOverload = false; this.FaultFeedback = false; }
    this.Fault = this.FaultOverload || this.FaultFeedback;
    this.Contactor = Run && !this.Fault;
  }
}

// ---------- FB_Pusher ----------
export class FB_Pusher {
  constructor() {
    Object.assign(this, { Valve: false, Ready: false, Done: false, FaultExtend: false, FaultRetract: false, State: 0, prevState: 0 });
    this.rtFire = new R_TRIG(); this.tonStep = new TON();
  }
  call({ Fire, Retracted, Extended, AirOk, ExtendTimeout, RetractTimeout, Reset }, now) {
    this.rtFire.call(Fire);
    this.Done = false;
    this.tonStep.call(this.State === this.prevState && (this.State === 1 || this.State === 2), this.State === 2 ? RetractTimeout : ExtendTimeout, now);
    this.prevState = this.State;
    switch (this.State) {
      case 0: if (this.rtFire.Q && Retracted && AirOk) this.State = 1; break;
      case 1:
        if (Extended) { this.Done = true; this.State = 2; }
        else if (this.tonStep.Q || !AirOk) { this.FaultExtend = true; this.State = 9; }
        break;
      case 2:
        if (Retracted) this.State = 0;
        else if (this.tonStep.Q) { this.FaultRetract = true; this.State = 9; }
        break;
      case 9:
        if (Reset && Retracted) { this.FaultExtend = false; this.FaultRetract = false; this.State = 0; }
        break;
      default: this.State = 9;
    }
    this.Valve = this.State === 1;
    this.Ready = this.State === 0 && Retracted && AirOk;
  }
}

// ---------- FB_Tracking ----------
const LAST_SLOT = 15;
const newParcel = () => ({ Active: false, Id: 0, LeadMm: 0, LengthMm: 0, Measured: false, SizeClass: 0, TargetLane: 0, PusherFired: false });

export class FB_Tracking {
  constructor(settings) {
    this.S = settings;
    this.Parcels = Array.from({ length: LAST_SLOT + 1 }, newParcel);
    Object.assign(this, { NextId: 1, MeasuringSlot: -1, MeasuredClass: 0, FiredSlot: [null, -1, -1, -1], LastCount: 0, AccMm: 0, InitDone: false });
    Object.assign(this, { FirePusher: [null, false, false, false], DivertedLane: 0, Rejected: false, Oversize: false, Lost: false, Unexpected: false, JamEntry: false, Overflow: false, Count: 0 });
    this.rtEntry = new R_TRIG(); this.ftEntry = new F_TRIG(); this.rtExit = new R_TRIG();
  }
  call({ EncoderCount, EntryPE, HeightLow, HeightMid, HeightHigh, ExitPE, PusherReady, PusherDone, LaneFull, Clear }) {
    const S = this.S;
    const P = this.Parcels;
    // One-scan outputs
    for (let lane = 1; lane <= 3; lane++) this.FirePusher[lane] = false;
    this.DivertedLane = 0; this.Rejected = false; this.Oversize = false; this.Lost = false; this.Unexpected = false;

    // Clear
    if (Clear) {
      for (const p of P) p.Active = false;
      this.MeasuringSlot = -1;
      for (let lane = 1; lane <= 3; lane++) this.FiredSlot[lane] = -1;
      this.Overflow = false;
    }

    // Encoder
    if (!this.InitDone) { this.LastCount = EncoderCount; this.InitDone = true; }
    this.AccMm += (EncoderCount - this.LastCount) * S.MmPerPulse;
    this.LastCount = EncoderCount;
    const stepMm = Math.trunc(this.AccMm);
    this.AccMm -= stepMm;
    for (const p of P) if (p.Active) p.LeadMm += stepMm;

    // Entry
    this.rtEntry.call(EntryPE);
    this.ftEntry.call(EntryPE);
    if (this.rtEntry.Q) {
      let slot = -1;
      for (let i = 0; i <= LAST_SLOT; i++) if (!P[i].Active && slot < 0) slot = i;
      if (slot >= 0) {
        Object.assign(P[slot], { Active: true, Id: this.NextId, LeadMm: 0, LengthMm: 0, Measured: false, SizeClass: 0, TargetLane: 0, PusherFired: false });
        this.NextId++;
        this.MeasuringSlot = slot;
        this.MeasuredClass = 0;
      } else {
        this.Overflow = true;
        this.MeasuringSlot = -1;
      }
    }
    if (EntryPE && this.MeasuringSlot >= 0) {
      if (HeightHigh) this.MeasuredClass = 3;
      else if (HeightMid && this.MeasuredClass < 2) this.MeasuredClass = 2;
      else if (HeightLow && this.MeasuredClass < 1) this.MeasuredClass = 1;
      if (P[this.MeasuringSlot].LeadMm > S.MaxLengthMm + S.JamExtraMm) this.JamEntry = true;
    }
    if (this.ftEntry.Q && this.MeasuringSlot >= 0) {
      const slot = this.MeasuringSlot;
      this.MeasuringSlot = -1;
      const p = P[slot];
      p.LengthMm = p.LeadMm;
      p.Measured = true;
      p.SizeClass = this.MeasuredClass;
      if (p.LengthMm < S.MinLengthMm) p.Active = false;
      else if (p.LengthMm > S.MaxLengthMm) { p.TargetLane = 0; this.Oversize = true; }
      else if (this.MeasuredClass >= 1 && this.MeasuredClass <= 3) p.TargetLane = S.LaneEnabled[this.MeasuredClass] ? this.MeasuredClass : 0;
      else p.TargetLane = 0;
    }
    if (!EntryPE) this.JamEntry = false;

    // Divert
    for (let i = 0; i <= LAST_SLOT; i++) {
      const p = P[i];
      if (p.Active && p.Measured && !p.PusherFired && p.TargetLane >= 1 && p.TargetLane <= 3) {
        const lane = p.TargetLane;
        const centreMm = p.LeadMm - Math.trunc(p.LengthMm / 2);
        if (centreMm >= S.PusherPosMm[lane] - S.FireWindowMm) {
          if (PusherReady[lane] && !LaneFull[lane] && this.FiredSlot[lane] < 0) {
            this.FirePusher[lane] = true;
            p.PusherFired = true;
            this.FiredSlot[lane] = i;
          } else {
            p.TargetLane = 0;
          }
        }
      }
    }
    for (let lane = 1; lane <= 3; lane++) {
      const fs = this.FiredSlot[lane];
      if (PusherDone[lane] && fs >= 0) {
        P[fs].Active = false;
        this.FiredSlot[lane] = -1;
        this.DivertedLane = lane;
      } else if (fs >= 0) {
        if (!P[fs].Active || P[fs].LeadMm - P[fs].LengthMm > S.PusherPosMm[lane] + 400) this.FiredSlot[lane] = -1;
      }
    }

    // Exit
    this.rtExit.call(ExitPE);
    if (this.rtExit.Q) {
      let slot = -1;
      let oldestId = 2147483647;
      for (let i = 0; i <= LAST_SLOT; i++) {
        const p = P[i];
        if (p.Active && p.LeadMm >= S.ExitPosMm - S.ExitToleranceMm && p.Id < oldestId) { oldestId = p.Id; slot = i; }
      }
      if (slot >= 0) { P[slot].Active = false; this.Rejected = true; }
      else this.Unexpected = true;
    }
    for (const p of P) {
      if (p.Active && p.Measured && p.LeadMm - p.LengthMm > S.ExitPosMm + S.ExitToleranceMm) { p.Active = false; this.Lost = true; }
    }

    // Status
    this.Count = P.filter((p) => p.Active).length;
    if (this.Count < LAST_SLOT) this.Overflow = false;
  }
}

// ---------- FB_Alarms ----------
const FAULT_MASK = 0x0000ffff;
export class FB_Alarms {
  constructor() { Object.assign(this, { Latched: 0, Unack: 0, FaultActive: false, WarningActive: false, FirstOut: -1, PrevConditions: 0 }); }
  call({ Conditions, Ack, Reset }) {
    const hadFault = this.FaultActive;
    const newBits = (Conditions & ~this.PrevConditions) >>> 0;
    this.PrevConditions = Conditions;
    this.Latched = (this.Latched | Conditions) >>> 0;
    this.Unack = (this.Unack | newBits) >>> 0;
    if (Ack || Reset) this.Unack = 0;
    if (Reset) this.Latched = Conditions >>> 0;
    this.FaultActive = (this.Latched & FAULT_MASK) !== 0;
    this.WarningActive = (this.Latched & ~FAULT_MASK) !== 0;
    if (!this.FaultActive) this.FirstOut = -1;
    else if (!hadFault) {
      for (let i = 0; i <= 15; i++) if (this.FirstOut < 0 && ((this.Latched >>> i) & 1) !== 0) this.FirstOut = i;
    }
  }
}

// ---------- FB_LineControl ----------
export class FB_LineControl {
  constructor() {
    Object.assign(this, { State: 0, RunInfeed: false, RunSorter: false, Horn: false, ReadyToStart: false, ResetRequired: false });
    this.rtStart = new R_TRIG(); this.tonWarning = new TON(); this.tonDrain = new TON();
  }
  call({ AutoMode, Start, Stop, Reset, EStopOk, FaultActive, BeltEmpty, StartWarning, DrainTimeout }, now) {
    this.rtStart.call(Start);
    if (!EStopOk) this.State = 5;
    else if (FaultActive && this.State >= 1 && this.State <= 3) this.State = 4;
    switch (this.State) {
      case 0: if (this.rtStart.Q && AutoMode && !FaultActive && !Stop) this.State = 1; break;
      case 1: if (Stop || !AutoMode) this.State = 0; else if (this.tonWarning.Q) this.State = 2; break;
      case 2: if (Stop || !AutoMode) this.State = 3; break;
      case 3: if (BeltEmpty || this.tonDrain.Q) this.State = 0; else if (this.rtStart.Q && AutoMode && !Stop) this.State = 2; break;
      case 4: if (Reset && !FaultActive) this.State = 0; break;
      case 5: if (Reset && EStopOk) this.State = 0; break;
      default: this.State = 4;
    }
    this.tonWarning.call(this.State === 1, StartWarning, now);
    this.tonDrain.call(this.State === 3, DrainTimeout, now);
    this.RunSorter = this.State === 2 || this.State === 3;
    this.RunInfeed = this.State === 2;
    this.Horn = this.State === 1;
    this.ReadyToStart = this.State === 0 && AutoMode && !FaultActive && EStopOk;
    this.ResetRequired = this.State === 4 || this.State === 5;
  }
}

// ---------- FB_StackLight ----------
export class FB_StackLight {
  constructor() { Object.assign(this, { Green: false, Yellow: false, Red: false, Horn: false, Blink: false }); this.tonOn = new TON(); this.tonOff = new TON(); this.tonFaultHorn = new TON(); }
  call({ LineState, AutoMode, WarningActive, UnackFault, StartHorn }, now) {
    this.tonOn.call(!this.tonOff.Q, 500, now);
    this.tonOff.call(this.tonOn.Q, 500, now);
    this.Blink = this.tonOn.Q;
    this.Green = LineState === 2 || (LineState === 1 && this.Blink);
    this.Yellow = ((!AutoMode || LineState === 3) && LineState !== 4 && LineState !== 5) || (WarningActive && this.Blink);
    this.Red = ((LineState === 4 || LineState === 5) && !UnackFault) || (UnackFault && this.Blink);
    this.tonFaultHorn.call(UnackFault, 2000, now);
    this.Horn = StartHorn || (UnackFault && !this.tonFaultHorn.Q);
  }
}

// ---------- FB_Counters ----------
export class FB_Counters {
  constructor() { this.Buckets = new Array(12).fill(0); this.BucketIdx = 0; this.tonTick = new TON(); }
  call({ DivertedLane, Rejected, Oversize, Lost, ResetCounters }, C, now) {
    if (ResetCounters) {
      for (let i = 1; i <= 3; i++) C.Lane[i] = 0;
      C.Rejected = 0; C.Total = 0; C.Oversize = 0; C.Lost = 0;
      this.Buckets.fill(0);
    }
    let counted = false;
    if (DivertedLane >= 1 && DivertedLane <= 3) { C.Lane[DivertedLane]++; counted = true; }
    if (Rejected) { C.Rejected++; counted = true; }
    if (Oversize) C.Oversize++;
    if (Lost) C.Lost++;
    if (counted) { C.Total++; this.Buckets[this.BucketIdx]++; }
    this.tonTick.call(!this.tonTick.Q, 5000, now);
    if (this.tonTick.Q) { this.BucketIdx = (this.BucketIdx + 1) % 12; this.Buckets[this.BucketIdx] = 0; }
    C.PerHour = this.Buckets.reduce((a, b) => a + b, 0) * 60;
  }
}

// ---------- FB_Sorter (main program) ----------
export const ALARMS = [
  'Emergency stop pressed', 'Compressed air pressure low', 'Infeed conveyor C1: motor overload', 'Infeed conveyor C1: no run feedback',
  'Sorter conveyor C2: motor overload', 'Sorter conveyor C2: no run feedback', 'Pusher 1: did not extend', 'Pusher 1: did not retract',
  'Pusher 2: did not extend', 'Pusher 2: did not retract', 'Pusher 3: did not extend', 'Pusher 3: did not retract',
  'Jam at the entry photo-eye', 'Reject bin full', 'Reject chute blocked', 'Tracking overflow (too many parcels)',
  'Lane 1 full', 'Lane 2 full', 'Lane 3 full', 'Parcel lost before the exit', 'Untracked parcel at the exit',
];
export const STATES = ['STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'FAULT', 'E-STOP'];

export class FB_Sorter {
  constructor(settings = defaultSettings(), hmi = newHmi()) {
    this.S = settings;
    this.HMI = hmi;
    this.Line = new FB_LineControl();
    this.C1 = new FB_Motor();
    this.C2 = new FB_Motor();
    this.Pusher1 = new FB_Pusher();
    this.Pusher2 = new FB_Pusher();
    this.Pusher3 = new FB_Pusher();
    this.Tracking = new FB_Tracking(settings);
    this.Alarms = new FB_Alarms();
    this.Lights = new FB_StackLight();
    this.Count = new FB_Counters();
    this.tonExitBlocked = new TON();
    this.tonLane = [null, new TON(), new TON(), new TON()];
    this.LostWarning = false;
    this.UnexpectedWarning = false;
  }

  /** One PLC cycle. I = input image (tag names), Q = output image (written). */
  scan(I, Q, now) {
    const S = this.S;
    const H = this.HMI;
    const autoMode = I.S_Auto;
    const start = I.S_Start || H.Cmd.Start;
    const stop = !I.S_Stop || H.Cmd.Stop;
    const reset = I.S_Reset || H.Cmd.Reset;
    const manual = !autoMode && this.Line.State === 0 && I.K_EStopOk;

    this.Line.call({ AutoMode: autoMode, Start: start, Stop: stop, Reset: reset, EStopOk: I.K_EStopOk, FaultActive: this.Alarms.FaultActive, BeltEmpty: this.Tracking.Count === 0, StartWarning: S.StartWarning, DrainTimeout: S.DrainTimeout }, now);

    this.C1.call({ Run: this.Line.RunInfeed || (manual && H.Cmd.JogC1), RunningFb: I.C1_RunFb, OverloadOk: I.C1_OverloadOk, FeedbackTimeout: S.MotorFeedbackTimeout, Reset: reset }, now);
    this.C2.call({ Run: this.Line.RunSorter || (manual && H.Cmd.JogC2), RunningFb: I.C2_RunFb, OverloadOk: I.C2_OverloadOk, FeedbackTimeout: S.MotorFeedbackTimeout, Reset: reset }, now);
    Q.K_C1 = this.C1.Contactor && I.K_EStopOk;
    Q.K_C2 = this.C2.Contactor && I.K_EStopOk;

    this.tonLane[1].call(I.B_Lane1Full, 1000, now);
    this.tonLane[2].call(I.B_Lane2Full, 1000, now);
    this.tonLane[3].call(I.B_Lane3Full, 1000, now);
    const laneFull = [null, this.tonLane[1].Q, this.tonLane[2].Q, this.tonLane[3].Q];

    const pushers = [null, this.Pusher1, this.Pusher2, this.Pusher3];
    this.Tracking.call({
      EncoderCount: I.HSC_Sorter, EntryPE: I.B_EntryPE, HeightLow: I.B_HeightLow, HeightMid: I.B_HeightMid, HeightHigh: I.B_HeightHigh, ExitPE: I.B_ExitPE,
      PusherReady: pushers.map((p) => p && p.Ready), PusherDone: pushers.map((p) => p && p.Done), LaneFull: laneFull,
      Clear: H.Cmd.ClearTracking && this.Line.State === 0,
    });

    for (let n = 1; n <= 3; n++) {
      pushers[n].call({ Fire: this.Tracking.FirePusher[n] || (manual && H.Cmd.ManualFire[n]), Retracted: I[`P${n}_Retracted`], Extended: I[`P${n}_Extended`], AirOk: I.B_AirOk, ExtendTimeout: S.PusherExtendTimeout, RetractTimeout: S.PusherRetractTimeout, Reset: reset }, now);
      Q[`Y_Pusher${n}`] = pushers[n].Valve && I.K_EStopOk;
    }

    this.tonExitBlocked.call(I.B_ExitPE && this.Line.RunSorter, S.ExitBlockedTimeout, now);
    if (this.Tracking.Lost) this.LostWarning = true;
    if (this.Tracking.Unexpected) this.UnexpectedWarning = true;
    if (reset || H.Cmd.AckAlarms) { this.LostWarning = false; this.UnexpectedWarning = false; }
    const bits = [
      !I.K_EStopOk, !I.B_AirOk, this.C1.FaultOverload, this.C1.FaultFeedback, this.C2.FaultOverload, this.C2.FaultFeedback,
      this.Pusher1.FaultExtend, this.Pusher1.FaultRetract, this.Pusher2.FaultExtend, this.Pusher2.FaultRetract, this.Pusher3.FaultExtend, this.Pusher3.FaultRetract,
      this.Tracking.JamEntry, I.B_RejectBinFull, this.tonExitBlocked.Q, this.Tracking.Overflow,
      laneFull[1], laneFull[2], laneFull[3], this.LostWarning, this.UnexpectedWarning,
    ];
    const cond = bits.reduce((acc, b, i) => (b ? (acc | (1 << i)) >>> 0 : acc), 0);
    this.Alarms.call({ Conditions: cond, Ack: H.Cmd.AckAlarms, Reset: reset });

    this.Lights.call({ LineState: this.Line.State, AutoMode: autoMode, WarningActive: this.Alarms.WarningActive, UnackFault: (this.Alarms.Unack & FAULT_MASK) !== 0, StartHorn: this.Line.Horn }, now);
    Q.H_Green = this.Lights.Green;
    Q.H_Yellow = this.Lights.Yellow;
    Q.H_Red = this.Lights.Red;
    Q.H_Horn = this.Lights.Horn;
    Q.H_ResetLamp = this.Line.ResetRequired && this.Lights.Red;

    this.Count.call({ DivertedLane: this.Tracking.DivertedLane, Rejected: this.Tracking.Rejected, Oversize: this.Tracking.Oversize, Lost: this.Tracking.Lost, ResetCounters: H.Cmd.ResetCounters }, H.Sts.Counters, now);
    Object.assign(H.Sts, {
      LineState: this.Line.State, AutoMode: autoMode, ReadyToStart: this.Line.ReadyToStart, ResetRequired: this.Line.ResetRequired,
      ActiveAlarms: this.Alarms.Latched, UnackAlarms: this.Alarms.Unack, FirstOut: this.Alarms.FirstOut, ParcelsOnBelt: this.Tracking.Count,
    });
    Object.assign(H.Cmd, { Start: false, Stop: false, Reset: false, AckAlarms: false, ClearTracking: false, ResetCounters: false });
  }
}
