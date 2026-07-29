import assert from 'node:assert/strict';
import test from 'node:test';

import { RingBuffer } from '../web/ticker.js';

test('RingBuffer keeps items in order until capacity is reached', () => {
  const r = new RingBuffer(3);
  assert.deepEqual(r.push('a'), []);
  assert.deepEqual(r.push('b'), []);
  assert.deepEqual(r.push('c'), []);
  assert.equal(r.size, 3);
  assert.deepEqual(r.toArray(), ['a', 'b', 'c']);
});

test('RingBuffer evicts oldest and returns what was dropped', () => {
  const r = new RingBuffer(3);
  for (const x of ['a', 'b', 'c']) r.push(x);
  assert.deepEqual(r.push('d'), ['a']);
  assert.deepEqual(r.toArray(), ['b', 'c', 'd']);
  assert.equal(r.size, 3);
});

test('RingBuffer stays bounded over a long run (hours of blocks)', () => {
  const cap = 48;
  const r = new RingBuffer(cap);
  for (let i = 0; i < 100_000; i++) r.push(i);
  assert.equal(r.size, cap, 'never grows past cap');
  assert.deepEqual(r.toArray()[cap - 1], 99_999, 'newest retained');
  assert.deepEqual(r.toArray()[0], 100_000 - cap, 'oldest within window retained');
});

test('RingBuffer clamps a non-positive capacity to at least 1', () => {
  const r = new RingBuffer(0);
  assert.equal(r.cap, 1);
  r.push('x');
  const dropped = r.push('y');
  assert.deepEqual(r.toArray(), ['y']);
  assert.deepEqual(dropped, ['x']);
});

test('RingBuffer.clear empties the buffer', () => {
  const r = new RingBuffer(3);
  r.push('a');
  r.push('b');
  r.clear();
  assert.equal(r.size, 0);
  assert.deepEqual(r.toArray(), []);
});
