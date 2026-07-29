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

// ---- BlockTicker marquee logic (minimal fake DOM) -------------------------

class FakeEl {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.href = '';
    this.title = '';
    this.textContent = '';
    this.offsetWidth = 80;
    this._clientWidth = 0;
    this._listeners = {};
    const set = new Set();
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, f) => (f ? set.add(c) : set.delete(c)),
    };
  }
  append(c) {
    c.parent = this;
    this.children.push(c);
  }
  appendChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    c.parent = this;
    this.children.push(c);
    return c;
  }
  prepend(c) {
    c.parent = this;
    this.children.unshift(c);
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    return c;
  }
  remove() {
    if (this.parent) this.parent.removeChild(this);
  }
  replaceChildren() {
    this.children = [];
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] ?? null;
  }
  get scrollWidth() {
    return this.children.reduce((a, c) => a + (c.offsetWidth || 0), 0);
  }
  get clientWidth() {
    return this._clientWidth;
  }
  addEventListener(t, f) {
    (this._listeners[t] = this._listeners[t] || []).push(f);
  }
  removeEventListener() {}
}

function withFakeDom(fn) {
  const savedDoc = global.document;
  const savedGcs = global.getComputedStyle;
  const savedRaf = global.requestAnimationFrame;
  const savedCaf = global.cancelAnimationFrame;
  let pending = null;
  global.document = { createElement: (t) => new FakeEl(t) };
  global.getComputedStyle = () => ({ columnGap: '8px', gap: '8px' });
  global.requestAnimationFrame = (cb) => {
    pending = cb;
    return 1;
  };
  global.cancelAnimationFrame = () => {
    pending = null;
  };
  const step = (ts) => {
    const cb = pending;
    pending = null;
    if (cb) cb(ts);
  };
  try {
    return fn({ step });
  } finally {
    global.document = savedDoc;
    global.getComputedStyle = savedGcs;
    global.requestAnimationFrame = savedRaf;
    global.cancelAnimationFrame = savedCaf;
  }
}

async function loadBlockTicker() {
  return (await import('../web/ticker.js')).BlockTicker;
}

test('BlockTicker seeds a fixed pool that overfills the viewport', async () => {
  const BlockTicker = await loadBlockTicker();
  withFakeDom(() => {
    const track = new FakeEl('div');
    const viewport = new FakeEl('div');
    viewport._clientWidth = 200; // need = 200 + 260 = 460 -> 6 chips of 80px
    const t = new BlockTicker({ track, viewport, render: (el, b) => (el.dataset.h = String(b.height)), speed: 1000 });
    t.seed([{ height: 1 }, { height: 2 }, { height: 3 }]);
    assert.equal(track.children.length, 6, 'loops the 3-block seed until the track overfills');
    assert.ok(track.scrollWidth >= 460);
  });
});

test('BlockTicker recycles a chip off the left and folds in a queued block', async () => {
  const BlockTicker = await loadBlockTicker();
  withFakeDom(({ step }) => {
    const track = new FakeEl('div');
    const viewport = new FakeEl('div');
    viewport._clientWidth = 200;
    const t = new BlockTicker({ track, viewport, render: (el, b) => (el.dataset.h = String(b.height)), speed: 1000 });
    t.seed([{ height: 10 }, { height: 11 }, { height: 12 }]);
    const poolSize = track.children.length;
    t.push({ height: 99 }); // real new block, queued
    assert.equal(track.children.length, poolSize, 'push does not grow the DOM pool');

    // chip advance width = 80 + 8 gap = 88px. At 1000px/s a 64ms frame = 64px.
    step(1000); // last := 1000, dt 0
    step(1064); // +64px -> offset -64, no recycle yet
    step(1128); // +64px -> offset -128 >= 88 -> recycle one, queued 99 folded in
    const last = track.children[track.children.length - 1];
    assert.equal(last.dataset.h, '99', 'the recycled chip became the queued block');
    assert.equal(track.children.length, poolSize, 'pool size stays constant (bounded)');
    assert.equal(t.queue.size, 0, 'the queue drained');
  });
});

test('BlockTicker stays bounded across many blocks and frames', async () => {
  const BlockTicker = await loadBlockTicker();
  withFakeDom(({ step }) => {
    const track = new FakeEl('div');
    const viewport = new FakeEl('div');
    viewport._clientWidth = 200;
    const t = new BlockTicker({ track, viewport, render: (el, b) => (el.dataset.h = String(b.height)), cap: 8, speed: 1000 });
    t.seed([{ height: 1 }, { height: 2 }]);
    const poolSize = track.children.length;
    let ts = 1000;
    step(ts);
    for (let i = 0; i < 500; i++) {
      if (i % 3 === 0) t.push({ height: 1000 + i });
      ts += 64;
      step(ts);
    }
    assert.equal(track.children.length, poolSize, 'DOM pool never grows');
    assert.ok(t.queue.size <= 8, 'the pending queue is bounded by cap');
    assert.ok(Math.abs(t.offset) < 200, 'offset stays bounded via recycling');
  });
});

test('BlockTicker reduced-motion falls back to a capped stepwise strip', async () => {
  const BlockTicker = await loadBlockTicker();
  withFakeDom(() => {
    const track = new FakeEl('div');
    const viewport = new FakeEl('div');
    const seed = Array.from({ length: 20 }, (_, i) => ({ height: i }));
    const t = new BlockTicker({ track, viewport, render: (el, b) => (el.dataset.h = String(b.height)), reducedMotion: true });
    t.seed(seed);
    assert.equal(track.children.length, 14, 'seed is capped at 14 in reduced-motion');
    for (let i = 100; i < 110; i++) t.push({ height: i });
    assert.equal(track.children.length, 14, 'push stays capped at 14');
    assert.equal(track.firstElementChild.dataset.h, '109', 'newest is prepended first');
  });
});
