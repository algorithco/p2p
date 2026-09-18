import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../../config';
import logger, { sanitizeLogValue } from '../../logger';
import { getMonthlyBuyerRating } from '../../db/queries';
import { webAppButton } from '../keyboards';

function welcomeText(): string {
  return [
    `🛡️ <b>Savdochi — xavfsiz P2P savdo</b>`,
    ``,
    `Bu bot pulni tovar/xizmat topshirilgunga qadar ushlab turadi. To'lov <b>TON</b> yoki <b>USDT</b> da, to'g'ridan-to'g'ri blokcheynda.`,
    ``,
    `<b>Qanday ishlaydi:</b>`,
    `1️⃣ Bitim yarating — narx, shartlar va muddatni kiriting`,
    `2️⃣ Xaridor to'lov qiladi — pul escrow hamyonda saqlanadi`,
    `3️⃣ Sotuvchi “Yubordim” bosadi, xaridor “Qabul qildim” tasdiqlaydi`,
    `4️⃣ Tasdiqdan keyin pul avtomatik sotuvchiga o'tadi (komissiya 1%). Nizo bo'lsa admin hal qiladi`,
    ``,
    `Barcha amallar ilovada — pastdagi <b>🚀 Ilovani ochish</b> tugmasini bosing.`,
    `Havola orqali taklif qilingan bo'lsangiz, havola avtomatik ochiladi.`,
  ].join('\n');
}

function helpText(): string {
  return [
    `📖 <b>Yordam</b>`,
    ``,
    `• Bitim yarating → havola ulashing → sherik qo'shilsin`,
    `• To'lovni faqat ilovada qiling — izoh (memo) avtomatik shifrlanadi`,
    `• “Yubordim” / “Qabul qildim” tugmalari bilan yakunlang`,
    `• Muammo bo'lsa /disputes (admin) yoki pastdagi Reyting tugmasi`,
    ``,
    `Ilovani pastdagi tugma orqali oching.`,
  ].join('\n');
}

function welcomeInlineKeyboard(): InlineKeyboard {
  const base = (config.webappUrl || '').replace(/\/$/, '');
  if (base) {
    return webAppButton(base, '🚀 Ilovani ochish').row().text('📖 Yordam', 'help').text('🏆 Reyting', 'help:rating');
  }
  return new InlineKeyboard().text('📖 Yordam', 'help').text('🏆 Reyting', 'help:rating');
}

function helpKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('◀️ Orqaga', 'menu:home');
}

