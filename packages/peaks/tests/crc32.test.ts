import { describe, expect, it } from 'vitest';
import { crc32 } from '../src/crc32.js';

describe('crc32', () => {
  it('matches the standard check value for "123456789"', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('returns 0 for empty input (inverted)', () => {
    expect(crc32(new Uint8Array(0))).toBe(0x00000000);
  });

  it('supports partial ranges', () => {
    const bytes = new TextEncoder().encode('xx123456789yy');
    expect(crc32(bytes, 2, 11)).toBe(0xcbf43926);
  });
});
