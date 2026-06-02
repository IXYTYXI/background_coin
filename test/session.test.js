import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSessionCookie,
  parseCookieHeader,
  readSessionCookie,
  serializeExpiredSessionCookie
} from '../lib/session.js';

const secret = 'test-secret-with-enough-length';

test('signed session cookie round-trips and rejects tampering', () => {
  const cookie = createSessionCookie({
    secret,
    secure: true,
    session: {
      openId: 'ou_test',
      name: 'Test User',
      expiresAt: Date.now() + 60_000
    }
  });

  assert.match(cookie, /gn_session=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);

  const parsed = readSessionCookie({ cookieHeader: cookie, secret });
  assert.equal(parsed.openId, 'ou_test');
  assert.equal(parsed.name, 'Test User');

  const tampered = cookie.replace(/\.[A-Za-z0-9_-]+/, '.tampered-signature');
  assert.equal(readSessionCookie({ cookieHeader: tampered, secret }), null);
});

test('expired sessions are rejected', () => {
  const cookie = createSessionCookie({
    secret,
    secure: false,
    session: {
      openId: 'ou_test',
      name: 'Test User',
      expiresAt: Date.now() - 1
    }
  });

  assert.equal(readSessionCookie({ cookieHeader: cookie, secret }), null);
});

test('cookie parsing handles multiple cookies', () => {
  assert.deepEqual(parseCookieHeader('a=1; gn_session=abc.def; theme=light'), {
    a: '1',
    gn_session: 'abc.def',
    theme: 'light'
  });
});

test('expired session cookie clears the browser value', () => {
  const cookie = serializeExpiredSessionCookie();
  assert.match(cookie, /gn_session=/);
  assert.match(cookie, /Max-Age=0/);
});
