// Rate limiting for HTTP requests with per-host and global limits
interface RateLimitConfig {
  maxConcurrentGlobal?: number;
  maxConcurrentPerHost?: number;
  minDelayBetweenRequestsMs?: number;
  maxQueueSize?: number;
}

interface PendingRequest<T> {
  url: string;
  host: string;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

class RateLimiter {
  private config: Required<RateLimitConfig>;
  private activeRequests: Map<string, number> = new Map(); // host -> count
  private lastRequestTime: Map<string, number> = new Map(); // host -> ms
  private globalActive = 0;
  private queue: PendingRequest<any>[] = [];
  private processing = false;

  constructor(config: RateLimitConfig = {}) {
    this.config = {
      maxConcurrentGlobal: config.maxConcurrentGlobal ?? 30,
      maxConcurrentPerHost: config.maxConcurrentPerHost ?? 10,
      minDelayBetweenRequestsMs: config.minDelayBetweenRequestsMs ?? 100,
      maxQueueSize: config.maxQueueSize ?? 1000,
    };
  }

  private getHost(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'unknown';
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const canProcessMore =
        this.globalActive < this.config.maxConcurrentGlobal &&
        this.queue.length > 0;

      if (!canProcessMore) {
        this.processing = false;
        return;
      }

      const pending = this.queue.shift();
      if (!pending) break;

      // Check per-host limits
      const hostCount = this.activeRequests.get(pending.host) ?? 0;
      if (hostCount >= this.config.maxConcurrentPerHost) {
        this.queue.unshift(pending); // Re-queue
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }

      // Check per-host delay
      const lastTime = this.lastRequestTime.get(pending.host) ?? 0;
      const timeSinceLastRequest = Date.now() - lastTime;
      if (timeSinceLastRequest < this.config.minDelayBetweenRequestsMs) {
        const waitTime = this.config.minDelayBetweenRequestsMs - timeSinceLastRequest;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }

      // Execute request
      this.globalActive++;
      const newHostCount = (hostCount ?? 0) + 1;
      this.activeRequests.set(pending.host, newHostCount);
      this.lastRequestTime.set(pending.host, Date.now());

      pending
        .fn()
        .then(pending.resolve)
        .catch(pending.reject)
        .finally(() => {
          this.globalActive--;
          const current = this.activeRequests.get(pending.host) ?? 1;
          if (current <= 1) {
            this.activeRequests.delete(pending.host);
          } else {
            this.activeRequests.set(pending.host, current - 1);
          }
          this.processQueue();
        });
    }

    this.processing = false;
  }

  async execute<T>(url: string, fn: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.config.maxQueueSize) {
      throw new Error('Rate limiter queue full');
    }

    return new Promise<T>((resolve, reject) => {
      const host = this.getHost(url);
      this.queue.push({ url, host, fn, resolve, reject });
      this.processQueue();
    });
  }

  getStats() {
    return {
      globalActive: this.globalActive,
      queueLength: this.queue.length,
      activeHosts: Array.from(this.activeRequests.entries()).map(([host, count]) => ({
        host,
        activeCount: count,
      })),
    };
  }
}

// Singleton instance
let limiter: RateLimiter;

export function initRateLimiter(config?: RateLimitConfig): RateLimiter {
  limiter = new RateLimiter(config);
  return limiter;
}

export function getRateLimiter(): RateLimiter {
  if (!limiter) {
    limiter = new RateLimiter();
  }
  return limiter;
}

export async function rateLimitedFetch<T>(
  url: string,
  fn: () => Promise<T>
): Promise<T> {
  return getRateLimiter().execute(url, fn);
}

// Note: The singleton RateLimiter is per-process and does not hold across serverless
// instances. Rate limits are meaningful only in the cron/refresh path where multiple
// concurrent sources run in the same process.
