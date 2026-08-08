// Retry logic with exponential backoff for transient failures
interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  timeoutMs: 10000,
  onRetry: () => {},
};

class RetryableError extends Error {
  constructor(public status?: number, message?: string) {
    super(message || `HTTP ${status}`);
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();

  // Check common retry patterns
  if (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up')
  ) {
    return true;
  }

  // Check RetryableError status codes
  if (error instanceof RetryableError) {
    return (
      error.status !== undefined && (error.status >= 500 || error.status === 429)
    );
  }

  return false;
}

export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);

    try {
      return await fn(controller.signal);
    } catch (error) {
      clearTimeout(timeoutId);

      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if aborted (timeout)
      if (controller.signal.aborted) {
        lastError = new Error(`Request timeout after ${opts.timeoutMs}ms`);
      }

      // Check if retryable
      if (!isRetryableError(lastError) || attempt === opts.maxRetries) {
        throw lastError;
      }

      // Full jitter backoff: random(0, min(initialDelayMs * 2^attempt, maxDelayMs))
      const cap = Math.min(
        opts.initialDelayMs * Math.pow(2, attempt),
        opts.maxDelayMs
      );
      const delayMs = Math.random() * cap;

      opts.onRetry(attempt + 1, lastError);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError || new Error('Retry exhausted');
}

export async function fetchWithRetry(
  url: string,
  options?: RetryOptions & RequestInit
): Promise<Response> {
  const retryOpts = {
    maxRetries: options?.maxRetries ?? 3,
    initialDelayMs: options?.initialDelayMs ?? 1000,
    maxDelayMs: options?.maxDelayMs ?? 10000,
    timeoutMs: options?.timeoutMs ?? 10000,
    onRetry: options?.onRetry,
  };

  const fetchOpts = Object.fromEntries(
    Object.entries(options || {}).filter(
      ([key]) => !['maxRetries', 'initialDelayMs', 'maxDelayMs', 'timeoutMs', 'onRetry'].includes(key)
    )
  );

  return withRetry(async () => {
    // Allow explicit cache control, but don't force no-store by default to support ISR
    const res = await fetch(url, fetchOpts);
    // Throw on 5xx or 429; 4xx (except 429) fails fast
    if (res.status >= 500 || res.status === 429) {
      const retryErr = new RetryableError(res.status, `HTTP ${res.status}`);
      if (res.status === 429 && res.headers.get('Retry-After')) {
        const retryAfter = res.headers.get('Retry-After');
        retryErr.message = `HTTP 429 Retry-After: ${retryAfter}`;
      }
      throw retryErr;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  }, retryOpts);
}
