import { Api } from 'teleproto';
import { ensureClient, getClient, withFloodWait, isChannelBlocked } from './client';
import logger, { sanitizeLogValue } from './logger';
import { config } from './config';
import { humanDelay } from './humanDelay';
import { cachedGetEntity, cachedGetPassword } from './entityCache';

// --- Patch for missing channels.EditCreator in teleproto 1.229 (removed from TL) ---
// Telegram still supports channels.editCreator (0x8f38cd1f) but generated TL dropped it.
// We inject it at runtime so transferChannelOwnership works.
try {
  const apiAny = Api as unknown as Record<string, unknown>;
  const channels = apiAny['channels'] as Record<string, unknown> | undefined;
  if (!channels || !channels['EditCreator']) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createApiFromDefinitions } = require('teleproto/tl/runtime/createApi') as {
      createApiFromDefinitions: (defs: unknown[]) => Record<string, Record<string, unknown>>;
    };
    const editCreatorDef = {
      name: 'EditCreator',
      constructorId: 2402864415,
      argsConfig: {
        channel: {
          isVector: false,
          isFlag: false,
          skipConstructorId: false,
          flagName: null,
          flagIndex: -1,
          flagIndicator: false,
          type: 'InputChannel',
          useVectorId: null,
        },
        userId: {
          isVector: false,
          isFlag: false,
          skipConstructorId: false,
          flagName: null,
          flagIndex: -1,
          flagIndicator: false,
          type: 'InputUser',
          useVectorId: null,
        },
        password: {
          isVector: false,
          isFlag: false,
          skipConstructorId: false,
          flagName: null,
          flagIndex: -1,
          flagIndicator: false,
          type: 'InputCheckPasswordSRP',
          useVectorId: null,
        },
      },
      subclassOfId: 2331323052,
      result: 'Updates',
      isFunction: true,
      namespace: 'channels',
    };
    const tmpApi = createApiFromDefinitions([editCreatorDef]);
    const patched = (tmpApi as Record<string, Record<string, unknown>>)['channels']?.['EditCreator'];
    if (patched) {
      if (!apiAny['channels']) (apiAny['channels'] as unknown) = {};
      ((apiAny['channels'] as Record<string, unknown>)['EditCreator'] as unknown) = patched;
      logger.info('Patched Api.channels.EditCreator (0x8f38cd1f) — ownership transfer enabled');
    }
  }
} catch (e) {
  logger.warn('Failed to patch Api.channels.EditCreator', e);
}

/**
 * Channel takeover helpers.
 * All methods assume client is connected as a user with sufficient rights.
 */

export interface AdminRights {
  changeInfo?: boolean;
  postMessages?: boolean;
  editMessages?: boolean;
  deleteMessages?: boolean;
  banUsers?: boolean;
  inviteUsers?: boolean;
  pinMessages?: boolean;
  addAdmins?: boolean;
  anonymous?: boolean;
  manageCall?: boolean;
  other?: boolean;
  manageTopics?: boolean;
}

/**
 * Build ChatAdminRights with minimal defaults to reduce ban risk.
 * Explicit rights should be passed by caller; defaults are conservative:
 * only banUsers/inviteUsers/pinMessages true, others false.
 * Logs a warning if called with empty rights (likely oversight).
 */
function buildAdminRights(r: AdminRights = {}): Api.ChatAdminRights {
  const hasExplicit = Object.keys(r).length > 0;
  if (!hasExplicit) {
    logger.warn(
      'buildAdminRights called with empty rights — using minimal defaults (ban/invite/pin only). Pass explicit rights to avoid unintended privilege level.',
    );
  }
  return new Api.ChatAdminRights({
    changeInfo: r.changeInfo ?? false,
    postMessages: r.postMessages ?? false,
    editMessages: r.editMessages ?? false,
    deleteMessages: r.deleteMessages ?? false,
    banUsers: r.banUsers ?? true,
    inviteUsers: r.inviteUsers ?? true,
    pinMessages: r.pinMessages ?? true,
    addAdmins: r.addAdmins ?? false,
    anonymous: r.anonymous ?? false,
    manageCall: r.manageCall ?? false,
    other: r.other ?? false,
    manageTopics: r.manageTopics ?? false,
  });
}

