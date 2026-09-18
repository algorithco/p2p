/**
 * TON access layer: jsonRPC get-methods (authoritative reads) + toncenter v3
 * indexed API (fast lookups). Reads only — the checker never signs anything.
 */
import { Address, Cell, beginCell } from '@ton/core';
import { TonClient } from '@ton/ton';
import { config } from './config';
import logger from './logger';

export const client = new TonClient({
  endpoint: config.tonApiEndpoint,
  apiKey: config.toncenterApiKey || undefined,
});

function timeoutSignal(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry with exponential backoff on 429/5xx and network aborts.
 * Keyless toncenter throttles hard — without this every burst fails.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const msg = String((err as Error)?.message || err);
      const retryable = /HTTP (429|5\d\d)|abort|fetch failed|network|timeout/i.test(msg);
      if (!retryable || attempt === tries) throw err;
      const wait = Math.min(1000 * 2 ** (attempt - 1), 8000);
      logger.warn(`${label}: retry ${attempt}/${tries} in ${wait}ms (${msg.slice(0, 120)})`);
      await sleep(wait);
    }
  }
  throw last;
}

function apiHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (config.toncenterApiKey) h['X-API-Key'] = config.toncenterApiKey;
  return h;
}

/** v2 HTTP base derived from the jsonRPC endpoint (strip trailing /jsonRPC). */
export function v2Base(): string {
  return config.tonApiEndpoint.replace(/\/jsonRPC\/?$/, '');
}

export async function v2Get(path: string, params: Record<string, string> = {}): Promise<any> {
  return withRetry(`v2 ${path}`, async () => {
    const q = new URLSearchParams(params).toString();
    const url = `${v2Base()}${path}${q ? `?${q}` : ''}`;
    const { signal, done } = timeoutSignal(config.requestTimeoutMs);
    try {
      const res = await fetch(url, { headers: apiHeaders(), signal });
      if (!res.ok) throw new Error(`v2 ${path} HTTP ${res.status}`);
      return await res.json();
    } finally {
      done();
    }
  });
}

export async function v3Get(path: string, params: Record<string, string> = {}): Promise<any> {
  return withRetry(`v3 ${path}`, async () => {
    const q = new URLSearchParams(params).toString();
    const url = `${config.tonApiV3Base}${path}${q ? `?${q}` : ''}`;
    const { signal, done } = timeoutSignal(config.requestTimeoutMs);
    try {
      const res = await fetch(url, { headers: apiHeaders(), signal });
      if (!res.ok) throw new Error(`v3 ${path} HTTP ${res.status}`);
      return await res.json();
    } finally {
      done();
    }
  });
}

function tonapiHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (config.tonApiKey) h['Authorization'] = `Bearer ${config.tonApiKey}`;
  return h;
}

/** TonAPI (tonapi.io) — indexed NFT data: owner enumeration, metadata. */
export async function tonapiGet(path: string, params: Record<string, string> = {}): Promise<any> {
  return withRetry(`tonapi ${path}`, async () => {
    const q = new URLSearchParams(params).toString();
    const url = `https://tonapi.io${path}${q ? `?${q}` : ''}`;
    const { signal, done } = timeoutSignal(config.requestTimeoutMs);
    try {
      const res = await fetch(url, { headers: tonapiHeaders(), signal });
      if (res.status === 401 || res.status === 403) throw new Error('tonapi_unauthorized_check_TONAPI_KEY');
      if (!res.ok) throw new Error(`tonapi ${path} HTTP ${res.status}`);
      return await res.json();
    } finally {
      done();
    }
  });
}

export interface TonApiNftItem {
  address: string;
  index?: number;
  owner?: { address?: string };
  collection?: { address?: string; name?: string };
  metadata?: { name?: string };
}

