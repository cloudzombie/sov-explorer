import assert from 'node:assert/strict';
import test from 'node:test';

const values = new Map();
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) { values.set(key, String(value)); },
};

const { isWatched, toggleWatch, watchlist } = await import('../web/tools.js');

test('watchlists persist locally without a server dependency', () => {
  assert.deepEqual(watchlist(), []);
  assert.equal(toggleWatch('alice'), true);
  assert.equal(isWatched('alice'), true);
  assert.deepEqual(watchlist(), ['alice']);
  assert.equal(toggleWatch('alice'), false);
  assert.deepEqual(watchlist(), []);
});
