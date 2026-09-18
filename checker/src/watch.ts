/**
 * Transfer watch (stateless long-poll): wait until the item owner becomes
 * the expected wallet, or time out. No background jobs, no DB — the caller
 * polls this endpoint again for longer waits.
 */
import { getNftData, toFriendly, toRaw } from './ton';

export interface WatchResult {
  reached: boolean;
  itemAddress: string;
  expectOwner: string;
  owner: string | null;
  ownerFriendly: string | null;
  polls: number;
  elapsedMs: number;
  seenOwners: string[];
  timedOut: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function watchOwner(
  itemAddress: string,
  expectOwnerRaw: string,
  timeoutSec = 120,
  intervalMs = 10000,
): Promise<WatchResult> {
  const timeoutMs = Math.min(Math.max(Number(timeoutSec) || 120, 10), 600) * 1000;
  const step = Math.min(Math.max(Number(intervalMs) || 10000, 3000), 30000);
  const t0 = Date.now();
  const seen: string[] = [];
  let polls = 0;
  let owner: string | null = null;

  const expectRaw = toRaw(expectOwnerRaw);

  function fin(reached: boolean, timedOut: boolean): WatchResult {
    let ownerFriendly: string | null = null;
    try {
      ownerFriendly = owner ? toFriendly(owner) : null;
    } catch {
      ownerFriendly = null;
    }
    return {
      reached,
      itemAddress,
      expectOwner: expectRaw,
      owner,
      ownerFriendly,
      polls,
      elapsedMs: Date.now() - t0,
      seenOwners: seen,
      timedOut,
    };
  }

  while (Date.now() - t0 < timeoutMs) {
    polls++;
    try {
      const nft = await getNftData(itemAddress);
      owner = nft.owner;
      if (owner && !seen.includes(owner)) seen.push(owner);
      if (owner === expectRaw) return fin(true, false);
    } catch {
      // Transient RPC failure — keep waiting until the deadline.
    }
    if (Date.now() - t0 < timeoutMs) await sleep(step);
  }
  return fin(false, true);
}