/** All NFTs held by a wallet (paginated). Needs TONAPI_KEY for real quotas. */
export async function getNftsByOwner(ownerRaw: string): Promise<TonApiNftItem[]> {
  const out: TonApiNftItem[] = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const data = await tonapiGet(`/v2/accounts/${ownerRaw}/nfts`, {
      limit: '1000',
      offset: String(offset),
      indirect_ownership: 'false',
    });
    const items = (data?.nft_items || []) as TonApiNftItem[];
    out.push(...items);
    if (items.length < 1000) break;
    offset += items.length;
  }
  return out;
}

export function toRaw(addr: string): string {
  return Address.parse(addr).toRawString();
}

export function toFriendly(addr: string): string {
  return Address.parse(addr).toString({ urlSafe: true, bounceable: false });
}

export function sameAddress(a: string, b: string): boolean {
  try {
    return toRaw(a) === toRaw(b);
  } catch {
    return false;
  }
}

export interface NftData {
  init: boolean;
  index: string;
  collection: string | null;
  owner: string | null;
  itemAddress: string;
}

/** Authoritative owner read straight from the NFT item contract. */
export async function getNftData(itemAddress: string): Promise<NftData> {
  const addr = Address.parse(itemAddress);
  const provider = client.provider(addr);
  const res = await provider.get('get_nft_data', []);
  const init = res.stack.readBigNumber() !== 0n;
  const index = res.stack.readBigNumber().toString();
  let collection: string | null = null;
  let owner: string | null = null;
  try {
    const c = res.stack.readAddressOpt();
    collection = c ? c.toRawString() : null;
  } catch {
    collection = null;
  }
  try {
    const o = res.stack.readAddressOpt();
    owner = o ? o.toRawString() : null;
  } catch {
    owner = null;
  }
  return { init, index, collection, owner, itemAddress: addr.toRawString() };
}

