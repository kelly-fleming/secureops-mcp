import { describe, expect, it } from 'vitest';

import {
  derivePasswordVerifier,
  isAcceptablePassphrase,
  maximumPassphraseBytes,
  minimumPassphraseLength,
  verifyPasswordVerifier,
} from '../src/security/password.js';

const passphrase = 'fictional-reviewer-passphrase-001';

describe('local reviewer password verifier', () => {
  it('uses a fresh salt and verifies only the matching passphrase', async () => {
    const first = await derivePasswordVerifier(passphrase);
    const second = await derivePasswordVerifier(passphrase);

    expect(first.passwordKdf).toBe('scrypt');
    expect(first.passwordSalt).not.toEqual(second.passwordSalt);
    expect(first.passwordVerifier).not.toEqual(second.passwordVerifier);
    expect(await verifyPasswordVerifier(passphrase, first)).toBe(true);
    expect(await verifyPasswordVerifier(passphrase, second)).toBe(true);
    expect(await verifyPasswordVerifier('fictional-reviewer-passphrase-002', first)).toBe(false);
    expect(
      await verifyPasswordVerifier(passphrase, {
        ...first,
        passwordVerifier: second.passwordVerifier,
      }),
    ).toBe(false);
  });

  it('rejects short, blank, oversized, and non-string passphrases', async () => {
    const short = 'x'.repeat(minimumPassphraseLength - 1);
    expect(isAcceptablePassphrase(short)).toBe(false);
    expect(isAcceptablePassphrase(' '.repeat(minimumPassphraseLength))).toBe(false);
    expect(isAcceptablePassphrase('x'.repeat(maximumPassphraseBytes + 1))).toBe(false);
    expect(isAcceptablePassphrase(undefined)).toBe(false);
    await expect(derivePasswordVerifier(short)).rejects.toThrow();

    const stored = await derivePasswordVerifier(passphrase);
    expect(await verifyPasswordVerifier(short, stored)).toBe(false);
    expect(await verifyPasswordVerifier(null, stored)).toBe(false);
  });

  it('fails closed on malformed stored verifiers and parameters', async () => {
    const stored = await derivePasswordVerifier(passphrase);
    const malformed = [
      null,
      { ...stored, passwordKdf: 'plaintext' },
      { ...stored, passwordSalt: Buffer.alloc(8) },
      { ...stored, passwordVerifier: Buffer.alloc(8) },
      { ...stored, scryptCost: 20_000 },
      { ...stored, scryptCost: 1_048_576 },
      { ...stored, scryptBlockSize: 0 },
      { ...stored, scryptParallelization: 100 },
    ];

    for (const value of malformed) {
      expect(await verifyPasswordVerifier(passphrase, value)).toBe(false);
    }
  });
});
