import { describe, expect, it } from 'vitest';
import { rupeesToPaise } from './money';

describe('rupeesToPaise', () => {
  it.each([['22', '2200'], ['100', '10000'], ['185.88', '18588'], ['0.5', '50'],
    ['33', '3300'], ['22.50', '2250'], ['1000', '100000']])('converts ₹%s to %s paise', (rupees, paise) => {
    expect(rupeesToPaise(rupees)).toBe(paise);
  });
  it('rejects more than two decimal places and zero', () => {
    expect(() => rupeesToPaise('185.889')).toThrow();
    expect(() => rupeesToPaise('0')).toThrow();
  });
  it('rejects negative amounts and non-numeric input', () => {
    expect(() => rupeesToPaise('-5')).toThrow();
    expect(() => rupeesToPaise('abc')).toThrow();
  });
});
