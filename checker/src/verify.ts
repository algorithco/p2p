/**
 * Verdict logic. One rule everywhere: ownership is proven ONLY by a fresh
 * on-chain read (get_nft_data) or, for off-chain state, by the Bot API.
 * Indexed hints, page scrapes and metadata are resolution aids, never proof.
 */
import { getNftData, sameAddress, toFriendly } from './ton';
import type { UsernameResolution } from './resolvers/username';
import type { GiftResolution, BotGiftHit } from './resolvers/gift';

export type Verdict =
  | 'verified'
  | 'wrong_owner'
  | 'not_nft'
  | 'not_tokenized'
  | 'offchain_only'
  | 'unresolved'
  | 'not_delivered'
  | 'collection_mismatch'
  | 'uninitialized';

export interface CheckResult {
  verdict: Verdict;
  reason?: string;
  itemAddress: string | null;
  itemAddressFriendly: string | null;
  ownerWallet: string | null;
  ownerWalletFriendly: string | null;
  expectedOwner: string | null;
  collection: string | null;
  proof: 'onchain' | 'bot_api' | 'none';
  checkedAt: string;
  /** Diagnostics (gift enumeration): scanned count + sample metadata names. */
  scanned?: number;
  sampleNames?: string[];
}

export function friendly(addr: string | null): string | null {
  if (!addr) return null;
  try {
    return toFriendly(addr);
  } catch {
    return null;
  }
}

function base(proof: CheckResult['proof']): Omit<CheckResult, 'verdict' | 'reason'> & { reason?: string } {
  return {
    itemAddress: null,
    itemAddressFriendly: null,
    ownerWallet: null,
    ownerWalletFriendly: null,
    expectedOwner: null,
    collection: null,
    proof,
    checkedAt: new Date().toISOString(),
  };
}

export function ownerMatches(actual: string | null, expected: string | null | undefined): boolean {
  if (!expected) return true; // no expectation set -> nothing to contradict
  if (!actual) return false;
  try {
    return sameAddress(actual, expected);
  } catch {
    return false;
  }
}

export function checkUsername(
  res: UsernameResolution,
  expected: { wallet?: string | null; collectionAllowlist?: string[] } = {},
): CheckResult {
  const b = base('onchain');
  b.itemAddress = res.itemAddress;
  b.itemAddressFriendly = friendly(res.itemAddress);
  b.ownerWallet = res.ownerWallet;
  b.ownerWalletFriendly = friendly(res.ownerWallet);
  b.collection = res.collection;
  b.expectedOwner = expected.wallet || null;
  if (!res.tokenized) return { ...b, verdict: 'not_tokenized', reason: res.reason || 'no_onchain_record' };
  if (!res.ownerWallet) return { ...b, verdict: 'unresolved', reason: 'owner_unreadable' };
  if (!res.collection) return { ...b, verdict: 'collection_mismatch', reason: 'collection_unknown' };
  const allowed = [res.resolver, ...(expected.collectionAllowlist || [])].filter(Boolean) as string[];
  const inCollection = allowed.some((a) => {
    try {
      return sameAddress(res.collection as string, a);
    } catch {
      return false;
    }
  });
  if (!inCollection) return { ...b, verdict: 'collection_mismatch', reason: 'item_outside_tme_collection' };
  if (!ownerMatches(res.ownerWallet, expected.wallet || null)) {
    return { ...b, verdict: 'wrong_owner', reason: 'owner_differs_from_expected' };
  }
  return { ...b, verdict: 'verified' };
}

export function checkGift(
  res: GiftResolution,
  botHit: BotGiftHit | null,
  expected: { wallet?: string | null } = {},
): CheckResult {
  const b = base(res.itemAddress ? 'onchain' : 'none');
  b.itemAddress = res.itemAddress;
  b.itemAddressFriendly = friendly(res.itemAddress);
  b.ownerWallet = res.ownerWallet;
  b.ownerWalletFriendly = friendly(res.ownerWallet);
  b.collection = res.collection;
  b.expectedOwner = expected.wallet || null;
  if (res.scanned != null) b.scanned = res.scanned;
  if (res.sampleNames) b.sampleNames = res.sampleNames;
  if (!res.itemAddress || !res.ownerWallet) {
    // Off-chain fallback: Bot API sees it on the user's profile.
    if (botHit && botHit.found && !botHit.isFromBlockchain) {
      return { ...b, proof: 'bot_api', verdict: 'verified', reason: 'offchain_profile_gift' };
    }
    return { ...b, verdict: 'unresolved', reason: res.reason || 'gift_address_unknown' };
  }
  if (!ownerMatches(res.ownerWallet, expected.wallet || null)) {
    return { ...b, verdict: 'wrong_owner', reason: 'owner_differs_from_expected' };
  }
  return { ...b, verdict: 'verified' };
}

/** Post-trade assert: is the item now with the buyer? */
export async function checkDelivery(
  itemAddress: string,
  buyerWallet: string,
  sellerWallet?: string | null,
): Promise<CheckResult & { sellerStillHolds?: boolean }> {
  const b = base('onchain');
  b.itemAddress = itemAddress;
  b.itemAddressFriendly = friendly(itemAddress);
  b.expectedOwner = buyerWallet;
  const nft = await getNftData(itemAddress);
  b.ownerWallet = nft.owner;
  b.ownerWalletFriendly = friendly(nft.owner);
  b.collection = nft.collection;
  if (!nft.init) return { ...b, verdict: 'uninitialized' };
  if (!ownerMatches(nft.owner, buyerWallet)) {
    return {
      ...b,
      verdict: 'not_delivered',
      reason: 'buyer_does_not_hold_item',
      sellerStillHolds: sellerWallet ? ownerMatches(nft.owner, sellerWallet) : undefined,
    };
  }
  return { ...b, verdict: 'verified' };
}