function mapChannelError(e: unknown, channel: string | number): never {
  const msg = String((e as Error).message || e);
  if (msg.includes('CHANNEL_INVALID') || msg.includes('CHAT_INVALID') || msg.includes('No entity')) {
    throw new Error(`channel_not_found: ${channel} — ${msg}`);
  }
  if (msg.includes('USERNAME_INVALID') || msg.includes('USERNAME_NOT_OCCUPIED')) {
    throw new Error(`channel_not_found: ${channel} — username invalid or not occupied`);
  }
  if (msg.includes('CHANNEL_PRIVATE')) {
    throw new Error(`channel_private: ${channel} — need invite link (not public username)`);
  }
  if (msg.includes('CHAT_ADMIN_REQUIRED')) {
    throw new Error(`not_admin: you are not admin/creator of ${channel} — ${msg}`);
  }
  if (msg.includes('CHAT_WRITE_FORBIDDEN')) {
    throw new Error(`write_forbidden: ${channel} — ${msg}`);
  }
  if (msg.includes('CHANNELS_TOO_MUCH')) {
    throw new Error(
      'CHANNELS_TOO_MUCH: bot has joined too many channels/supergroups — leave some or use another account',
    );
  }
  if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error('admin_change_forbidden: recent admin changes, wait 24h before transferring ownership');
  }
  if (msg.includes('PEER_FLOOD')) {
    throw new Error(
      `peer_flood: ${channel} — Telegram anti-spam PEER_FLOOD throttled (too many peer actions) — ${msg}`,
    );
  }
  if (msg.includes('SLOWMODE_WAIT')) {
    const m = msg.match(/SLOWMODE_WAIT_(\d+)|(\d+)\s*seconds/i);
    const secs = m ? m[1] || m[2] || '60' : '60';
    throw new Error(`slowmode_wait: ${channel} — Telegram slowmode wait ${secs}s — ${msg}`);
  }
  if (msg.includes('TAKEOUT_INIT_DELAY')) {
    const m = msg.match(/TAKEOUT_INIT_DELAY_(\d+)|(\d+)\s*seconds/i);
    const secs = m ? m[1] || m[2] || '30' : '30';
    throw new Error(`takeout_delay: ${channel} — takeout init delay ${secs}s — ${msg}`);
  }
  if (msg.includes('FLOOD_WAIT') || msg.includes('FloodWait')) {
    const m = msg.match(/FLOOD_WAIT_(\d+)|FLOOD_PREMIUM_WAIT_(\d+)|wait of (\d+) seconds|(\d+)\s*seconds/i);
    const secs = m ? m[1] || m[2] || m[3] || m[4] || '30' : '30';
    throw new Error(`flood_wait: ${channel} — Telegram FLOOD_WAIT ${secs}s — ${msg}`);
  }
  if (msg.includes('USER_BANNED_IN_CHANNEL') || msg.includes('USER_BANNED')) {
    throw new Error(`user_banned: ${channel} — ${msg}`);
  }
  if (msg.includes('CHAT_NOT_MODIFIED')) {
    // let caller decide; but surface if not handled upstream
    throw new Error(`not_modified: ${channel} — ${msg}`);
  }
  throw e as Error;
}

async function resolveChannel(channel: string | number): Promise<Api.Channel | Api.Chat> {
  // Check global FRESH breaker before hitting Telegram (anti-abuse 24h)
  if (isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error(
      'admin_change_forbidden: FRESH_CHANGE_ADMINS_FORBIDDEN breaker active — recent admin changes, wait 24h before admin operations',
    );
  }
  if (isChannelBlocked('PEER_FLOOD')) {
    throw new Error('peer_flood: PEER_FLOOD breaker active — anti-spam throttled, wait before retry');
  }
  const client = await ensureClient();
  try {
    // Use entity cache for getEntity to avoid repeated DC hits
    const entity = (await cachedGetEntity(
      client as unknown as { getEntity: (id: string) => Promise<unknown> },
      String(channel),
    )) as Api.Channel | Api.Chat;
    // Human-like delay after resolve to avoid hammering
    await humanDelay(600, 1400);
    return entity;
  } catch (e) {
    mapChannelError(e, channel);
  }
}

