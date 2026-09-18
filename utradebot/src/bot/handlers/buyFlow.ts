import { Bot } from 'grammy';
import * as db from '../../db/queries';
import * as tradeService from '../../services/tradeService';
import { setAwaitingCode } from './codeHandler';
import logger from '../../logger';

export function registerBuyFlow(bot: Bot) {
  bot.command('buy', async (ctx) => {
    const parts = ((ctx.match as string) || '').trim().split(/\s+/);
    if (parts.length < 1 || !parts[0]) {
      await ctx.reply(
        'Usage: /buy <tradeId>\n\nYou need trade id from seller. After seller confirms payment, you will receive phone and be asked to send login code.',
      );
      return;
    }
    const tradeId = Number(parts[0]);
    if (!Number.isInteger(tradeId)) return ctx.reply('Invalid tradeId');

    const trade = (await db.getTrade(tradeId)) as unknown as {
      seller_telegram_id: number;
      buyer_telegram_id?: number;
      status: string;
      phone?: string;
    } | null;
    if (!trade) return ctx.reply('Trade not found');

    const from = ctx.from!.id;
    if (trade.buyer_telegram_id && Number(trade.buyer_telegram_id) !== from) {
      return ctx.reply('This trade already has a different buyer');
    }
    if (!trade.buyer_telegram_id) {
      await tradeService.bindBuyer(tradeId, from);
    }

    const updated = (await db.getTrade(tradeId)) as unknown as { status: string; phone?: string };
    if (!updated.phone) {
      await ctx.reply(
        `You are now buyer for trade #${tradeId}. Seller has not yet confirmed payment and shared phone.\n\n` +
          `Waiting for seller to press "Payment received". You will be notified when phone is shared.`,
      );
      return;
    }

    const phone = String(updated.phone);
    setAwaitingCode(tradeId, from, phone);
    await tradeService.bindBuyer(tradeId, from); // ensure status AWAITING_CODE
    await ctx.reply(
      `⚠️ OGOHLANTIRISH: Sotuvchi hali ham telefon raqam egasi — istalgan vaqtda SMS orqali kod so'rab kirishi mumkin. ` +
        `Xaridordan keyin darhol 2FA parol o'rnating va iloji bo'lsa telefon raqamini almashtiring. Ushbu tavakkalni tushungan holda davom eting.\n\n` +
        `✅ You are buyer for trade #${tradeId}.\n\n` +
        `Phone: \`${phone}\`\n\n` +
        `Please trigger Telegram login on your device (enter this phone in Telegram app) and send the login code you receive via SMS/Telegram to this chat. The tradebot will verify code, log you in, and log itself out.`,
      { parse_mode: 'Markdown' },
    );
    try {
      await db.updateTradeStatus(tradeId, 'AWAITING_CODE');
    } catch {}
  });

  bot.command('mytrades', async (ctx) => {
    const from = ctx.from!.id;
    const rows = (await db.pool.query(
      `SELECT id, status, phone, seller_telegram_id, buyer_telegram_id, created_at FROM utrade_trades
       WHERE seller_telegram_id = $1 OR buyer_telegram_id = $1 ORDER BY id DESC LIMIT 20`,
      [from],
    )) as unknown as {
      rows: Array<{
        id: number;
        status: string;
        phone?: string;
        seller_telegram_id: number;
        buyer_telegram_id?: number;
      }>;
    };
    // Fallback if above fails: use listTradesForSeller plus buyer trades
    let trades: Array<{
      id: number;
      status: string;
      phone?: string;
      seller_telegram_id: number;
      buyer_telegram_id?: number;
    }> = [];
    try {
      trades = rows.rows;
    } catch (e) {
      logger.warn('mytrades query failed', e);
      trades = (await db.listTradesForSeller(from, 20)) as unknown as typeof trades;
    }
    if (trades.length === 0) return ctx.reply('No trades found. Use /sell to create one or /buy <id>');
    const lines = ['📋 Your trades:'];
    for (const t of trades) {
      const role = Number(t.seller_telegram_id) === from ? 'seller' : 'buyer';
      lines.push(`#${t.id} [${t.status}] (${role}) ${t.phone ? t.phone.slice(0, 4) + '****' : ''}`);
    }
    await ctx.reply(lines.join('\n'));
  });

  bot.callbackQuery(/^buyer_code_sent:(\d+)$/, async (ctx) => {
    const tradeId = Number(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: 'Send code as message' });
    await ctx.reply(`For trade #${tradeId}, please send the 5-6 digit login code you received via SMS/Telegram.`);
  });
}
