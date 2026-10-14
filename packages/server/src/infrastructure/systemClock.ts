import type { Clock } from '../application/ports.js';

/** The real clock. The only place in the server that reads wall time. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * A clock the tests drive by hand, so expiry can be verified in microseconds
 * instead of two real minutes and without flakiness.
 */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    this.current = start;
  }

  now(): Date {
    return this.current;
  }

  advanceBy(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }

  set(instant: Date): void {
    this.current = instant;
  }
}