// BigInt-safe helper: returns number if safe, otherwise string to avoid precision loss
function toSafeId(raw: unknown): number | string {
  if (typeof raw === 'bigint') {
    return raw > BigInt(Number.MAX_SAFE_INTEGER) ? String(raw) : Number(raw);
  }
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) ? raw : String(raw);
  }
  if (raw && typeof (raw as { toJSNumber?: () => number }).toJSNumber === 'function') {
    try {
      const n = (raw as { toJSNumber: () => number }).toJSNumber();
      // toJSNumber may lose precision for >53-bit; try to check via toString
      const s = (raw as { toString?: () => string }).toString?.();
      if (s && s !== String(n)) {
        // Likely precision loss — check if string value exceeds safe integer
        try {
          const big = BigInt(s);
          if (big > BigInt(Number.MAX_SAFE_INTEGER)) return String(big);
        } catch {}
      }
      return n;
    } catch {
      return String(raw);
    }
  }
  if (raw && typeof (raw as { toString?: () => string }).toString === 'function') {
    const s = String((raw as { toString: () => string }).toString());
    // If numeric string and fits safe integer, return number, else string
    if (/^-?\d+$/.test(s)) {
      try {
        const big = BigInt(s);
        if (big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(s);
        return s;
      } catch {
        return s;
      }
    }
    return s;
  }
  const n = Number(raw as unknown as number);
  return Number.isFinite(n) ? n : String(raw);
}

export async function getChannelInfo(
  channel: string | number,
): Promise<{ id: number | string; title: string; username?: string; isChannel: boolean }> {
  const ent = (await resolveChannel(channel)) as unknown as {
    id: unknown;
    title: string;
    username?: string;
    broadcast?: boolean;
    megagroup?: boolean;
  };
  const id = toSafeId(ent.id);
  return {
    id,
    title: ent.title,
    username: ent.username,
    isChannel: !!(ent as { broadcast?: boolean }).broadcast || !!(ent as { megagroup?: boolean }).megagroup,
  };
}

// Internal helper that operates on already-resolved entities (no double resolve).
// Used by groupService to avoid String(channel) double-resolve bug.
export async function promoteToAdminWithEntities(
  channelEntity: Api.Channel | Api.Chat,
  userEntity: unknown,
  rights: AdminRights = {},
  rank: string = 'Admin',
): Promise<void> {
  if (!userEntity) throw new Error('userEntity required');
  if (rank && rank.length > 32) throw new Error('rank too long (max 32)');
  if (isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error('admin_change_forbidden: FRESH breaker active — wait 24h');
  }
  if (isChannelBlocked('PEER_FLOOD')) {
    throw new Error('peer_flood: PEER_FLOOD breaker active');
  }
  const client = await ensureClient();
  // Human-like pacing before sensitive admin change
  await humanDelay(1200, 2200);
  try {
    await withFloodWait(() =>
      client.invoke(
        new Api.channels.EditAdmin({
          channel: channelEntity as unknown as Api.InputChannel,
          userId: userEntity as unknown as Api.InputUser,
          adminRights: buildAdminRights(rights),
          rank,
        }),
      ),
    );
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('USER_NOT_PARTICIPANT')) {
      const uid = (userEntity as { id?: unknown })?.id ? String((userEntity as { id: unknown }).toString()) : 'unknown';
      throw new Error(`user_not_participant: ${uid} is not in channel — invite first via channels.InviteToChannel`);
    }
    if (msg.includes('CHAT_NOT_MODIFIED')) {
      logger.info(`Promote not modified — already admin`);
      return;
    }
    if (msg.includes('RIGHTS_INVALID') || msg.includes('RANK_INVALID')) {
      throw new Error(`rights_invalid: ${msg}`);
    }
    mapChannelError(e, 'channelEntity');
  }
  const uidLog = (userEntity as { id?: unknown })?.id
    ? String((userEntity as { id: unknown }).toString()).slice(0, 20)
    : 'user';
  logger.info(`Promoted ${sanitizeLogValue(uidLog)} to admin (via entities)`);
}

