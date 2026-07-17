import assert from 'node:assert/strict';
import test from 'node:test';
import { Metrics, routeTemplate } from '../src/metrics.js';

test('metrics use bounded route labels and expose request/cache counters', () => {
  const metrics = new Metrics();
  metrics.observeRequest('GET', routeTemplate('/api/mainnet/block/secret'), 200, 25);
  metrics.observeRequest('GET', routeTemplate('/api/v1/mainnet/transactions'), 200, 5);
  metrics.observeCache(true);
  metrics.observeApiAccess('pro', 'paid');
  const text = metrics.render();
  assert.match(text, /route="\/api\/mainnet\/block"/);
  assert.doesNotMatch(text, /secret/);
  assert.match(text, /result="hit"} 1/);
  assert.match(text, /route="\/api\/v1\/:network\/transactions"/);
  assert.match(text, /api_access_total\{tier="pro",outcome="paid"} 1/);
  assert.match(text, /_sum.*0\.025000/);
});

test('unknown paths collapse and metric maps remain bounded', () => {
  assert.equal(routeTemplate('/wp-login.php'), 'other');
  assert.equal(routeTemplate('/attacker-controlled'), 'other');
  const metrics = new Metrics();
  for (let i = 0; i < 1_000; i++) {
    metrics.observeRequest('GET', `/dynamic-${i}`, 200, 1);
    metrics.observeUpstream('mainnet', `method-${i}`);
  }
  assert.ok(metrics.requests.size <= 257);
  assert.ok(metrics.requestSeconds.size <= 129);
  assert.ok(metrics.upstreamErrors.size <= 65);
});
