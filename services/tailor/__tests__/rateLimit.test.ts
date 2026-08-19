import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../../scrape/ddb.js', () => ({
  doc: { send: (...a: unknown[]) => send(...a) },
  TABLE: 'test-table',
}));

const {
  reserve,
  consume,
  release,
  getQuota,
  dayKey,
  resetsAt,
  RateLimitedError,
  DAILY_LIMIT,
} = await import('../rateLimit.js');

const conditionalFailure = () =>
  Object.assign(new Error('conditional failed'), {
    name: 'ConditionalCheckFailedException',
  });

const NOW = Date.UTC(2026, 7, 18, 15, 30, 0);

describe('day boundaries', () => {
  it('keys buckets by UTC day', () => {
    expect(dayKey(NOW)).toBe('2026-08-18');
  });

  it('rolls over at UTC midnight, not local midnight', () => {
    // The pre-migration Firestore limiter reset at UTC midnight; changing that
    // would silently move every user's reset time.
    expect(dayKey(Date.UTC(2026, 7, 18, 23, 59, 59))).toBe('2026-08-18');
    expect(dayKey(Date.UTC(2026, 7, 19, 0, 0, 0))).toBe('2026-08-19');
  });

  it('reports the next UTC midnight as the reset time', () => {
    expect(resetsAt(NOW)).toBe(Date.UTC(2026, 7, 19) / 1000);
  });
});

describe('reserve', () => {
  beforeEach(() => vi.clearAllMocks());

  it('increments reserved under a conditional write', async () => {
    send.mockResolvedValue({});
    await reserve('user-1', NOW);

    const input = send.mock.calls[0][0].input;
    expect(input.Key).toEqual({ PK: 'RATE#user-1', SK: 'DAY#2026-08-18' });
    expect(input.UpdateExpression).toContain('#reserved');
    expect(input.ConditionExpression).toContain(':limit');
  });

  it('counts consumed and reserved together against the limit', async () => {
    // A user with 4 consumed and 1 in flight is at the limit even though
    // neither counter alone has reached it. That total is maintained as
    // `claimed` and incremented alongside `reserved`.
    send.mockResolvedValue({});
    await reserve('user-1', NOW);

    const input = send.mock.calls[0][0].input;
    expect(input.UpdateExpression).toMatch(/#claimed = if_not_exists\(#claimed, :zero\) \+ :one/);
    expect(input.ConditionExpression).toContain('#claimed');
  });

  it('uses only condition-expression-legal syntax', async () => {
    // ConditionExpressions are much more restricted than UpdateExpressions, and
    // both limits below broke real calls while string-matching unit tests
    // passed:
    //   - arithmetic  -> "Syntax error; token: \"+\""
    //   - if_not_exists -> "The function is not allowed in a condition expression"
    // Only a live call catches these, hence this guard.
    send.mockResolvedValue({});
    await reserve('user-1', NOW);

    const cond = send.mock.calls[0][0].input.ConditionExpression;
    expect(cond).not.toContain('+');
    expect(cond).not.toContain('if_not_exists');
  });

  it('sets a TTL so the bucket disappears after the day ends', async () => {
    send.mockResolvedValue({});
    await reserve('user-1', NOW);
    expect(send.mock.calls[0][0].input.ExpressionAttributeValues[':ttl']).toBe(
      Date.UTC(2026, 7, 19) / 1000,
    );
  });

  it('throws RateLimitedError when the bucket is full', async () => {
    send
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { consumed: 5, reserved: 0 } });

    await expect(reserve('user-1', NOW)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('reports usage and reset time on rejection', async () => {
    send
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({ Item: { consumed: 3, reserved: 2 } });

    try {
      await reserve('user-1', NOW);
      expect.unreachable();
    } catch (err) {
      const e = err as InstanceType<typeof RateLimitedError>;
      expect(e.used).toBe(5);
      expect(e.limit).toBe(DAILY_LIMIT);
      expect(e.resets).toBe(Date.UTC(2026, 7, 19) / 1000);
    }
  });

  it('propagates unexpected errors rather than masking them as rate limits', async () => {
    send.mockRejectedValue(new Error('throughput exceeded'));
    await expect(reserve('user-1', NOW)).rejects.toThrow('throughput exceeded');
  });
});

describe('consume', () => {
  beforeEach(() => vi.clearAllMocks());

  it('moves a reservation into consumed', async () => {
    send.mockResolvedValue({});
    await consume('user-1', NOW);

    const expr = send.mock.calls[0][0].input.UpdateExpression;
    expect(expr).toContain('#consumed');
    expect(expr).toContain('#reserved - :one');
  });

  it('requires an outstanding reservation', async () => {
    // Guards against a redelivered message double-charging.
    send.mockResolvedValue({});
    await consume('user-1', NOW);
    expect(send.mock.calls[0][0].input.ConditionExpression).toContain('#reserved > :zero');
  });

  it('leaves the claimed slot in place', async () => {
    // Unlike release(), a consumed slot really was spent and must keep counting
    // against the daily limit.
    send.mockResolvedValue({});
    await consume('user-1', NOW);
    expect(send.mock.calls[0][0].input.UpdateExpression).not.toContain('#claimed');
  });

  it('is a no-op when no reservation is held', async () => {
    send.mockRejectedValue(conditionalFailure());
    await expect(consume('user-1', NOW)).resolves.toBeUndefined();
  });
});

describe('release', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the reservation without touching consumed', async () => {
    // The core of charging on completion: a failed job costs the user nothing.
    send.mockResolvedValue({});
    await release('user-1', NOW);

    const expr = send.mock.calls[0][0].input.UpdateExpression;
    expect(expr).toContain('#reserved - :one');
    expect(expr).not.toContain('consumed');
  });

  it('frees the slot against the daily limit', async () => {
    // `claimed` must drop too, or a released slot stays permanently counted and
    // the user silently loses quota for the rest of the day.
    send.mockResolvedValue({});
    await release('user-1', NOW);
    expect(send.mock.calls[0][0].input.UpdateExpression).toContain('#claimed - :one');
  });

  it('cannot drive reserved negative', async () => {
    // Releasing twice would otherwise hand the user free quota.
    send.mockResolvedValue({});
    await release('user-1', NOW);
    expect(send.mock.calls[0][0].input.ConditionExpression).toContain('#reserved > :zero');
  });

  it('is a no-op when nothing is reserved', async () => {
    send.mockRejectedValue(conditionalFailure());
    await expect(release('user-1', NOW)).resolves.toBeUndefined();
  });
});

describe('getQuota', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports zero for a user with no bucket yet', async () => {
    send.mockResolvedValue({});
    expect(await getQuota('new-user', NOW)).toEqual({
      used: 0,
      reserved: 0,
      limit: DAILY_LIMIT,
      resetsAt: Date.UTC(2026, 7, 19) / 1000,
    });
  });

  it('reports consumed as the user-facing count, separate from in-flight', async () => {
    send.mockResolvedValue({ Item: { consumed: 2, reserved: 1 } });
    const quota = await getQuota('user-1', NOW);
    expect(quota.used).toBe(2);
    expect(quota.reserved).toBe(1);
  });
});
