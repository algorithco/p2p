import { Api } from 'teleproto';
import { ensureClient, getClient, withFloodWait } from './client';
import logger, { sanitizeLogValue } from './logger';
import {
  promoteToAdmin,
  promoteToAdminWithEntities,
  transferChannelOwnershipWithEntities,
  demoteAdminWithEntities,
} from './channelService';
import { humanDelay } from './humanDelay';
import { cachedGetEntity, entityCache } from './entityCache';

/**
 * Group takeover — supports both basic groups (Chat) and supergroups (Channel megagroup).
 * Basic groups must be migrated to supergroup before admin/creator operations.
 */

// Promise-based lock for migrate to avoid double-migrate race
const migrating = new Map<string, Promise<Api.Channel>>();

export async function isBasicGroup(groupId: string | number): Promise<boolean> {
  const client = await ensureClient();
  const entity = (await cachedGetEntity(
    client as unknown as { getEntity: (id: string) => Promise<unknown> },
    String(groupId),
  )) as unknown as { className: string };
  return entity.className === 'Chat';
}

export async function migrateToSupergroup(groupId: string | number): Promise<Api.Channel> {
  const key = String(groupId);
  if (migrating.has(key)) {
    // Another migrate in progress — wait for its result (no arbitrary sleep)
    return await migrating.get(key)!;
  }

  const promise = (async (): Promise<Api.Channel> => {
    try {
      const client = await ensureClient();
      const entity = (await cachedGetEntity(
        client as unknown as { getEntity: (id: string) => Promise<unknown> },
        String(groupId),
      )) as unknown as Api.Chat & { id: unknown } & { className: string };
      if ((entity as unknown as { className: string }).className !== 'Chat') {
        // Already migrated (Channel megagroup)
        return entity as unknown as Api.Channel;
      }
      // teleproto MigrateChat chatId expects BigInteger; runtime accepts number.
      const res = (await withFloodWait(() =>
        client.invoke(
          new Api.messages.MigrateChat({
            chatId: (entity as unknown as { id: number }).id as unknown as any,
          }),
        ),
      )) as unknown as { updates: { chats: Api.Channel[] } };
      const migrated = res?.updates?.chats?.[0];
      if (!migrated)
        throw new Error('migrate_failed: Telegram did not return migrated channel (already migrated or not admin)');
      logger.info(
        `Migrated group ${sanitizeLogValue(groupId)} to supergroup ${sanitizeLogValue((migrated as unknown as { id: unknown }).id)}`,
      );
      // Invalidate old Chat cache and cache new supergroup under same key for future ensureSupergroup fast path
      entityCache.delete(`entity:${key}`);
      // Also cache migrated channel by its new id if available
      try {
        const newId = String((migrated as unknown as { id: unknown }).toString());
        entityCache.set(`entity:${newId}`, migrated);
      } catch {}
      // Cache under original groupId key as well (so ensureSupergroup sees Channel next time)
      entityCache.set(`entity:${key}`, migrated);
      return migrated;
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (
        msg.includes('CHAT_NOT_MODIFIED') ||
        msg.includes('already a supergroup') ||
        msg.includes('CHAT_ADMIN_REQUIRED')
      ) {
        // Fetch again — it is already a supergroup (invalidate cache to force fresh fetch)
        entityCache.delete(`entity:${key}`);
        const client = await ensureClient();
        const ent = (await cachedGetEntity(
          client as unknown as { getEntity: (id: string) => Promise<unknown> },
          String(groupId),
        )) as unknown as Api.Channel;
        return ent;
      }
      if (msg.includes('CHANNELS_TOO_MUCH')) {
        throw new Error('CHANNELS_TOO_MUCH: cannot migrate — too many channels/supergroups');
      }
      throw e;
    }
  })();

  migrating.set(key, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    migrating.delete(key);
  }
}

async function ensureSupergroup(groupId: string | number): Promise<Api.Channel> {
  const key = String(groupId);
  const client = await ensureClient();
  // Fetch once via cache; if Chat then migrate without second getEntity
  let entity: unknown;
  try {
    entity = await cachedGetEntity(client as unknown as { getEntity: (id: string) => Promise<unknown> }, key);
  } catch (e) {
    // Let migrate handle not-found vs already migrated edge
    logger.debug(`ensureSupergroup cache miss for ${sanitizeLogValue(key)}, falling back to migrate`, e);
    return await migrateToSupergroup(groupId);
  }
  const className = (entity as { className?: string })?.className;
  if (className === 'Chat') {
    logger.info(`Group ${sanitizeLogValue(groupId)} is basic Chat — migrating to supergroup`);
    // Direct migrate using already-fetched Chat entity to avoid double getEntity
    const chatEntity = entity as Api.Chat & { id: unknown };
    // Use migrating lock with direct invoke to avoid duplicate getEntity inside migrateToSupergroup
    if (migrating.has(key)) {
      return await migrating.get(key)!;
    }
    const promise = (async (): Promise<Api.Channel> => {
      try {
        const c = await ensureClient();
        const res = (await withFloodWait(() =>
          c.invoke(
            new Api.messages.MigrateChat({
              chatId: (chatEntity as unknown as { id: number }).id as unknown as any,
            }),
          ),
        )) as unknown as { updates: { chats: Api.Channel[] } };
        const migrated = res?.updates?.chats?.[0];
        if (!migrated) throw new Error('migrate_failed: Telegram did not return migrated channel');
        logger.info(
          `Migrated group ${sanitizeLogValue(groupId)} to supergroup ${sanitizeLogValue((migrated as unknown as { id: unknown }).id)}`,
        );
        entityCache.delete(`entity:${key}`);
        entityCache.set(`entity:${key}`, migrated);
        try {
          const newId = String((migrated as unknown as { id: unknown }).toString());
          entityCache.set(`entity:${newId}`, migrated);
        } catch {}
        return migrated;
      } catch (e) {
        const msg = String((e as Error).message || e);
        if (
          msg.includes('CHAT_NOT_MODIFIED') ||
          msg.includes('already a supergroup') ||
          msg.includes('CHAT_ADMIN_REQUIRED')
        ) {
          entityCache.delete(`entity:${key}`);
          const cl = await ensureClient();
          const ent = (await cachedGetEntity(
            cl as unknown as { getEntity: (id: string) => Promise<unknown> },
            key,
          )) as unknown as Api.Channel;
          return ent;
        }
        if (msg.includes('CHANNELS_TOO_MUCH')) {
          throw new Error('CHANNELS_TOO_MUCH: cannot migrate — too many channels/supergroups');
        }
        throw e;
      }
    })();
    migrating.set(key, promise);
    try {
      return await promise;
    } finally {
      migrating.delete(key);
    }
  }
  return entity as Api.Channel;
}