// Aliases for groupService compatibility
export const promoteToAdminDirect = promoteToAdminWithEntities;
export const promoteToAdminByEntity = promoteToAdminWithEntities;
export const promoteToAdminWithChannelEntity = promoteToAdminWithEntities;

export async function promoteToAdmin(
  channel: string | number,
  userId: string | number,
  rights: AdminRights = {},
  rank: string = 'Admin',
): Promise<void> {
  if (!userId || String(userId).trim() === '') throw new Error('userId required');
  if (rank && rank.length > 32) throw new Error('rank too long (max 32)');
  if (isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error('admin_change_forbidden: FRESH breaker active — wait 24h before admin operations');
  }
  if (isChannelBlocked('PEER_FLOOD')) {
    throw new Error('peer_flood: PEER_FLOOD breaker active');
  }
  // Single ensure via resolveChannel (it connects lazily); getClient reuses it —
  // no second checkAuthorization per request.
  const channelEntity = await resolveChannel(channel);
  const client = getClient();
  if (!client) throw new Error('telegram_not_connected: lazy connect failed — retry the request');
  let userEntity: unknown;
  try {
    userEntity = await cachedGetEntity(
      client as unknown as { getEntity: (id: string) => Promise<unknown> },
      String(userId),
    );
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('Could not find') || msg.includes('No entity') || msg.includes('USER_ID_INVALID')) {
      throw new Error(
        `user_not_found: ${userId} — user must have interacted with bot or be in contacts; try inviting first`,
      );
    }
    mapChannelError(e, channel);
  }

  // Human-like delay between user fetch and admin edit (1200-2200ms)
  await humanDelay(1200, 2200);

  try {
    await withFloodWait(() =>
      client.invoke(
        new Api.channels.EditAdmin({
          channel: channelEntity as unknown as Api.InputChannel,
          userId: userEntity as unknown as Api.InputUser,
          adminRights: buildAdminRights(rights),
          rank,
        }),
      ),
    );
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('USER_NOT_PARTICIPANT')) {
      throw new Error(
        `user_not_participant: ${userId} is not in ${channel} — invite first via channels.InviteToChannel`,
      );
    }
    if (msg.includes('CHAT_NOT_MODIFIED')) {
      // Already admin with same rights — treat as success
      logger.info(`Promote not modified — ${sanitizeLogValue(userId)} already admin in ${sanitizeLogValue(channel)}`);
      return;
    }
    if (msg.includes('RIGHTS_INVALID') || msg.includes('RANK_INVALID')) {
      throw new Error(`rights_invalid: ${msg}`);
    }
    mapChannelError(e, channel);
  }
  logger.info(`Promoted ${sanitizeLogValue(userId)} to admin in ${sanitizeLogValue(channel)}`);
}

