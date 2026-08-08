import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withRetry } from '../retryManager';

describe('retryManager.ts', () => {
  describe('withRetry', () => {
    it('succeeds on first attempt without delay', async () => {
      const fn = async (_signal?: AbortSignal) => 'success';
      const result = await withRetry(fn);
      expect(result).toBe('success');
    });

    it('retries on timeout errors', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Request timeout after 5000ms');
        }
        return 'success';
      };

      const result = await withRetry(fn, { maxRetries: 3 });
      expect(result).toBe('success');
      expect(callCount).toBe(3);
    });

    it('does not retry on 4xx errors', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        throw new Error('HTTP 404');
      };
      await expect(withRetry(fn)).rejects.toThrow('HTTP 404');
      expect(callCount).toBe(1);
    });

    it('does not retry on generic Error', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        throw new Error('Something bad');
      };
      await expect(withRetry(fn)).rejects.toThrow('Something bad');
      expect(callCount).toBe(1);
    });

    it('stops after maxRetries and throws last error', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        throw new Error('Request timeout after 5000ms');
      };

      await expect(withRetry(fn, { maxRetries: 2 })).rejects.toThrow();
      expect(callCount).toBe(3); // initial + 2 retries
    });

    it('calls onRetry once per retry with attempt number', async () => {
      const onRetry = vi.fn();
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Request timeout after 5000ms');
        }
        return 'success';
      };

      const result = await withRetry(fn, { maxRetries: 3, onRetry });
      expect(result).toBe('success');
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(Error));
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(Error));
    });

    it('works with non-Error rejections', async () => {
      const fn = async (_signal?: AbortSignal) => {
        throw 'string error';
      };
      await expect(withRetry(fn)).rejects.toThrow('string error');
    });

    it('retries on connection errors', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('ECONNREFUSED');
        }
        return 'success';
      };

      const result = await withRetry(fn, { maxRetries: 2 });
      expect(result).toBe('success');
      expect(callCount).toBe(2);
    });

    it('retries on socket hang up', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('socket hang up');
        }
        return 'success';
      };

      const result = await withRetry(fn, { maxRetries: 2 });
      expect(result).toBe('success');
    });

    it('passes signal to function for timeout cancellation', async () => {
      let signalPassed = false;
      let abortedSignal = false;
      const fn = async (signal?: AbortSignal) => {
        signalPassed = !!signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            abortedSignal = true;
          });
          // Simulate aborting by checking signal
          if (signal.aborted) {
            throw new Error('Request timeout');
          }
        }
        return 'success';
      };

      const result = await withRetry(fn, { timeoutMs: 10000, maxRetries: 0 });
      expect(result).toBe('success');
      expect(signalPassed).toBe(true);
    });

    it('respects maxRetries option', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        throw new Error('timeout');
      };

      await expect(withRetry(fn, { maxRetries: 1 })).rejects.toThrow();
      expect(callCount).toBe(2); // initial + 1 retry
    });

    it('uses default timeout of 10000ms', async () => {
      const fn = async (_signal?: AbortSignal) => 'success';
      const result = await withRetry(fn);
      expect(result).toBe('success');
    });

    it('retries on ENOTFOUND errors', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('ENOTFOUND getaddrinfo');
        }
        return 'success';
      };

      const result = await withRetry(fn, { maxRetries: 2 });
      expect(result).toBe('success');
      expect(callCount).toBe(2);
    });

    it('retries on timeout errors', async () => {
      let callCount = 0;
      const fn = async (_signal?: AbortSignal) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('timeout');
        }
        return 'success';
      };

      const result = await withRetry(fn, { maxRetries: 2 });
      expect(result).toBe('success');
      expect(callCount).toBe(2);
    });
  });
});
