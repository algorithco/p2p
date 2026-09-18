import { InlineKeyboard } from 'grammy';

export function webAppButton(url: string, label = 'Ilovani ochish'): InlineKeyboard {
  return new InlineKeyboard().webApp(label, url);
}

export function adminKeyboard(dealId: number | string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Chiqarish', `admin_do_release:${dealId}`)
    .text('↩️ Qaytarish', `admin_do_refund:${dealId}`);
}
