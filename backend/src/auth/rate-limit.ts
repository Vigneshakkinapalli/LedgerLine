interface AttemptRecord { count: number; resetAt: number; }

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, AttemptRecord>();

export function loginRateLimitKey(ip: string, email: string): string {
  return `${ip}:${email.trim().toLowerCase()}`;
}

export function isLoginRateLimited(key: string): boolean {
  const current = attempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    attempts.delete(key);
    return false;
  }
  return current.count >= MAX_ATTEMPTS;
}

export function recordLoginFailure(key: string): void {
  const current = attempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    attempts.set(key, { count: 1, resetAt: Date.now() + WINDOW_MS });
    return;
  }
  current.count += 1;
}

export function clearLoginFailures(key: string): void {
  attempts.delete(key);
}

export function resetLoginRateLimitForTests(): void {
  attempts.clear();
}
