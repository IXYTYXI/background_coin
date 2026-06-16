import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCallbackVerificationToken,
  callbackVerificationToken,
  isEncryptedCallbackPayload
} from '../lib/lark-callback.js';

test('reads verification token from supported callback shapes', () => {
  assert.equal(callbackVerificationToken({ token: 'root-token' }), 'root-token');
  assert.equal(callbackVerificationToken({ event: { token: 'event-token' } }), 'event-token');
  assert.equal(callbackVerificationToken({ header: { token: 'header-token' } }), 'header-token');
});

test('callback token assertion rejects mismatches when configured', () => {
  assert.doesNotThrow(() => assertCallbackVerificationToken({ event: { token: 'ok' } }, 'ok'));
  assert.doesNotThrow(() => assertCallbackVerificationToken({}, ''));

  assert.throws(
    () => assertCallbackVerificationToken({ token: 'bad' }, 'ok'),
    (error) => error.statusCode === 401 && /token/.test(error.message)
  );
});

test('detects encrypted callback payloads', () => {
  assert.equal(isEncryptedCallbackPayload({ encrypt: 'ciphertext' }), true);
  assert.equal(isEncryptedCallbackPayload({ encrypt: '' }), false);
  assert.equal(isEncryptedCallbackPayload({}), false);
});
