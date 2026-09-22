import { createHmac, timingSafeEqual } from 'node:crypto';
/**
 * The envelope, exactly as the Squeek app builds and opens it
 * (rattus-messenger, lib/crypto/envelope.ts). Keep the two in step: a bot
 * and a phone must agree byte for byte on what a sealed message looks like.
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  utf8ToBytes,
} from '@noble/hashes/utils.js';

const NONCE_BYTES = 24;
const MESSAGE_KEY_BYTES = 32;
const SEAL_INFO = utf8ToBytes('squeek/message-seal/v1');

const deriveSealKey = (
  sharedSecret: Uint8Array,
  ephemeralPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array =>
  hkdf(
    sha256,
    sharedSecret,
    concatBytes(ephemeralPublicKey, recipientPublicKey),
    SEAL_INFO,
    32,
  );

/** Seals bytes to a public key: ephemeralPublicKey:nonce:ciphertext, hex. */
export const sealTo = (recipientPublicKeyHex: string, payload: Uint8Array): string => {
  const recipientPublicKey = hexToBytes(recipientPublicKeyHex);
  const ephemeral = x25519.keygen();
  const shared = x25519.getSharedSecret(ephemeral.secretKey, recipientPublicKey);
  const key = deriveSealKey(shared, ephemeral.publicKey, recipientPublicKey);
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(key, nonce).encrypt(payload);

  return [bytesToHex(ephemeral.publicKey), bytesToHex(nonce), bytesToHex(sealed)].join(':');
};

export const openSealed = (sealed: string, recipientSecretKeyHex: string): Uint8Array => {
  const [ephemeralHex, nonceHex, cipherHex] = sealed.split(':');

  if (!ephemeralHex || !nonceHex || !cipherHex) {
    throw new Error('Malformed sealed key');
  }

  const secretKey = hexToBytes(recipientSecretKeyHex);
  const ephemeralPublicKey = hexToBytes(ephemeralHex);
  const shared = x25519.getSharedSecret(secretKey, ephemeralPublicKey);
  const key = deriveSealKey(shared, ephemeralPublicKey, x25519.getPublicKey(secretKey));

  return xchacha20poly1305(key, hexToBytes(nonceHex)).decrypt(hexToBytes(cipherHex));
};

export type Envelope = {
  /** nonce:ciphertext, hex. What the server stores as the message body. */
  content: string;
  /** userId -> sealed message key. One entry per participant. */
  encryptedSymmetricKeys: Record<string, string>;
};

export type Recipient = { userId: number | string; publicKey: string };

/**
 * Encrypts one message for every participant: the body once under a random
 * key, and only that key sealed per recipient.
 */
