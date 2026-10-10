import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expiresWithin } from '../src/api';

const tokenWith = (payload: object) =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');

test('a token is stale within the margin of its expiry, and fresh before it', () => {
  const now = 1_000_000_000_000;
  const exp = now / 1000 + 120;

  assert.equal(expiresWithin(tokenWith({ exp }), 60_000, now), false);
  assert.equal(expiresWithin(tokenWith({ exp }), 180_000, now), true);
  assert.equal(expiresWithin(tokenWith({ exp: now / 1000 - 1 }), 0, now), true);
});

test('a token that cannot be read counts as expiring', () => {
  assert.equal(expiresWithin('not-a-token', 60_000), true);
  assert.equal(expiresWithin(tokenWith({ sub: '1' }), 60_000), true);
});
