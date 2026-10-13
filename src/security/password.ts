import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import { ValidationError } from '../domain/errors.js';

export const minimumPassphraseLength = 16;
export const maximumPassphraseBytes = 1_024;

const saltLength = 32;
const verifierLength = 64;
const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const maximumScryptMemoryBytes = 256 * 1_024 * 1_024;

/** Values persisted in local_identities; the plaintext passphrase is never included. */
export interface PasswordVerifier {
  readonly passwordKdf: 'scrypt';
  readonly passwordSalt: Buffer;
  readonly passwordVerifier: Buffer;
  readonly scryptCost: number;
  readonly scryptBlockSize: number;
  readonly scryptParallelization: number;
}

export function isAcceptablePassphrase(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') <= maximumPassphraseBytes &&
    [...value].length >= minimumPassphraseLength &&
    value.trim().length > 0
  );
}

function isStoredVerifier(value: unknown): value is PasswordVerifier {
  if (typeof value !== 'object' || value === null) return false;
  const stored = value as Partial<PasswordVerifier>;
  const cost = stored.scryptCost;
  return (
    stored.passwordKdf === 'scrypt' &&
    Buffer.isBuffer(stored.passwordSalt) &&
    stored.passwordSalt.length >= 16 &&
    stored.passwordSalt.length <= 64 &&
    Buffer.isBuffer(stored.passwordVerifier) &&
    stored.passwordVerifier.length >= 32 &&
    stored.passwordVerifier.length <= 64 &&
    typeof cost === 'number' &&
    Number.isInteger(cost) &&
    cost >= 16_384 &&
    cost <= 65_536 &&
    (cost & (cost - 1)) === 0 &&
    typeof stored.scryptBlockSize === 'number' &&
    Number.isInteger(stored.scryptBlockSize) &&
    stored.scryptBlockSize >= 8 &&
    stored.scryptBlockSize <= 16 &&
    typeof stored.scryptParallelization === 'number' &&
    Number.isInteger(stored.scryptParallelization) &&
    stored.scryptParallelization >= 1 &&
    stored.scryptParallelization <= 4
  );
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  length: number,
  parameters: Pick<PasswordVerifier, 'scryptCost' | 'scryptBlockSize' | 'scryptParallelization'>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      length,
      {
        N: parameters.scryptCost,
        r: parameters.scryptBlockSize,
        p: parameters.scryptParallelization,
        maxmem: maximumScryptMemoryBytes,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

/** Derive one salted verifier for local storage using a fresh random salt. */
export async function derivePasswordVerifier(passphrase: string): Promise<PasswordVerifier> {
  if (!isAcceptablePassphrase(passphrase)) throw new ValidationError();

  const parameters = { scryptCost, scryptBlockSize, scryptParallelization };
  const passwordSalt = randomBytes(saltLength);
  const passwordVerifier = await deriveKey(passphrase, passwordSalt, verifierLength, parameters);
  return { passwordKdf: 'scrypt', passwordSalt, passwordVerifier, ...parameters };
}

/** Malformed stored values and invalid attempts fail closed without echoing secrets. */
export async function verifyPasswordVerifier(
  passphrase: unknown,
  stored: unknown,
): Promise<boolean> {
  if (!isAcceptablePassphrase(passphrase) || !isStoredVerifier(stored)) return false;

  // Snapshot mutable database buffers before the asynchronous derivation.
  const salt = Buffer.from(stored.passwordSalt);
  const verifier = Buffer.from(stored.passwordVerifier);
  let derivedKey: Buffer | undefined;
  try {
    derivedKey = await deriveKey(passphrase, salt, verifier.length, stored);
    return timingSafeEqual(derivedKey, verifier);
  } catch {
    // A corrupt verifier or unsupported parameter combination is never authentication.
    return false;
  } finally {
    derivedKey?.fill(0);
    salt.fill(0);
    verifier.fill(0);
  }
}
