// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createParentalPin, verifyParentalPin } from './parental-pin';

describe('parental PIN derivation', () => {
  it('stores a salted digest and verifies only the matching PIN', async () => {
    const first = await createParentalPin('1234');
    const second = await createParentalPin('1234');

    expect(first.algorithm).toBe('sha256');
    expect(first.digest).not.toBe('1234');
    expect(first.salt).not.toBe(second.salt);
    expect(first.digest).not.toBe(second.digest);
    await expect(verifyParentalPin('1234', first)).resolves.toBe(true);
    await expect(verifyParentalPin('4321', first)).resolves.toBe(false);
  });

  it('refuses to store a PIN without Web Crypto', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(createParentalPin('1234')).rejects.toThrow('Web Crypto is unavailable');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a record from another algorithm', async () => {
    const record = await createParentalPin('1234');
    await expect(verifyParentalPin('1234', {
      ...record,
      algorithm: 'pbkdf2-sha256' as 'sha256',
    })).resolves.toBe(false);
  });

  it('requires exactly four numeric digits', async () => {
    await expect(createParentalPin('123')).rejects.toThrow(RangeError);
    await expect(createParentalPin('12345')).rejects.toThrow(RangeError);
    await expect(createParentalPin('1234567')).rejects.toThrow(RangeError);
    await expect(createParentalPin('12a4')).rejects.toThrow(RangeError);
  });
});
