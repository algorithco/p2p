import { InlineKeyboard } from 'grammy';
import { getBot } from './bot';
import { config } from '../config';

type DealLike = { id: number | string; amount: string | number; asset: string; terms?: string };

function dealUrl(dealId: number | string): string | undefined {
  const base = (config.webappUrl || '').replace(/\/$/, '');
  if (!base) return undefined;
  // Creator approves join requests inside the mini-app deal CHAT (not bot, no separate page).
  return `${base}/#/deal/${dealId}/chat`;
}

function kbFor(dealId: number | string): InlineKeyboard | undefined {
  const url = dealUrl(dealId);
  if (!url) return undefined;
  return new InlineKeyboard().webApp('Ilovani ochish', url);
}

/**
 * Escape user-influenced text for Telegram HTML parse_mode.
 * All templates in this file are plain text (no intentional tags), so escaping
 * at the sink closes stored/reflected HTML injection (e.g. a joiner username
 * like `<a href="https://evil">admin</a>` rendering as a phishing link).
 */
export function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function send(chatId: number | string, text: string, dealId?: number | string): Promise<void> {
  try {
    const bot = getBot();
    if (!bot) return;
    const safe = escapeHtml(text);
    const kb = dealId !== undefined ? kbFor(dealId) : undefined;
    if (kb) {
      await bot.api.sendMessage(Number(chatId), safe, { parse_mode: 'HTML', reply_markup: kb });
    } else {
      await bot.api.sendMessage(Number(chatId), safe, { parse_mode: 'HTML' });
    }
  } catch {
    // never throw
  }
}

export async function joinRequestToCreator(creatorId: number, deal: DealLike, requesterLabel: string): Promise<void> {
  const text = [
    `🤝 Deal #${deal.id} ga so'rov: ${requesterLabel}`,
    `${deal.amount} ${deal.asset} — sherik bo'lmoqchi.`,
    `Bitim chati ichida tasdiqlang (mini-app → chat).`,
  ].join('\n');
  await send(creatorId, text, deal.id);
}

export async function joinApproved(partnerId: number, deal: DealLike, role: 'sotuvchi' | 'xaridor'): Promise<void> {
  const text = [
    `✅ Deal #${deal.id} ga qo'shildingiz (${role}).`,
    `${deal.amount} ${deal.asset} — keyingi qadam ilovada.`,
    `Ilovani oching.`,
  ].join('\n');
  await send(partnerId, text, deal.id);
}

export async function joinRejected(partnerId: number, deal: DealLike): Promise<void> {
  const text = [`❌ Deal #${deal.id} so'rovi rad etildi.`, `Yangi havola so'rang.`, `Yordam kerak bo'lsa yozing.`].join(
    '\n',
  );
  await send(partnerId, text, deal.id);
}

export async function depositToSeller(sellerId: number, deal: DealLike): Promise<void> {
  const text = [
    `💰 Pul keldi: ${deal.amount} ${deal.asset} (Deal #${deal.id}).`,
    `Iltimos, tovarni xaridorga bering.`,
    `Keyin ilovada "Yubordim" ni bosing.`,
  ].join('\n');
  await send(sellerId, text, deal.id);
}

export async function shippedToBuyer(buyerId: number, deal: DealLike): Promise<void> {
  const text = [
    `📦 Sotuvchi yetkazdi (Deal #${deal.id}).`,
    `Oldingizmi? Iltimos, ilovada tasdiqlang.`,
    `Ilovani oching.`,
  ].join('\n');
  await send(buyerId, text, deal.id);
}

export async function releasedToBuyer(buyerId: number, deal: DealLike): Promise<void> {
  const text = [
    `✅ Deal #${deal.id} yakunlandi.`,
    `${deal.amount} ${deal.asset} sotuvchiga o'tdi.`,
    `Xizmatdan yana foydalaning.`,
  ].join('\n');
  await send(buyerId, text, deal.id);
}

export async function releasedToSeller(sellerId: number, deal: DealLike, netAmount: string): Promise<void> {
  const text = [
    `🎉 Deal #${deal.id}: ${netAmount} ${deal.asset} oldingiz.`,
    `Komissiya chegirildi.`,
    `Ilovada tekshiring.`,
  ].join('\n');
  await send(sellerId, text, deal.id);
}

export async function adminDecisionToParty(partyId: number, deal: DealLike, text: string): Promise<void> {
  const msg = [`⚖️ Admin qarori (Deal #${deal.id}): ${text}`, `Batafsil ilovada ko'ring.`].join('\n');
  await send(partyId, msg, deal.id);
}

export async function reminderToPayer(buyerId: number, deal: DealLike): Promise<void> {
  const text = [
    `⏰ Eslatma: Deal #${deal.id} uchun ${deal.amount} ${deal.asset} to'lang.`,
    `Vaqt tugamasdan ilovada to'lov qiling.`,
  ].join('\n');
  await send(buyerId, text, deal.id);
}

export async function reminderToShipper(sellerId: number, deal: DealLike): Promise<void> {
  const text = [`⏰ Eslatma: Deal #${deal.id} uchun tovarni yuboring.`, `Keyin ilovada "Yubordim" ni bosing.`].join(
    '\n',
  );
  await send(sellerId, text, deal.id);
}

export async function reminderToConfirmer(buyerId: number, deal: DealLike): Promise<void> {
  const text = [`⏰ Eslatma: Deal #${deal.id} — tovarni oldingizmi?`, `Ilovani ochib tasdiqlang.`].join('\n');
  await send(buyerId, text, deal.id);
}

export async function unknownDepositToAdmins(info: {
  amount: string | number;
  asset: string;
  address: string;
  memo: string;
}): Promise<void> {
  try {
    const bot = getBot();
    if (!bot) return;
    const text = [
      `⚠️ Noma'lum to'lov: ${info.amount} ${info.asset}`,
      `Manzil: ${info.address}`,
      `Memo: ${info.memo}`,
    ].join('\n');
    const safe = escapeHtml(text);
    for (const adminId of config.adminTelegramIds) {
      try {
        await bot.api.sendMessage(Number(adminId), safe, { parse_mode: 'HTML' });
      } catch {
        // ignore per-admin errors
      }
    }
  } catch {
    // never throw
  }
}
