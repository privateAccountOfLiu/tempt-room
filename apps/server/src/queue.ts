export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: { resolve: (v: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  private closed = false;
  private error?: unknown;
  push(value: T) { if (this.closed) return; const waiter = this.waiting.shift(); if (waiter) waiter.resolve({ value, done: false }); else { if (this.items.length > 10000) { this.end(new Error('Output queue exceeded limit')); return; } this.items.push(value); } }
  end(error?: unknown) { this.closed = true; this.error = error; for (const waiter of this.waiting.splice(0)) error ? waiter.reject(error) : waiter.resolve({ value: undefined as T, done: true }); }
  [Symbol.asyncIterator]() { return { next: (): Promise<IteratorResult<T>> => { if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false }); if (this.closed) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined as T, done: true }); return new Promise((resolve, reject) => this.waiting.push({ resolve, reject })); } }; }
}
