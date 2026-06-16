import assert from 'node:assert/strict';
import test from 'node:test';
import { withdrawDigest } from '../lib/withdraw-digest.js';

test('uses the same digest shape for table rows and committed withdraws', () => {
  const tableRowDigest = withdrawDigest({
    accountId: 'rec_account',
    person: 'ou_user',
    amount: 8
  });
  const committedDigest = withdrawDigest({
    account: {
      id: 'rec_account',
      userId: 'ou_user'
    },
    amount: 8
  });

  assert.equal(tableRowDigest, committedDigest);
});

test('changes digest when the target account, user, or amount changes', () => {
  const digest = withdrawDigest({ accountId: 'rec_account', person: 'ou_user', amount: 8 });

  assert.notEqual(digest, withdrawDigest({ accountId: 'rec_other', person: 'ou_user', amount: 8 }));
  assert.notEqual(digest, withdrawDigest({ accountId: 'rec_account', person: 'ou_other', amount: 8 }));
  assert.notEqual(digest, withdrawDigest({ accountId: 'rec_account', person: 'ou_user', amount: 9 }));
});
