import { describe, expect, it } from 'vitest';
import { DISPLAY_VERSION_LENGTH, formatDisplayVersion } from '../public/js/config.js';

describe('formatDisplayVersion', () => {
  it('shows the first 6 characters like 710a0b', () => {
    expect(formatDisplayVersion('710a0b1234567890')).toBe('710a0b');
    expect(formatDisplayVersion('9922e5530b81dfb9')).toBe('9922e5');
    expect(DISPLAY_VERSION_LENGTH).toBe(6);
  });

  it('lowercases and ignores empty values', () => {
    expect(formatDisplayVersion('ABCDef')).toBe('abcdef');
    expect(formatDisplayVersion('')).toBe('');
    expect(formatDisplayVersion(null)).toBe('');
    expect(formatDisplayVersion(undefined)).toBe('');
  });
});
