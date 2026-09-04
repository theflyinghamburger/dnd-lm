/**
 * Per-connection rate limit (M2.5). Rejections are surfaced as a typed error
 * event by the caller — a silent drop looks like packet loss to the player and
 * is indistinguishable from a bug.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefill = now;
  }

  take(now: number = Date.now()): boolean {
    const elapsedSeconds = Math.max(now - this.lastRefill, 0) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefill = now;

    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
