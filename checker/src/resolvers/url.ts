/** Input classifier: URL / username / raw address -> one resolver path. */
import { Address } from '@ton/core';

export type InputKind = 'username' | 'gift' | 'address' | 'unsupported';

export interface ClassifiedInput {
  kind: InputKind;
  /** Normalized value: username without @, gift name, or raw address. */
  value: string;
  /** Extra detail (e.g. gift number) when present in the URL. */
  extra?: Record<string, string>;
  reason?: string;
}

const USERNAME_RE = /^[A-Za-z0-9_]{5,32}$/;

function tryAddress(s: string): string | null {
  try {
    return Address.parse(s.trim()).toRawString();
  } catch {
    return null;
  }
}

function stripQuery(u: string): string {
  const q = u.indexOf('?');
  return q === -1 ? u : u.slice(0, q);
}

export function classifyInput(input: string): ClassifiedInput {
  const raw = String(input || '').trim();
  if (!raw) return { kind: 'unsupported', value: '', reason: 'empty_input' };

  // Raw TON address (EQ../UQ../0:..)
  const asAddr = tryAddress(raw);
  if (asAddr) return { kind: 'address', value: asAddr };

  // @name or bare name
  const bare = raw.startsWith('@') ? raw.slice(1) : raw;
  if (USERNAME_RE.test(bare) && !raw.includes('/') && !raw.includes('.')) {
    return { kind: 'username', value: bare.toLowerCase() };
  }

  // Bare gift "Name-1234" / "Name #1234" (no URL). Separator required so that
  // plain usernames ending in digits ("user123") are never hijacked.
  if (!raw.includes('/') && !raw.includes('.')) {
    const g = bare.match(/^([A-Za-z][A-Za-z0-9_\s]*?)\s*[-_#\s]\s*#?(\d{1,10})$/);
    if (g && g[1].trim() !== '') {
      return { kind: 'gift', value: g[1].trim(), extra: { number: g[2] } };
    }
  }

  // URLs
  let url: URL;
  try {
    url = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return { kind: 'unsupported', value: raw, reason: 'unrecognized_input' };
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = stripQuery(url.pathname).split('/').filter(Boolean);

  // t.me/nft/< GiftName > [/<number>]
  if (host === 't.me' && parts[0] === 'nft' && parts[1]) {
    const extra: Record<string, string> = {};
    if (parts[2] && /^\d+$/.test(parts[2])) extra.number = parts[2];
    return { kind: 'gift', value: parts[1], extra };
  }
  // t.me/<name> — public username link (could be basic or collectible)
  if (host === 't.me' && parts.length === 1 && USERNAME_RE.test(parts[0])) {
    return { kind: 'username', value: parts[0].toLowerCase() };
  }
  // fragment.com/username/<name>
  if (host === 'fragment.com' && parts[0] === 'username' && parts[1]) {
    const n = parts[1].replace(/^@/, '');
    if (USERNAME_RE.test(n)) return { kind: 'username', value: n.toLowerCase() };
  }
  // getgems.io/nft/<collection>/<item-address> — extract the item address
  if (host === 'getgems.io' && parts[0] === 'nft') {
    for (const p of parts.slice(1)) {
      const a = tryAddress(p);
      if (a) return { kind: 'address', value: a };
    }
  }
  // Anonymous numbers are a different TeleMint variant (NoDns) — out of scope.
  if (host === 'fragment.com' && parts[0] === 'number') {
    return { kind: 'unsupported', value: raw, reason: 'phone_collectible_unsupported' };
  }
  return { kind: 'unsupported', value: raw, reason: 'unsupported_url' };
}
