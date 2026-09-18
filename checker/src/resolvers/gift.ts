/**
 * Gift (t.me/nft/<name>) resolution.
 * A gift name has no deterministic on-chain mapping (the name lives in
 * off-chain metadata), so the reliable path is the holder's wallet:
 * enumerate the seller's NFTs via TonAPI and match metadata name (+number).
 * Ownership itself is ALWAYS re-read from the item contract afterwards.
 * (t.me page scraping and the GetGems REST surface are unreachable from
 * here — both were probed and return empty/403.)
 */
import { config } from '../config';
import logger from '../logger';
import { fetchNftMetadataName, getNftData, getNftsByOwner, toRaw } from '../ton';

export interface GiftResolution {
  name: string;
  number: string | null;
  itemAddress: string | null;
  ownerWallet: string | null;
  collection: string | null;
  index: string | null;
  source: 'owner-enumeration' | 'none';
  reason?: string;
  /** Diagnostics: how many wallet NFTs were scanned + sample metadata names. */
  scanned?: number;
  sampleNames?: string[];
}

/** "PlushPepe-2172" / "Plush Pepe #2172" / "PlushPepe 2172" -> {name, number}. */
export function splitNameNumber(input: string): { name: string; number: string | null } {
  const s = String(input || '').trim();
  const m = s.match(/^(.*?)[\s\-_]*#?(\d+)\s*$/);
  if (m && m[1].trim() !== '') return { name: m[1].trim(), number: m[2] };
  return { name: s, number: null };
}

function normalize(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_#№]+/g, '');
}

/**
 * Strip CR/LF (and truncate) before interpolating user-controlled values
 * into log lines — prevents log-injection (forged multi-line entries).
 */
function sanitizeLogToken(value: unknown, maxLen = 120): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, maxLen);
}

/** TonAPI item metadata name, with fallback to the item content cell. */
async function displayName(itemAddress: string, tonapiName?: string | null): Promise<string | null> {
  if (tonapiName) return tonapiName;
  return fetchNftMetadataName(itemAddress);
}

function metadataMatches(metaName: string | null, giftName: string, number: string | null): boolean {
  if (!metaName) return false;
  const m = normalize(metaName);
  if (!m.includes(normalize(giftName))) return false;
  if (number && !m.includes(normalize(number))) return false;
  return true;
}

export async function resolveGift(
  name: string,
  number?: string | null,
  sellerWallet?: string | null,
): Promise<GiftResolution> {
  const split = splitNameNumber(name);
  const giftName = split.name;
  const num = number != null && String(number).trim() !== '' ? String(number).trim() : split.number;
  const base: GiftResolution = {
    name: giftName,
    number: num,
    itemAddress: null,
    ownerWallet: null,
    collection: null,
    index: null,
    source: 'none',
  };
  if (!giftName) return { ...base, reason: 'empty_name' };
  if (!sellerWallet) {
    return { ...base, reason: 'seller_wallet_required' };
  }
  let sellerRaw: string;
  try {
    sellerRaw = toRaw(sellerWallet);
  } catch {
    return { ...base, reason: 'seller_wallet_invalid' };
  }

  // Enumerate the seller's NFTs and match by metadata name (+number).
  let items;
  try {
    items = await getNftsByOwner(sellerRaw);
  } catch (err) {
    logger.warn(`gift ${sanitizeLogToken(giftName)}: owner enumeration failed`, err);
    return { ...base, reason: 'enumeration_failed_check_TONAPI_KEY' };
  }
  logger.info(`gift ${sanitizeLogToken(giftName)}: scanning ${items.length} NFT(s) of seller`);
  const sampleNames: string[] = [];
  for (const it of items) {
    try {
      const metaName = await displayName(it.address, it.metadata?.name);
      if (metaName && sampleNames.length < 10 && !sampleNames.includes(metaName)) {
        sampleNames.push(metaName);
      }
      if (!metadataMatches(metaName, giftName, num)) continue;
      const nft = await getNftData(it.address);
      if (!nft.init) continue;
      return {
        ...base,
        itemAddress: nft.itemAddress,
        ownerWallet: nft.owner,
        collection: nft.collection,
        index: nft.index,
        source: 'owner-enumeration',
        scanned: items.length,
        sampleNames,
      };
    } catch (err) {
      logger.warn(`gift ${sanitizeLogToken(giftName)}: candidate rejected`, err);
    }
  }
  return { ...base, reason: 'gift_not_found_in_seller_wallet', scanned: items.length, sampleNames };
}

export interface BotGiftHit {
  found: boolean;
  isUnique: boolean;
  isFromBlockchain: boolean;
  giftId: string | null;
  number: number | null;
}

function timeoutSignal(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/** Bot API binding: is this gift owned/hosted by the Telegram user? */
export async function findGiftInUserGifts(
  userId: number,
  giftName: string,
  number?: string | null,
): Promise<BotGiftHit> {
  const miss: BotGiftHit = { found: false, isUnique: false, isFromBlockchain: false, giftId: null, number: null };
  if (!config.botToken) return miss;
  try {
    let offset = '';
    for (let page = 0; page < 10; page++) {
      const body = new URLSearchParams({
        user_id: String(userId),
        limit: '100',
        ...(offset ? { offset } : {}),
      });
      const { signal, done } = timeoutSignal(config.requestTimeoutMs);
      let data: any;
      try {
        const r = await fetch(`https://api.telegram.org/bot${config.botToken}/getUserGifts`, {
          method: 'POST',
          body,
          signal,
        });
        data = await r.json();
      } finally {
        done();
      }
      const gifts = data?.result?.gifts;
      if (!Array.isArray(gifts) || gifts.length === 0) break;
      for (const g of gifts) {
        const u = g?.unique;
        if (!u) continue; // regular (non-unique) gifts carry no stable identity
        const nm = String(u.name || '');
        const nb = u.number != null ? Number(u.number) : null;
        const wantNum = number != null && String(number).trim() !== '' ? Number(number) : null;
        if (nm.toLowerCase() === String(giftName).toLowerCase() && (wantNum == null || nb === wantNum)) {
          return {
            found: true,
            isUnique: true,
            isFromBlockchain: u.is_from_blockchain === true,
            giftId: u.gift_id != null ? String(u.gift_id) : null,
            number: nb,
          };
        }
      }
      offset = String(data?.result?.next_offset || '');
      if (!offset) break;
    }
  } catch (err) {
    logger.warn(`getUserGifts failed for ${userId}`, err);
  }
  return miss;
}
