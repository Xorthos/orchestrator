export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableCheck?: (error: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    retryableCheck = isTransientError,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts || !retryableCheck(error)) throw error;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = delay * (0.5 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, jitter));
    }
  }

  throw new Error('Unreachable');
}

export function isTransientError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const status =
      (error as any).status ??
      (error as any).response?.status ??
      (error as any).statusCode;
    if (status === 429 || status === 502 || status === 503 || status === 504) return true;

    const msg = (error as Error).message ?? '';
    if (
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('socket hang up') ||
      msg.includes('network')
    )
      return true;
  }
  return false;
}
