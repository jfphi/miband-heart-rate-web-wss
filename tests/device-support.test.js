import { describe, expect, it } from 'vitest';
import { DEVICE_BRANDS, DEVICE_SUPPORT_NOTE } from '../public/js/device-support.js';

describe('device support catalog', () => {
  it('lists confirmed models for every brand', () => {
    expect(DEVICE_BRANDS.length).toBeGreaterThan(0);
    for (const entry of DEVICE_BRANDS) {
      expect(entry.brand).toBeTruthy();
      expect(entry.supported.length + entry.unsupported.length).toBeGreaterThan(0);
    }
  });

  it('keeps Xiaomi Band 10 supported and Apple Watch unsupported', () => {
    const xiaomi = DEVICE_BRANDS.find((entry) => entry.brand === '小米');
    const apple = DEVICE_BRANDS.find((entry) => entry.brand === 'Apple');
    expect(xiaomi.supported.some((item) => item.includes('手環 10'))).toBe(true);
    expect(apple.unsupported.some((item) => item.includes('Apple Watch'))).toBe(true);
    expect(apple.supported).toEqual([]);
  });

  it('mentions COROS only as unlisted', () => {
    expect(DEVICE_SUPPORT_NOTE).toContain('COROS');
    expect(DEVICE_BRANDS.some((entry) => entry.brand === 'COROS')).toBe(false);
  });
});
