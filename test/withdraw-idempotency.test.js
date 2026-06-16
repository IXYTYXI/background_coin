import assert from 'node:assert/strict';
import test from 'node:test';
import { WithdrawCompletionRegistry } from '../lib/withdraw-idempotency.js';

test('prevents duplicate withdraw completion while pending and after success', () => {
  const registry = new WithdrawCompletionRegistry();

  assert.deepEqual(registry.start('GW-1'), { status: 'started', key: 'GW-1' });
  assert.deepEqual(registry.start('GW-1'), { status: 'pending', key: 'GW-1' });

  const committed = { serial: 'GW-1', recordId: 'rec001', amount: 3 };
  registry.finish('GW-1', committed);

  assert.deepEqual(registry.start('GW-1'), {
    status: 'completed',
    key: 'GW-1',
    value: committed
  });
});

test('releases withdraw serial after a failed attempt', () => {
  const registry = new WithdrawCompletionRegistry();

  assert.equal(registry.start('GW-2').status, 'started');
  registry.fail('GW-2');
  assert.equal(registry.start('GW-2').status, 'started');
});
