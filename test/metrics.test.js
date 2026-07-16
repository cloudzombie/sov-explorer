import assert from 'node:assert/strict';
import test from 'node:test';
import { Metrics, routeTemplate } from '../src/metrics.js';

test('metrics use bounded route labels and expose request/cache counters', () => {
  const metrics = new Metrics();
  metrics.observeRequest('GET', routeTemplate('/api/mainnet/block/secret'), 200, 25);
  metrics.observeCache(true);
  const text = metrics.render();
  assert.match(text, /route="\/api\/mainnet\/block"/);
  assert.doesNotMatch(text, /secret/);
  assert.match(text, /result="hit"} 1/);
  assert.match(text, /_sum.*0\.025000/);
});
