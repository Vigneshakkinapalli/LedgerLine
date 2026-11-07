export function rupeesToPaise(value: string): string {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) throw new Error('Enter a valid INR amount with up to two decimal places');
  const [whole, fraction = ''] = normalized.split('.');
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  if (paise <= 0n) throw new Error('Amount must be greater than ₹0.00');
  return paise.toString();
}

export function paiseToRupees(paise: string): string {
  return (BigInt(paise) / 100n).toString() + '.' + (BigInt(paise) % 100n).toString().padStart(2, '0');
}
