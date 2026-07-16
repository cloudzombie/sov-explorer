// Small Prometheus-compatible metrics registry. Labels are deliberately bounded:
// route templates and network names only, never raw URLs, hashes, or accounts.

function labelValue(value) {
  return String(value ?? 'unknown').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.requests = new Map();
    this.requestSeconds = new Map();
    this.upstreamErrors = new Map();
    this.cache = { hit: 0, miss: 0 };
  }

  observeRequest(method, route, status, elapsedMs) {
    const key = `${method}\0${route}\0${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const timingKey = `${method}\0${route}`;
    const timing = this.requestSeconds.get(timingKey) ?? { count: 0, sum: 0 };
    timing.count += 1;
    timing.sum += elapsedMs / 1000;
    this.requestSeconds.set(timingKey, timing);
  }

  observeUpstream(network, method) {
    const key = `${network}\0${method}`;
    this.upstreamErrors.set(key, (this.upstreamErrors.get(key) ?? 0) + 1);
  }

  observeCache(hit) { this.cache[hit ? 'hit' : 'miss'] += 1; }

  render(nets = []) {
    const lines = [
      '# HELP sovereign_explorer_uptime_seconds Process uptime.',
      '# TYPE sovereign_explorer_uptime_seconds gauge',
      `sovereign_explorer_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`,
      '# HELP sovereign_explorer_http_requests_total HTTP requests.',
      '# TYPE sovereign_explorer_http_requests_total counter',
    ];
    for (const [key, value] of this.requests) {
      const [method, route, status] = key.split('\0');
      lines.push(`sovereign_explorer_http_requests_total{method="${labelValue(method)}",route="${labelValue(route)}",status="${labelValue(status)}"} ${value}`);
    }
    lines.push('# HELP sovereign_explorer_http_request_duration_seconds HTTP request duration.');
    lines.push('# TYPE sovereign_explorer_http_request_duration_seconds summary');
    for (const [key, value] of this.requestSeconds) {
      const [method, route] = key.split('\0');
      const labels = `method="${labelValue(method)}",route="${labelValue(route)}"`;
      lines.push(`sovereign_explorer_http_request_duration_seconds_count{${labels}} ${value.count}`);
      lines.push(`sovereign_explorer_http_request_duration_seconds_sum{${labels}} ${value.sum.toFixed(6)}`);
    }
    lines.push('# HELP sovereign_explorer_history_cache_total Historical cache outcomes.');
    lines.push('# TYPE sovereign_explorer_history_cache_total counter');
    lines.push(`sovereign_explorer_history_cache_total{result="hit"} ${this.cache.hit}`);
    lines.push(`sovereign_explorer_history_cache_total{result="miss"} ${this.cache.miss}`);
    lines.push('# HELP sovereign_explorer_upstream_errors_total Relay request failures.');
    lines.push('# TYPE sovereign_explorer_upstream_errors_total counter');
    for (const [key, value] of this.upstreamErrors) {
      const [network, method] = key.split('\0');
      lines.push(`sovereign_explorer_upstream_errors_total{network="${labelValue(network)}",method="${labelValue(method)}"} ${value}`);
    }
    for (const net of nets) {
      const stats = net.store.stats();
      const labels = `network="${labelValue(net.name)}"`;
      lines.push(`sovereign_explorer_index_height{${labels}} ${stats.tipHeight}`);
      lines.push(`sovereign_explorer_index_lag_blocks{${labels}} ${stats.sync.behindBlocks ?? -1}`);
      lines.push(`sovereign_explorer_websocket_clients{${labels}} ${net.wsHub.count()}`);
      lines.push(`sovereign_explorer_relay_healthy{${labels}} ${stats.relays?.healthy ?? 0}`);
      lines.push(`sovereign_explorer_archive_blocks{${labels}} ${stats.archive?.blocks ?? 0}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export function routeTemplate(pathname) {
  if (pathname === '/' || /^\/[a-z.-]+$/.test(pathname)) return pathname;
  if (/^\/api\/[a-z0-9-]+\//.test(pathname)) {
    const [, , network, endpoint] = pathname.split('/');
    return `/api/${network}/${endpoint || ''}`;
  }
  if (/^\/(graphql|ws)\/[a-z0-9-]+$/.test(pathname)) return pathname.replace(/\/[^/]+$/, '/:network');
  return 'other';
}
