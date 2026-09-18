import { Bot } from 'grammy';
import { db } from '../../db/queries';
import { adminRelease, adminRefund } from '../../services/escrowService';
import { adminKeyboard } from '../keyboards';
import logger from '../../logger';

function isAdminCtx(ctx: any): boolean {
  return Boolean((ctx as any).session?.isAdmin);
}

export function registerAdminCommands(bot: Bot) {
  bot.command('admin_release', async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.reply(`❌ Ruxsat yo'q.\nBu buyruq faqat admin uchun.`);
    const dealId = (ctx.match || '').trim();
    if (!dealId) return ctx.reply(`Foydalanish: /admin_release <deal_id>\nMasalan: /admin_release 12`);
    if (!/^\d{1,10}$/.test(dealId)) return ctx.reply(`❌ Noto'g'ri deal_id — faqat raqam kiriting.`);
    const result = await adminRelease(ctx.from!.id, dealId);
    if (result.success) {
      await ctx.reply(`✅ Deal #${dealId} chiqarildi.\nPul sotuvchiga yuborildi.`);
    } else {
      await ctx.reply(`❌ Xatolik: ${result.message}\nQayta urinib ko'ring.`);
    }
  });

  bot.command('admin_refund', async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.reply(`❌ Ruxsat yo'q.\nBu buyruq faqat admin uchun.`);
    const dealId = (ctx.match || '').trim();
    if (!dealId) return ctx.reply(`Foydalanish: /admin_refund <deal_id>\nMasalan: /admin_refund 12`);
    if (!/^\d{1,10}$/.test(dealId)) return ctx.reply(`❌ Noto'g'ri deal_id — faqat raqam kiriting.`);
    const result = await adminRefund(ctx.from!.id, dealId);
    if (result.success) {
      await ctx.reply(`✅ Deal #${dealId} qaytarildi.\nPul xaridorga qaytdi.`);
    } else {
      await ctx.reply(`❌ Xatolik: ${result.message}\nQayta urinib ko'ring.`);
    }
  });

  bot.command('disputes', async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.reply(`❌ Ruxsat yo'q.\nBu buyruq faqat admin uchun.`);
    const res = await db.query(
      `SELECT * FROM deals WHERE confirmations->>'disputed' = 'true' AND status NOT IN ('RELEASED','REFUNDED') ORDER BY id DESC LIMIT 20`,
    );
    if (res.rows.length === 0) {
      await ctx.reply(`✅ Ochilgan nizolar yo'q.\nHammasi joyida.`);
    } else {
      for (const d of res.rows) {
        await ctx.reply(
          `⚖️ Nizo #${d.id} — ${d.amount} ${d.asset}\nXaridor ${d.buyer_telegram_id} ↔ Sotuvchi ${d.seller_telegram_id}.\nQaror uchun tugmani bosing.`,
          { parse_mode: 'HTML', reply_markup: adminKeyboard(d.id) },
        );
      }
    }
    try {
      const { listAdminAlerts } = await import('../../db/queries');
      const alerts = await listAdminAlerts(10);
      if (alerts.length > 0) {
        await ctx.reply(`⚠️ So'nggi admin ogohlantirishlar (${alerts.length}):`);
        for (const a of alerts) {
          let when = '';
          try {
            when = a.created_at ? new Date(a.created_at).toLocaleString('uz-UZ') : '';
          } catch {} // best-effort: bad timestamp omits the date, alert text still sent.
          await ctx.reply(`• #${a.id} [${a.kind}] ${a.text}${when ? `\n${when}` : ''}`);
        }
      } else {
        await ctx.reply(`ℹ️ Admin ogohlantirishlar yo'q.`);
      }
    } catch (e) {
      // Was silent: an admin tapping "alerts" with a failing DB saw nothing. Log it.
      logger.warn('disputes/alerts handler failed', e);
      try {
        await ctx.reply(`❌ Ogohlantirishlarni o'qib bo'lmadi, keyinroq urinib ko'ring.`);
      } catch {}
    }
  });

  bot.callbackQuery(/^admin_do_release:(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCallbackQuery({ text: "Ruxsat yo'q" });
    const r = await adminRelease(ctx.from!.id, ctx.match![1]);
    await ctx.answerCallbackQuery({ text: r.success ? 'Chiqarildi' : String(r.message).slice(0, 180) });
    await ctx.reply(r.success ? `✅ Deal #${ctx.match![1]} chiqarildi.` : `❌ Xatolik: ${r.message}`);
  });

  bot.callbackQuery(/^admin_do_refund:(\d+)$/, async (ctx) => {
    if (!isAdminCtx(ctx)) return ctx.answerCallbackQuery({ text: "Ruxsat yo'q" });
    const r = await adminRefund(ctx.from!.id, ctx.match![1]);
    await ctx.answerCallbackQuery({ text: r.success ? 'Qaytarildi' : String(r.message).slice(0, 180) });
    await ctx.reply(r.success ? `✅ Deal #${ctx.match![1]} qaytarildi.` : `❌ Xatolik: ${r.message}`);
  });
}
