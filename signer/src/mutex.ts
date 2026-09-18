// AGPL-3.0 — tiny promise-chain mutex serializing wallet seqno usage.
// A TON wallet consumes exactly one seqno per transfer: two concurrent
// sendTransfer calls read the SAME seqno and one is rejected on-chain (funds
// never move twice, but the caller gets an ambiguous failure). Serializing all
// signing ops also closes the idempotency check→send→store TOCTOU window for
// identical keys arriving concurrently.

export interface Mutex {
  run<T>(fn: () => Promise<T>): T | Promise<T>;
  getActive(): number;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

export function createMutex(): Mutex {
  let chain: Promise<void> = Promise.resolve();
  let active = 0;

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = chain;
    let release!: () => void;
    // `chain` below only ever resolves (release takes no value), so `prev`
    // never rejects and `await prev` cannot throw.
    chain = new Promise<void>((res) => {
      release = res;
    });
    await prev;
    active++;
    try {
      return await fn();
    } finally {
      active--;
      release();
    }
  }

  return {
    run,
    getActive: () => active,
    waitForIdle: async (timeoutMs: number): Promise<boolean> => {
      const start = Date.now();
      while (active > 0 && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return active === 0;
    },
  };
}
