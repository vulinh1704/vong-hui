/**
 * Throwaway TEST keys. Never use these helpers for keys that hold real money.
 */
import { generatePrivateKey, secp256k1, sha256, utf8ToBin } from '@bitauth/libauth';

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

function pairOf(privateKey: Uint8Array): KeyPair {
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  return { privateKey, publicKey };
}

/** Deterministic test key from a label, e.g. testKey('member-1'). Public by construction: TEST ONLY. */
export function testKey(label: string): KeyPair {
  return pairOf(sha256.hash(utf8ToBin(`hui-test-key:${label}`)));
}

/** Fresh random key (for chipnet throwaway wallets). */
export function randomKey(): KeyPair {
  return pairOf(generatePrivateKey());
}
