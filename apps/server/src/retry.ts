export interface RetryIoOptions {
  attempts?: number;
  delayMs?: number;
  retryable?: (error: any) => boolean;
}

const transientCodes = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

/** Retry Windows filesystem operations that transiently fail while a scanner,
 * installer, or antivirus briefly holds a handle. */
export async function retryIo<T>(operation: () => Promise<T>, options: RetryIoOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 8;
  const delayMs = options.delayMs ?? 40;
  const retryable = options.retryable ?? ((error: any) => transientCodes.has(String(error?.code)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) throw error;
      await new Promise(done => setTimeout(done, delayMs * attempt));
    }
  }
  throw lastError;
}
