export type ErrorCategory = 'transient' | 'conflict' | 'budget' | 'permanent';

export function classifyError(error: unknown): ErrorCategory {
  const msg = (error as Error)?.message ?? '';
  const status =
    (error as any)?.status ??
    (error as any)?.response?.status ??
    (error as any)?.statusCode;

  // Rate limits, network issues
  if (status === 429 || status === 502 || status === 503 || status === 504) return 'transient';
  if (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('socket hang up')
  )
    return 'transient';

  // Merge conflicts
  if (msg.toLowerCase().includes('merge conflict') || msg.includes('CONFLICT')) return 'conflict';

  // Budget/turn limits
  if (msg.includes('budget') || msg.includes('max_turns') || msg.includes('Budget exceeded'))
    return 'budget';

  return 'permanent';
}
