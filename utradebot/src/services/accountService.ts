import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { Api } from 'teleproto';
import { config } from '../config';
import logger from '../logger';
import { decryptSession } from './sessionCrypto';

/**
 * Per-trade GramJS client that holds the traded account's session.
 * Handles: login validation, getAuthorizations, resetAuthorization (kick seller),
 * and final logout.
 */

export function createClientFromSession(sessionEncryptedOrPlain: string): TelegramClient {
  const plain = decryptSession(sessionEncryptedOrPlain);
  const session = new StringSession(plain);
  if (!config.apiId || !config.apiHash) throw new Error('API_ID/API_HASH not configured');
  return new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 3,
    retryDelay: 1500,
  });
}

export async function validateSession(
  sessionEnc: string,
): Promise<{ ok: boolean; phone?: string; username?: string; error?: string }> {
  let client: TelegramClient;
  try {
    client = createClientFromSession(sessionEnc);
  } catch (e) {
    // Includes undecryptable blobs (e.g. wrong ENCRYPTION_KEY) — surface the
    // diagnosable message instead of crashing the handler.
    return { ok: false, error: String((e as Error).message || e) };
  }
  try {
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (!authorized) return { ok: false, error: 'session_not_authorized' };
    const me = (await client.getMe()) as unknown as { phone?: string; username?: string; id: unknown };
    // Check if account looks "empty" — allow but warn if has many dialogs
    // We consider empty if < 20 dialogs (heuristic)
    try {
      const dialogs = await client.getDialogs({ limit: 25 });
      if (dialogs.length > 20) {
        logger.warn(`validateSession: account has ${dialogs.length} dialogs (expected empty)`);
      }
    } catch {}
    return { ok: true, phone: me.phone, username: me.username };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}

export async function getPhoneFromSession(sessionEnc: string): Promise<string | null> {
  const r = await validateSession(sessionEnc);
  return r.phone || null;
}

export async function kickOtherSessions(sessionEnc: string): Promise<{ kicked: number; currentHash: string | null }> {
  const client = createClientFromSession(sessionEnc);
  try {
    await client.connect();
    const auths = (await client.invoke(new Api.account.GetAuthorizations())) as unknown as {
      authorizations: Array<{ hash: string | number; current: boolean }>;
    };
    const current = auths.authorizations.find((a) => a.current);
    const currentHash = current ? String(current.hash) : null;
    let kicked = 0;
    for (const a of auths.authorizations) {
      if (a.current) continue;
      try {
        await client.invoke(new Api.auth.ResetAuthorizations() as unknown as Api.account.ResetAuthorization);
        // Note: ResetAuthorizations resets ALL other sessions at once; but we also support per-hash ResetAuthorization
        kicked = auths.authorizations.length - 1;
        break;
      } catch {
        // Fallback per-hash
        try {
          await client.invoke(
            new Api.account.ResetAuthorization({
              hash: a.hash as unknown as any,
            }) as unknown as Api.account.GetAuthorizations,
          );
          kicked++;
        } catch (e) {
          logger.warn(`kickOtherSessions: failed to reset hash ${String(a.hash)}`, e);
        }
      }
    }
    // If ResetAuthorizations not available, loop per hash
    if (kicked === 0 && auths.authorizations.length > 1) {
      for (const a of auths.authorizations) {
        if (a.current) continue;
        try {
          await client.invoke(
            new Api.account.ResetAuthorization({
              hash: a.hash as unknown as any,
            }) as unknown as Api.account.GetAuthorizations,
          );
          kicked++;
        } catch {}
      }
    }
    // Persist potentially updated session string (session may have rotated)
    return { kicked, currentHash };
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}

export async function logoutSession(sessionEnc: string): Promise<void> {
  const client = createClientFromSession(sessionEnc);
  try {
    await client.connect();
    // auth.logOut logs out current session
    await client.invoke(new Api.auth.LogOut());
    logger.info('logoutSession: auth.LogOut succeeded');
  } catch (e) {
    logger.warn('logoutSession failed (may already be invalid)', e);
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}

/**
 * Attempt buyer login using phone + code.
 * We create a *new* client with empty session and try auth.signIn.
 * On success, we return the new StringSession for buyer to keep.
 */
export async function attemptBuyerLogin(params: {
  phone: string;
  phoneCode: string;
  phoneCodeHash?: string;
  password?: string;
}): Promise<{ success: boolean; session?: string; error?: string }> {
  const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
    connectionRetries: 3,
  });
  try {
    await client.connect();
    // We need to send code first if phoneCodeHash not provided.
    // But spec says buyer already triggered code via their device; we just verify code they send.
    // So we simulate signIn: if phoneCodeHash missing, we call sendCode to get it, but we assume buyer provided correct code from SMS.
    // For our service, the utradebot holding seller session cannot trigger sendCode for buyer; buyer triggers it themselves.
    // So we attempt to sign in using the provided code via auth.signIn.
    // GramJS high-level helper: client.start with phoneCode, but we do manual:
    let codeHash = params.phoneCodeHash;
    if (!codeHash) {
      const sent = (await client.invoke(
        new Api.auth.SendCode({
          phoneNumber: params.phone,
          apiId: config.apiId,
          apiHash: config.apiHash,
          settings: new Api.CodeSettings({}),
        }),
      )) as unknown as { phoneCodeHash: string };
      codeHash = sent.phoneCodeHash;
    }

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: params.phone,
          phoneCodeHash: codeHash,
          phoneCode: params.phoneCode,
        }),
      );
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        if (!params.password) return { success: false, error: '2fa_required' };
        // Need to get password and check
        const pwdInfo = await client.invoke(new Api.account.GetPassword());
        const { computeCheck } = await import('teleproto/Password');
        const check = await (computeCheck as unknown as (pwd: unknown, pw: string) => Promise<unknown>)(
          pwdInfo,
          params.password,
        );
        await client.invoke(
          new Api.auth.CheckPassword({
            password: check as unknown as Api.InputCheckPasswordSRP,
          }),
        );
      } else {
        throw e;
      }
    }

    const newSession = (client.session as StringSession).save() as unknown as string;
    return { success: true, session: newSession };
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes('PHONE_CODE_INVALID') || msg.includes('PHONE_CODE_EXPIRED')) {
      return { success: false, error: 'invalid_code' };
    }
    return { success: false, error: msg };
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}

export async function sendCodeToPhone(phone: string): Promise<{ phoneCodeHash: string }> {
  const client = new TelegramClient(new StringSession(''), config.apiId, config.apiHash, {
    connectionRetries: 3,
  });
  try {
    await client.connect();
    const res = (await client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: config.apiId,
        apiHash: config.apiHash,
        settings: new Api.CodeSettings({}),
      }),
    )) as unknown as { phoneCodeHash: string };
    return { phoneCodeHash: res.phoneCodeHash };
  } finally {
    try {
      await client.disconnect();
    } catch {}
  }
}
