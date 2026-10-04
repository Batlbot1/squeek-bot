import { test } from 'node:test';
import assert from 'node:assert/strict';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import {
  decryptMessage,
  encryptMessage,
  encryptFile,
  decryptFile,
  openSealed,
  sealTo,
  publicKeyOf,
  verifySignature,
} from '../src/crypto';
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

test('a sealed file opens again, chunk boundaries included', () => {
  const bot = keypair();
  const recipients = [{ userId: 7, publicKey: bot.publicKey }];

  for (const size of [0, 1, 256 * 1024, 256 * 1024 + 1, 600 * 1024]) {
    const plain = new Uint8Array(size).map((_, i) => i % 251);
    const sealed = encryptFile(plain, recipients);
    const opened = decryptFile(sealed.body, sealed.fileEncryptedSymmetricKeys['7'], bot.secretKey);

    assert.deepEqual(Array.from(opened), Array.from(plain), `size ${size}`);
  }
});

/** A file the way the app writes it since version 2: native AES-GCM. */
const sealV2 = (plain: Uint8Array, fileKey: Uint8Array) => {
  const magic = Uint8Array.from([0x53, 0x51, 0x4b, 0x02]);
  const baseNonce = randomBytes(12);
  const total = Math.max(1, Math.ceil(plain.length / (256 * 1024)));
  const parts: Buffer[] = [Buffer.from(magic), baseNonce];

  for (let index = 0; index < total; index += 1) {
    const nonce = Buffer.from(baseNonce);
    nonce.writeUInt32BE((nonce.readUInt32BE(8) ^ index) >>> 0, 8);
    const isLast = index === total - 1;
    const aad = Buffer.from([...magic, index >>> 24, (index >>> 16) & 0xff, (index >>> 8) & 0xff, index & 0xff, isLast ? 1 : 0]);
    const cipher = createCipheriv('aes-256-gcm', fileKey, nonce);

    cipher.setAAD(aad);
    parts.push(cipher.update(plain.subarray(index * 256 * 1024, (index + 1) * 256 * 1024)), cipher.final(), cipher.getAuthTag());
  }

  return new Uint8Array(Buffer.concat(parts));
};

test('a version 2 file from the app opens, and a tampered one does not', () => {
  const bot = keypair();
  const fileKey = new Uint8Array(randomBytes(32));
  const sealedKey = sealTo(bot.publicKey, fileKey);

  for (const size of [0, 1, 256 * 1024, 256 * 1024 + 1, 600 * 1024]) {
    const plain = new Uint8Array(size).map((_, i) => i % 251);
    const opened = decryptFile(sealV2(plain, fileKey), sealedKey, bot.secretKey);

    assert.deepEqual(Array.from(opened), Array.from(plain), `size ${size}`);
  }

  const body = sealV2(new Uint8Array(600 * 1024), fileKey);

  body[body.length - 1] ^= 1;
  assert.throws(() => decryptFile(body, sealedKey, bot.secretKey));
  // Cut at a chunk boundary: the last chunk left is not marked as the last.
  assert.throws(() => decryptFile(sealV2(new Uint8Array(600 * 1024), fileKey).subarray(0, 16 + 2 * (256 * 1024 + 16)), sealedKey, bot.secretKey));
});

test('a file sealed for someone else does not open', () => {
  const bot = keypair();
  const stranger = keypair();
  const sealed = encryptFile(new Uint8Array([1, 2, 3]), [{ userId: 7, publicKey: bot.publicKey }]);

  assert.throws(() =>
    decryptFile(sealed.body, sealed.fileEncryptedSymmetricKeys['7'], stranger.secretKey),
  );
});

test('a message lists its files as the server describes them', async () => {
  const { Message } = await import('../src/index');
  const msg = new Message({} as any, {
    id: 5,
    attachments: [{ id: 9, originalName: 'voice.m4a', mimeType: 'audio/mp4', size: 1200 }],
  }, { id: 1, type: 'private', name: null }, '');

  assert.deepEqual(msg.attachments, [{ id: 9, name: 'voice.m4a', mimeType: 'audio/mp4', size: 1200 }]);
  await assert.rejects(new Message({} as any, { id: 6 }, { id: 1, type: 'private', name: null }, '').download(), /no file/);
});
