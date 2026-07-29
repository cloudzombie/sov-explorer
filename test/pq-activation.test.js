import assert from 'node:assert/strict';
import test from 'node:test';

const { shieldedActivation } = await import('../web/tools.js');

// Mainnet shielded-v2 schedule: start 14,976, period 288 → 15,264 → 15,552.
const DEP = (over = {}) => ({
  name: 'shielded-v2', bit: 2, startHeight: 14976, period: 288,
  timeoutHeight: 20000, state: 'Started', ...over,
});

test('derives the three milestones from startHeight + period, never hardcoded', () => {
  const m = shieldedActivation(DEP(), 15000);
  assert.deepEqual(m.milestones.map((x) => x.height), [14976, 15264, 15552]);
  assert.equal(m.activeHeight, 15552);
  // A re-scheduled deployment renders against its own numbers.
  const r = shieldedActivation(DEP({ startHeight: 20000, period: 100 }), 20050);
  assert.deepEqual(r.milestones.map((x) => x.height), [20000, 20100, 20200]);
});

test('done-ness follows BIP-9 state, not height alone', () => {
  // Started: only the signal milestone is reached; lock-in is the countdown.
  const started = shieldedActivation(DEP({ state: 'Started' }), 15000);
  assert.deepEqual(started.milestones.map((x) => x.reached), [true, false, false]);
  const next = started.milestones.find((x) => x.next);
  assert.equal(next.key, 'lockin');
  assert.equal(next.blocksRemaining, 264); // 15264 - 15000
  assert.equal(next.etaSeconds, 264 * 150);
  assert.equal(next.eligibleNow, false);

  // LockedIn: signal + lock-in reached, active is the countdown.
  const locked = shieldedActivation(DEP({ state: 'LockedIn' }), 15300);
  assert.deepEqual(locked.milestones.map((x) => x.reached), [true, true, false]);
  assert.equal(locked.milestones.find((x) => x.next).key, 'active');
});

test('Active collapses to live with no pending milestone', () => {
  const m = shieldedActivation(DEP({ state: 'Active' }), 15600);
  assert.equal(m.active, true);
  assert.deepEqual(m.milestones.map((x) => x.reached), [true, true, true]);
  assert.equal(m.milestones.some((x) => x.next), false);
});

test('projected height passed but state not advanced → eligible, no negative countdown', () => {
  // Head past the lock-in height while still Started (signaling missed 90%).
  const m = shieldedActivation(DEP({ state: 'Started' }), 15300);
  const next = m.milestones.find((x) => x.next);
  assert.equal(next.key, 'lockin');
  assert.equal(next.blocksRemaining, 0);
  assert.equal(next.eligibleNow, true);
  assert.equal(next.etaSeconds, 0);
});

test('custom blockSeconds feeds the ETA estimate', () => {
  const m = shieldedActivation(DEP({ state: 'Started' }), 15000, { blockSeconds: 60 });
  assert.equal(m.milestones.find((x) => x.next).etaSeconds, 264 * 60);
});

test('absent or malformed deployment renders nothing (older node)', () => {
  assert.equal(shieldedActivation(null, 15000), null);
  assert.equal(shieldedActivation(undefined, 15000), null);
  assert.equal(shieldedActivation(DEP({ startHeight: undefined }), 15000), null);
  assert.equal(shieldedActivation(DEP({ period: 0 }), 15000), null);
});

test('failed deployment surfaces state with no countdown', () => {
  const m = shieldedActivation(DEP({ state: 'Failed' }), 15000);
  assert.equal(m.failed, true);
  assert.equal(m.milestones.some((x) => x.next), false);
});
