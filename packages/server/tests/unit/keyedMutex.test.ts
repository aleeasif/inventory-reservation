import { describe, expect, it } from 'vitest';
import { LockTimeoutError } from '../../src/domain/errors.js';
import { KeyedMutex } from '../../src/infrastructure/keyedMutex.js';

// The acquire timeout is a bound on *queueing*, so throughput tests need a
// generous one: 200 queued waiters legitimately wait a long time, and a tight
// timeout would make this suite fail on a loaded machine rather than on a bug.
// The timeout behaviour itself is exercised explicitly with `mutex(20)` below.
const mutex = (acquireTimeoutMs = 30_000): KeyedMutex => new KeyedMutex({ acquireTimeoutMs });

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe('KeyedMutex', () => {
  it('never runs two critical sections for the same key at once', async () => {
    const lock = mutex();
    let inside = 0;
    let maxInside = 0;

    await Promise.all(
      Array.from({ length: 50 }, () =>
        lock.withLock('product:x', async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await delay(0);
          inside -= 1;
        }),
      ),
    );

    expect(maxInside).toBe(1);
  });

  it('serialises a read-modify-write that would otherwise interleave', async () => {
    const lock = mutex();
    let counter = 0;

    await Promise.all(
      Array.from({ length: 200 }, () =>
        lock.withLock('product:x', async () => {
          const seen = counter;
          await delay(0);
          counter = seen + 1;
        }),
      ),
    );

    expect(counter).toBe(200);
  });

  it('serves waiters first-in-first-out, so no caller is starved', async () => {
    const lock = mutex();
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        lock.withLock('product:x', async () => {
          order.push(index);
          await delay(0);
        }),
      ),
    );

    expect(order).toEqual(Array.from({ length: 20 }, (_unused, index) => index));
  });

  it('lets different keys proceed in parallel', async () => {
    const lock = mutex();
    let concurrent = 0;
    let maxConcurrent = 0;

    await Promise.all(
      ['a', 'b', 'c', 'd'].map((key) =>
        lock.withLock(key, async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await delay(5);
          concurrent -= 1;
        }),
      ),
    );

    expect(maxConcurrent).toBe(4);
  });

  it('releases the lock when the critical section throws', async () => {
    const lock = mutex();

    await expect(
      lock.withLock('product:x', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    await expect(lock.withLock('product:x', () => Promise.resolve('recovered'))).resolves.toBe(
      'recovered',
    );
  });

  it('forgets a key once nobody holds it, so memory does not grow per product', async () => {
    const lock = mutex();
    await lock.withLock('product:x', () => Promise.resolve());
    expect(lock.activeKeys).toBe(0);
  });

  it('fails fast and transiently when a holder monopolises a key', async () => {
    const lock = mutex(20);
    let releaseHolder = (): void => undefined;
    const holder = lock.withLock('product:x', async () => {
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
    });

    const waiter = lock.withLock('product:x', () => Promise.resolve('never runs'));
    await expect(waiter).rejects.toBeInstanceOf(LockTimeoutError);
    await expect(waiter).rejects.toMatchObject({ classification: 'transient', httpStatus: 503 });

    releaseHolder();
    await holder;
  });

  it('keeps the queue moving after a waiter times out', async () => {
    const lock = mutex(20);
    let releaseHolder = (): void => undefined;
    const holder = lock.withLock('product:x', async () => {
      await new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
    });

    await expect(lock.withLock('product:x', () => Promise.resolve())).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    releaseHolder();
    await holder;

    await expect(lock.withLock('product:x', () => Promise.resolve('ok'))).resolves.toBe('ok');
  });
});