export const encryptMessage = (plainText: string, recipients: Recipient[]): Envelope => {
  const messageKey = randomBytes(MESSAGE_KEY_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const sealedBody = xchacha20poly1305(messageKey, nonce).encrypt(utf8ToBytes(plainText));
  const encryptedSymmetricKeys: Record<string, string> = {};

  for (const recipient of recipients) {
    if (!/^[0-9a-f]{64}$/.test(recipient.publicKey ?? '')) continue;
    encryptedSymmetricKeys[String(recipient.userId)] = sealTo(recipient.publicKey, messageKey);
  }

  if (!Object.keys(encryptedSymmetricKeys).length) {
    throw new Error('Nobody in this chat has a key to seal to');
  }

  return {
    content: `${bytesToHex(nonce)}:${bytesToHex(sealedBody)}`,
    encryptedSymmetricKeys,
  };
};

/** Opens a message addressed to us; `sealedKey` is our entry from the envelope. */
export const decryptMessage = (content: string, sealedKey: string, secretKeyHex: string): string => {
  const [nonceHex, cipherHex] = content.split(':');

  if (!nonceHex || !cipherHex) {
    throw new Error('Malformed message body');
  }

  const messageKey = openSealed(sealedKey, secretKeyHex);
  const opened = xchacha20poly1305(messageKey, hexToBytes(nonceHex)).decrypt(hexToBytes(cipherHex));

  return new TextDecoder().decode(opened);
};

export const publicKeyOf = (secretKeyHex: string): string =>
  bytesToHex(x25519.getPublicKey(hexToBytes(secretKeyHex)));

/**
 * Whether a webhook delivery really came from Squeek: the signature is an
 * HMAC-SHA256 of the raw body under the secret the server handed out when
 * the URL was set. Compared in constant time.
 */
export const verifySignature = (body: string, signature: string, secret: string): boolean => {
  const expected = createHmac('sha256', secret).update(body).digest('hex');

  if (expected.length !== signature.length) return false;

  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
};

const CHUNK_BYTES = 256 * 1024;
const FILE_KEY_BYTES = 32;

/** Each chunk gets its own nonce; one nonce over two chunks would leak both. */
const chunkNonce = (baseNonce: Uint8Array, index: number): Uint8Array => {
  const nonce = baseNonce.slice();
  const offset = nonce.length - 4;

  nonce[offset] ^= (index >>> 24) & 0xff;
  nonce[offset + 1] ^= (index >>> 16) & 0xff;
  nonce[offset + 2] ^= (index >>> 8) & 0xff;
  nonce[offset + 3] ^= index & 0xff;

  return nonce;
};

/**
 * Binds a chunk to its place and marks the last one, so a file that arrives
 * truncated or reordered fails to open rather than quietly decoding short.
 */
const chunkAad = (index: number, isLast: boolean): Uint8Array =>
  Uint8Array.from([
    (index >>> 24) & 0xff,
    (index >>> 16) & 0xff,
    (index >>> 8) & 0xff,
    index & 0xff,
    isLast ? 1 : 0,
  ]);

export type EncryptedFile = {
  /** The bytes to upload: the 24-byte nonce, then the sealed chunks. */
  body: Uint8Array;
  /** userId -> sealed file key. */
  fileEncryptedSymmetricKeys: Record<string, string>;
};

/**
 * Seals a file the way the app does: one key for the file, chunks of 256 KiB
 * each under their own nonce, and that key sealed to every recipient.
 *
 * The app streams chunk by chunk because a phone holding a 40 MB video three
 * times over crashes; a bot sending a chart or a log does not, so this keeps
 * the whole thing in memory and stays short.
 */
export const encryptFile = (data: Uint8Array, recipients: Recipient[]): EncryptedFile => {
  const fileKey = randomBytes(FILE_KEY_BYTES);
  const baseNonce = randomBytes(NONCE_BYTES);
  const total = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));
  const parts: Uint8Array[] = [baseNonce];

  for (let index = 0; index < total; index += 1) {
    const start = index * CHUNK_BYTES;
    const plain = data.subarray(start, Math.min(start + CHUNK_BYTES, data.length));
    const isLast = index === total - 1;

    parts.push(
      xchacha20poly1305(fileKey, chunkNonce(baseNonce, index), chunkAad(index, isLast)).encrypt(plain),
    );
  }

  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const body = new Uint8Array(size);
  let offset = 0;

  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  const fileEncryptedSymmetricKeys: Record<string, string> = {};

  for (const recipient of recipients) {
    if (!/^[0-9a-f]{64}$/.test(recipient.publicKey ?? '')) continue;
    fileEncryptedSymmetricKeys[String(recipient.userId)] = sealTo(recipient.publicKey, fileKey);
  }

  if (!Object.keys(fileEncryptedSymmetricKeys).length) {
    throw new Error('Nobody in this chat has a key to seal to');
  }

  return { body, fileEncryptedSymmetricKeys };
};

/** Opens a file sealed by encryptFile, given the key sealed to this bot. */
export const decryptFile = (body: Uint8Array, sealedKey: string, secretKeyHex: string): Uint8Array => {
  const fileKey = openSealed(sealedKey, secretKeyHex);
  const baseNonce = body.subarray(0, NONCE_BYTES);
  const sealed = body.subarray(NONCE_BYTES);
  const sealedChunk = CHUNK_BYTES + 16;
  const total = Math.max(1, Math.ceil(sealed.length / sealedChunk));
  const parts: Uint8Array[] = [];

  for (let index = 0; index < total; index += 1) {
    const start = index * sealedChunk;
    const chunk = sealed.subarray(start, Math.min(start + sealedChunk, sealed.length));
    const isLast = index === total - 1;

    parts.push(
      xchacha20poly1305(fileKey, chunkNonce(baseNonce, index), chunkAad(index, isLast)).decrypt(chunk),
    );
  }

  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const plain = new Uint8Array(size);
  let offset = 0;

  for (const part of parts) {
    plain.set(part, offset);
    offset += part.length;
  }

  return plain;
};