// Direct-entity version for transfer ownership
export async function transferChannelOwnershipWithEntities(
  channelEntity: Api.Channel | Api.Chat,
  newOwnerEntity: unknown,
  password?: string,
): Promise<void> {
  const pwd = password || config.twoFaPassword;
  if (!pwd) throw new Error('2FA password required for ownership transfer (TWO_FA_PASSWORD or per-request password)');
  if (!newOwnerEntity) throw new Error('newOwnerEntity required');
  if (isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error('admin_change_forbidden: FRESH breaker active — wait 24h before transferring ownership');
  }
  const client = await ensureClient();
  try {
    const passwordInfo = (await cachedGetPassword(
      client as unknown as { invoke: (req: unknown) => Promise<unknown> },
    )) as unknown as { hasPassword: boolean };
    let check: unknown = null;
    try {
      const { computeCheck } = await import('teleproto/Password');
      check = await (computeCheck as unknown as (pwd: unknown, pw: string) => Promise<unknown>)(passwordInfo, pwd);
    } catch (err) {
      const m = String((err as Error).message || err);
      if (m.includes('computeCheck') || m.includes('Cannot find')) {
        check = null;
      } else {
        throw err;
      }
    }
    // Human delay before sensitive EditCreator (1500-2500ms)
    await humanDelay(1500, 2500);
    const inputUser = newOwnerEntity as unknown as Api.InputUser;
    if (check) {
      await withFloodWait(
        () =>
          client.invoke(
            new (Api.channels as unknown as { EditCreator: new (p: unknown) => unknown }).EditCreator({
              channel: channelEntity as unknown as Api.InputChannel,
              userId: inputUser as unknown as Api.InputUser,
              password: check as unknown as Api.InputCheckPasswordSRP,
            } as never) as unknown as any,
          ) as Promise<unknown>,
      );
    } else {
      await withFloodWait(
        () =>
          client.invoke(
            new (Api.channels as unknown as { EditCreator: new (p: unknown) => unknown }).EditCreator({
              channel: channelEntity as unknown as Api.InputChannel,
              userId: inputUser as unknown as Api.InputUser,
              // Older typings expect InputCheckPasswordSRP; runtime accepts the computed check.
              password: pwd as unknown as Api.InputCheckPasswordSRP,
            } as never) as unknown as any,
          ) as Promise<unknown>,
      );
    }
    const chanId = (channelEntity as unknown as { id?: unknown })?.id
      ? String((channelEntity as unknown as { id: unknown }).toString())
      : 'channel';
    const ownerId = (newOwnerEntity as { id?: unknown })?.id
      ? String((newOwnerEntity as { id: unknown }).toString())
      : 'owner';
    logger.info(`Transferred ownership of ${sanitizeLogValue(chanId)} to ${sanitizeLogValue(ownerId)} (via entities)`);
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('PASSWORD_EMPTY') || msg.includes('SRP_ID_INVALID')) {
      throw new Error(`2FA password invalid for ownership transfer: ${msg}`);
    }
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      throw new Error(`2FA required: ${msg} — set TWO_FA_PASSWORD`);
    }
    if (msg.includes('CHAT_ADMIN_REQUIRED') || msg.includes('CHANNEL_PRIVATE')) {
      throw new Error(`Not admin/creator of channel: ${msg}`);
    }
    if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
      throw new Error(
        'Ownership transfer forbidden — account too new or recent admin changes (Telegram anti-abuse, wait 24h)',
      );
    }
    if (msg.includes('USER_NOT_MUTUAL_CONTACT') || msg.includes('USER_ID_INVALID')) {
      throw new Error(`new_owner_invalid — ${msg}`);
    }
    if (msg.includes('CHANNELS_TOO_MUCH')) {
      throw new Error('CHANNELS_TOO_MUCH: bot has joined too many channels/supergroups');
    }
    if (msg.includes('PEER_FLOOD')) {
      throw new Error(`peer_flood: ${msg}`);
    }
    throw e;
  }
}

export const transferChannelOwnershipDirect = transferChannelOwnershipWithEntities;
export const transferByEntity = transferChannelOwnershipWithEntities;
export const transferChannelOwnershipWithChannelEntity = transferChannelOwnershipWithEntities;

