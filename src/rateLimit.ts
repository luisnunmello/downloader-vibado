// Simple in-memory brute-force limiter: 10 failures per 15 min per IP.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

const fails = new Map<string, { count: number; since: number }>();

export function isBlocked(ip: string): boolean {
  const f = fails.get(ip);
  if (!f) return false;
  if (Date.now() - f.since > WINDOW_MS) {
    fails.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILS;
}

export function recordFailure(ip: string): void {
  const f = fails.get(ip) ?? { count: 0, since: Date.now() };
  f.count++;
  fails.set(ip, f);
}
