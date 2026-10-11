import type { ParentalPinRecord } from '../types';
import { CONFIG } from '../config';

function subtleCrypto(): SubtleCrypto {
  if (!parentalPinSupported()) {
    throw new Error('Web Crypto is unavailable');
  }
  return crypto.subtle;
}

export function parentalPinSupported(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

function utf8(value: string): Uint8Array {
  const encoded = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function validatePin(pin: string): void {
  const length = CONFIG.PARENTAL_PIN_LENGTH;
  if (!new RegExp(`^\\d{${length}}$`).test(pin)) {
    throw new RangeError(`PIN must contain exactly ${length} digits`);
  }
}

async function derive(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const pinBytes = utf8(pin);
  const input = new Uint8Array(salt.length + pinBytes.length);
  input.set(salt);
  input.set(pinBytes, salt.length);
  return new Uint8Array(await subtleCrypto().digest('SHA-256', input));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    mismatch |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return mismatch === 0;
}

export async function createParentalPin(pin: string): Promise<ParentalPinRecord> {
  validatePin(pin);
  subtleCrypto();
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return {
    algorithm: 'sha256',
    salt: toBase64(salt),
    digest: toBase64(await derive(pin, salt)),
  };
}

export async function verifyParentalPin(
  pin: string,
  record: ParentalPinRecord,
): Promise<boolean> {
  validatePin(pin);
  if (record.algorithm !== 'sha256') return false;
  try {
    return equalBytes(await derive(pin, fromBase64(record.salt)), fromBase64(record.digest));
  } catch {
    return false;
  }
}
