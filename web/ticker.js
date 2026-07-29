// web/ticker.js
// The "LIVE" strip's rolling block-height ticker: a continuous, low-CPU
// horizontal marquee driven by requestAnimationFrame. Only `transform` is
// written each frame (GPU-composited, no per-frame reflow); widths are read
// only when a chip is created or when a fresh block is folded in, so the roll
// stays smooth. The bounded-buffer logic lives here as a pure, unit-testable
// helper (`RingBuffer`) with no DOM dependency.

// A tiny fixed-capacity ring: items are pushed on the end and the oldest are
// evicted from the front once `cap` is exceeded. This is what keeps the ticker
// bounded so it can run for hours without growing memory. Pure — no DOM.
export class RingBuffer {
  constructor(cap) {
    this.cap = Math.max(1, Math.floor(Number(cap) || 1));
    this.items = [];
  }
  // Append `item`; returns the array of items evicted to stay within `cap`.
  push(item) {
    this.items.push(item);
    const dropped = [];
    while (this.items.length > this.cap) dropped.push(this.items.shift());
    return dropped;
  }
  get size() {
    return this.items.length;
  }
  toArray() {
    return this.items.slice();
  }
  clear() {
    this.items.length = 0;
  }
}

// The DOM-backed marquee. Constructed with the track/viewport elements and a
// `render(el, block)` callback that (re)populates a chip element for a block.
// The pool of chip DOM nodes is fixed once the track overfills the viewport, so
// the node count is bounded by construction; fresh blocks are folded into a
// chip as it recycles off the leading (right) edge rather than by growing the
// DOM. Falls back to a stepwise, non-animated strip under reduced-motion.
export class BlockTicker {
  constructor({ track, viewport, render, cap = 48, speed = 44, reducedMotion = false }) {
    this.track = track;
    this.viewport = viewport;
    this.render = render;
    this.cap = Math.max(4, Math.floor(cap));
    this.speed = speed; // px per second
    this.reduced = !!reducedMotion;
    this.offset = 0;
    this.paused = false;
    this.raf = 0;
    this.last = 0;
    this.gap = 0;
    // Pending real blocks waiting to be folded in on the next recycle. Bounded
    // by a RingBuffer so a burst of blocks can never grow memory.
    this.queue = new RingBuffer(this.cap);
    this._frameBound = (t) => this._frame(t);
    this._onEnter = () => this._pause();
    this._onLeave = () => this._resume();
    if (viewport) {
      // Pause on hover / keyboard focus so a moving chip can actually be read
      // and clicked. focusin/out cover keyboard users tabbing onto a chip.
      viewport.addEventListener('mouseenter', this._onEnter);
      viewport.addEventListener('mouseleave', this._onLeave);
      viewport.addEventListener('focusin', this._onEnter);
      viewport.addEventListener('focusout', this._onLeave);
    }
  }

  _makeChip(block) {
    const a = document.createElement('a');
    a.className = 'ticker-chip';
    this.render(a, block);
    return a;
  }

  _measure() {
    this.gap = parseFloat(getComputedStyle(this.track).columnGap || '0') || 0;
    for (const c of this.track.children) c._w = c.offsetWidth + this.gap;
  }

  // Replace all content with `blocks` (oldest..newest; newest ends up at the
  // trailing/right edge, the leading edge new blocks feed in from). Loops the
  // seed until the track comfortably overfills the viewport so recycling never
  // exposes a gap. Starts the roll.
  seed(blocks) {
    this.stop();
    this.track.replaceChildren();
    this.offset = 0;
    this.track.style.transform = 'translateX(0px)';
    const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
    if (!list.length) return;
    if (this.reduced) {
      // Static fallback: newest-first, capped — mirrors the old strip and the
      // prepend order used by push() below.
      for (const b of list.slice(-14).reverse()) this.track.append(this._makeChip(b));
      return;
    }
    for (const b of list) this.track.append(this._makeChip(b));
    const need = (this.viewport?.clientWidth || 0) + 260;
    let guard = 0;
    while (this.track.scrollWidth < need && guard++ < 400) {
      for (const b of list) {
        this.track.append(this._makeChip(b));
        if (this.track.scrollWidth >= need) break;
      }
    }
    this._measure();
    this.start();
  }

  // A real, newly-mined block arrived from the live feed.
  push(block) {
    if (!block) return;
    if (this.reduced) {
      // Stepwise fallback: prepend newest-first, hard-cap the strip. No motion.
      const chip = this._makeChip(block);
      this.track.prepend(chip);
      while (this.track.children.length > 14) this.track.lastChild.remove();
      return;
    }
    if (!this.track.firstElementChild) {
      // Nothing seeded yet (e.g. WS delivered before the REST seed) — bootstrap.
      this.seed([block]);
      return;
    }
    this.queue.push(block); // RingBuffer bounds the backlog
    this.start();
  }

  _pause() {
    this.paused = true;
    this.stop(); // fully idle while hovered/focused — zero rAF cost
  }
  _resume() {
    this.paused = false;
    this.start();
  }

  start() {
    if (this.reduced || this.raf || this.paused) return;
    this.last = 0;
    this.raf = requestAnimationFrame(this._frameBound);
  }
  stop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  // Move a chip that has fully scrolled off the left to the trailing edge. If a
  // real block is queued, that recycling chip becomes the new block — this is
  // how fresh blocks "feed in" at the leading edge without growing the DOM.
  _recycleOne(chip) {
    const next = this.queue.items.length ? this.queue.items.shift() : null;
    if (next) {
      this.render(chip, next);
      chip._w = chip.offsetWidth + this.gap; // width may change with the new content
    }
    this.track.appendChild(chip);
  }

  _frame(now) {
    if (!this.last) this.last = now;
    const dt = Math.min(64, now - this.last); // clamp after a tab-throttle gap
    this.last = now;
    if (!this.paused && this.speed > 0) {
      this.offset -= (this.speed * dt) / 1000;
      let first = this.track.firstElementChild;
      let guard = 0;
      while (first && guard++ < 128) {
        const w = first._w || (first._w = first.offsetWidth + this.gap);
        if (-this.offset < w) break;
        this.offset += w;
        this._recycleOne(first);
        first = this.track.firstElementChild;
      }
      this.track.style.transform = `translateX(${this.offset}px)`;
    }
    this.raf = requestAnimationFrame(this._frameBound);
  }

  destroy() {
    this.stop();
    if (this.viewport) {
      this.viewport.removeEventListener('mouseenter', this._onEnter);
      this.viewport.removeEventListener('mouseleave', this._onLeave);
      this.viewport.removeEventListener('focusin', this._onEnter);
      this.viewport.removeEventListener('focusout', this._onLeave);
    }
    this.queue.clear();
    if (this.track) this.track.replaceChildren();
  }
}