export async function transferChannelOwnership(
  channel: string | number,
  newOwnerUserId: string | number,
  password?: string,
): Promise<void> {
  const pwd = password || config.twoFaPassword;
  if (!pwd) throw new Error('2FA password required for ownership transfer (TWO_FA_PASSWORD or per-request password)');
  if (!newOwnerUserId || String(newOwnerUserId).trim() === '') throw new Error('newOwnerUserId required');
  if (isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error('admin_change_forbidden: FRESH breaker active — wait 24h before transferring ownership');
  }

  // Single ensure via resolveChannel (it connects lazily); getClient reuses it.
  const channelEntity = await resolveChannel(channel);
  const client = getClient();
  if (!client) throw new Error('telegram_not_connected: lazy connect failed — retry the request');
  let newOwnerEntity: unknown;
  try {
    newOwnerEntity = await cachedGetEntity(
      client as unknown as { getEntity: (id: string) => Promise<unknown> },
      String(newOwnerUserId),
    );
  } catch (e) {
    throw new Error(`new_owner_not_found: ${newOwnerUserId} — ${(e as Error).message}`);
  }

  try {
    const passwordInfo = (await cachedGetPassword(
      client as unknown as { invoke: (req: unknown) => Promise<unknown> },
    )) as unknown as { hasPassword: boolean };
    // If account has no password, we still need to handle
    let check: unknown = null;
    try {
      const { computeCheck } = await import('teleproto/Password');
      check = await (computeCheck as unknown as (pwd: unknown, pw: string) => Promise<unknown>)(passwordInfo, pwd);
    } catch (err) {
      const m = String((err as Error).message || err);
      if (m.includes('computeCheck') || m.includes('Cannot find')) {
        // Fallback: some teleproto versions handle SRP internally if we pass raw pwd
        check = null;
      } else {
        throw err;
      }
    }

    // Human delay before ownership transfer
    await humanDelay(1500, 2500);

    const inputUser = newOwnerEntity as unknown as Api.InputUser;
    if (check) {
      await withFloodWait(
        () =>
          client.invoke(
            new (Api.channels as unknown as { EditCreator: new (p: unknown) => unknown }).EditCreator({
              channel: channelEntity as unknown as Api.InputChannel,
              userId: inputUser as unknown as Api.InputUser,
              password: check as unknown as Api.InputCheckPasswordSRP,
            } as never) as unknown as any,
          ) as Promise<unknown>,
      );
    } else {
      await withFloodWait(
        () =>
          client.invoke(
            new (Api.channels as unknown as { EditCreator: new (p: unknown) => unknown }).EditCreator({
              channel: channelEntity as unknown as Api.InputChannel,
              userId: inputUser as unknown as Api.InputUser,
              // Older typings expect InputCheckPasswordSRP; runtime accepts the computed check.
              password: pwd as unknown as Api.InputCheckPasswordSRP,
            } as never) as unknown as any,
          ) as Promise<unknown>,
      );
    }
    logger.info(`Transferred ownership of ${sanitizeLogValue(channel)} to ${sanitizeLogValue(newOwnerUserId)}`);
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('PASSWORD_HASH_INVALID') || msg.includes('PASSWORD_EMPTY') || msg.includes('SRP_ID_INVALID')) {
      throw new Error(`2FA password invalid for ownership transfer: ${msg}`);
    }
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      throw new Error(`2FA required: ${msg} — set TWO_FA_PASSWORD`);
    }
    if (msg.includes('CHAT_ADMIN_REQUIRED') || msg.includes('CHANNEL_PRIVATE')) {
      throw new Error(`Not admin/creator of channel ${channel}: ${msg}`);
    }
    if (msg.includes('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
      throw new Error(
        'Ownership transfer forbidden — account too new or recent admin changes (Telegram anti-abuse, wait 24h)',
      );
    }
    if (msg.includes('USER_NOT_MUTUAL_CONTACT') || msg.includes('USER_ID_INVALID')) {
      throw new Error(`new_owner_invalid: ${newOwnerUserId} — ${msg}`);
    }
    if (msg.includes('CHANNELS_TOO_MUCH')) {
      throw new Error('CHANNELS_TOO_MUCH: bot has joined too many channels/supergroups');
    }
    throw e;
  }
}

export async function demoteAdminWithEntities(
  channelEntity: Api.Channel | Api.Chat,
  userEntity: unknown,
): Promise<void> {
  if (!userEntity) throw new Error('userEntity required');
  if (isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error('admin_change_forbidden: FRESH breaker active — wait 24h');
  }
  // Entity-direct helper: caller already ensured the connection, reuse it.
  const client = getClient();
  if (!client) throw new Error('telegram_not_connected: lazy connect failed — retry the request');
  await humanDelay(1000, 2000);
  await withFloodWait(() =>
    client.invoke(
      new Api.channels.EditAdmin({
        channel: channelEntity as unknown as Api.InputChannel,
        userId: userEntity as unknown as Api.InputUser,
        adminRights: new Api.ChatAdminRights({
          changeInfo: false,
          postMessages: false,
          editMessages: false,
          deleteMessages: false,
          banUsers: false,
          inviteUsers: false,
          pinMessages: false,
          addAdmins: false,
          anonymous: false,
          manageCall: false,
          other: false,
          manageTopics: false,
        }),
        rank: '',
      }),
    ),
  );
  logger.info(`Demoted user via entities`);
}

