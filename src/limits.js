// Process-wide request limiter used behind the edge limiter. The client bucket
// contains one abusive address; the global bucket also bounds a distributed flood
// spread across many addresses. The reverse proxy remains the first enforcement
// point, while this prevents a missing/misconfigured proxy rule from being fatal.

export class RateGate {
  constructor(opts = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.clientLimits = {
      http: opts.clientHttp ?? 600,
      graphql: opts.clientGraphql ?? 60,
    };
    this.globalLimits = {
      http: opts.globalHttp ?? 30_000,
      graphql: opts.globalGraphql ?? 3_000,
    };
    this.windows = new Map();
    this.operations = 0;
  }

  _increment(key, window) {
    const current = this.windows.get(key);
    const next = !current || current.window !== window
      ? { window, count: 1 }
      : { window, count: current.count + 1 };
    this.windows.set(key, next);
    return next.count;
  }

  _cleanup(window) {
    this.operations += 1;
    if (this.operations % 1_000 !== 0) return;
    for (const [key, value] of this.windows) {
      if (value.window < window - 1) this.windows.delete(key);
    }
  }

  allow(client, kind = 'http', now = Date.now()) {
    if (!(kind in this.clientLimits)) throw new Error(`unknown rate-limit class ${kind}`);
    const window = Math.floor(now / this.windowMs);
    const retryAfterSeconds = Math.max(1, Math.ceil(((window + 1) * this.windowMs - now) / 1_000));
    const clientCount = this._increment(`client:${kind}:${client}`, window);
    if (clientCount > this.clientLimits[kind]) {
      this._cleanup(window);
      return { allowed: false, scope: 'client', retryAfterSeconds };
    }
    const globalCount = this._increment(`global:${kind}`, window);
    this._cleanup(window);
    if (globalCount > this.globalLimits[kind]) {
      return { allowed: false, scope: 'global', retryAfterSeconds };
    }
    return { allowed: true, scope: null, retryAfterSeconds: 0 };
  }
}