export function registerCommands(bot: Bot) {
  bot.command('start', async (ctx) => {
    const payload = ((ctx.match as string) || '').trim();
    if (payload.startsWith('join_')) {
      let handled = false;
      const rest = payload.slice(5);
      const sep = rest.indexOf('_');
      if (sep !== -1) {
        const dealId = rest.slice(0, sep);
        const token = rest.slice(sep + 1);
        // Validate before reflecting into URLs/replies: Telegram start payloads
        // are attacker-craftable (t.me/<bot>?start=join_...). Reject junk so a
        // malicious payload can never reach the Mini App fragment path raw.
        if (!/^\d{1,10}$/.test(dealId) || !/^[A-Za-z0-9_-]{10,128}$/.test(token)) {
          await ctx.reply(`Taklif havolasi buzilgan — yangisini so'rang.`);
          return;
        }
        const base = (config.webappUrl || '').replace(/\/$/, '');
        const username = (config.botUsername || 'savdochi_uzbot').replace(/^@/, '');
        if (dealId && token && base) {
          // Carry the invite twice: hash route (canonical) + ?startapp= query
          // (some clients drop the URL fragment when opening a web_app — the
          // Mini App resolves the query/start_param fallback to the join page).
          const joinUrl = `${base}/?startapp=${encodeURIComponent(`join_${dealId}_${token}`)}#/deal/${dealId}/join/${token}`;
          const kb = webAppButton(joinUrl, "➕ Bitimga qo'shilish");
          await ctx.reply(
            `🤝 Sizni Bitim #${dealId} ga taklif qilishdi.\nQo'shilish uchun pastdagi tugmani bosing — yaratuvchi bitim chatida tasdiqlaydi.`,
            { reply_markup: kb },
          );
          handled = true;
        } else if (dealId && token) {
          // WEBAPP_URL not configured — fall back to the bot's Mini App link.
          // Needs the Mini App attached in BotFather; the startapp value arrives
          // in the app as start_param and the app routes it to the join page.
          // Definitive fix: set WEBAPP_URL=https://<public-frontend> in backend/.env.
          logger.warn(
            `Bot /start join_${sanitizeLogValue(dealId)}_… without button-url: WEBAPP_URL empty, using t.me/${username}/app fallback`,
          );
          const appLink = `https://t.me/${username}/app?startapp=${encodeURIComponent(`join_${dealId}_${token}`)}`;
          const kb = new InlineKeyboard().url("➕ Bitimga qo'shilish", appLink);
          await ctx.reply(
            `🤝 Sizni Bitim #${dealId} ga taklif qilishdi.\nQo'shilish uchun pastdagi tugmani bosing — yaratuvchi bitim chatida tasdiqlaydi.`,
            { reply_markup: kb },
          );
          handled = true;
        } else {
          await ctx.reply(`Taklif havolasi buzilgan — yangisini so'rang.`);
          handled = true;
        }
      } else {
        await ctx.reply(`Taklif havolasi buzilgan — yangisini so'rang.`);
        handled = true;
      }
      // Join payload handled — don't pile the generic welcome on top of it.
      if (handled) return;
    }
    // Ordinary /start: keep only inline buttons (no duplicate ReplyKeyboard).
    // The Mini App is also available via the Telegram Menu Button (bot.ts).
    await ctx.reply(welcomeText(), { parse_mode: 'HTML', reply_markup: welcomeInlineKeyboard() });
    // Remove any stale ReplyKeyboard from the previous build (was duplicate
    // of the inline). One-time cleanup: clients keep the old persistent keyboard
    // until we explicitly remove it.
    try {
      await ctx.api
        .sendMessage(ctx.chat!.id, ' ', {
          reply_markup: { remove_keyboard: true } as any,
        })
        .then(async (m) => {
          try {
            await ctx.api.deleteMessage(ctx.chat!.id, m.message_id);
          } catch {}
        });
    } catch {}
  });

  bot.callbackQuery('menu:home', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(welcomeText(), { parse_mode: 'HTML', reply_markup: welcomeInlineKeyboard() });
    } catch {
      // best-effort: edit fails when the message is unchanged/deleted — reply instead.
      await ctx.reply(welcomeText(), { parse_mode: 'HTML', reply_markup: welcomeInlineKeyboard() });
    }
  });

  const showHelp = async (ctx: any) => {
    try {
      await ctx.answerCallbackQuery?.();
    } catch {} // best-effort: callback may already be answered/expired.
    try {
      await ctx.editMessageText?.(helpText(), { parse_mode: 'HTML', reply_markup: helpKeyboard() });
    } catch {
      // best-effort: uneditable message — reply instead.
      await ctx.reply(helpText(), { parse_mode: 'HTML', reply_markup: helpKeyboard() });
    }
  };

  bot.callbackQuery('help', async (ctx) => showHelp(ctx));
  bot.callbackQuery('help:rating', async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {}
    try {
      const [ton, usdt] = await Promise.all([
        getMonthlyBuyerRatingSafe('TON', 5),
        getMonthlyBuyerRatingSafe('USDT', 5),
      ]);
      await ctx.reply(formatRating(ton, usdt), { parse_mode: 'HTML' });
    } catch (e) {
      logger.warn('/reyting inline failed', e);
      await ctx.reply('Reyting hozircha mavjud emas — birozdan keyin urinib ko‘ring.');
    }
  });
  bot.command('help', async (ctx) => {
    await ctx.reply(helpText(), { parse_mode: 'HTML', reply_markup: helpKeyboard() });
  });

  // Monthly buyer rating — completed (RELEASED) deals only; only the buyer
  // (the side that sent TON/USDT) earns rating.
  bot.command('reyting', async (ctx) => {
    try {
      const [ton, usdt] = await Promise.all([
        getMonthlyBuyerRatingSafe('TON', 5),
        getMonthlyBuyerRatingSafe('USDT', 5),
      ]);
      await ctx.reply(formatRating(ton, usdt), { parse_mode: 'HTML' });
    } catch (e) {
      logger.warn('/reyting failed', e);
      await ctx.reply('Reyting hozircha mavjud emas — birozdan keyin urinib ko‘ring.');
    }
  });
}

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

function fmtVol(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Math.round(n * 10000) / 10000);
}

function ratingName(r: { telegram_id: number; username: string | null }): string {
  return r.username ? '@' + r.username : 'ID ' + r.telegram_id;
}

function ratingBlock(
  title: string,
  rows: { telegram_id: number; username: string | null; volume: string; deals: number }[],
): string {
  if (!rows.length) return `${title}\n— hali bitim yo‘q`;
  const lines = rows.map(
    (r, i) => `${MEDALS[i] || `#${i + 1}`} ${ratingName(r)} — <b>${fmtVol(r.volume)}</b> (${r.deals} bitim)`,
  );
  return `${title}\n${lines.join('\n')}`;
}

function formatRating(
  ton: { telegram_id: number; username: string | null; volume: string; deals: number }[],
  usdt: { telegram_id: number; username: string | null; volume: string; deals: number }[],
): string {
  const d = new Date();
  const month = `${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  return [
    `🏆 <b>Oylik reyting — ${month}</b>`,
    `Faqat yakunlangan bitimlar; ochko faqat TON/USDT yuborgan xaridorga.`,
    ``,
    ratingBlock('💎 <b>TON</b>', ton),
    ``,
    ratingBlock('💵 <b>USDT</b>', usdt),
  ].join('\n');
}

// Small indirection so a single-asset DB outage still shows the other board.
async function getMonthlyBuyerRatingSafe(asset: string, limit: number) {
  try {
    return await getMonthlyBuyerRating(asset, limit);
  } catch (e) {
    logger.warn(`monthly rating ${asset} failed`, e);
    return [];
  }
}
