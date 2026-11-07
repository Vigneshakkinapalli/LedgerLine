import { describe, expect, it } from 'vitest';
import { rupeesToPaise } from './money';

describe('rupeesToPaise', () => {
  it.each([['22', '2200'], ['100', '10000'], ['185.88', '18588'], ['0.5', '50']])('converts ₹%s to %s paise', (rupees, paise) => {
    expect(rupeesToPaise(rupees)).toBe(paise);
  });
  it('rejects more than two decimal places and zero', () => {
    expect(() => rupeesToPaise('185.889')).toThrow();
    expect(() => rupeesToPaise('0')).toThrow();
  });
});
