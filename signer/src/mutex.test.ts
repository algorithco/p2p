// AGPL-3.0 — send-mutex tests (seqno serialization guarantee).
import { describe, it, expect } from 'vitest';
import { createMutex } from './mutex';

describe('createMutex', () => {
  it('serializes concurrent runs (no overlap)', async () => {
    const m = createMutex();
    let inside = 0;
    let maxInside = 0;
    const job = async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 20));
      inside--;
      return 1;
    };
    await Promise.all([m.run(job), m.run(job), m.run(job)]);
    expect(maxInside).toBe(1);
  });

  it('propagates errors and keeps the chain usable', async () => {
    const m = createMutex();
    await expect(m.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await m.run(async () => 42)).toBe(42);
    expect(m.getActive()).toBe(0);
  });

  it('waitForIdle resolves true/false correctly', async () => {
    const m = createMutex();
    expect(await m.waitForIdle(100)).toBe(true);
    const gate = m.run(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    // Let the job pass `await prev` and set active=1 (microtask turn).
    await new Promise((r) => setTimeout(r, 10));
    expect(m.getActive()).toBe(1);
    expect(await m.waitForIdle(50)).toBe(false);
    await gate;
    expect(await m.waitForIdle(1000)).toBe(true);
  });
});
