import assert from 'node:assert/strict';
import test from 'node:test';

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, String(value)); },
};

const {
  isWatched,
  toggleWatch,
  watchlist,
  blockUnit,
  poolBlocks,
  relayAvailability,
  timingSummary,
} = await import('../web/tools.js');

test('watchlists persist locally without a server dependency', () => {
  assert.deepEqual(watchlist(), []);
  assert.equal(toggleWatch('alice'), true);
  assert.equal(isWatched('alice'), true);
  assert.deepEqual(watchlist(), ['alice']);
  assert.equal(toggleWatch('alice'), false);
  assert.deepEqual(watchlist(), []);
});

test('blockUnit keeps the tallest pool stack within the target block count', () => {
  // On a 1/2/5×10ⁿ ladder, sized so max/unit never exceeds the target.
  assert.equal(blockUnit(20, 20), 1);
  assert.equal(blockUnit(21, 20), 2); // 21/1=21 > 20 → step up to 2
  assert.equal(blockUnit(200, 20), 10);
  assert.equal(blockUnit(4200, 20), 500); // 4200/500 = 8.4 ≤ 20
  for (const v of [7, 21, 133, 999, 4200, 12345, 987654]) {
    assert.ok(v / blockUnit(v, 20) <= 20, `stack for ${v} stays ≤ 20 blocks`);
  }
});

test('blockUnit stays honest for empty or degenerate pools', () => {
  assert.equal(blockUnit(0, 20), 1);
  assert.equal(blockUnit(-5, 20), 1);
  assert.equal(blockUnit(Number.NaN, 20), 1);
});

test('poolBlocks splits a value into whole blocks plus a sub-unit remainder', () => {
  const a = poolBlocks(2500, 1000);
  assert.equal(a.full, 2);
  assert.ok(Math.abs(a.partial - 0.5) < 1e-9);
  assert.equal(poolBlocks(3000, 1000).partial, 0); // exact multiple → no partial top block
  assert.equal(poolBlocks(3000, 1000).full, 3);
  const z = poolBlocks(0, 1000);
  assert.equal(z.full, 0);
  assert.equal(z.partial, 0);
  assert.equal(poolBlocks(-10, 1000).full, 0); // clamps negatives, never NaN
});

test('timingSummary renders a real observation and refuses to invent a missing one', () => {
  assert.deepEqual(timingSummary({
    firstSeenMs: 1_753_900_000_000,
    firstSeenHeight: 14_400,
    waitedMs: 300_000,
    waitedBlocks: 2,
    source: 'node',
    observed: true,
  }), {
    observed: true,
    source: 'node',
    firstSeenMs: 1_753_900_000_000,
    firstSeenHeight: 14_400,
    waitedMs: 300_000,
    waitedSeconds: 300,
    waitedBlocks: 2,
  });

  // Unobserved, absent, and malformed all collapse to the same honest "unknown" —
  // the UI shows "— / not observed" rather than a guessed wait.
  for (const timing of [
    null,
    undefined,
    { observed: false, firstSeenMs: null, waitedMs: null },
    { observed: true, firstSeenMs: null, waitedMs: 5_000 },
  ]) {
    const summary = timingSummary(timing);
    assert.equal(summary.observed, false);
    assert.equal(summary.firstSeenMs, null);
    assert.equal(summary.waitedMs, null);
    assert.equal(summary.waitedSeconds, null);
    assert.equal(summary.waitedBlocks, null);
  }

  // Observed first-seen but no wait yet (still pending) keeps the wait null.
  const pending = timingSummary({ observed: true, firstSeenMs: 10, waitedMs: null, waitedBlocks: null });
  assert.equal(pending.observed, true);
  assert.equal(pending.waitedMs, null);
});

test('relayAvailability keeps unavailable configured relays visible without degrading quorum', () => {
  assert.deepEqual(relayAvailability({
    configured: 3,
    verified: 2,
    healthy: 2,
    consistent: true,
    degraded: false,
    reducedRedundancy: true,
  }), {
    healthy: 2,
    configured: 3,
    state: 'reduced redundancy',
    tone: 'info',
  });
  assert.equal(relayAvailability({
    configured: 2,
    verified: 1,
    healthy: 1,
    consistent: null,
    degraded: true,
  }).tone, 'warn');
  assert.equal(relayAvailability({
    configured: 2,
    verified: 2,
    healthy: 2,
    consistent: false,
    degraded: true,
  }).tone, 'bad');
});
