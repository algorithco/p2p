// Typed API client — wraps backend `/api/*` with initData auth, 15s timeout, ApiError
import { TG } from './tg';

let BASE = '';
try {
  const raw = window.localStorage.getItem('tonescrow:apiBase') || '';
  if (raw) {
    // Validate custom base: only allow same-origin or https hosts to prevent
    // credential exfiltration (x-init-data) to an attacker origin.
    try {
      const u = new URL(raw, window.location.origin);
      if (u.origin === window.location.origin || u.protocol === 'https:') {
        BASE = raw.charAt(raw.length - 1) === '/' ? raw.slice(0, -1) : raw;
        if (u.origin !== window.location.origin) {
          console.warn('[api] using custom apiBase', u.origin);
        } else if (raw.startsWith('http')) {
          BASE = '';
        }
      } else {
        console.warn('[api] ignoring unsafe apiBase (must be same-origin or https)');
      }
    } catch {
      // relative path like '/api-v2' is safe
      if (raw.startsWith('/')) BASE = raw.charAt(raw.length - 1) === '/' ? raw.slice(0, -1) : raw;
    }
  }
} catch {}

export class ApiError extends Error {
  status: number;
  payload: any;
  constructor(status: number, message: string, payload: any = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.payload = payload || null;
  }
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  try {
    const initData = (TG as any).initData ? TG.initData() : '';
    if (initData) h['x-init-data'] = initData;
    // Never send the preview fallback id (777000001) without a signature —
    // it would look like ID spoofing to the backend and pollutes logs.
    const real = TG.realUser ? TG.realUser() : null;
    if (real && real.id) {
      h['x-telegram-user-id'] = String(real.id);
    } else if (initData) {
      h['x-telegram-user-id'] = String(TG.user().id || 0);
    }
  } catch {}
  return h;
}

function request(method: string, path: string, body?: any, opts: any = {}): Promise<any> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => {
    if (ctrl) ctrl.abort();
  }, opts.timeoutMs || 15000);
  return fetch(BASE + path, {
    method,
    headers: Object.assign(
      { Accept: 'application/json' } as any,
      body ? { 'Content-Type': 'application/json' } : {},
      authHeaders(),
    ),
    body: body ? JSON.stringify(body) : undefined,
    signal: ctrl ? ctrl.signal : undefined,
  })
    .then((res) =>
      res.text().then((txt) => {
        let data: any = null;
        if (txt) {
          try {
            data = JSON.parse(txt);
          } catch {
            data = txt;
          }
        }
        if (!res.ok) {
          const msg = data && data.error ? String(data.error) : 'HTTP ' + res.status;
          throw new ApiError(res.status, msg, data);
        }
        return data;
      }),
    )
    .catch((err) => {
      clearTimeout(timer);
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, 'Network unreachable', null);
    })
    .finally(() => clearTimeout(timer));
}

/** In-memory object URLs for user avatars (revoked never — process-lifetime cache, tiny count). */
const avatarUrlCache = new Map<number, string>();
const avatarInflight = new Map<number, Promise<string | null>>();