export const demoteAdminDirect = demoteAdminWithEntities;
export const demoteByEntity = demoteAdminWithEntities;

export async function demoteAdmin(channel: string | number, userId: string | number): Promise<void> {
  if (!userId) throw new Error('userId required');
  if (isChannelBlocked('FRESH_CHANGE_ADMINS_FORBIDDEN')) {
    throw new Error('admin_change_forbidden: FRESH breaker active — wait 24h');
  }
  // Single ensure via resolveChannel (it connects lazily); getClient reuses it.
  const channelEntity = await resolveChannel(channel);
  const client = getClient();
  if (!client) throw new Error('telegram_not_connected: lazy connect failed — retry the request');
  let userEntity: unknown;
  try {
    userEntity = await cachedGetEntity(
      client as unknown as { getEntity: (id: string) => Promise<unknown> },
      String(userId),
    );
  } catch (e) {
    throw new Error(`user_not_found: ${userId} — ${(e as Error).message}`);
  }
  await humanDelay(1000, 2000);
  await withFloodWait(() =>
    client.invoke(
      new Api.channels.EditAdmin({
        channel: channelEntity as unknown as Api.InputChannel,
        userId: userEntity as unknown as Api.InputUser,
        adminRights: new Api.ChatAdminRights({
          changeInfo: false,
          postMessages: false,
          editMessages: false,
          deleteMessages: false,
          banUsers: false,
          inviteUsers: false,
          pinMessages: false,
          addAdmins: false,
          anonymous: false,
          manageCall: false,
          other: false,
          manageTopics: false,
        }),
        rank: '',
      }),
    ),
  );
  logger.info(`Demoted ${sanitizeLogValue(userId)} in ${sanitizeLogValue(channel)}`);
}

export async function listChannelAdmins(
  channel: string | number,
): Promise<Array<{ id: number | string; isCreator: boolean }>> {
  // Highest-frequency read path (every verify + confirm-escrow): single ensure via
  // resolveChannel, reuse the client — previously 2x checkAuthorization per request.
  const channelEntity = await resolveChannel(channel);
  const client = getClient();
  if (!client) throw new Error('telegram_not_connected: lazy connect failed — retry the request');
  // Human delay before listing admins
  await humanDelay(800, 1500);
  // teleproto expects BigInteger for hash; JS BigInt is compatible at runtime.
  const res = (await withFloodWait(() =>
    client.invoke(
      new Api.channels.GetParticipants({
        channel: channelEntity as unknown as Api.InputChannel,
        filter: new Api.ChannelParticipantsAdmins(),
        offset: 0,
        limit: 100,
        hash: 0 as unknown as any,
      }),
    ),
  )) as unknown as {
    participants: Array<{
      className?: string;
      userId?: unknown;
      participant?: { className: string };
      peer?: { userId?: unknown };
    }>;
    users?: Array<{ id: unknown; username?: string }>;
  };
  // Handle both shapes: channels.ChannelParticipants (participants[].className) and channels.ChannelParticipant (participant)
  // Telethon/teleproto admin list returns ChannelParticipantCreator / ChannelParticipantAdmin at top level
  return (res.participants || []).map((p) => {
    const cls = p.className || p.participant?.className || '';
    // For Banned/Left the id is in peer.userId
    const raw = ((p as { userId?: unknown }).userId ??
      (p as { peer?: { userId?: unknown } }).peer?.userId) as unknown as {
      toJSNumber?: () => number;
      toString?: () => string;
    };
    const id =
      raw !== undefined && raw !== null
        ? toSafeId(raw)
        : toSafeId((p as unknown as { toString: () => string }).toString?.() || '0');
    return {
      id,
      isCreator: cls === 'ChannelParticipantCreator',
    };
  });
}