/** TEP-64 content cell -> off-chain metadata URI (prefix 0x01) or null. */
function contentUri(cell: Cell | null): string | null {
  if (!cell) return null;
  try {
    const s = cell.beginParse();
    if (s.remainingBits < 8) return null;
    const prefix = s.loadUint(8);
    if (prefix !== 0x01) return null; // 0x00 = on-chain data (not resolved here)
    const bytes = s.loadBuffer(s.remainingBits / 8);
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

/** Display name from the item's TEP-64 metadata (for gift name matching). */
export async function fetchNftMetadataName(itemAddress: string): Promise<string | null> {
  try {
    const addr = Address.parse(itemAddress);
    const provider = client.provider(addr);
    const res = await provider.get('get_nft_data', []);
    res.stack.readBigNumber();
    res.stack.readBigNumber();
    try {
      res.stack.readAddressOpt();
    } catch {
      /* collection ignored here */
    }
    try {
      res.stack.readAddressOpt();
    } catch {
      /* owner ignored here */
    }
    let content: Cell | null = null;
    try {
      content = res.stack.readCellOpt();
    } catch {
      content = null;
    }
    const uri = contentUri(content);
    if (!uri || (!uri.startsWith('http://') && !uri.startsWith('https://') && !uri.startsWith('ipfs://'))) {
      return null;
    }
    const httpUrl = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
    const { signal, done } = timeoutSignal(config.requestTimeoutMs);
    try {
      const r = await fetch(httpUrl, { signal });
      if (!r.ok) return null;
      const j = (await r.json()) as { name?: unknown };
      return typeof j.name === 'string' ? j.name : null;
    } finally {
      done();
    }
  } catch (err) {
    logger.warn(`metadata fetch failed for ${itemAddress}`, err);
    return null;
  }
}

export interface DnsRecord {
  bits: number;
  kind: 'next_resolver' | 'smc_address' | 'other' | 'empty';
  address: string | null;
}

function parseDnsRecord(cell: Cell | null): DnsRecord {
  if (!cell) return { bits: 0, kind: 'empty', address: null };
  try {
    const s = cell.beginParse();
    if (s.remainingBits < 16) return { bits: 0, kind: 'other', address: null };
    const prefix = s.loadUint(16);
    if (prefix === 0xba93) {
      // dns_next_resolver#ba93 resolver:MsgAddressInt
      const addr = s.loadAddress();
      return { bits: 0, kind: 'next_resolver', address: addr.toRawString() };
    }
    if (prefix === 0x9fd3) {
      // dns_smc_address#9fd3 smc_addr:MsgAddressInt flags:uint8 cap_list:uint8
      const addr = s.loadAddress();
      return { bits: 0, kind: 'smc_address', address: addr.toRawString() };
    }
    return { bits: 0, kind: 'other', address: null };
  } catch (err) {
    logger.warn('dns record parse failed', err);
    return { bits: 0, kind: 'other', address: null };
  }
}

/** Raw dnsresolve get-method. Subdomain encoded as reversed \0-joined labels. */
export async function dnsResolve(
  contractAddress: string,
  subdomain: string,
  category = 0,
): Promise<{ bits: number; record: DnsRecord }> {
  const addr = Address.parse(contractAddress);
  const cell = beginCell().storeBuffer(Buffer.from(subdomain, 'utf8')).endCell();
  const provider = client.provider(addr);
  const res = await provider.get('dnsresolve', [
    { type: 'slice', cell },
    { type: 'int', value: BigInt(category) },
  ]);
  const bits = Number(res.stack.readBigNumber());
  let recordCell: Cell | null = null;
  try {
    recordCell = res.stack.readCellOpt();
  } catch {
    recordCell = null;
  }
  return { bits, record: parseDnsRecord(recordCell) };
}

/** Encode "name.t.me" style domains to resolver byte form ("me\0t\0name\0"). */
export function encodeSubdomain(domain: string): string {
  return domain.split('.').filter(Boolean).reverse().join('\0') + '\0';
}

/**
 * Root DNS contract address: explicit override wins, otherwise read from
 * blockchain config param #4 (masterchain).
 * toncenter v2 shape: { ok:true, result:"<base64 boc>" } where the cell holds
 * dns_root_addr:bits256 (NOT a wrapped address cell).
 */
export async function getRootDnsAddress(): Promise<string> {
  if (config.dnsRootAddress) return toRaw(config.dnsRootAddress);
  const data = await v2Get('/getConfigParam', { param: '4' });
  if (!data?.ok) throw new Error(`config_param_4: ${String(data?.description || 'not_ok').slice(0, 120)}`);
  // toncenter shape: { ok:true, result:{ "@type":"configInfo", config:{ "@type":"tvm.cell", bytes:"<base64 boc>" } } }
  const boc = data?.result?.config?.bytes as string | undefined;
  if (!boc) throw new Error('config_param_4_empty');
  const cell = Cell.fromBoc(Buffer.from(boc, 'base64'))[0];
  const s = cell.beginParse();
  try {
    if (s.remainingBits === 256 && s.remainingRefs === 0) {
      return new Address(-1, s.loadBuffer(32)).toRawString();
    }
    return s.loadAddress().toRawString();
  } catch {
    throw new Error('config_param_4_parse_failed');
  }
}

export interface DnsLookup {
  domain: string;
  nftItemAddress: string | null;
  nftItemOwner: string | null;
  source: 'v3' | 'onchain';
}

/**
 * Indexed fast path: toncenter v3 DNS records (supports .t.me).
 * Returns item address + last known owner (verify on-chain before trusting).
 */
export async function v3DnsLookup(domain: string): Promise<DnsLookup | null> {
  const data = await v3Get('/dns', { domain });
  const rec = data?.records?.[0];
  if (!rec) return null;
  return {
    domain,
    nftItemAddress: rec.nft_item_address ? toRaw(rec.nft_item_address) : null,
    nftItemOwner: rec.nft_item_owner ? toRaw(rec.nft_item_owner) : null,
    source: 'v3',
  };
}
