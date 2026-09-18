/**
 * Username (.t.me collectible) resolution — pure on-chain, no indexer needed:
 *   root DNS (config#4) -> .t.me resolver -> item -> get_nft_data.
 * A resolver derives an address for ANY name, so only a DEPLOYED item means
 * a real collectible. Ownership is ALWAYS re-read from the item contract.
 */
import { Address } from '@ton/core';
import { config } from '../config';
import logger, { sanitizeLogValue } from '../logger';
import { client, dnsResolve, encodeSubdomain, getNftData, getRootDnsAddress, sameAddress, toRaw } from '../ton';

export interface UsernameResolution {
  username: string;
  tokenized: boolean;
  itemAddress: string | null;
  ownerWallet: string | null;
  collection: string | null;
  index: string | null;
  resolver: string | null;
  source: 'onchain' | 'none';
  reason?: string;
}

const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

async function discoverTmeResolver(): Promise<string> {
  if (config.tmeResolverAddress) return toRaw(config.tmeResolverAddress);
  const root = await getRootDnsAddress();
  // "t.me" reversed labels -> "me\0t\0"
  const r = await dnsResolve(root, encodeSubdomain('t.me'), 0);
  if (r.record.kind !== 'next_resolver' || !r.record.address) {
    throw new Error('tme_resolver_not_found');
  }
  return toRaw(r.record.address);
}

/** Pure on-chain fallback: root -> .t.me resolver -> item address. */
async function resolveItemOnchain(username: string, tmeResolver: string): Promise<string | null> {
  const r = await dnsResolve(tmeResolver, `${username}\0`, 0);
  if (r.record.kind === 'next_resolver' && r.record.address) return toRaw(r.record.address);
  if (r.record.kind === 'smc_address' && r.record.address) return toRaw(r.record.address);
  return null;
}

export async function resolveUsername(rawName: string): Promise<UsernameResolution> {
  const username = String(rawName || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return {
      username,
      tokenized: false,
      itemAddress: null,
      ownerWallet: null,
      collection: null,
      index: null,
      resolver: null,
      source: 'none',
      reason: 'invalid_username',
    };
  }

  // 1) Root DNS -> .t.me (TeleMint) resolver.
  let resolver: string | null = null;
  try {
    resolver = await discoverTmeResolver();
  } catch (err) {
    logger.warn(`username @${sanitizeLogValue(username)}: resolver discovery failed`, err);
    return {
      username,
      tokenized: false,
      itemAddress: null,
      ownerWallet: null,
      collection: null,
      index: null,
      resolver: null,
      source: 'none',
      reason: 'resolver_unreachable',
    };
  }

  // 2) Resolver -> item address.
  let itemAddress: string | null = null;
  try {
    itemAddress = await resolveItemOnchain(username, resolver);
  } catch (err) {
    logger.warn(`username @${sanitizeLogValue(username)}: on-chain resolve failed`, err);
  }

  if (!itemAddress) {
    // No on-chain record: either a basic (non-tokenized) username or nonexistent.
    // The checker cannot distinguish those without Telegram — honest verdict.
    return {
      username,
      tokenized: false,
      itemAddress: null,
      ownerWallet: null,
      collection: null,
      index: null,
      resolver,
      source: 'none',
      reason: 'no_onchain_record',
    };
  }

  // 3) The resolver derives an address for ANY name — only a DEPLOYED item
  // means a real collectible. Uninitialized = basic username, honest verdict.
  try {
    const st = await client.getContractState(Address.parse(itemAddress));
    if (st.state !== 'active') {
      return {
        username,
        tokenized: false,
        itemAddress,
        ownerWallet: null,
        collection: null,
        index: null,
        resolver,
        source: 'onchain',
        reason: 'item_not_deployed_basic_username',
      };
    }
  } catch (err) {
    logger.warn(`username @${sanitizeLogValue(username)}: contract state unreadable`, err);
    return {
      username,
      tokenized: false,
      itemAddress,
      ownerWallet: null,
      collection: null,
      index: null,
      resolver,
      source: 'onchain',
      reason: 'item_state_unknown',
    };
  }

  // 4) Authoritative read from the item contract.
  try {
    const nft = await getNftData(itemAddress);
    return {
      username,
      tokenized: true,
      itemAddress: nft.itemAddress,
      ownerWallet: nft.owner,
      collection: nft.collection,
      index: nft.index,
      resolver,
      source: 'onchain',
      reason: nft.init ? undefined : 'item_not_initialized',
    };
  } catch {
    return {
      username,
      tokenized: false,
      itemAddress,
      ownerWallet: null,
      collection: null,
      index: null,
      resolver,
      source: 'onchain',
      reason: 'item_not_nft_interface',
    };
  }
}

/** The item must belong to the .t.me collection (anti-spoof for lookalike names). */
export function usernameCollectionOk(res: UsernameResolution, extraAllowlist: string[] = []): boolean {
  if (!res.tokenized || !res.collection) return false;
  if (res.resolver && sameAddress(res.collection, res.resolver)) return true;
  return extraAllowlist.some((a) => {
    try {
      return sameAddress(res.collection as string, a);
    } catch {
      return false;
    }
  });
}
