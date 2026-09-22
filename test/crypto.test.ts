import { test } from 'node:test';
import assert from 'node:assert/strict';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createHmac } from 'node:crypto';
import { decryptMessage, encryptMessage, openSealed, sealTo, publicKeyOf, verifySignature } from '../src/crypto';
import { parseToken } from '../src/index';

const keypair = () => {
  const pair = x25519.keygen();
  return { secretKey: bytesToHex(pair.secretKey), publicKey: bytesToHex(pair.publicKey) };
};

test('a message sealed to two members opens for each with their own key', () => {
  const alice = keypair();
  const bot = keypair();
  const envelope = encryptMessage('Hello 🐀', [
    { userId: 1, publicKey: alice.publicKey },
    { userId: 42, publicKey: bot.publicKey },
  ]);

  assert.equal(decryptMessage(envelope.content, envelope.encryptedSymmetricKeys['1'], alice.secretKey), 'Hello 🐀');
  assert.equal(decryptMessage(envelope.content, envelope.encryptedSymmetricKeys['42'], bot.secretKey), 'Hello 🐀');
  assert.throws(() => decryptMessage(envelope.content, envelope.encryptedSymmetricKeys['1'], bot.secretKey));
});

test('sealTo/openSealed round trip and the derived public key', () => {
  const pair = keypair();
  const sealed = sealTo(pair.publicKey, new TextEncoder().encode('secret'));

  assert.equal(new TextDecoder().decode(openSealed(sealed, pair.secretKey)), 'secret');
  assert.equal(publicKeyOf(pair.secretKey), pair.publicKey);
});

test('the token has three parts', () => {
  const parsed = parseToken(`42:${'a'.repeat(64)}:${'b'.repeat(64)}`);

  assert.deepEqual(parsed, { botId: 42, secretKey: 'a'.repeat(64), loginSecret: 'b'.repeat(64) });
  assert.throws(() => parseToken('nope'));
});

test('a webhook signature verifies only under its own secret and body', () => {
  const body = JSON.stringify({ type: 'message', chatId: 1 });
  const secret = 'a'.repeat(48);
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifySignature(body, signature, secret), true);
  assert.equal(verifySignature(body + ' ', signature, secret), false);
  assert.equal(verifySignature(body, signature, 'b'.repeat(48)), false);
  assert.equal(verifySignature(body, 'short', secret), false);
});
