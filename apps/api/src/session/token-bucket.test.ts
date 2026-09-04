import { describe, expect, it } from 'vitest';
import { TokenBucket } from './token-bucket';

describe('TokenBucket', () => {
  it('allows a burst up to capacity then refuses', () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true]);
    expect(bucket.take(0)).toBe(false);
  });

  it('refills over time but never past capacity', () => {
    const bucket = new TokenBucket(3, 1, 0);
    for (let i = 0; i < 3; i += 1) bucket.take(0);

    expect(bucket.take(500)).toBe(false); // half a token
    expect(bucket.take(1000)).toBe(true); // one whole token

    // Idle for a minute: still only three, not sixty.
    expect([bucket.take(61_000), bucket.take(61_000), bucket.take(61_000)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(bucket.take(61_000)).toBe(false);
  });

  it('treats a clock that jumps backwards as no elapsed time', () => {
    const bucket = new TokenBucket(1, 1, 10_000);
    expect(bucket.take(10_000)).toBe(true);
    expect(bucket.take(0)).toBe(false);
  });
});