export const Api = {
  ApiError,
  /**
   * Counterparty avatar as an <img>-ready object URL (authenticated fetch —
   * <img> tags can't carry x-init-data). Returns null when the user has no
   * photo or it can't be loaded; callers keep the initials fallback then.
   * Results (incl. null) are cached per session to avoid refetching per card.
   */
  userPhoto(id: number | string): Promise<string | null> {
    const uid = Number(id);
    if (!Number.isInteger(uid) || uid <= 0) return Promise.resolve(null);
    const hit = avatarUrlCache.get(uid);
    if (hit) return Promise.resolve(hit);
    const pending = avatarInflight.get(uid);
    if (pending) return pending;
    const p = fetch(BASE + '/api/users/' + encodeURIComponent(String(uid)) + '/photo', {
      headers: Object.assign({ Accept: 'image/*' } as any, authHeaders()),
    })
      .then((res) => {
        if (!res.ok) return null;
        return res.blob().then((b) => {
          if (!b || !b.size) return null;
          const url = URL.createObjectURL(b);
          avatarUrlCache.set(uid, url);
          return url;
        });
      })
      .catch(() => null)
      .finally(() => {
        avatarInflight.delete(uid);
      });
    avatarInflight.set(uid, p);
    return p;
  },
  info(): Promise<{ adminTelegramIds: number[]; feeBps?: number; paymentAddress?: string; network?: string }> {
    return request('GET', '/api/info').then((d) => ({
      adminTelegramIds: (d && d.adminTelegramIds) || [],
      feeBps: d?.feeBps,
      paymentAddress: d?.paymentAddress,
      network: d?.network,
    }));
  },
  deals(): Promise<any[]> {
    return request('GET', '/api/deals')
      .then((d) => (Array.isArray(d) ? d : []))
      .catch((err: ApiError) => {
        if (err && err.status === 404)
          return request('GET', '/api/deals/mine').then((d) => (Array.isArray(d) ? d : []));
        throw err;
      });
  },
  deal(id: number | string, token?: string): Promise<any> {
    let path = '/api/deals/' + encodeURIComponent(String(id));
    if (token) path += '?token=' + encodeURIComponent(token);
    return request('GET', path);
  },
  createDeal(payload: any): Promise<{
    deal: any;
    link: string;
    botLink: string;
    webappLink: string;
    encryption: string;
    paymentAddress?: string;
  }> {
    return request('POST', '/api/deals', payload).then((d) => {
      d = d || {};
      return {
        deal: d.deal || d,
        link: d.botLink || d.link || d.webappLink || '',
        botLink: d.botLink || d.link || '',
        webappLink: d.webappLink || d.link || '',
        encryption: d.encryption || '',
        paymentAddress: d.paymentAddress,
      };
    });
  },
  joinDeal(id: number | string, token: string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(id)) + '/join/' + encodeURIComponent(token), {});
  },
  inviteLink(id: number | string): Promise<{ link: string; botLink: string; webappLink: string }> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(id)) + '/invite', {}).then((d) => {
      d = d || {};
      return {
        link: d.botLink || d.link || d.webappLink || '',
        botLink: d.botLink || d.link || '',
        webappLink: d.webappLink || d.link || '',
      };
    });
  },
  dealKey(dealId: number | string): Promise<string | null> {
    return request('GET', '/api/deals/' + encodeURIComponent(String(dealId)) + '/key').then((d) =>
      d && d.key ? d.key : null,
    );
  },
  chat(dealId: number | string): Promise<any[]> {
    return request('GET', '/api/deals/' + encodeURIComponent(String(dealId)) + '/chat').then((d) =>
      Array.isArray(d) ? d : [],
    );
  },
  sendChatEncrypted(dealId: number | string, senderTelegramId: number, ciphertext: string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/chat', {
      senderTelegramId,
      ciphertext,
    });
  },
  sendChat(dealId: number | string, senderTelegramId: number, content: string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/chat', { senderTelegramId, content });
  },
  chainStatus(address: string): Promise<any> {
    return request('GET', '/api/status/' + encodeURIComponent(address));
  },
  balance(address: string): Promise<any> {
    return request('GET', '/api/balance/' + encodeURIComponent(address));
  },
  tonPayload(comment: string): Promise<string | null> {
    return request('GET', '/api/ton/payload?comment=' + encodeURIComponent(comment)).then((d) =>
      d && d.payload ? d.payload : null,
    );
  },
  dealPayload(dealId: number | string, token?: string): Promise<any> {
    let path = '/api/deals/' + encodeURIComponent(String(dealId)) + '/payload';
    if (token) path += '?token=' + encodeURIComponent(token);
    return request('GET', path);
  },
  recheckDeal(dealId: number | string): Promise<{ status: string }> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/recheck', {});
  },
  confirmDeal(dealId: number | string): Promise<any> {
    // legacy alias — prefer approveDeal
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/approve', {}).catch((e: any) => {
      if (e && e.status === 404)
        return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/confirm', {});
      throw e;
    });
  },
  shipDeal(dealId: number | string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/ship', {});
  },
  approveDeal(dealId: number | string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/approve', {});
  },
  payoutAddress(dealId: number | string, tonAddress: string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/payout-address', { tonAddress });
  },
  setTonAddress(tonAddress: string): Promise<any> {
    return request('POST', '/api/users/me/ton-address', { tonAddress });
  },
  me(): Promise<any> {
    return request('GET', '/api/users/me');
  },
  // CHANNEL/GROUP escrow (custodial via @gramchioka) — P2P untouched
  channelVerify(dealId: number | string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/channel/verify', {});
  },
  channelRequestEscrow(dealId: number | string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/channel/request-escrow', {});
  },
  channelConfirmEscrow(dealId: number | string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/channel/confirm-escrow', {});
  },
  channelPayout(dealId: number | string, tonAddress?: string): Promise<any> {
    return request(
      'POST',
      '/api/deals/' + encodeURIComponent(String(dealId)) + '/channel/payout',
      tonAddress ? { tonAddress } : {},
    );
  },
  channelSetNewOwner(dealId: number | string, newOwner: string): Promise<any> {
    return request('POST', '/api/deals/' + encodeURIComponent(String(dealId)) + '/channel/set-new-owner', { newOwner });
  },
  channelTransferToBuyer(dealId: number | string, newOwner?: string): Promise<any> {
    return request(
      'POST',
      '/api/deals/' + encodeURIComponent(String(dealId)) + '/channel/transfer-to-buyer',
      newOwner ? { newOwner } : {},
    );
  },
  joinRequests(dealId: number | string): Promise<any[]> {
    return request('GET', '/api/deals/' + encodeURIComponent(String(dealId)) + '/join-requests').then((d) =>
      Array.isArray(d) ? d : Array.isArray(d?.requests) ? d.requests : [],
    );
  },
  joinStatus(
    id: number | string,
    token: string,
  ): Promise<{ status: string; requestId?: number; isPartyNow?: boolean }> {
    return request(
      'GET',
      '/api/deals/' + encodeURIComponent(String(id)) + '/join-status?token=' + encodeURIComponent(token),
    );
  },
  joinRequestPhoto(dealId: number | string, requestId: number | string): Promise<string | null> {
    // Profile photo bytes via authed fetch -> object URL.
    // Plain <img src> can't send x-init-data headers, so callers must
    // URL.revokeObjectURL() the result on unmount (see joinRequestsBox).
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (ctrl) ctrl.abort();
    }, 12000);
    return fetch(
      BASE +
        '/api/deals/' +
        encodeURIComponent(String(dealId)) +
        '/join-requests/' +
        encodeURIComponent(String(requestId)) +
        '/photo',
      {
        headers: Object.assign({ Accept: 'image/*' } as any, authHeaders()),
        signal: ctrl ? ctrl.signal : undefined,
      },
    )
      .then((res) => {
        clearTimeout(timer);
        if (!res.ok) return null;
        return res.blob().then((b) => (b && b.size > 0 ? URL.createObjectURL(b) : null));
      })
      .catch(() => {
        clearTimeout(timer);
        return null;
      });
  },
  approveJoin(dealId: number | string, requestId: number | string): Promise<any> {
    return request(
      'POST',
      '/api/deals/' +
        encodeURIComponent(String(dealId)) +
        '/join-requests/' +
        encodeURIComponent(String(requestId)) +
        '/approve',
      {},
    );
  },
  rejectJoin(dealId: number | string, requestId: number | string): Promise<any> {
    return request(
      'POST',
      '/api/deals/' +
        encodeURIComponent(String(dealId)) +
        '/join-requests/' +
        encodeURIComponent(String(requestId)) +
        '/reject',
      {},
    );
  },
  inbox(): Promise<any[]> {
    return request('GET', '/api/inbox').then((d) => (Array.isArray(d) ? d : []));
  },
  // ubot proxy
  ubot: {
    info(channelId: string): Promise<any> {
      return request('GET', '/api/ubot/channel/' + encodeURIComponent(channelId));
    },
    admins(channelId: string): Promise<any> {
      return request('GET', '/api/ubot/channel/' + encodeURIComponent(channelId) + '/admins');
    },
    promote(channelId: string, body: any): Promise<any> {
      return request('POST', '/api/ubot/channel/' + encodeURIComponent(channelId) + '/promote', body);
    },
    invite(channelId: string, body: any): Promise<any> {
      return request('POST', '/api/ubot/channel/' + encodeURIComponent(channelId) + '/invite', body);
    },
    transfer(channelId: string, body: any): Promise<any> {
      return request('POST', '/api/ubot/channel/' + encodeURIComponent(channelId) + '/transfer', body);
    },
    takeover(channelId: string, body: any): Promise<any> {
      return request('POST', '/api/ubot/channel/' + encodeURIComponent(channelId) + '/takeover', body);
    },
    groupIsBasic(groupId: string): Promise<any> {
      return request('GET', '/api/ubot/group/' + encodeURIComponent(groupId) + '/isBasic');
    },
    groupMigrate(groupId: string): Promise<any> {
      return request('POST', '/api/ubot/group/' + encodeURIComponent(groupId) + '/migrate', {});
    },
    groupPromote(groupId: string, body: any): Promise<any> {
      return request('POST', '/api/ubot/group/' + encodeURIComponent(groupId) + '/promote', body);
    },
    groupTransfer(groupId: string, body: any): Promise<any> {
      return request('POST', '/api/ubot/group/' + encodeURIComponent(groupId) + '/transfer', body);
    },
  },
  // Monthly buyer rating (RELEASED deals, buyer side earns)
  rating(asset: string): Promise<{ month: string; asset: string; rows: any[] }> {
    return request('GET', '/api/rating?asset=' + encodeURIComponent(asset) + '&limit=50').then((d) => ({
      month: (d && d.month) || '',
      asset: (d && d.asset) || asset,
      rows: d && Array.isArray(d.rows) ? d.rows : [],
    }));
  },
};

export default Api;
