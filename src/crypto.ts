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
