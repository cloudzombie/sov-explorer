import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateGate } from '../src/limits.js';

test('rate gate enforces independent client and distributed global ceilings', () => {
  const gate = new RateGate({
    windowMs: 60_000,
    clientHttp: 2,
    clientGraphql: 1,
    globalHttp: 3,
    globalGraphql: 2,
  });

  assert.equal(gate.allow('a', 'http', 1_000).allowed, true);
  assert.equal(gate.allow('a', 'http', 1_000).allowed, true);
  assert.deepEqual(gate.allow('a', 'http', 1_000), {
    allowed: false,
    scope: 'client',
    retryAfterSeconds: 59,
  });

  assert.equal(gate.allow('b', 'http', 1_000).allowed, true);
  assert.deepEqual(gate.allow('c', 'http', 1_000), {
    allowed: false,
    scope: 'global',
    retryAfterSeconds: 59,
  });
  assert.equal(gate.allow('a', 'graphql', 1_000).allowed, true, 'GraphQL has a separate class');
  assert.equal(gate.allow('a', 'graphql', 1_000).scope, 'client');

  assert.equal(gate.allow('a', 'http', 60_001).allowed, true, 'new window resets counters');
});
