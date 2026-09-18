import { Bot } from 'grammy';
import * as tradeService from '../../services/tradeService';
import * as accountService from '../../services/accountService';
import * as db from '../../db/queries';
import { sellKeyboard } from '../keyboards';
import logger from '../../logger';

// In-memory step tracking per user (prod: replace with redis or db)
const sellSteps = new Map<number, { step: 'await_session' | 'await_phone' | 'await_buyer'; tradeId?: number }>();

export function registerSellFlow(bot: Bot) {
  bot.callbackQuery(/^confirm_payment:(\d+)$/, async (ctx) => {
    const tradeId = Number(ctx.match[1]);
    const sellerId = ctx.from!.id;
    try {
      await tradeService.confirmPayment(tradeId, sellerId);
      const trade = (await db.getTrade(tradeId)) as unknown as { phone?: string; buyer_telegram_id?: number };
      let phone = trade?.phone as string | undefined;
      if (!phone) {
        // Try derive from session
        const full = (await db.getTrade(tradeId)) as unknown as { session_encrypted: string };
        try {
          phone = (await accountService.getPhoneFromSession(full.session_encrypted)) || undefined;
          if (phone) {
            await db.setPhone(tradeId, phone);
          }
        } catch (e) {
          // Diagnosable: a key-mismatch throw lands here (not swallowed silently).
          logger.warn(`confirm_payment phone derive failed for trade #${tradeId}`, e);
        }
      }
      if (!phone) {
        await ctx.answerCallbackQuery({ text: 'Phone not known — use /setphone <tradeId> <phone>' });
        await ctx.reply(`⚠️ Phone not set for trade #${tradeId}. Please send: /setphone ${tradeId} +1234567890`);
        return;
      }
      // If buyer already bound, share phone immediately
      const buyerId = trade?.buyer_telegram_id as number | undefined;
      if (buyerId) {
        try {
          await ctx.api.sendMessage(
            buyerId,
            `📞 Seller confirmed payment for trade #${tradeId}.\n\nPhone: \`${phone}\`\n\nPlease send the login code you receive via SMS/Telegram to this bot.`,
            { parse_mode: 'Markdown' },
          );
        } catch {}
        await tradeService.bindBuyer(tradeId, buyerId);
      }
      await ctx.answerCallbackQuery({ text: 'Payment confirmed — phone shared with buyer (if buyer known)' });
      await ctx.reply(
        `✅ Trade #${tradeId}: Phone shared.\n\nBuyer will be asked to send the login code. Once buyer logs in, your session will be logged out.`,
      );
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message || e).slice(0, 60) });
    }
  });

  bot.callbackQuery(/^cancel_trade:(\d+)$/, async (ctx) => {
    const tradeId = Number(ctx.match[1]);
    try {
      await tradeService.cancelTrade(tradeId, ctx.from!.id);
      await ctx.answerCallbackQuery({ text: 'Cancelled' });
      await ctx.reply(`Trade #${tradeId} cancelled.`);
    } catch (e) {
      await ctx.answerCallbackQuery({ text: String((e as Error).message || e).slice(0, 60) });
    }
  });

  bot.command('sell', async (ctx) => {
    const from = ctx.from!;
    sellSteps.set(from.id, { step: 'await_session' });
    await ctx.reply(
      '💼 **Sell Telegram Account**\n\n' +
        'Send your **StringSession** for the account you want to sell (generated via client.session.save()).\n\n' +
        'Alternatively, send phone in format: `phone:+1234567890` and I will guide you through code login.\n\n' +
        '⚠️ I will log into the account, terminate all other sessions (kick seller), and hold it securely until buyer pays.\n\n' +
        'Send session or `phone:+...` now. Cancel with /cancel',
      { parse_mode: 'Markdown' },
    );
  });

  bot.command('setphone', async (ctx) => {
    const parts = ((ctx.match as string) || '').trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply('Usage: /setphone <tradeId> <phone>  e.g. /setphone 123 +1234567890');
    const tradeId = Number(parts[0]);
    const phone = parts[1];
    if (!phone.startsWith('+')) return ctx.reply('Phone must be E.164, e.g. +1234567890');
    try {
      const trade = await db.getTrade(tradeId);
      if (!trade) return ctx.reply('Trade not found');
      if (Number(trade.seller_telegram_id) !== ctx.from!.id) return ctx.reply('Only seller can set phone');
      await db.setPhone(tradeId, phone);
      await ctx.reply(`Phone set for trade #${tradeId}: ${phone.slice(0, 4)}****`);
      // If awaiting payment, phone_shared will happen on confirm
    } catch (e) {
      await ctx.reply(`Error: ${String((e as Error).message || e)}`);
    }
  });

  bot.command('setbuyer', async (ctx) => {
    const parts = ((ctx.match as string) || '').trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply('Usage: /setbuyer <tradeId> <buyerTelegramId|@username>');
    const tradeId = Number(parts[0]);
    let buyerId: number | null = null;
    const ref = parts[1];
    if (/^-?\d+$/.test(ref)) buyerId = Number(ref);
    else {
      return ctx.reply(
        'For @username you must have the user start the bot first, then use numeric id. Buyer can run /start and you can use their id.',
      );
    }
    try {
      await tradeService.bindBuyer(tradeId, buyerId);
      const trade = (await db.getTrade(tradeId)) as unknown as { phone?: string };
      const phone = trade?.phone as string | undefined;
      if (phone) {
        try {
          await ctx.api.sendMessage(
            buyerId,
            `📞 You are buyer for trade #${tradeId}. Phone: \`${phone}\` — please send login code when prompted.`,
            { parse_mode: 'Markdown' },
          );
        } catch {}
      }
      await ctx.reply(`Buyer ${buyerId} bound to trade #${tradeId}`);
    } catch (e) {
      await ctx.reply(`Error: ${String((e as Error).message || e)}`);
    }
  });

  // Catch-all for session/phone during sell flow
  bot.on('message:text', async (ctx, next) => {
    const from = ctx.from?.id;
    if (!from) return next();
    const state = sellSteps.get(from);
    if (!state || state.step !== 'await_session') return next();

    const text = ctx.message.text.trim();

    if (text === '/cancel') {
      sellSteps.delete(from);
      await ctx.reply('Cancelled.');
      return;
    }

    // Phone path: phone:+123...
    if (text.startsWith('phone:')) {
      const phone = text.slice(6).trim();
      if (!phone.startsWith('+')) {
        await ctx.reply('Phone must start with +, e.g. phone:+1234567890');
        return;
      }
      await ctx.reply(
        `Phone received: ${phone.slice(0, 4)}****\n\nNow send the login code you receive via SMS/Telegram, or if 2FA needed, also send 2FA password as second message.`,
      );
      // Store phone and await code (interactive phone login)
      // For phone flow, we use temporary client to send code
      try {
        const { phoneCodeHash } = await accountService.sendCodeToPhone(phone);
        sellSteps.set(from, { step: 'await_phone', tradeId: undefined } as unknown as typeof state);
        // Store phoneCodeHash in memory keyed by user
        (sellSteps as unknown as Map<number, { phone: string; phoneCodeHash: string }>).set(from, {
          phone,
          phoneCodeHash,
        } as unknown as never);
        // We'll need to handle next code message in codeHandler or here
        await ctx.reply(
          'Code sent to your phone. Please reply with the code (e.g. 12345). If code is wrong, you will be prompted again.',
        );
      } catch (e) {
        await ctx.reply(`Failed to send code to ${phone.slice(0, 4)}****: ${String((e as Error).message || e)}`);
      }
      return;
    }

    // Assume StringSession (long base64/1...)
    if (text.length < 50) {
      await ctx.reply('Session too short — please send full StringSession (client.session.save()) or phone:+...');
      return;
    }

    await ctx.reply('🔐 Validating session…');
    const validation = await accountService.validateSession(text);
    if (!validation.ok) {
      await ctx.reply(
        `❌ Session invalid: ${validation.error}\n\nPlease resend a valid StringSession or use phone:+...`,
      );
      return;
    }

    await ctx.reply(
      `✅ Account validated${validation.username ? ` (@${validation.username})` : ''}${validation.phone ? ` ${validation.phone.slice(0, 4)}****` : ''}\n\nKicking other sessions (removing seller)…`,
    );
    let kicked = 0;
    try {
      const res = await accountService.kickOtherSessions(text);
      kicked = res.kicked;
    } catch (e) {
      logger.warn('kickOtherSessions failed', e);
      await ctx.reply(
        `⚠️ Could not kick other sessions: ${String((e as Error).message || e).slice(0, 120)}\nContinuing…`,
      );
    }

    let tradeId: number;
    try {
      tradeId = await tradeService.createTradeWithSession(from, text, validation.phone || null);
    } catch (e) {
      await ctx.reply(`Failed to create trade: ${String((e as Error).message || e)}`);
      return;
    }

    sellSteps.delete(from);
    // P3-11: structural trust gap — phone retains control, warn both parties prominently before proceeding
    await ctx.reply(
      `⚠️ OGOHLANTIRISH (P3-11): Sotuvchi telefon raqami orqali istalgan vaqtda SMS kod so'rab akkauntni qaytarib olishi mumkin. ` +
        `Utradebot faqat sessiyalarni bekor qiladi, SIM Egasi emas. ` +
        `Xaridor buni tushunib, tavakkalni qabul qilgan holda davom etsin. Savdo tugagach zudlik bilan 2FA parol o'rnating va telefon raqamini o'zgartirishni ko'rib chiqing.`,
    );
    await ctx.reply(
      `✅ Trade #${tradeId} created. Kicked ${kicked} other sessions. Holding account securely.\n\n` +
        `Next steps:\n` +
        `1. Buyer (outside) transfers fee to you.\n` +
        `2. When you receive fee, press:`,
      { reply_markup: sellKeyboard(tradeId) },
    );
    // Also instruct to bind buyer if not yet
    await ctx.reply(
      `To bind buyer now (so phone is shared automatically on confirm), send: /setbuyer ${tradeId} <buyerTelegramId>\nBuyer must have started this bot with /start.`,
    );

    // Auto-set status to AWAITING_PAYMENT
    try {
      await db.updateTradeStatus(tradeId, 'AWAITING_PAYMENT');
    } catch {}
  });
}
