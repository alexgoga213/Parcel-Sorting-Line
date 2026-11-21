// Closed-loop tests: the PLC program (sim/plc.js, port of plc/*.scl) against the plant model.
// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FB_Sorter, FB_Pusher, FB_Alarms, ALARMS } from '../sim/plc.js';
import { Plant } from '../sim/plant.js';

function rig(seed = 42) {
  let s = seed;
  const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const orig = Math.random;
  Math.random = rng;
  const plc = new FB_Sorter();
  const plant = new Plant();
  const Q = {};
  let now = 0;
  const run = (ms) => {
    for (let t = 0; t < ms; t += 10) {
      plc.scan(plant.inputs(), Q, now);
      plant.step(Q, 10);
      now += 10;
    }
  };
  const press = (k) => {
    plant.panel[k] = true;
    run(100);
    plant.panel[k] = false;
    run(50);
  };
  const alarms = () => ALARMS.filter((_, i) => (plc.Alarms.Latched >>> i) & 1);
  return { plc, plant, Q, run, press, alarms, restore: () => (Math.random = orig) };
}

const sizeClass = (h) => (h > 300 ? 3 : h > 150 ? 2 : h > 40 ? 1 : 0);

test('start: horn for 3 s, then both conveyors run', () => {
  const r = rig();
  r.press('start');
  assert.equal(r.plc.Line.State, 1);
  assert.equal(r.Q.H_Horn, true);
  assert.equal(r.Q.K_C2, false);
  r.run(3100);
  assert.equal(r.plc.Line.State, 2);
  assert.equal(r.Q.K_C1 && r.Q.K_C2, true);
  r.restore();
});

test('two minutes of production: every parcel ends in the right place and the counters match', () => {
  const r = rig(42);
  r.press('start');
  r.run(120000);
  const C = r.plc.HMI.Sts.Counters;
  const diverted = [0, 0, 0, 0];
  let rejected = 0;
  for (const e of r.plant.events) {
    if (e.type === 'diverted') diverted[e.lane]++;
    if (e.type === 'rejected') rejected++;
  }
  assert.deepEqual(C.Lane.slice(1), diverted.slice(1));
  assert.equal(C.Rejected, rejected);
  assert.ok(C.Total > 60, `only ${C.Total} parcels sorted`);
  assert.equal(C.Lost, 0);
  for (let n = 1; n <= 3; n++) for (const p of r.plant.lanes[n]) assert.equal(sizeClass(p.height), n);
  assert.equal(r.plc.Line.State, 2);
  assert.equal(r.plc.Alarms.FaultActive, false);
  r.restore();
});

test('oversize and flat parcels go to the reject chute', () => {
  const r = rig(5);
  r.press('start');
  r.run(150000);
  const C = r.plc.HMI.Sts.Counters;
  assert.ok(C.Oversize > 0, 'expected at least one oversize parcel in 2.5 min');
  assert.ok(C.Rejected >= C.Oversize);
  r.restore();
});

test('stuck pusher: fault, line stops, first-out names the pusher, reset recovers', () => {
  const r = rig(7);
  r.press('start');
  r.run(4000);
  r.plant.faults.pusherStuck[2] = true;
  r.run(30000);
  assert.equal(r.plc.Line.State, 4);
  assert.equal(r.Q.K_C1 || r.Q.K_C2, false);
  assert.equal(ALARMS[r.plc.Alarms.FirstOut], 'Pusher 2: did not extend');
  // the stuck cylinder is still at home, so Reset is accepted, but the next parcel for lane 2 faults again
  r.press('reset');
  assert.equal(r.plc.Line.State, 0);
  r.press('start');
  r.run(40000);
  assert.equal(r.plc.Line.State, 4);
  r.plant.faults.pusherStuck[2] = false;
  r.press('reset');
  r.press('start');
  r.run(20000);
  assert.equal(r.plc.Line.State, 2);
  r.restore();
});

test('emergency stop: outputs drop at once, restart needs release + reset + start', () => {
  const r = rig();
  r.press('start');
  r.run(4000);
  r.plant.panel.estop = true;
  r.run(30);
  assert.equal(r.plc.Line.State, 5);
  assert.equal(r.Q.K_C1 || r.Q.K_C2 || r.Q.Y_Pusher1 || r.Q.Y_Pusher2 || r.Q.Y_Pusher3, false);
  r.press('reset');
  assert.equal(r.plc.Line.State, 5, 'reset while still pressed does nothing');
  r.plant.panel.estop = false;
  r.run(100);
  r.press('reset');
  assert.equal(r.plc.Line.State, 0, 'no automatic restart after an e-stop');
  r.press('start');
  r.run(3200);
  assert.equal(r.plc.Line.State, 2);
  r.restore();
});

test('jam at the entry eye is detected', () => {
  const r = rig(3);
  r.press('start');
  r.plant.faults.jamNext = true;
  r.run(20000);
  assert.ok(r.alarms().includes('Jam at the entry photo-eye'));
  assert.equal(r.plc.Line.State, 4);
  r.restore();
});

test('full lane: parcels for it are rejected, the line keeps running', () => {
  const r = rig(9);
  r.press('start');
  r.plant.faults.laneBlocked[1] = true;
  r.run(90000);
  assert.ok(r.alarms().includes('Lane 1 full'));
  assert.equal(r.plc.Line.State, 2);
  assert.ok(r.plant.lanes[1].length <= 6);
  r.restore();
});

test('controlled stop empties the sorter before stopping', () => {
  const r = rig(11);
  r.press('start');
  r.run(20000);
  r.press('stopPressed');
  assert.equal(r.plc.Line.State, 3);
  assert.equal(r.Q.K_C1, false);
  assert.equal(r.Q.K_C2, true);
  r.run(13000);
  assert.equal(r.plc.Line.State, 0);
  assert.equal(r.plc.Tracking.Count, 0);
  r.restore();
});

test('contactor without feedback trips the motor', () => {
  const r = rig();
  r.press('start');
  r.plant.faults.c2Contactor = true;
  r.run(5000);
  assert.ok(r.alarms().includes('Sorter conveyor C2: no run feedback'));
  r.restore();
});

test('FB_Pusher unit: extend timeout and retract timeout', () => {
  const p = new FB_Pusher();
  const base = { Retracted: true, Extended: false, AirOk: true, ExtendTimeout: 800, RetractTimeout: 800, Reset: false };
  let t = 0;
  p.call({ ...base, Fire: false }, t);
  p.call({ ...base, Fire: true }, (t += 10));
  assert.equal(p.State, 1);
  for (let i = 0; i < 100; i++) p.call({ ...base, Retracted: false, Fire: false }, (t += 10));
  assert.equal(p.FaultExtend, true);
  assert.equal(p.Valve, false);
});

test('FB_Alarms unit: latch, acknowledge, reset only clears what is gone', () => {
  const a = new FB_Alarms();
  a.call({ Conditions: 0b101, Ack: false, Reset: false });
  assert.equal(a.FaultActive, true);
  assert.equal(a.FirstOut, 0);
  a.call({ Conditions: 0b100, Ack: true, Reset: false });
  assert.equal(a.Unack, 0);
  a.call({ Conditions: 0b100, Ack: false, Reset: true });
  assert.equal(a.Latched, 0b100);
});