export async function promoteGroupAdmin(
  groupId: string | number,
  userId: string | number,
  rights: Parameters<typeof promoteToAdmin>[2] = {},
  rank = 'Admin',
): Promise<void> {
  if (!userId) throw new Error('userId required');
  // ensureSupergroup already ensures the (lazy) connection — reuse it, no second auth check.
  const supergroup = await ensureSupergroup(groupId);
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
      throw new Error(`user_not_found: ${userId} — user must have interacted or be in contacts; try inviting first`);
    }
    throw e;
  }
  // Use entity-direct helper to avoid String(channel) double-resolve bug (previous code did String(supergroup) -> "[object Object]")
  await promoteToAdminWithEntities(supergroup, userEntity, rights, rank);
}

export async function transferGroupOwnership(
  groupId: string | number,
  newOwnerId: string | number,
  password?: string,
): Promise<void> {
  if (!newOwnerId) throw new Error('newOwnerId required');
  // ensureSupergroup already ensures the (lazy) connection — reuse it.
  const supergroup = await ensureSupergroup(groupId);
  const client = getClient();
  if (!client) throw new Error('telegram_not_connected: lazy connect failed — retry the request');
  let newOwnerEntity: unknown;
  try {
    newOwnerEntity = await cachedGetEntity(
      client as unknown as { getEntity: (id: string) => Promise<unknown> },
      String(newOwnerId),
    );
  } catch (e) {
    throw new Error(`new_owner_not_found: ${newOwnerId} — ${(e as Error).message}`);
  }
  await transferChannelOwnershipWithEntities(supergroup, newOwnerEntity, password);
}

export async function demoteGroupAdmin(groupId: string | number, userId: string | number): Promise<void> {
  if (!userId) throw new Error('userId required');
  // ensureSupergroup already ensures the (lazy) connection — reuse it.
  const supergroup = await ensureSupergroup(groupId);
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
  await demoteAdminWithEntities(supergroup, userEntity);
}

export async function addGroupMember(groupId: string | number, userId: string | number): Promise<void> {
  if (!userId) throw new Error('userId required');
  // ensureSupergroup ensures the (lazy) connection itself — reuse it, no separate auth check.
  const group = await ensureSupergroup(groupId);
  const client = getClient();
  if (!client) throw new Error('telegram_not_connected: lazy connect failed — retry the request');
  let user: unknown;
  try {
    user = await cachedGetEntity(client as unknown as { getEntity: (id: string) => Promise<unknown> }, String(userId));
  } catch (e) {
    throw new Error(`user_not_found: ${userId} — ${(e as Error).message}`);
  }
  // Human delay before invite to appear non-bot
  await humanDelay(1000, 2000);
  try {
    await withFloodWait(() =>
      client.invoke(
        new Api.channels.InviteToChannel({
          channel: group as unknown as Api.InputChannel,
          users: [user as unknown as Api.InputUser],
        }),
      ),
    );
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('USER_ALREADY_PARTICIPANT')) {
      logger.info(`User ${sanitizeLogValue(userId)} already participant in ${sanitizeLogValue(groupId)}`);
      return;
    }
    if (msg.includes('USER_NOT_MUTUAL_CONTACT'))
      throw new Error(`user_not_mutual: ${userId} — not mutual contact or privacy restricted`);
    if (msg.includes('USER_PRIVACY_RESTRICTED'))
      throw new Error(`privacy_restricted: ${userId} — privacy settings block invite`);
    if (msg.includes('USERS_TOO_MUCH')) throw new Error('group_full: too many participants');
    if (msg.includes('INVITE_REQUEST_SENT'))
      throw new Error('invite_request_sent: join request already pending (group requires approval)');
    throw e;
  }
  logger.info(`Invited ${sanitizeLogValue(userId)} to group ${sanitizeLogValue(groupId)}`);
}
